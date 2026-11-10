"""Behavioral contracts for volatile Codex Responses WebSocket continuation."""

from types import SimpleNamespace
import threading
from unittest.mock import patch

import httpx
import pytest

from agent.codex_responses_websocket import (
    CodexResponsesContinuation,
    CodexResponsesWebSocketSession,
    CodexWebSocketConnectError,
    CodexWebSocketSendError,
    CodexWebSocketUnavailable,
)
from agent.codex_runtime import _is_official_codex_websocket_route, run_codex_stream


@pytest.mark.parametrize(("value", "expected"), [(None, False), (True, True), ("false", False)])
def test_agent_config_gates_websocket_transport(value, expected):
    from run_agent import AIAgent

    config = {"agent": {}}
    if value is not None:
        config["agent"]["codex_responses_websocket"] = value
    with patch("agent.process_bootstrap.OpenAI"), \
            patch("hermes_cli.config.load_config", return_value=config), \
            patch("hermes_cli.config.load_config_readonly", return_value=config):
        agent = AIAgent(
            api_key="test-key", base_url="https://chatgpt.com/backend-api/codex",
            provider="openai-codex", api_mode="codex_responses", model="gpt-6-luna",
            quiet_mode=True, skip_context_files=True, skip_memory=True,
        )
    try:
        assert agent._codex_responses_websocket_enabled is expected
    finally:
        agent.close()


@pytest.mark.parametrize(("provider", "base_url", "backend", "expected"), [
    ("openai-codex", "https://chatgpt.com/backend-api/codex", True, True),
    ("openai-codex", "https://chatgpt.com:443/backend-api/codex/", True, True),
    ("openai", "https://chatgpt.com/backend-api/codex", True, False),
    ("openai-codex", "http://chatgpt.com/backend-api/codex", True, False),
    ("openai-codex", "https://chatgpt.com:444/backend-api/codex", True, False),
    ("openai-codex", "https://chatgpt.com/backend-api/codex-proxy", True, False),
    ("openai-codex", "https://relay.example/backend-api/codex", True, False),
    ("openai-codex", "https://chatgpt.com/backend-api/codex", False, False),
])
def test_websocket_transport_requires_official_codex_oauth_route(provider, base_url, backend, expected):
    agent = SimpleNamespace(provider=provider, _is_codex_backend=lambda: backend)
    client = SimpleNamespace(base_url=base_url)

    assert _is_official_codex_websocket_route(agent, client) is expected


def _completed(response_id="resp-1", output=None):
    return SimpleNamespace(id=response_id, status="completed", output=output or [])


def _user(text="hello"):
    return {"type": "message", "role": "user", "content": [{"type": "input_text", "text": text}]}


def _tool_call(call_id="call-1", *, item_id="fc-item-1", status="completed", arguments='{"command":"true"}'):
    return {
        "type": "function_call", "id": item_id, "status": status,
        "call_id": call_id, "name": "terminal", "arguments": arguments,
    }


def test_first_websocket_request_sends_full_input_and_forces_store_false():
    state = CodexResponsesContinuation()

    plan = state.plan({"model": "gpt-6-luna", "input": [_user()], "store": True, "stream": True})

    assert plan is not None
    assert plan.incremental is False
    assert plan.payload["type"] == "response.create"
    assert plan.payload["store"] is False
    assert plan.payload["input"] == [_user()]
    assert "stream" not in plan.payload
    assert "previous_response_id" not in plan.payload


def test_plan_preserves_transport_options_outside_the_response_create_body():
    state = CodexResponsesContinuation()

    plan = state.plan({
        "model": "gpt-6-luna", "input": [_user()], "timeout": 17.0,
        "extra_headers": {"session_id": "session-1", "x-client-request-id": "cache-key"},
        "extra_query": {"tenant": "example"},
    })

    assert plan is not None
    assert plan.timeout == 17.0 and plan.timeout_was_set is True
    assert plan.extra_headers == {"session_id": "session-1", "x-client-request-id": "cache-key"}
    assert plan.extra_query == {"tenant": "example"}
    assert not ({"timeout", "extra_headers", "extra_query"} & plan.payload.keys())


def test_extra_body_overrides_typed_fields_without_becoming_transport_options():
    plan = CodexResponsesContinuation().plan({
        "model": "gpt-6-luna", "input": [_user("typed")], "timeout": 17.0,
        "extra_headers": {"session_id": "session-1"},
        "extra_body": {
            "model": "gpt-6-astra", "input": [_user("extra")], "timeout": "body-timeout",
        },
    })

    assert plan is not None
    assert plan.payload["model"] == "gpt-6-astra"
    assert plan.payload["input"] == [_user("extra")]
    assert plan.payload["timeout"] == "body-timeout"
    assert plan.timeout == 17.0 and plan.timeout_was_set is True
    assert plan.extra_headers == {"session_id": "session-1"}


def test_follow_up_sends_only_new_input_after_previous_input_and_response_output():
    state = CodexResponsesContinuation()
    first_input = [_user()]
    first = state.plan({"model": "gpt-6-luna", "input": first_input, "tools": [{"name": "terminal"}]})
    state.commit(first, _completed(output=[_tool_call()]))

    follow_up = state.plan({
        "model": "gpt-6-luna",
        "input": [first_input[0], _tool_call(item_id="replayed-fc-item"),
                  {"type": "function_call_output", "call_id": "call-1", "output": "done"}],
        "tools": [{"name": "terminal"}],
    })

    assert follow_up.incremental is True
    assert follow_up.payload["previous_response_id"] == "resp-1"
    assert follow_up.payload["input"] == [
        {"type": "function_call_output", "call_id": "call-1", "output": "done"}
    ]
    assert follow_up.full_input_bytes > follow_up.sent_input_bytes


def test_follow_up_matches_reasoning_when_only_empty_content_is_omitted_on_replay():
    state = CodexResponsesContinuation()
    first_input = [_user()]
    reasoning = {
        "type": "reasoning", "content": [], "encrypted_content": "opaque",
        "summary": [],
    }
    first = state.plan({"model": "gpt-6-luna", "input": first_input})
    state.commit(first, _completed(output=[reasoning, _tool_call()]))

    follow_up = state.plan({
        "model": "gpt-6-luna",
        "input": [first_input[0], {key: value for key, value in reasoning.items() if key != "content"},
                  _tool_call(item_id="replayed-fc-item"),
                  {"type": "function_call_output", "call_id": "call-1", "output": "done"}],
    })

    assert follow_up.incremental is True
    assert follow_up.payload["input"] == [
        {"type": "function_call_output", "call_id": "call-1", "output": "done"}
    ]


@pytest.mark.parametrize("reference_type", ["item_reference", None])
def test_item_reference_id_must_match_before_using_incremental_continuation(reference_type):
    state = CodexResponsesContinuation()
    first_reference = {"id": "item-original"}
    replayed_reference = {"id": "item-replaced"}
    if reference_type is not None:
        first_reference["type"] = replayed_reference["type"] = reference_type
    first_input = [_user(), first_reference]
    first = state.plan({"model": "gpt-6-luna", "input": first_input})
    state.commit(first, _completed(output=[]))

    replay = [_user(), replayed_reference]
    follow_up = state.plan({"model": "gpt-6-luna", "input": replay})

    assert follow_up.incremental is False
    assert follow_up.payload["input"] == replay
    assert "previous_response_id" not in follow_up.payload


def test_changed_referenced_target_id_forces_full_input_replay():
    state = CodexResponsesContinuation()
    target = {"type": "message", "id": "item-target", "role": "assistant", "content": []}
    first_input = [_user(), target]
    first = state.plan({"model": "gpt-6-luna", "input": first_input})
    state.commit(first, _completed(output=[]))

    replay = [*first_input, {"type": "item_reference", "id": "item-target"}]
    follow_up = state.plan({"model": "gpt-6-luna", "input": replay})

    assert follow_up.incremental is False
    assert follow_up.payload["input"] == replay
    assert "previous_response_id" not in follow_up.payload


@pytest.mark.parametrize("operation", ["loads", "dumps"])
def test_json_recursion_error_falls_back_to_exact_text_comparison(operation, monkeypatch):
    import agent.codex_responses_websocket as websocket_module

    def raise_recursion_error(*_args, **_kwargs):
        raise RecursionError("JSON nesting exceeds the safe comparison limit")

    monkeypatch.setattr(websocket_module.json, operation, raise_recursion_error)

    assert websocket_module._canonical_json_object('{"command":"true"}') is None


def test_nonempty_reasoning_content_remains_part_of_replay_comparison():
    from agent.codex_responses_websocket import _comparison_item

    prior = {"type": "reasoning", "content": [{"type": "summary_text", "text": "keep"}]}
    replayed = {"type": "reasoning", "content": [{"type": "summary_text", "text": "changed"}]}

    assert _comparison_item(prior) != _comparison_item(replayed)


def test_function_arguments_match_after_json_whitespace_and_key_order_normalization():
    state = CodexResponsesContinuation()
    first_input = [_user()]
    first = state.plan({"model": "gpt-6-luna", "input": first_input})
    state.commit(first, _completed(output=[_tool_call(arguments='{"command":"printf ok","timeout":5}')]))

    follow_up = state.plan({
        "model": "gpt-6-luna",
        "input": [first_input[0], _tool_call(
            item_id="fc-replayed", arguments=' { "timeout" : 5, "command" : "printf ok" } ',
        ), {"type": "function_call_output", "call_id": "call-1", "output": "ok"}],
    })

    assert follow_up.incremental is True
    assert follow_up.payload["input"] == [
        {"type": "function_call_output", "call_id": "call-1", "output": "ok"}
    ]


def test_function_arguments_with_different_json_values_do_not_match():
    state = CodexResponsesContinuation()
    first = state.plan({"model": "gpt-6-luna", "input": [_user()]})
    state.commit(first, _completed(output=[_tool_call()]))

    follow_up = state.plan({
        "model": "gpt-6-luna",
        "input": [_user(), _tool_call(arguments='{"command":"false"}')],
    })

    assert follow_up.incremental is False
    assert follow_up.payload["input"][1]["arguments"] == '{"command":"false"}'


@pytest.mark.parametrize(("prior_arguments", "replayed_arguments"), [
    ('{"n":1.0000000000000000}', '{"n":1.0000000000000001}'),
    ('{"n":1e400}', '{"n":1e401}'),
    ('{"n":-0}', '{"n":0}'),
])
def test_distinct_float_argument_tokens_never_match_by_rounded_value(prior_arguments, replayed_arguments):
    state = CodexResponsesContinuation()
    first = state.plan({"model": "gpt-6-luna", "input": [_user()]})
    state.commit(first, _completed(output=[_tool_call(arguments=prior_arguments)]))

    follow_up = state.plan({
        "model": "gpt-6-luna", "input": [_user(), _tool_call(arguments=replayed_arguments)],
    })

    assert follow_up.incremental is False


@pytest.mark.parametrize("arguments", [
    '{"command":"true","command":"false"}',
    '{"command":NaN}',
    '["not an object"]',
    '{"n":1.0000000000000000}',
    '{"n":1.0000000000000001}',
    '{"n":1e400}',
    '{"n":1e401}',
    '{"n":-0}',
])
def test_noncanonicalizable_arguments_remain_exact(arguments):
    from agent.codex_responses_websocket import _comparison_item

    item = _tool_call(arguments=arguments)

    assert _comparison_item(item)["arguments"] == arguments


@pytest.mark.parametrize(
    "request_kwargs",
    [
        {"model": "gpt-6-luna", "input": [_user("edited")]},
        {"model": "gpt-6-luna", "input": [_user(), {"type": "message", "role": "assistant", "content": "branch"}]},
        {"model": "gpt-6-luna", "input": [_user()], "instructions": "changed"},
    ],
)
def test_history_or_request_change_falls_back_to_full_input(request_kwargs):
    state = CodexResponsesContinuation()
    first = state.plan({"model": "gpt-6-luna", "input": [_user()], "instructions": "same"})
    state.commit(first, _completed(output=[_tool_call()]))

    plan = state.plan(request_kwargs)

    assert plan.incremental is False
    assert plan.payload["input"] == request_kwargs["input"]
    assert "previous_response_id" not in plan.payload


def test_failed_or_incomplete_response_clears_continuation_state():
    state = CodexResponsesContinuation()
    plan = state.plan({"model": "gpt-6-luna", "input": [_user()]})

    state.commit(plan, SimpleNamespace(id="resp-failed", status="incomplete", output=[]))

    next_plan = state.plan({"model": "gpt-6-luna", "input": [_user(), _tool_call()]})
    assert next_plan.incremental is False
    assert "previous_response_id" not in next_plan.payload


class _FakeConnection:
    def __init__(self, events):
        self.events = iter(events)
        self.sent = []
        self.closed = False
        self.recv_timeouts = []
        self._connection = SimpleNamespace(
            socket=SimpleNamespace(shutdown=lambda _how: None), recv=self._recv_raw,
        )

    def send(self, payload):
        self.sent.append(payload)

    def recv(self):
        event = next(self.events)
        if isinstance(event, BaseException):
            raise event
        return event

    def _recv_raw(self, *, timeout=None, decode=None):
        self.recv_timeouts.append(timeout)
        import json
        return json.dumps(self.recv())

    @staticmethod
    def parse_event(data):
        import json
        return json.loads(data)


class _FakeManager:
    def __init__(self, connection, *, error=None):
        self.connection, self.error = connection, error
        self.closed = False
        self.close_thread_id = None

    def __enter__(self):
        if self.error:
            raise self.error
        return self.connection

    def __exit__(self, *_args):
        self.closed = True
        self.close_thread_id = threading.get_ident()
        if self.connection is not None:
            self.connection.closed = True


class _FakeResponses:
    def __init__(self, manager):
        self.manager = manager
        self.connect_calls = []

    def connect(self, **kwargs):
        self.connect_calls.append(kwargs)
        return self.manager


def test_response_terminal_keeps_socket_open_for_the_next_request():
    connection = _FakeConnection([
        {"type": "response.completed", "response": {"id": "resp-1"}},
        {"type": "response.completed", "response": {"id": "resp-2"}},
    ])
    manager = _FakeManager(connection)
    client = SimpleNamespace(responses=_FakeResponses(manager), timeout=None)
    session = CodexResponsesWebSocketSession(client)

    first_stream = session.open_response({"model": "gpt-6-luna", "input": [_user()]})
    assert next(first_stream)["type"] == "response.completed"
    with pytest.raises(StopIteration):
        next(first_stream)
    first_plan = first_stream.plan
    session.commit(first_plan, _completed(output=[_tool_call()]))
    first_stream.close()

    second_stream = session.open_response({
        "model": "gpt-6-luna", "input": [_user(), _tool_call(),
                                             {"type": "function_call_output", "call_id": "call-1", "output": "done"}],
    })

    assert len(client.responses.connect_calls) == 1
    assert client.responses.connect_calls[0] == {
        "max_retries": 0, "extra_headers": {}, "extra_query": {},
        "websocket_connection_options": {"open_timeout": None, "max_size": None},
    }
    assert connection.closed is False
    assert connection.sent[0]["store"] is False
    assert "stream" not in connection.sent[0]
    assert connection.sent[1]["previous_response_id"] == "resp-1"
    assert second_stream.plan.incremental is True
    assert next(second_stream)["type"] == "response.completed"
    second_stream.close()
    session.close()
    assert manager.closed is True


def test_close_after_nonterminal_event_retires_the_active_stream():
    connection = _FakeConnection([{"type": "response.output_text.delta", "delta": "partial"}])
    manager = _FakeManager(connection)
    session = CodexResponsesWebSocketSession(SimpleNamespace(responses=_FakeResponses(manager), timeout=None))
    stream = session.open_response({"model": "gpt-6-luna", "input": [_user()]})

    assert next(stream)["type"] == "response.output_text.delta"
    stream.close()

    assert session._active_stream is None
    assert session._connection is None
    assert session.disabled is True
    assert manager.closed is True
    with pytest.raises(CodexWebSocketUnavailable, match="disabled for this agent"):
        session.open_response({"model": "gpt-6-luna", "input": [_user()]})


def test_abort_during_receive_closes_connection_on_receiving_thread():
    entered_receive = threading.Event()
    release_receive = threading.Event()
    receive_thread_ids = []
    connection = _FakeConnection([])

    def blocked_receive():
        receive_thread_ids.append(threading.get_ident())
        entered_receive.set()
        assert release_receive.wait(timeout=1)
        raise ConnectionError("socket closed")

    connection.recv = blocked_receive
    connection._connection.socket.shutdown = lambda _how: release_receive.set()
    manager = _FakeManager(connection)
    session = CodexResponsesWebSocketSession(SimpleNamespace(responses=_FakeResponses(manager), timeout=None))
    stream = session.open_response({"model": "gpt-6-luna", "input": [_user()]})
    receive_errors = []

    def receive_one_event():
        try:
            next(stream)
        except BaseException as exc:
            receive_errors.append(exc)

    receiver = threading.Thread(target=receive_one_event)
    receiver.start()
    assert entered_receive.wait(timeout=1)
    stream.close()
    receiver.join(timeout=1)

    assert not receiver.is_alive()
    assert len(receive_errors) == 1 and isinstance(receive_errors[0], ConnectionError)
    assert manager.closed is True
    assert manager.close_thread_id == receive_thread_ids[0]
    assert session._active_stream is None
    assert session._connection is None


def test_session_close_during_terminal_receive_cannot_leave_socket_open():
    entered_receive = threading.Event()
    release_receive = threading.Event()
    receive_thread_ids = []
    connection = _FakeConnection([])

    def terminal_receive():
        receive_thread_ids.append(threading.get_ident())
        entered_receive.set()
        assert release_receive.wait(timeout=1)
        return {"type": "response.completed"}

    connection.recv = terminal_receive
    connection._connection.socket.shutdown = lambda _how: release_receive.set()
    manager = _FakeManager(connection)
    session = CodexResponsesWebSocketSession(SimpleNamespace(responses=_FakeResponses(manager), timeout=None))
    stream = session.open_response({"model": "gpt-6-luna", "input": [_user()]})
    receive_results = []

    def receive_one_event():
        try:
            receive_results.append(next(stream))
        except StopIteration:
            receive_results.append(None)

    receiver = threading.Thread(target=receive_one_event)
    receiver.start()
    assert entered_receive.wait(timeout=1)
    session.close()
    receiver.join(timeout=1)

    assert not receiver.is_alive()
    assert receive_results == [None]
    assert session.disabled is True
    assert session._active_stream is None
    assert session._connection is None
    assert manager.closed is True
    assert manager.close_thread_id == receive_thread_ids[0]


def test_receive_failure_cleanup_is_atomic_with_concurrent_close():
    failure_cleanup_started = threading.Event()
    release_failure_cleanup = threading.Event()
    receive_thread_ids = []
    connection = _FakeConnection([ConnectionError("socket closed")])
    manager = _FakeManager(connection)
    session = CodexResponsesWebSocketSession(SimpleNamespace(responses=_FakeResponses(manager), timeout=None))
    stream = session.open_response({"model": "gpt-6-luna", "input": [_user()]})
    stream_session_failure = session._stream_failed

    def paused_failure_cleanup(failed_stream):
        failure_cleanup_started.set()
        assert release_failure_cleanup.wait(timeout=1)
        stream_session_failure(failed_stream)

    session._stream_failed = paused_failure_cleanup
    receive_errors = []

    def receive_one_event():
        receive_thread_ids.append(threading.get_ident())
        try:
            next(stream)
        except BaseException as exc:
            receive_errors.append(exc)

    receiver = threading.Thread(target=receive_one_event)
    receiver.start()
    assert failure_cleanup_started.wait(timeout=1)
    session.close()
    release_failure_cleanup.set()
    receiver.join(timeout=1)

    assert not receiver.is_alive()
    assert len(receive_errors) == 1 and isinstance(receive_errors[0], ConnectionError)
    assert manager.closed is True
    assert manager.close_thread_id == receive_thread_ids[0]
    assert session._active_stream is None
    assert session._connection is None


def test_websocket_handshake_keeps_client_headers_query_and_timeouts():
    connection = _FakeConnection([{"type": "response.completed"}])
    manager = _FakeManager(connection)
    client = SimpleNamespace(
        responses=_FakeResponses(manager),
        _custom_headers={"User-Agent": "Hermes", "originator": "hermes-agent"},
        _custom_query={"tenant": "default"},
        timeout=SimpleNamespace(connect=1.5, read=3.0),
    )
    session = CodexResponsesWebSocketSession(client)

    stream = session.open_response({
        "model": "gpt-6-luna", "input": [_user()],
        "extra_headers": {"session_id": "session-1", "x-client-request-id": "cache-key"},
        "extra_query": {"tenant": "request"},
    })

    assert client.responses.connect_calls == [{
        "max_retries": 0,
        "extra_headers": {
            "User-Agent": "Hermes", "originator": "hermes-agent",
            "session_id": "session-1", "x-client-request-id": "cache-key",
        },
        "extra_query": {"tenant": "request"},
        "websocket_connection_options": {"open_timeout": 1.5, "max_size": None},
    }]
    assert stream.read_timeout == 3.0
    assert next(stream)["type"] == "response.completed"
    session.close()
    assert connection.recv_timeouts == [3.0]


def test_changed_connection_headers_disable_websocket_before_sending_follow_up():
    connection = _FakeConnection([{"type": "response.completed"}])
    manager = _FakeManager(connection)
    client = SimpleNamespace(responses=_FakeResponses(manager), timeout=None)
    session = CodexResponsesWebSocketSession(client)
    first = session.open_response({
        "model": "gpt-6-luna", "input": [_user()], "extra_headers": {"session_id": "one"},
    })
    assert next(first)["type"] == "response.completed"
    session.commit(first.plan, _completed(output=[_tool_call()]))
    sent_count = len(connection.sent)

    with pytest.raises(CodexWebSocketUnavailable, match="request headers or query changed"):
        session.open_response({
            "model": "gpt-6-luna", "input": [_user(), _tool_call(),
                {"type": "function_call_output", "call_id": "call-1", "output": "done"}],
            "extra_headers": {"session_id": "two"},
        })

    assert session.disabled is True
    assert connection.closed is True
    assert len(connection.sent) == sent_count
    assert session.continuation.response_id is None


def test_unsupported_timed_receive_disables_session_after_one_handshake():
    connection = _FakeConnection([])
    connection.parse_event = None
    manager = _FakeManager(connection)
    responses = _FakeResponses(manager)
    session = CodexResponsesWebSocketSession(SimpleNamespace(
        responses=responses, timeout=SimpleNamespace(connect=1.0, read=2.0, write=1.0),
    ))

    with pytest.raises(CodexWebSocketUnavailable, match="cannot enforce the configured read timeout"):
        session.open_response({"model": "gpt-6-luna", "input": [_user()]})
    with pytest.raises(CodexWebSocketUnavailable, match="disabled for this agent"):
        session.open_response({"model": "gpt-6-luna", "input": [_user()]})

    assert session.disabled is True
    assert len(responses.connect_calls) == 1
    assert manager.closed is True


def test_ambiguous_websocket_send_failure_is_not_retried_over_http(monkeypatch):
    """A failed send may have reached the server; never repeat it as HTTP inference."""
    from tests.agent.test_run_agent_codex_responses import _build_agent

    agent = _build_agent(monkeypatch)
    agent._codex_responses_websocket_enabled = True
    connection = _FakeConnection([])
    send_attempts = []

    def fail_send(payload):
        send_attempts.append(payload)
        raise httpx.ReadError("send outcome is ambiguous")

    connection.send = fail_send
    manager = _FakeManager(connection)
    responses = _FakeResponses(manager)
    http_requests = []
    responses.create = lambda **kwargs: http_requests.append(kwargs)
    client = SimpleNamespace(
        responses=responses, timeout=None, base_url="https://chatgpt.com/backend-api/codex",
    )

    try:
        with pytest.raises(CodexWebSocketSendError, match="delivery is ambiguous"):
            run_codex_stream(agent, {"model": "gpt-6-luna", "input": [_user()]}, client=client)

        assert len(send_attempts) == 1
        assert http_requests == []
        assert manager.closed is True
    finally:
        agent.close()


def test_close_after_terminal_prevents_late_commit_from_reusing_closed_connection():
    connection = _FakeConnection([{"type": "response.completed"}])
    manager = _FakeManager(connection)
    session = CodexResponsesWebSocketSession(SimpleNamespace(responses=_FakeResponses(manager), timeout=None))
    stream = session.open_response({"model": "gpt-6-luna", "input": [_user()]})
    assert next(stream)["type"] == "response.completed"

    session.close()
    session.commit(stream.plan, _completed())

    assert session.disabled is True
    assert session.continuation.response_id is None
    with pytest.raises(CodexWebSocketUnavailable):
        session.open_response({"model": "gpt-6-luna", "input": [_user()]})


def test_ambiguous_send_failure_is_not_mistaken_for_handshake_fallback():
    connection = _FakeConnection([])
    connection.send = lambda _payload: (_ for _ in ()).throw(ConnectionError("send failed"))
    manager = _FakeManager(connection)
    session = CodexResponsesWebSocketSession(SimpleNamespace(responses=_FakeResponses(manager), timeout=None))

    with pytest.raises(CodexWebSocketSendError, match="delivery is ambiguous"):
        session.open_response({"model": "gpt-6-luna", "input": [_user()]})

    assert session.disabled is True
    assert manager.closed is True


@pytest.mark.parametrize("receive_error", [
    httpx.ReadTimeout("receive timed out"),
    httpx.ReadError("connection reset"),
])
def test_receive_failure_after_websocket_send_is_not_retried_over_http(monkeypatch, receive_error):
    """Once response.create is sent, a failed receive must not duplicate inference via retry/fallback."""
    from tests.agent.test_run_agent_codex_responses import _build_agent

    agent = _build_agent(monkeypatch)
    agent._codex_responses_websocket_enabled = True
    connection = _FakeConnection([receive_error])
    manager = _FakeManager(connection)
    responses = _FakeResponses(manager)
    http_requests = []

    def _http_create(**kwargs):
        http_requests.append(kwargs)
        raise AssertionError("an already-sent WebSocket request must not fall back to HTTP")

    responses.create = _http_create
    client = SimpleNamespace(
        responses=responses, timeout=None, base_url="https://chatgpt.com/backend-api/codex",
    )

    try:
        with pytest.raises(type(receive_error)):
            run_codex_stream(agent, {"model": "gpt-6-luna", "input": [_user()]}, client=client)

        assert len(connection.sent) == 1
        assert http_requests == []
        assert manager.closed is True
    finally:
        agent.close()


def test_failed_handshake_disables_session_before_any_request_is_sent():
    manager = _FakeManager(None, error=OSError("handshake failed"))
    session = CodexResponsesWebSocketSession(SimpleNamespace(responses=_FakeResponses(manager)))

    with pytest.raises(CodexWebSocketConnectError):
        session.open_response({"model": "gpt-6-luna", "input": [_user()]})

    assert session.disabled is True
    assert manager.closed is False
    assert session.continuation.response_id is None


def test_synchronous_connect_setup_error_is_a_safe_connection_failure():
    responses = _FakeResponses(_FakeManager(None))

    def fail_connect(**_kwargs):
        raise RuntimeError("unsupported WebSocket option")

    responses.connect = fail_connect
    session = CodexResponsesWebSocketSession(SimpleNamespace(responses=responses))

    with pytest.raises(CodexWebSocketConnectError, match="client setup failed") as raised:
        session.open_response({"model": "gpt-6-luna", "input": [_user()]})

    assert isinstance(raised.value.__cause__, RuntimeError)
    assert session.disabled is True
    assert session.continuation.response_id is None


def test_synchronous_connect_setup_error_falls_back_to_http_once(monkeypatch):
    from tests.agent.test_run_agent_codex_responses import _build_agent

    agent = _build_agent(monkeypatch)
    agent._codex_responses_websocket_enabled = True
    item = SimpleNamespace(
        type="message", status="completed", content=[SimpleNamespace(type="output_text", text="HTTP fallback")],
    )
    usage = SimpleNamespace(input_tokens=5, output_tokens=2, total_tokens=7)
    connect_attempts = []
    http_requests = []

    def fail_connect(**_kwargs):
        connect_attempts.append(1)
        raise RuntimeError("unsupported WebSocket option")

    def http_create(**kwargs):
        http_requests.append(kwargs)
        return [
            SimpleNamespace(type="response.created"),
            SimpleNamespace(type="response.output_item.done", item=item),
            SimpleNamespace(
                type="response.completed",
                response=SimpleNamespace(status="completed", usage=usage, id="resp_http_fallback"),
            ),
        ]

    client = SimpleNamespace(
        responses=SimpleNamespace(connect=fail_connect, create=http_create),
        timeout=None,
        base_url="https://chatgpt.com/backend-api/codex",
    )

    try:
        response = run_codex_stream(agent, {"model": "gpt-6-luna", "input": [_user()]}, client=client)

        assert connect_attempts == [1]
        assert len(http_requests) == 1
        assert http_requests[0]["stream"] is True
        assert response.status == "completed"
        assert response.id == "resp_http_fallback"
        assert response.output == [item]
    finally:
        agent.close()


def test_stream_error_discards_connection_and_volatile_response_state():
    connection = _FakeConnection([OSError("socket failed")])
    manager = _FakeManager(connection)
    session = CodexResponsesWebSocketSession(SimpleNamespace(responses=_FakeResponses(manager)))
    stream = session.open_response({"model": "gpt-6-luna", "input": [_user()]})

    with pytest.raises(OSError, match="socket failed"):
        next(stream)

    assert session.disabled is True
    assert manager.closed is True
    assert session.continuation.response_id is None
