"""Legacy trace to Agent Work; pure parsing adapted from oss-replay."""
from typing import Any
from .trace_graph import ANNOTATION_KEY, annotate_trace_graph
from .legacy_fold import _Fold
from .legacy_work_helpers import (
    agent_label, _stamp, _event, _agent_key, _event_id, _human_turn, _valid_turn, _usage_context_tokens, _valid_request_index, _valid_image, _index_set, _message, _message_role, _collect_dispatch, annotate_global_turns,
)

def _block_type(block: Any) -> str:
    if isinstance(block, dict) and isinstance(block.get("type"), str):
        return block["type"].lower().replace("_", "").replace("-", "")
    return ""


def _details(item: dict) -> list[dict]:
    """Ordered presentation entries interleaving message blocks with tools."""
    details: list[dict] = []
    unused: set[str] = {tool["id"] for tool in item["tools"]}
    thinking_index = 0
    text_index = 0
    by_id = {tool["id"]: tool for tool in item["tools"]}
    name_index: dict[str, list[dict]] = {}
    for tool in item["tools"]:
        name_index.setdefault(tool["name"], []).append(tool)

    def take_tool(block: dict) -> dict | None:
        explicit = next((v for v in (block.get("toolCallId"), block.get("id"))
                         if isinstance(v, str) and v), None)
        if explicit and explicit in unused and explicit in by_id:
            return by_id[explicit]
        name = next((v for v in (block.get("name"), block.get("toolName"))
                     if isinstance(v, str) and v), None)
        candidates = [t for t in item["tools"] if t["id"] in unused]
        by_name = [t for t in candidates if name and t["name"] == name]
        if by_name:
            return by_name[0]
        return candidates[0] if candidates else None

    for block in (item["message"] or {}).get("blocks", []):
        if not isinstance(block, dict):
            continue
        block_type = _block_type(block)
        if block_type == "thinking" and (block.get("text") or block.get("thinking")):
            details.append({
                "kind": "thinking", "key": f"thinking:{thinking_index}",
                "text": block.get("text") or block.get("thinking") or "",
                "index": thinking_index,
            })
            thinking_index += 1
        elif block_type == "text" and block.get("text"):
            details.append({
                "kind": "text", "key": f"output:{text_index}",
                "text": block.get("text"), "index": text_index,
            })
            text_index += 1
        elif block_type in ("toolcall", "tooluse"):
            tool = take_tool(block)
            if tool is None:
                continue
            unused.discard(tool["id"])
            details.append({"kind": "tool", "key": f"tool:{tool['id']}", "tool_id": tool["id"]})
    for tool in item["tools"]:
        if tool["id"] in unused:
            details.append({"kind": "tool", "key": f"tool:{tool['id']}", "tool_id": tool["id"]})
    return details


# Nulls that carry meaning in the view model; every other absent optional is
# omitted rather than emitted as null.
_MEANINGFUL_NULLS = {"end_ms", "is_error"}


def _strip_absent(value: Any) -> Any:
    if isinstance(value, dict):
        return {
            key: _strip_absent(item) for key, item in value.items()
            if item is not None or key in _MEANINGFUL_NULLS
        }
    if isinstance(value, list):
        return [_strip_absent(item) for item in value]
    return value


def build_episode_work(
    records: list[dict], cursor_ms: int, *, terminal: bool = False,
    duration_ms: int | None = None,
) -> dict:
    """Project elapsed-ordered trace records into the episode work model.

    This is the projection boundary: callers hand over records exactly as
    loaded (plus any loader-added trace_index) and receive the typed view
    model; nothing downstream reads event shapes again.
    """
    fold = _Fold(records, cursor_ms)
    items = fold.run()
    if terminal:
        for item in items:
            item["ongoing"] = False
            for tool in item["tools"]:
                if tool["end_ms"] is not None:
                    continue
                tool["end_ms"] = cursor_ms
                tool["is_error"] = True
                tool["result"] = {
                    "text": "Tool execution was interrupted when the episode terminated.",
                    "details": {"synthetic": True, "status": "interrupted"},
                }
    for item in items:
        item["details"] = _details(item) if not (
            (item.get("message") or {}).get("role") == "user"
        ) else []
    agents: list[dict] = []
    seen: set[str] = set()
    for item in items:
        if item["agent_id"] in seen:
            continue
        seen.add(item["agent_id"])
        agents.append({
            "id": item["agent_id"], "role": item["role"],
            "origin": item["origin"], "label": item["label"],
        })
    return _strip_absent({
        "terminal": terminal,
        "duration_ms": duration_ms if duration_ms is not None else cursor_ms,
        "agents": agents,
        "items": items,
    })


def slice_episode_work(work: dict, start_ms: int, end_ms: int,
                       cursor_ms: int) -> dict:
    """Slice already-folded work so calls are paired before windowing.

    A semantic work item is atomic: when any part overlaps the requested
    interval, the response carries its complete tool boundaries.  This keeps
    a completed call from becoming spuriously ongoing merely because its end
    record landed in the next raw-trace window.
    """
    def overlaps(item: dict) -> bool:
        item_start = item.get("start_ms")
        if not isinstance(item_start, (int, float)) or isinstance(item_start, bool):
            return False
        ends = [item_start + (item.get("thinking_ms") or 0)]
        active = item.get("ongoing") is True
        for tool in item.get("tools", []):
            tool_end = tool.get("end_ms")
            if isinstance(tool_end, (int, float)) and not isinstance(tool_end, bool):
                ends.append(tool_end)
            else:
                active = True
        if active:
            ends.append(cursor_ms)
        return item_start <= end_ms and max(ends) >= start_ms

    items = [item for item in work.get("items", []) if overlaps(item)]
    agent_ids = {item.get("agent_id") for item in items}
    return {
        **work,
        "agents": [agent for agent in work.get("agents", [])
                   if agent.get("id") in agent_ids],
        "items": items,
    }


def annotate_for_work(records: list[dict]) -> list[dict]:
    """Graph annotations + global turn numbering, in the projection layer."""
    from .legacy_work_helpers import annotate_global_turns

    return annotate_trace_graph(annotate_global_turns(records))
