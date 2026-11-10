"""Volatile WebSocket continuation for the official Codex Responses route.

The SDK connection is deliberately owned by one AIAgent and never written to
session storage. A continuation is sent only when the current full input still
starts with the prior request input and completed response output, allowing
only server-assigned IDs/status and safely canonicalized function-argument JSON formatting to differ.
"""
from __future__ import annotations

import copy
import hashlib
import json
import logging
import socket
import threading
from dataclasses import dataclass
from typing import Any

logger = logging.getLogger("run_agent")


class CodexWebSocketConnectError(RuntimeError):
    """The WebSocket handshake failed before a Responses request was sent."""


class CodexWebSocketUnavailable(RuntimeError):
    """This request can't safely use the configured WebSocket connection."""


class CodexWebSocketSendError(RuntimeError):
    """A WebSocket send failed after its acceptance by the server became ambiguous."""


def _jsonable(value: Any) -> Any:
    dump = getattr(value, "model_dump", None)
    if callable(dump):
        return _jsonable(dump(mode="json", exclude_none=True))
    if isinstance(value, dict):
        return {str(key): _jsonable(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_jsonable(item) for item in value]
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    if hasattr(value, "__dict__"):
        return _jsonable(vars(value))
    return value


def _canonical_json_object(value: Any) -> str | None:
    """Canonicalize safe JSON object text; float tokens stay exact to avoid precision loss."""
    if not isinstance(value, str):
        return None

    def object_without_duplicates(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
        result: dict[str, Any] = {}
        for key, child in pairs:
            if key in result:
                raise ValueError("duplicate JSON object key")
            result[key] = child
        return result

    def reject_constant(value: str) -> None:
        raise ValueError(f"nonstandard JSON constant: {value}")

    def reject_float(value: str) -> None:
        raise ValueError(f"floating-point JSON value kept exact: {value}")

    def reject_negative_zero(value: str) -> int:
        if value == "-0":
            raise ValueError("negative zero JSON integer kept exact")
        return int(value)

    try:
        parsed = json.loads(
            value, object_pairs_hook=object_without_duplicates,
            parse_constant=reject_constant, parse_float=reject_float,
            parse_int=reject_negative_zero,
        )
    except (TypeError, ValueError, RecursionError):
        return None
    if not isinstance(parsed, dict):
        return None
    try:
        return json.dumps(parsed, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    except (TypeError, ValueError, RecursionError):
        return None


def _comparison_item(item: Any, referenced_ids: frozenset[str] = frozenset()) -> Any:
    """Normalize transport metadata while retaining IDs needed by Responses item references."""
    value = _jsonable(item)
    if isinstance(value, dict):
        item_type = value.get("type")
        item_id = value.get("id")
        preserve_id = item_type in (None, "item_reference") or item_id in referenced_ids
        result = {
            key: child for key, child in value.items()
            if key != "status" and (key != "id" or preserve_id)
        }
        # The Codex Responses stream can return an empty reasoning content array, while Hermes
        # omits that empty optional field when it rebuilds the same history for a later request.
        # Treat only this empty representation difference as equivalent; populated content remains
        # part of the fingerprint because it can affect the model's context.
        if result.get("type") == "reasoning" and result.get("content") == []:
            result.pop("content")
        if result.get("type") == "function_call" and "arguments" in result:
            canonical = _canonical_json_object(result["arguments"])
            if canonical is not None:
                result["arguments"] = canonical
        return result
    return value


def _fingerprint(value: Any) -> bytes | None:
    try:
        serialized = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    except (TypeError, ValueError, RecursionError):
        return None
    return hashlib.sha256(serialized).digest()


def _item_reference_ids(items: list[Any]) -> frozenset[str]:
    """IDs in references, including the SDK's permitted id-only ItemReference form."""
    referenced_ids = set()
    for item in items:
        value = item  # plan() has already converted the request tree to JSON-compatible values.
        if (
            isinstance(value, dict)
            and value.get("type") in (None, "item_reference")
            and isinstance(value.get("id"), str)
        ):
            referenced_ids.add(value["id"])
    return frozenset(referenced_ids)


def _fingerprint_items(
    items: list[Any], *, referenced_ids: frozenset[str] = frozenset(),
) -> tuple[tuple[bytes, ...], tuple[int, ...]] | None:
    fingerprints, sizes = [], []
    for item in items:
        normalized = _comparison_item(item, referenced_ids)
        try:
            serialized = json.dumps(normalized, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
            raw_size = len(json.dumps(item, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))
        except (TypeError, ValueError, RecursionError):
            return None
        fingerprints.append(hashlib.sha256(serialized).digest())
        sizes.append(raw_size)
    return tuple(fingerprints), tuple(sizes)


def _json_array_size(item_sizes: tuple[int, ...] | list[int]) -> int:
    return 2 + sum(item_sizes) + max(0, len(item_sizes) - 1)


def _merge_headers(defaults: dict[str, Any], request_headers: dict[str, Any]) -> dict[str, str]:
    """Merge SDK client headers with request headers using HTTP's case-insensitive names."""
    merged: dict[str, str] = {}
    for source in (defaults, request_headers):
        for raw_key, raw_value in source.items():
            key, value = str(raw_key), str(raw_value)
            prior = next((existing for existing in merged if existing.lower() == key.lower()), None)
            if prior is not None:
                del merged[prior]
            merged[key] = value
    return merged


def _timeout_component(timeout: Any, component: str) -> float | None:
    if timeout is None:
        return None
    value = timeout if isinstance(timeout, (int, float)) and not isinstance(timeout, bool) else getattr(
        timeout, component, None)
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        try:
            number = float(value)
        except (OverflowError, ValueError):
            return None
        if number >= 0 and number < float("inf"):
            return number
    return None


def _request_timeouts(client: Any, plan: ContinuationPlan) -> tuple[float | None, float | None, float | None]:
    timeout = plan.timeout if plan.timeout_was_set else getattr(client, "timeout", None)
    return (
        _timeout_component(timeout, "connect"),
        _timeout_component(timeout, "read"),
        _timeout_component(timeout, "write"),
    )


@dataclass(frozen=True)
class ContinuationPlan:
    payload: dict[str, Any]
    full_input: list[Any]
    full_input_fingerprints: tuple[bytes, ...]
    request_fields_fingerprint: bytes
    incremental: bool
    full_input_bytes: int
    sent_input_bytes: int
    extra_headers: dict[str, Any]
    extra_query: dict[str, Any]
    timeout: Any
    timeout_was_set: bool


class CodexResponsesContinuation:
    """Strictly plan and commit a single connection-local response chain."""

    def __init__(self) -> None:
        self.clear()

    def clear(self) -> None:
        self.response_id: str | None = None
        self.request_fields_fingerprint: bytes | None = None
        self.request_input_fingerprints: tuple[bytes, ...] | None = None
        self.response_output_fingerprints: tuple[bytes, ...] | None = None

    def plan(self, request: dict[str, Any]) -> ContinuationPlan | None:
        try:
            body = _jsonable(request)
        except RecursionError:
            return None
        if not isinstance(body, dict):
            return None
        extra_body = body.pop("extra_body", None)
        if extra_body is not None:
            if not isinstance(extra_body, dict):
                return None
        body.pop("stream", None)
        body.pop("stream_options", None)
        extra_headers = body.pop("extra_headers", None) or {}
        extra_query = body.pop("extra_query", None) or {}
        timeout_was_set = "timeout" in body
        timeout = body.pop("timeout", None)
        if (not isinstance(extra_headers, dict) or not isinstance(extra_query, dict)
                or any(not isinstance(key, str) or not isinstance(value, str)
                       for key, value in extra_headers.items())):
            return None
        if extra_body is not None:
            # openai-python merges extra_body after its typed arguments, so caller values win.
            # Extract transport options first: similarly named keys inside extra_body remain JSON
            # fields and must not silently become local timeout/header/query controls.
            body = {**body, **extra_body}
        if "previous_response_id" in body or body.get("type") not in (None, "response.create"):
            # The continuation owns previous_response_id and the protocol's type. Defer to the
            # ordinary SDK route when a caller explicitly supplies incompatible values.
            return None
        full_input = body.get("input")
        if not isinstance(full_input, list):
            return None
        input_fingerprints = _fingerprint_items(
            full_input, referenced_ids=_item_reference_ids(full_input),
        )
        if input_fingerprints is None:
            return None
        full_input_fingerprints, input_item_sizes = input_fingerprints
        body["store"] = False
        body["type"] = "response.create"
        fields = {key: value for key, value in body.items() if key not in {"input", "type", "store"}}
        fields_fingerprint = _fingerprint(fields)
        if fields_fingerprint is None:
            return None

        sent_input = full_input
        sent_input_start = 0
        incremental = False
        if (self.response_id and self.request_fields_fingerprint == fields_fingerprint
                and self.request_input_fingerprints is not None
                and self.response_output_fingerprints is not None):
            baseline = self.request_input_fingerprints + self.response_output_fingerprints
            if len(full_input_fingerprints) >= len(baseline) and full_input_fingerprints[:len(baseline)] == baseline:
                sent_input_start = len(baseline)
                sent_input = full_input[sent_input_start:]
                incremental = True
                body["previous_response_id"] = self.response_id

        body["input"] = sent_input
        full_input_bytes = _json_array_size(input_item_sizes)
        sent_input_bytes = _json_array_size(input_item_sizes[sent_input_start:])
        return ContinuationPlan(
            payload=body,
            full_input=full_input,
            full_input_fingerprints=full_input_fingerprints,
            request_fields_fingerprint=fields_fingerprint,
            incremental=incremental,
            full_input_bytes=full_input_bytes,
            sent_input_bytes=sent_input_bytes,
            extra_headers=copy.deepcopy(extra_headers),
            extra_query=copy.deepcopy(extra_query),
            timeout=timeout,
            timeout_was_set=timeout_was_set,
        )

    def commit(self, plan: ContinuationPlan, response: Any) -> None:
        response_id = getattr(response, "id", None)
        status = getattr(response, "status", None)
        output = _jsonable(getattr(response, "output", None))
        if status != "completed" or not isinstance(response_id, str) or not response_id or not isinstance(output, list):
            self.clear()
            return
        output_fingerprints = _fingerprint_items(output)
        if output_fingerprints is None:
            self.clear()
            return
        self.response_id = response_id
        self.request_fields_fingerprint = plan.request_fields_fingerprint
        self.request_input_fingerprints = plan.full_input_fingerprints
        self.response_output_fingerprints = output_fingerprints[0]


def _event_type(event: Any) -> str:
    value = getattr(event, "type", None)
    if value is None and isinstance(event, dict):
        value = event.get("type")
    return value if isinstance(value, str) else ""


class _WebSocketResponseStream:
    """One response's view of a persistent WebSocket; normal close keeps the socket."""

    _TERMINAL = frozenset({"response.completed", "response.failed", "response.incomplete"})

    def __init__(self, owner: CodexResponsesWebSocketSession, connection: Any,
                 plan: ContinuationPlan, read_timeout: float | None) -> None:
        self.owner, self.connection, self.plan = owner, connection, plan
        self.read_timeout = read_timeout
        self.terminal = False
        self.closed = False
        self._receiving_thread_id: int | None = None

    def __iter__(self) -> _WebSocketResponseStream:
        return self

    def __next__(self) -> Any:
        with self.owner._lock:
            if self.closed or self.terminal:
                raise StopIteration
            self._receiving_thread_id = threading.get_ident()
        try:
            if self.read_timeout is None:
                event = self.connection.recv()
            else:
                # openai-python's sync ResponsesConnection.recv() doesn't expose the
                # websockets timeout argument. Its pinned implementation delegates to
                # ClientConnection.recv(decode=False) and then parse_event(); use those
                # public lower-level calls to retain the HTTP read-timeout contract.
                websocket = getattr(self.connection, "_connection", None)
                recv = getattr(websocket, "recv", None)
                parse_event = getattr(self.connection, "parse_event", None)
                if not callable(recv) or not callable(parse_event):
                    raise CodexWebSocketUnavailable("the WebSocket SDK cannot enforce the configured read timeout")
                event = parse_event(recv(timeout=self.read_timeout, decode=False))
        except TimeoutError:
            self.owner._stream_failed(self)
            raise
        except BaseException:
            self.owner._stream_failed(self)
            raise
        with self.owner._lock:
            if self.closed:
                aborted = True
                self.owner._stream_failed(self)
            else:
                self._receiving_thread_id = None
                aborted = False
                if _event_type(event) in self._TERMINAL:
                    self.terminal = True
                    self.owner._stream_terminal(self)
        if aborted:
            raise StopIteration
        return event

    def close(self) -> None:
        with self.owner._lock:
            if self.closed:
                return
            self.closed = True
            terminal = self.terminal
        if not terminal:
            self.owner._abort_stream(self)


class CodexResponsesWebSocketSession:
    """One SDK WebSocket and its volatile continuation state."""

    def __init__(self, client: Any) -> None:
        self.client = client
        self.continuation = CodexResponsesContinuation()
        self._lock = threading.RLock()
        self._manager: Any = None
        self._connection: Any = None
        self._active_stream: _WebSocketResponseStream | None = None
        self._retire_when_idle = False
        self._connection_headers: dict[str, Any] | None = None
        self._connection_query: dict[str, Any] | None = None
        self.disabled = False

    def open_response(self, request: dict[str, Any]) -> _WebSocketResponseStream:
        plan = self.continuation.plan(request)
        if plan is None:
            raise CodexWebSocketUnavailable("request shape is not supported by the WebSocket continuation path")
        with self._lock:
            if self.disabled:
                raise CodexWebSocketUnavailable("WebSocket continuation is disabled for this agent")
            if self._active_stream is not None:
                raise CodexWebSocketUnavailable("another WebSocket response is still active")
            if self._connection is not None and (
                    self._connection_headers != plan.extra_headers or self._connection_query != plan.extra_query):
                self.disabled = True
                self.continuation.clear()
                self._close_connection_locked()
                raise CodexWebSocketUnavailable("request headers or query changed during the WebSocket session")
            if self._connection is None:
                responses = getattr(self.client, "responses", None)
                connect = getattr(responses, "connect", None)
                if not callable(connect):
                    self.disabled = True
                    raise CodexWebSocketConnectError("the active Responses client has no WebSocket support")
                client_headers = getattr(self.client, "_custom_headers", None)
                if not isinstance(client_headers, dict):
                    client_headers = {}
                headers = _merge_headers(client_headers, plan.extra_headers)
                client_query = getattr(self.client, "_custom_query", None)
                if not isinstance(client_query, dict):
                    client_query = {}
                query = {**client_query, **plan.extra_query}
                connect_timeout, read_timeout, write_timeout = _request_timeouts(self.client, plan)
                websocket_options = {"open_timeout": connect_timeout, "max_size": None}
                try:
                    manager = connect(
                        max_retries=0,
                        extra_headers=headers,
                        extra_query=query,
                        websocket_connection_options=websocket_options,
                    )
                except Exception as exc:
                    self.disabled = True
                    self.continuation.clear()
                    raise CodexWebSocketConnectError(
                        "Codex Responses WebSocket client setup failed before the request was sent") from exc
                try:
                    connection = manager.__enter__()
                except Exception as exc:
                    self.disabled = True
                    self.continuation.clear()
                    raise CodexWebSocketConnectError("Codex Responses WebSocket handshake failed") from exc
                self._manager, self._connection = manager, connection
                self._connection_headers, self._connection_query = (
                    copy.deepcopy(plan.extra_headers), copy.deepcopy(plan.extra_query))
                if read_timeout is not None:
                    websocket = getattr(connection, "_connection", None)
                    recv = getattr(websocket, "recv", None)
                    parse_event = getattr(connection, "parse_event", None)
                    if not callable(recv) or not callable(parse_event):
                        self.disabled = True
                        self.continuation.clear()
                        self._close_connection_locked()
                        raise CodexWebSocketUnavailable(
                            "the WebSocket SDK cannot enforce the configured read timeout")
            else:
                _connect_timeout, read_timeout, write_timeout = _request_timeouts(self.client, plan)
            connection = self._connection
            try:
                self._send_with_timeout(connection, plan.payload, write_timeout)
            except Exception as exc:
                self.disabled = True
                self.continuation.clear()
                self._close_connection_locked()
                raise CodexWebSocketSendError(
                    "Codex Responses WebSocket send failed; refusing an HTTP retry because delivery is ambiguous") from exc
            stream = _WebSocketResponseStream(self, connection, plan, read_timeout)
            self._active_stream = stream
            self._retire_when_idle = False
            return stream

    def commit(self, plan: ContinuationPlan, response: Any) -> None:
        with self._lock:
            if self.disabled or self._connection is None:
                self.continuation.clear()
                return
            self.continuation.commit(plan, response)

    def _stream_terminal(self, stream: _WebSocketResponseStream) -> None:
        with self._lock:
            if self._active_stream is stream:
                self._active_stream = None
                if self._retire_when_idle:
                    self._close_connection_locked()

    def _stream_failed(self, stream: _WebSocketResponseStream) -> None:
        with self._lock:
            stream._receiving_thread_id = None
            if self._active_stream is stream or self._connection is stream.connection:
                self.continuation.clear()
                self.disabled = True
                self._active_stream = None
                self._close_connection_locked()

    def _abort_stream(self, stream: _WebSocketResponseStream) -> None:
        with self._lock:
            if self._active_stream is not stream:
                return
            self.continuation.clear()
            self.disabled = True
            stream.closed = True
            connection = self._connection
            receiving_thread_id = stream._receiving_thread_id
            if receiving_thread_id is None or receiving_thread_id == threading.get_ident():
                self._active_stream = None
                self._close_connection_locked()
                return
            self._retire_when_idle = True
        self._shutdown_socket(connection)

    @staticmethod
    def _shutdown_socket(connection: Any) -> None:
        """Wake a blocked recv without releasing its descriptor from the caller thread."""
        ws_connection = getattr(connection, "_connection", None)
        raw_socket = getattr(ws_connection, "socket", None)
        shutdown = getattr(raw_socket, "shutdown", None)
        if callable(shutdown):
            try:
                shutdown(socket.SHUT_RDWR)
            except OSError:
                pass

    def _send_with_timeout(self, connection: Any, payload: dict[str, Any], timeout: float | None) -> None:
        if timeout is None:
            connection.send(payload)
            return
        timed_out = threading.Event()
        timer = threading.Timer(timeout, lambda: (timed_out.set(), self._shutdown_socket(connection)))
        timer.daemon = True
        try:
            timer.start()
            connection.send(payload)
        finally:
            timer.cancel()
            if timer.ident is not None:
                timer.join()
        if timed_out.is_set():
            raise TimeoutError("Codex Responses WebSocket send exceeded the configured write timeout")

    def close(self) -> None:
        with self._lock:
            self.disabled = True
            self.continuation.clear()
            if self._active_stream is not None:
                self._retire_when_idle = True
                self._abort_stream(self._active_stream)
            else:
                self._close_connection_locked()

    def _close_connection_locked(self) -> None:
        manager, self._manager = self._manager, None
        connection, self._connection = self._connection, None
        self._active_stream = None
        self._retire_when_idle = False
        self._connection_headers = None
        self._connection_query = None
        if manager is not None:
            self._shutdown_socket(connection)
            try:
                manager.__exit__(None, None, None)
            except Exception:
                logger.debug("Codex Responses WebSocket close failed", exc_info=True)


def get_agent_session(agent: Any, client: Any) -> CodexResponsesWebSocketSession:
    session = getattr(agent, "_codex_responses_websocket_session", None)
    if session is not None and session.client is client:
        return session
    if session is not None:
        session.close()
    session = CodexResponsesWebSocketSession(client)
    agent._codex_responses_websocket_session = session
    return session


def close_agent_session(agent: Any) -> None:
    session = getattr(agent, "_codex_responses_websocket_session", None)
    if session is not None:
        session.close()
        agent._codex_responses_websocket_session = None


def abort_agent_session_for_client(agent: Any, client: Any) -> None:
    session = getattr(agent, "_codex_responses_websocket_session", None)
    if session is not None and session.client is client:
        session.close()


__all__ = [
    "CodexResponsesContinuation",
    "CodexResponsesWebSocketSession",
    "CodexWebSocketConnectError",
    "CodexWebSocketSendError",
    "CodexWebSocketUnavailable",
    "ContinuationPlan",
    "abort_agent_session_for_client",
    "close_agent_session",
    "get_agent_session",
]
