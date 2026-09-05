"""Stable structural annotations shared by replay trace projections.

The source trace is intentionally kept lossless.  This module adds the small
amount of structure that cannot be reconstructed reliably from a time window:
agent calls, visible turn numbers, and non-work cancellation tails.
"""

from __future__ import annotations

from typing import Any


ANNOTATION_KEY = "trace_graph"

# The schema's informational origin vocabulary, as transfer-edge labels: the
# same surface agent appears as worker (under the coordinator) and as reviewer
# (under the gate), and the role label alone cannot tell them apart.
_ORIGIN_FALLBACK_ROLES = {
    "main": "MAIN",
    "gate": "GATE",
    "gui_worker": "GUI",
    "gui_reviewer": "GUI-REVIEW",
}


def _event(record: dict) -> dict:
    value = record.get("event")
    return value if isinstance(value, dict) else {}


def _identity(record: dict) -> str:
    return str(record.get("agentId") or record.get("sessionKey")
               or record.get("role") or "agent")


def _role(record: dict) -> str:
    return _role_label(
        record.get("role") or record.get("sessionKey") or record.get("agentId"),
        record.get("origin"),
    )


def _role_label(role_value: object, origin: object = None) -> str:
    """Display the agent role; origin only qualifies reviewer assignments."""
    value = role_value
    if not isinstance(value, str) or not value:
        return _ORIGIN_FALLBACK_ROLES.get(origin, "AGENT")
    if value.lower().startswith("stateact_"):
        value = value[len("stateact_"):]
    label = value.split(":", 1)[0].upper().replace("_REVIEWER", "-REVIEW")
    if origin == "gui_reviewer" and not label.endswith("-REVIEW"):
        label = f"{label}-REVIEW"
    return label


def _annotation(record: dict) -> dict:
    value = record.get(ANNOTATION_KEY)
    return dict(value) if isinstance(value, dict) else {}


def _mark(records: list[dict], index: int, **values: Any) -> None:
    annotation = _annotation(records[index])
    annotation.update(values)
    records[index][ANNOTATION_KEY] = annotation


def _message_is_empty_cancellation(event: dict) -> bool:
    message = event.get("message")
    if not isinstance(message, dict) or message.get("role") != "assistant":
        return False
    content = message.get("content")
    if content not in (None, [], ""):
        return False
    usage = message.get("usage")
    if isinstance(usage, dict) and any(
        type(usage.get(key)) in (int, float) and usage[key] != 0
        for key in ("input", "output", "cacheRead", "cacheWrite", "totalTokens")
    ):
        return False
    stop_reason = str(message.get("stopReason") or "").lower()
    error = str(message.get("errorMessage") or "").lower()
    return stop_reason == "aborted" or (
        stop_reason == "error" and "abort" in error
    )


def _mark_control_tails(records: list[dict]) -> None:
    active_turns: dict[str, tuple[int, list[int]]] = {}
    pending_inputs: dict[str, list[int]] = {}
    for index, record in enumerate(records):
        event = _event(record)
        event_type = event.get("type")
        key = _identity(record)
        if event_type == "model_input_images" and key not in active_turns:
            pending_inputs.setdefault(key, []).append(index)
            continue
        if event_type == "turn_start":
            active_turns[key] = (index, pending_inputs.pop(key, []))
            continue
        if event_type != "turn_end":
            continue
        start, prelude = active_turns.pop(key, (index, []))
        pending_inputs.pop(key, None)
        segment = list(range(start, index + 1))
        is_cancelled = any(
            _message_is_empty_cancellation(_event(records[position]))
            for position in segment
        )
        has_tool = any(
            _event(records[position]).get("type") == "tool_execution_start"
            for position in segment
        )
        if is_cancelled and not has_tool:
            for position in [*prelude, *segment]:
                _mark(records, position, suppress_work=True)

    # A truncated trace may contain the message pair without its turn markers.
    for index, record in enumerate(records):
        if _message_is_empty_cancellation(_event(record)):
            _mark(records, index, suppress_work=True)


def _mark_observer_inputs(records: list[dict]) -> None:
    participants = {
        _identity(record)
        for record in records
        if _event(record).get("type") == "agent_start"
        or (
            _event(record).get("type") in {"message_start", "message_end"}
            and isinstance(_event(record).get("message"), dict)
            and _event(record)["message"].get("role") == "assistant"
        )
    }
    for index, record in enumerate(records):
        if (_event(record).get("type") == "model_input_images"
                and _identity(record) not in participants):
            _mark(records, index, suppress_work=True)


def _delegates(event: dict) -> bool:
    name = str(event.get("toolName") or "").lower()
    args = event.get("args")
    return (name in {"task", "agent"} or name.startswith("delegate_")
            or (isinstance(args, dict) and isinstance(args.get("agent"), str)))


def _bind_child(open_calls: dict, open_order: list[str], child_agent_id: object,
                child_role: object, *, parent_call_id: object = None,
                parent_agent_id: object = None, trajectory_id: object = None,
                attempt: object = None) -> str | None:
    """Bind by explicit parent call, or by an unambiguous legacy candidate."""
    if not isinstance(child_agent_id, str) or not child_agent_id:
        return None
    candidate_ids = [parent_call_id] if isinstance(parent_call_id, str) else list(reversed(open_order))
    candidates = []
    for candidate_id in candidate_ids:
        candidate = open_calls.get(candidate_id)
        if (candidate is None or candidate["child_agent_id"] is not None
                or candidate["caller_agent_id"] == child_agent_id
                or (isinstance(parent_agent_id, str)
                    and candidate["caller_agent_id"] != parent_agent_id)
                or (not isinstance(parent_call_id, str)
                    and candidate["caller_role"] == child_role)):
            continue
        candidates.append((candidate_id, candidate))
    if not candidates:
        return None
    if not isinstance(parent_call_id, str):
        delegated = [pair for pair in candidates if pair[1]["delegates"]]
        if len(delegated) == 1:
            candidates = delegated
        elif len(delegated) > 1:
            return None
        elif len(candidates) != 1:
            return None
    candidate_id, candidate = candidates[0]
    candidate["child_agent_id"] = child_agent_id
    candidate["child_role"] = child_role
    if isinstance(trajectory_id, str) and trajectory_id:
        candidate["trajectory_id"] = trajectory_id
    if isinstance(attempt, int) and not isinstance(attempt, bool) and attempt > 0:
        candidate["attempts"] = max(candidate["attempts"], attempt)
    return candidate_id


def _result_status(event: dict, child_agent_id: str) -> dict:
    summaries = event.get("subagentResults")
    summary = next((item for item in summaries or [] if isinstance(item, dict)
                    and item.get("trajectoryId") == child_agent_id), None)
    if isinstance(summary, dict):
        return {
            key: value for key, value in {
                "execution_status": summary.get("executionStatus"),
                "agent_outcome": summary.get("agentOutcome"),
                "exit_code": summary.get("exitCode"),
                "aborted": summary.get("aborted"),
            }.items() if value is not None
        }
    result = event.get("result")
    details = result.get("details") if isinstance(result, dict) else None
    children = details.get("results") if isinstance(details, dict) else None
    child = next((item for item in children or [] if isinstance(item, dict)
                  and item.get("id") == child_agent_id), None)
    values = {"execution_status": "error" if event.get("isError") else "success"}
    if not isinstance(child, dict):
        return values
    if isinstance(child.get("exitCode"), int):
        values["exit_code"] = child["exitCode"]
        if child["exitCode"] != 0:
            values["execution_status"] = "error"
    if isinstance(child.get("aborted"), bool):
        values["aborted"] = child["aborted"]
    structured = child.get("structuredOutput")
    data = structured.get("data") if isinstance(structured, dict) else None
    outcome = data.get("status") if isinstance(data, dict) else None
    normalized = outcome.lower() if isinstance(outcome, str) else None
    if normalized in {
        "success", "succeeded", "completed", "failed", "blocked",
        "partial", "cancelled", "aborted",
    }:
        values["agent_outcome"] = normalized
    elif child.get("aborted") is True:
        values["agent_outcome"] = "aborted"
    return values


def _mark_call_returns(records: list[dict]) -> None:
    open_calls: dict[str, dict] = {}
    open_order: list[str] = []
    seen_identities: set[str] = set()
    for index, record in enumerate(records):
        event = _event(record)
        event_type = event.get("type")
        call_id = event.get("toolCallId")
        if event_type == "tool_execution_start" and isinstance(call_id, str):
            identity = _identity(record)
            seen_identities.add(identity)
            open_calls[call_id] = {
                "caller_agent_id": identity,
                "caller_role": _role(record),
                "delegates": _delegates(event),
                "child_agent_id": None,
                "child_role": None,
                "trajectory_id": None,
                "attempts": 0,
                "agent_starts": 0,
                "dispatch_status": None,
            }
            if call_id in open_order:
                open_order.remove(call_id)
            open_order.append(call_id)
            continue
        if (isinstance(record.get("event"), str)
                and record.get("event") == "subagent_lifecycle"):
            if record.get("status") == "started":
                child_id = record.get("id")
                bound = _bind_child(
                    open_calls, open_order, child_id,
                    _role_label(record.get("agent"), record.get("origin")),
                    parent_call_id=record.get("parentToolCallId"),
                    parent_agent_id=record.get("parentAgentId"),
                    trajectory_id=record.get("trajectoryId"),
                    attempt=record.get("attempt"),
                )
                if bound and isinstance(child_id, str) and child_id:
                    seen_identities.add(child_id)
            else:
                parent_call_id = record.get("parentToolCallId")
                candidates = ([open_calls.get(parent_call_id)]
                              if isinstance(parent_call_id, str)
                              else open_calls.values())
                for call in candidates:
                    if call is not None and call["child_agent_id"] == record.get("id"):
                        call["dispatch_status"] = record.get("status")
                        if isinstance(record.get("attempt"), int):
                            call["attempts"] = max(call["attempts"], record["attempt"])
                        break
            continue
        identity = _identity(record)
        # Fallback for producers without lifecycle frames (legacy traces):
        # the first appearance of an unknown agent identity inside an open
        # tool span is that span's child. Identities seen before the span can
        # never bind to it, and observer-only records (model inputs) never
        # establish an agent call.
        if identity not in seen_identities:
            seen_identities.add(identity)
            if (open_order and identity != "agent"
                    and event_type != "model_input_images"):
                _bind_child(open_calls, open_order, identity, _role(record))
        if event_type == "agent_start":
            for call in open_calls.values():
                if call["child_agent_id"] == identity:
                    call["agent_starts"] += 1
                    call["attempts"] = max(call["attempts"], call["agent_starts"])
                    break
        if event_type != "tool_execution_end" or not isinstance(call_id, str):
            continue
        call = open_calls.pop(call_id, None)
        if call_id in open_order:
            open_order.remove(call_id)
        if call is None or call["child_agent_id"] is None:
            continue
        call_return = {
            "from": call["child_role"],
            "to": call["caller_role"],
            "parent_agent_id": call["caller_agent_id"],
            "child_agent_id": call["child_agent_id"],
            "tool_call_id": call_id,
            **_result_status(event, call["child_agent_id"]),
        }
        if call["trajectory_id"]:
            call_return["trajectory_id"] = call["trajectory_id"]
        if call["attempts"]:
            call_return["attempts"] = call["attempts"]
        if call["dispatch_status"]:
            call_return["dispatch_status"] = call["dispatch_status"]
        _mark(records, index, call_return=call_return)


def annotate_trace_graph(source_records: list[dict]) -> list[dict]:
    """Return records with deterministic full-trace structural annotations."""
    records = [dict(record) for record in source_records]
    for record in records:
        record.pop(ANNOTATION_KEY, None)
    _mark_control_tails(records)
    _mark_observer_inputs(records)
    _mark_call_returns(records)
    return records
