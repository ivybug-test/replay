"""Portable execution-state adapters adapted from oss-replay/replay_index.py."""
from typing import Any
EXECUTION_STATE_TYPES = {
    "execution_state_declaration",
    "execution_state_goal",
    "execution_state_action",
    "execution_state_checkpoint",
    "execution_state_attempt",
    "execution_state_evidence",
    "execution_state_failure",
    "execution_state_recovery",
}

EXECUTION_STATE_EXTENSION_VERSION = "execution-state/v2"


def _milliseconds(value: Any) -> int | None:
    return value if isinstance(value, int) and not isinstance(value, bool) and value >= 0 else None


def _through(items: list[dict]) -> int | None:
    values = [_milliseconds(item.get("episode_elapsed_ms")) for item in items]
    present = [value for value in values if value is not None]
    return max(present) if present else None


def execution_state_feed(records: list[dict]) -> dict:
    """Project raw execution-state orchestration records for Replay.

    These records deliberately stay outside ``compact_trace``: their string
    event names are an extension stream, not standard Agent Trace events.
    """
    events = []
    version = "execution-state/v1"
    counts = {name.removeprefix("execution_state_"): 0
              for name in sorted(EXECUTION_STATE_TYPES)}
    for record in records:
        event = record.get("event") if isinstance(record, dict) else None
        event_name = (event if isinstance(event, str) else
                      event.get("type") if isinstance(event, dict) else None)
        if event_name not in EXECUTION_STATE_TYPES:
            continue
        events.append(record)
        if isinstance(record.get("version"), str):
            version = record["version"]
        counts[event_name.removeprefix("execution_state_")] += 1
    return {"version": version, "counts": counts, "events": events}


def execution_state_extension_feed(trajectory: Any) -> dict | None:
    """Project the portable ATIF root extension into the live feed shape.

    The producer-owned extension stays append-only and record-oriented.  This
    adapter gives the frontend one ExecutionStateView whether the source is a
    live runtime trace or an archived ``trajectory.json``.
    """
    if not isinstance(trajectory, dict):
        return None
    extra = trajectory.get("extra")
    extension = (extra.get("osworld_execution_state")
                 if isinstance(extra, dict) else None)
    if (not isinstance(extension, dict)
            or extension.get("schema_version") != EXECUTION_STATE_EXTENSION_VERSION
            or not isinstance(extension.get("events"), list)):
        return None
    counts = {name.removeprefix("execution_state_"): 0
              for name in sorted(EXECUTION_STATE_TYPES)}
    events = []
    for index, item in enumerate(extension["events"]):
        if not isinstance(item, dict):
            continue
        event_type = item.get("event_type")
        event_name = f"execution_state_{event_type}"
        elapsed = _milliseconds(item.get("episode_elapsed_ms"))
        record = item.get("record")
        if (event_name not in EXECUTION_STATE_TYPES
                or elapsed is None or not isinstance(record, dict)):
            continue
        sequence = item.get("sequence")
        if not isinstance(sequence, int) or isinstance(sequence, bool) or sequence < 1:
            sequence = index + 1
        event = {
            key: value for key, value in item.items()
            if key not in {"event_type"}
        }
        event.update({
            "sequence": sequence,
            "episode_elapsed_ms": elapsed,
            "event": event_name,
            "version": EXECUTION_STATE_EXTENSION_VERSION,
            "record": record,
        })
        events.append(event)
        counts[event_type] += 1
    events.sort(key=lambda item: (item["episode_elapsed_ms"], item["sequence"]))
    result = {
        "version": EXECUTION_STATE_EXTENSION_VERSION,
        "counts": counts,
        "events": events,
        "source": "trajectory_extra",
    }
    if isinstance(extension.get("final_state"), dict):
        result["final_state"] = extension["final_state"]
    return result
