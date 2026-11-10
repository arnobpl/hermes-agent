"""delegate_task(background=true) on resumable and one-shot API-server requests.

Previously async_delivery_supported()=False forced SYNCHRONOUS execution for
every background dispatch on the API server, blocking the whole turn. An
eligible session-continuable request can dispatch async; its completion is persisted
to the transcript and reaches the model on a later client turn after delivery.
Requests without a resumable server-history consumer (including session-id-less
one-shot requests) keep the sync fallback.

The origin target must be captured from the request-scoped chat_id binding,
NOT from HERMES_SESSION_ID: constructing a child agent calls
set_current_session_id(child.session_id), clobbering the HERMES_SESSION_ID
ContextVar and os.environ with the subagent's internal id before the
dispatch code reads it — the fake child build below reproduces that clobber.
"""

import json
import time
from unittest.mock import MagicMock

import pytest

from gateway.session_context import set_session_vars
from tools.process_registry import process_registry


@pytest.fixture(autouse=True)
def _clean_queue_and_context(monkeypatch):
    monkeypatch.delenv("HERMES_SESSION_ID", raising=False)
    while not process_registry.completion_queue.empty():
        try:
            process_registry.completion_queue.get_nowait()
        except Exception:
            break
    yield
    # Restore ContextVars to the pristine "never set" sentinel rather than
    # clear_session_vars()'s explicit-"" state, which would mask env vars for
    # unrelated tests running later in the same worker.
    import gateway.session_context as sc

    for var in sc._VAR_MAP.values():
        var.set(sc._UNSET)
    sc._SESSION_ASYNC_DELIVERY.set(sc._UNSET)
    sc._SESSION_HISTORY_DELIVERY.set(sc._UNSET)
    # set_current_session_id (invoked by the clobber-reproducing fake child
    # build) writes os.environ directly — scrub it so it can't leak into
    # other test modules.
    import os

    os.environ.pop("HERMES_SESSION_ID", None)
    while not process_registry.completion_queue.empty():
        try:
            process_registry.completion_queue.get_nowait()
        except Exception:
            break


def _drain_one(timeout=5.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if not process_registry.completion_queue.empty():
            return process_registry.completion_queue.get_nowait()
        time.sleep(0.02)
    return None


def _fake_parent():
    parent = MagicMock()
    parent._delegate_depth = 0
    parent.session_id = "sess"
    parent._interrupt_requested = False
    parent._active_children = []
    parent._active_children_lock = None
    return parent


def _patch_delegate(monkeypatch):
    import tools.delegate_tool as dt

    fake_child = MagicMock()
    fake_child._delegate_role = "leaf"
    fake_child._subagent_id = "s1"

    def fast_child(task_index, goal, child=None, parent_agent=None, **kw):
        return {
            "task_index": 0, "status": "completed", "summary": f"done: {goal}",
            "api_calls": 1, "duration_seconds": 0.1, "model": "m",
            "exit_reason": "completed",
        }

    creds = {
        "model": "m", "provider": None, "base_url": None, "api_key": None,
        "api_mode": None, "command": None, "args": None,
    }
    def clobbering_build_child(**kw):
        # Reproduce what the real _build_child_agent -> AIAgent -> agent_init
        # path does: it synchronizes the child's internal session id into the
        # HERMES_SESSION_ID ContextVar + os.environ, clobbering the spawner's
        # id ~milliseconds before delegate_tool dispatches the batch.
        from gateway.session_context import set_current_session_id

        set_current_session_id("20260715_child1")
        return fake_child

    monkeypatch.setattr(dt, "_build_child_agent", clobbering_build_child)
    monkeypatch.setattr(dt, "_run_single_child", fast_child)
    monkeypatch.setattr(dt, "_resolve_delegation_credentials", lambda *a, **k: creds)
    return dt


def test_apiserver_session_with_id_dispatches_background(monkeypatch):
    """async_delivery=False + a raw session id (HERMES_SESSION_ID) →
    background dispatch (the completion is persisted to that session's
    history), NOT the forced-sync fallback."""
    dt = _patch_delegate(monkeypatch)
    monkeypatch.setenv("HERMES_SESSION_ID", "raw-sid-7")
    set_session_vars(
        platform="api_server",
        chat_id="raw-sid-7",
        session_key="raw-sid-7",
        session_id="raw-sid-7",
        session_history_delivery="1",
        async_delivery=False,
    )

    out = dt.delegate_task(
        goal="bg on api_server", context="ctx",
        background=True, parent_agent=_fake_parent(),
    )
    parsed = json.loads(out)
    assert parsed["status"] == "dispatched", parsed
    assert parsed["mode"] == "background"
    assert "saved to this session's transcript" in parsed["note"]
    assert "a subsequent client turn after it is stored" in parsed["note"]
    assert "completion does not start a turn" in parsed["note"]
    assert "Do not promise an unprompted follow-up" in parsed["note"]
    assert "re-enters the conversation as a new message" not in parsed["note"]

    evt = _drain_one()
    assert evt is not None
    assert evt["type"] == "async_delegation"
    # The raw session id is stamped so the gateway can persist the result to
    # the REAL session (session_key alone is the raw id here, which
    # carries no parseable routing metadata). Crucially this is the SPAWNER's
    # id, not the subagent-internal id the child build clobbered
    # HERMES_SESSION_ID with (see clobbering_build_child).
    assert evt["origin_session_id"] == "raw-sid-7"


def test_many_persist_only_dispatch_note_counts_subagents_and_units():
    from types import SimpleNamespace

    from tools.delegate_tool_dispatch import _dispatched_payload

    batch = SimpleNamespace(
        task_list=[{"goal": "g1"}, {"goal": "g2"}, {"goal": "g3"}],
        children=[(i, {}, SimpleNamespace()) for i in range(3)],
        live_deleg_id="live-many",
        refused=[],
        live_paths=[],
    )
    note = _dispatched_payload(batch, [(batch, "unit-1")], persist_only=True)["note"]

    assert "3 subagents" in note
    assert "1 completion unit(s)" in note
    assert "can be used by the assistant on a later client turn" in note
    assert "Completions do not start turns" in note


def test_push_delivery_note_keeps_new_message_promise():
    from types import SimpleNamespace

    from tools.delegate_tool_dispatch import _dispatched_payload

    batch = SimpleNamespace(
        task_list=[{"goal": "g1"}],
        children=[(0, {}, SimpleNamespace())],
        live_deleg_id="live-push",
        refused=[],
        live_paths=[],
    )
    note = _dispatched_payload(batch, [(batch, "unit-1")])["note"]

    assert "re-enters the conversation as a new message" in note
    assert "Hermes saves it as a note for the next turn instead of starting a turn" in note
    assert "NEXT message" not in note


def test_static_description_qualifies_stateless_api_delivery():
    from tools.delegate_tool import _build_top_level_description

    description = _build_top_level_description()

    assert "On wake-capable sessions" in description
    assert "Persist-only API sessions" in description
    assert "when the request declares resumable server-history continuation" in description
    assert "later eligible turn after delivery" in description
    assert "no automatic follow-up starts" in description
    assert "the call runs synchronously with an explanatory note" in description
    assert "Later capacity or scheduling failures run inline and appear under" in description
    assert "appear under `not_dispatched`" in description
    assert "If a CLI/TUI completion reaches the head of the queue while no viewer" in description
    assert "Push-delivered background results arrive only BETWEEN your turns" in description


def test_partial_dispatch_counts_only_background_children():
    from types import SimpleNamespace

    from tools.delegate_tool_dispatch import _dispatched_payload

    children = [
        (i, {"goal": f"g{i}"}, SimpleNamespace(_subagent_id=f"s{i}")) for i in range(3)
    ]
    batch = SimpleNamespace(
        task_list=[{"goal": f"g{i}"} for i in range(3)],
        children=children,
        live_deleg_id="live-partial",
        refused=[],
        live_paths=[],
    )
    accepted_unit = SimpleNamespace(children=[children[0]], group=None)
    payload = _dispatched_payload(batch, [(accepted_unit, "unit-1")], persist_only=True)

    assert payload["count"] == 1
    assert payload["subagent_ids"] == ["s0"]
    assert "Subagent is running in the background" in payload["note"]


# ---------------------------------------------------------------------------
# _current_origin_session_id — the clobber-proof origin capture helper
# ---------------------------------------------------------------------------


def test_apiserver_session_without_id_stays_synchronous(monkeypatch):
    """No session id to wake → keep the sync fallback (a detached result
    would never re-enter any conversation)."""
    dt = _patch_delegate(monkeypatch)
    set_session_vars(
        platform="api_server",
        chat_id="",
        session_key="",
        session_id="",
        async_delivery=False,
    )

    out = dt.delegate_task(
        goal="one-shot", context="ctx",
        background=True, parent_agent=_fake_parent(),
    )
    parsed = json.loads(out)
    assert parsed.get("status") != "dispatched", parsed
    assert "SYNCHRONOUSLY" in parsed.get("note", "")
    assert process_registry.completion_queue.empty()


def test_apiserver_session_without_declared_history_stays_synchronous(monkeypatch):
    """A session id alone does not declare a server-history consumer."""
    dt = _patch_delegate(monkeypatch)
    monkeypatch.setenv("HERMES_SESSION_ID", "raw-sid-8")
    set_session_vars(
        platform="api_server",
        chat_id="raw-sid-8",
        session_key="raw-sid-8",
        session_id="raw-sid-8",
        async_delivery=False,
    )

    out = dt.delegate_task(
        goal="no history consumer", context="ctx",
        background=True, parent_agent=_fake_parent(),
    )
    parsed = json.loads(out)
    assert parsed.get("status") != "dispatched", parsed
    assert "SYNCHRONOUSLY" in parsed.get("note", "")
    assert "without declared server-history delivery" in parsed.get("note", "")
    assert process_registry.completion_queue.empty()


@pytest.mark.parametrize(
    ("reason", "expected_status"),
    [("session_closed", "interrupted"), ("backend_retiring", "error")],
)
def test_non_capacity_dispatch_rejection_does_not_run_child(monkeypatch, reason, expected_status):
    dt = _patch_delegate(monkeypatch)
    built = []
    build_child = dt._build_child_agent

    def record_child(**kwargs):
        child = build_child(**kwargs)
        built.append(child)
        return child

    monkeypatch.setattr(dt, "_build_child_agent", record_child)
    ran = []
    monkeypatch.setattr(dt, "_run_single_child", lambda *args, **kwargs: ran.append(kwargs))

    from tools import async_delegation

    monkeypatch.setattr(async_delegation, "dispatch_async_delegation_batch", lambda **_kwargs: {
        "status": "rejected", "reason": reason, "error": "test dispatch rejection",
    })
    monkeypatch.setenv("HERMES_SESSION_ID", "raw-sid-9")
    set_session_vars(
        platform="api_server",
        chat_id="raw-sid-9",
        session_key="raw-sid-9",
        session_id="raw-sid-9",
        session_history_delivery="1",
        async_delivery=False,
    )
    parent = _fake_parent()

    parsed = json.loads(dt.delegate_task(
        goal="must not run after dispatch rejection", context="ctx",
        background=True, parent_agent=parent,
    ))

    assert parsed["error"]
    assert parsed["results"][0]["status"] == expected_status
    assert not ran
    built[0].close.assert_called_once()
    assert parent._active_children == []
    assert process_registry.completion_queue.empty()


def test_partial_non_capacity_rejection_is_not_run_inline(monkeypatch):
    from dataclasses import replace
    from types import SimpleNamespace

    import tools.delegate_tool_dispatch as dtd
    from tools.delegate_tool_dispatch import _Batch

    parent = _fake_parent()
    children = [
        (i, {"goal": f"g{i}"}, SimpleNamespace(_subagent_id=f"s{i}")) for i in range(2)
    ]
    batch = _Batch(
        task_list=[{"goal": "g0"}, {"goal": "g1"}], children=children, parent_agent=parent,
        creds={"model": "m"}, context=None, top_role="leaf", max_children=2,
        live_deleg_id="call-1", live_writers=[], live_paths=[], origin_wake_sid="",
        origin_ui_session_id="", origin_owner_transport=None, origin_owner_session_record=None,
        origin_session_history_delivery=False, overall_start=0.0,
    )
    units = [replace(batch, children=[children[0]]), replace(batch, children=[children[1]])]
    monkeypatch.setattr(dtd, "_resolve_async_wake_sid", lambda *_args, **_kwargs: "")
    monkeypatch.setattr(dtd, "_resolve_async_session_key", lambda *_args: ("session", ""))
    monkeypatch.setattr(dtd, "_units_of", lambda _batch: units)
    dispatches = iter([
        {"status": "dispatched", "delegation_id": "unit-1"},
        {"status": "rejected", "reason": "session_closed", "error": "closed"},
    ])
    monkeypatch.setattr(dtd, "_dispatch_unit", lambda *_args, **_kwargs: next(dispatches))
    settled = []

    def settle(unit, reason, *, completed):
        settled.append((reason, completed))
        return [{"task_index": unit.children[0][0], "status": "interrupted"}]

    monkeypatch.setattr(dtd, "_settle_unstarted_unit", settle)
    monkeypatch.setattr(
        dtd, "_execute_and_aggregate",
        lambda *_args, **_kwargs: pytest.fail("a closed-session rejection must not run inline"),
    )
    import tools.delegate_tool as dt

    monkeypatch.setattr(dt, "_get_max_async_children", lambda: 2)

    parsed = json.loads(dtd._dispatch_background(batch))

    assert parsed["status"] == "dispatched"
    assert parsed["count"] == 1
    assert parsed["not_dispatched"] == [{"task_index": 1, "status": "interrupted"}]
    assert "inline_results" not in parsed
    assert settled == [("session_closed", False)]


def test_first_non_capacity_rejection_settles_every_unit(monkeypatch):
    from dataclasses import replace
    from types import SimpleNamespace

    import tools.delegate_tool_dispatch as dtd
    from tools.delegate_tool_dispatch import _Batch

    parent = _fake_parent()
    children = [
        (i, {"goal": f"g{i}"}, SimpleNamespace(_subagent_id=f"s{i}")) for i in range(2)
    ]
    batch = _Batch(
        task_list=[{"goal": "g0"}, {"goal": "g1"}, {"goal": "g2"}], children=children, parent_agent=parent,
        creds={"model": "m"}, context=None, top_role="leaf", max_children=2,
        live_deleg_id="call-2", live_writers=[], live_paths=[], origin_wake_sid="",
        origin_ui_session_id="", origin_owner_transport=None, origin_owner_session_record=None,
        origin_session_history_delivery=False, overall_start=0.0,
        refused=[{"task_index": 2, "status": "error", "error": "route refused"}],
    )
    units = [replace(batch, children=[children[0]]), replace(batch, children=[children[1]])]
    monkeypatch.setattr(dtd, "_resolve_async_wake_sid", lambda *_args, **_kwargs: "")
    monkeypatch.setattr(dtd, "_resolve_async_session_key", lambda *_args: ("session", ""))
    monkeypatch.setattr(dtd, "_units_of", lambda _batch: units)
    dispatch_calls = []

    def reject_first(*_args, **_kwargs):
        dispatch_calls.append(True)
        return {"status": "rejected", "reason": "session_closed", "error": "closed"}

    monkeypatch.setattr(dtd, "_dispatch_unit", reject_first)
    settled = []

    def settle(unit, reason, *, completed):
        index = unit.children[0][0]
        settled.append((index, reason, completed))
        return [{"task_index": index, "status": "interrupted"}]

    monkeypatch.setattr(dtd, "_settle_unstarted_unit", settle)
    monkeypatch.setattr(
        dtd, "_execute_and_aggregate",
        lambda *_args, **_kwargs: pytest.fail("a closed session must not run any unit inline"),
    )
    import tools.delegate_tool as dt

    monkeypatch.setattr(dt, "_get_max_async_children", lambda: 2)

    parsed = json.loads(dtd._dispatch_background(batch))

    assert parsed["error"]
    assert [result["task_index"] for result in parsed["results"]] == [0, 1, 2]
    assert dispatch_calls == [True]
    assert settled == [(0, "session_closed", False), (1, "session_closed", True)]
