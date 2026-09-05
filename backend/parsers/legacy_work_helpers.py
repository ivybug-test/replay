"""The single trace interpreter: raw trace records in, typed view model out.

This module (with the load-side normalization in oss_source and the graph
annotations in trace_graph) is the ONLY place that reads event shapes.
Everything downstream — HTTP responses, the Vue frontend, analysis tools —
consumes the view model it emits and never sees `event.type` dispatch.

The fold semantics are the port of the former frontend foldWork/agent-work
state machine; the ordering contract is docs/trace-schema.md (real episode
time, ties by sequence).
"""
from __future__ import annotations

from typing import Any

from .trace_graph import ANNOTATION_KEY, annotate_trace_graph

# Assignment qualifiers from the schema's origin vocabulary: the same surface
# agent runs as a worker (under the coordinator) and as a reviewer (under the
# gate); the role label alone cannot tell them apart.
ORIGIN_QUALIFIERS = {
    "gui_worker": "worker",
    "gui_reviewer": "reviewer",
    "gate": "gate",
}


def agent_label(role: Any, origin: Any) -> str:
    """Opaque producer role plus the origin qualifier when the schema
    provides one; unknown or absent origins leave the role untouched."""
    base = role if isinstance(role, str) and role else "agent"
    qualifier = ORIGIN_QUALIFIERS.get(origin) if isinstance(origin, str) else None
    return f"{base} · {qualifier}" if qualifier else base


def _stamp(record: dict) -> int | None:
    value = record.get("episode_elapsed_ms")
    if isinstance(value, int) and not isinstance(value, bool) and value >= 0:
        return value
    return None


def _event(record: dict) -> dict:
    event = record.get("event")
    return event if isinstance(event, dict) else {}


def _agent_key(record: dict) -> str:
    return (record.get("sessionKey") or record.get("agentId")
            or record.get("role") or "agent")


def _event_id(record: dict) -> str | None:
    index = record.get("trace_index")
    if isinstance(index, int) and not isinstance(index, bool) and index >= 0:
        return f"trace:{index}"
    return None


def _human_turn(value: Any) -> int | None:
    if isinstance(value, int) and not isinstance(value, bool) and value >= 0:
        return value + 1
    return None


def _valid_turn(value: Any) -> int | None:
    if isinstance(value, int) and not isinstance(value, bool) and value > 0:
        return value
    return None


def _usage_context_tokens(usage: Any) -> int | None:
    if not isinstance(usage, dict):
        return None
    observed, total = False, 0
    for key in ("input", "cacheRead", "cacheWrite"):
        value = usage.get(key)
        if isinstance(value, (int, float)) and not isinstance(value, bool) and value >= 0:
            observed, total = True, total + value
    return total if observed else None


def _valid_request_index(value: Any) -> int | None:
    if isinstance(value, int) and not isinstance(value, bool) and value >= 0:
        return value
    return None


def _valid_image(image: Any) -> dict | None:
    if not isinstance(image, dict):
        return None
    path, digest, size = image.get("path"), image.get("sha256"), image.get("bytes")
    return image if (isinstance(path, str) and path.startswith("frames/")
                    and isinstance(digest, str) and len(digest) == 64
                    and isinstance(size, int) and not isinstance(size, bool)
                    and size >= 0) else None


def _index_set(value: Any, count: int) -> set[int] | None:
    if not isinstance(value, list):
        return None
    indexes: set[int] = set()
    for index in value:
        if (not isinstance(index, int) or isinstance(index, bool)
                or index < 0 or index >= count or index in indexes):
            return None
        indexes.add(index)
    return indexes


def _message(record: dict) -> dict | None:
    message = _event(record).get("message")
    return message if isinstance(message, dict) else None


def _message_role(record: dict) -> Any:
    message = _message(record)
    return message.get("role") if message else None


def _collect_dispatch(records: list[dict]) -> dict[str, dict]:
    """Pair each delegation_state probe with the delegated child agent.

    Runtime emit order is deterministic under the single-spawn contract: the
    dispatch guard probes before the task tool spawns, so the next
    subagent_lifecycle started row for a GUI role binds the pending probe;
    computer delegations also carry an attach row whose childId names the
    child directly. Browser probes never attach an image and have no attach
    row — the pairing is the only join. Probes that never bind (spawn
    rejected upstream) simply annotate nothing. Returns child agent key ->
    display-ready dispatch summary.
    """
    dispatch: dict[str, dict] = {}
    attach: dict[str, dict] = {}
    pending: dict | None = None
    for record in records:
        event = record.get("event")
        if isinstance(event, dict):
            continue
        if event == "delegation_state":
            if record.get("stage") == "attach":
                child = record.get("childId")
                if isinstance(child, str):
                    attach.setdefault(child, {"attach_attached": bool(record.get("attached"))})
            elif record.get("stage") == "probe":
                browser = record.get("browser")
                pending = {
                    "surface": record.get("surface"),
                    "probe_attached": bool(record.get("attached")),
                    "path": record.get("path"),
                    "tabs": (len(browser.get("tabs") or [])
                             if isinstance(browser, dict) else None),
                }
        elif event == "subagent_lifecycle" and record.get("status") == "started":
            child = record.get("id")
            if record.get("agent") in ("stateact_gui", "stateact_browser"):
                if pending is not None and isinstance(child, str):
                    dispatch[child] = pending
            # Any spawn the guard did not probe for invalidates a stale
            # pending probe: pairing must never cross another delegation.
            pending = None
    for child, summary in attach.items():
        if child in dispatch:
            dispatch[child].update(summary)
    return dispatch



def annotate_global_turns(records: list[dict]) -> list[dict]:
    """Attach stable global and per-agent request numbers to assistant pairs."""
    request_indexes: dict[str, list[int]] = {}
    for record in records:
        event = record.get("event") if isinstance(record.get("event"), dict) else {}
        request_index = event.get("requestIndex")
        if (event.get("type") != "model_input_images"
                or not isinstance(request_index, int)
                or isinstance(request_index, bool) or request_index < 0):
            continue
        key = record.get("agentId") or record.get("sessionKey") \
            or record.get("role") or "agent"
        indexes = request_indexes.setdefault(key, [])
        if request_index not in indexes:
            indexes.append(request_index)
    for indexes in request_indexes.values():
        indexes.sort()

    numbered = []
    open_turns: dict[str, int] = {}
    open_requests: dict[str, int] = {}
    request_positions: dict[str, int] = {}
    global_turn = 0
    for original in records:
        record = dict(original)
        # Orchestration records carry a string event name: they carry no turn
        # or request semantics and pass through untouched (schema resilience).
        event = record.get("event") if isinstance(record.get("event"), dict) else {}
        if (event.get("type") in {"message_start", "message_end"}
                and event.get("message", {}).get("role") == "assistant"):
            key = record.get("sessionKey") or record.get("agentId") \
                or record.get("role") or "agent"
            request_key = record.get("agentId") or record.get("sessionKey") \
                or record.get("role") or "agent"
            if event["type"] == "message_start":
                global_turn += 1
                open_turns[key] = global_turn
                record["global_turn_num"] = global_turn
                position = request_positions.get(request_key, 0)
                agent_indexes = request_indexes.get(request_key, [])
                if position < len(agent_indexes):
                    request_index = agent_indexes[position]
                    request_positions[request_key] = position + 1
                    open_requests[request_key] = request_index
                    record["request_index"] = request_index
            elif key in open_turns:
                record["global_turn_num"] = open_turns.pop(key)
                if request_key in open_requests:
                    record["request_index"] = open_requests.pop(request_key)
        numbered.append(record)
    return numbered

