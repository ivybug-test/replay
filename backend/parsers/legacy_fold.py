"""Semantic work fold adapted from oss-replay/work_model.py."""
from typing import Any
from .trace_graph import ANNOTATION_KEY
from .legacy_work_helpers import (
    agent_label, _stamp, _event, _agent_key, _event_id, _human_turn, _valid_turn, _usage_context_tokens, _valid_request_index, _valid_image, _index_set, _message, _message_role, _collect_dispatch, annotate_global_turns,
)

class _Fold:
    """Port of the frontend work-folding state machine."""

    def __init__(self, records: list[dict], cursor_ms: int):
        self.records = records
        self.cursor = cursor_ms
        self.items: list[dict] = []
        self.starts: dict[str, dict] = {}
        self.current: dict[str, dict] = {}
        self.tools: dict[str, dict] = {}
        self.tool_owners: dict[str, dict] = {}
        self.user_starts: dict[str, dict] = {}
        self.pending_control: dict[str, list[str]] = {}
        self.active_turns: dict[str, int] = {}
        self.observed_turns: dict[str, int] = {}
        # Image digests of each agent's latest user input message: the model
        # does see them again on the next request, but the input item already
        # renders them, so assistant prelude thumbnails skip them.
        self.last_user_images: dict[str, set[str]] = {}
        self.model_inputs = self._collect_model_inputs()
        self.matched: set[int] = set()  # indexes into model_inputs
        # Delegation dispatch summaries keyed by child agent: the first input
        # item of each delegated child carries its assignment's live state.
        self.dispatch = _collect_dispatch(records)

    # ---------- model inputs ----------

    def _collect_model_inputs(self) -> list[dict]:
        collected = []
        first_pool: dict[str, list[dict]] = {}
        for record in self.records:
            event = _event(record)
            if event.get("type") != "model_input_images":
                continue
            if record.get(ANNOTATION_KEY, {}).get("suppress_work"):
                continue
            images = [i for i in (event.get("images") or []) if _valid_image(i)]
            # The first image-bearing request of an agent contains its input
            # message images in message order — the pool that recovers
            # content-addressed references for user-message image blocks the
            # producer recorded without a digest.
            key = _agent_key(record)
            if images and key not in first_pool:
                first_pool[key] = list(images)
            new_set = _index_set(event.get("newImageIndexes"), len(images))
            context_set = _index_set(event.get("contextImageIndexes"), len(images))
            known = bool(
                new_set is not None and context_set is not None
                and len(new_set) + len(context_set) == len(images)
                and not (new_set & context_set)
            )
            request_index = _valid_request_index(event.get("requestIndex"))
            collected.append({
                "record": record,
                "request_index": request_index,
                "agent_key": key,
                "request": {
                    "request_index": request_index,
                    "images": images,
                    "new_images": [images[i] for i in sorted(new_set)] if known and new_set else [],
                    "context_images": [images[i] for i in sorted(context_set)] if known and context_set else [],
                    "classification_known": known,
                },
            })
        self.input_image_pool = first_pool
        return collected

    # ---------- item helpers ----------

    def _work_id(self, record: dict, stamp: int, kind: str) -> str:
        fallback = record.get("trace_index", record.get("sequence", stamp))
        return f"{_agent_key(record)}:{kind}:{fallback}"

    def _create(self, work_id: str, record: dict, start: int, ongoing: bool) -> dict:
        return {
            "id": work_id,
            "agent_id": _agent_key(record),
            "role": record.get("role"),
            "origin": record.get("origin"),
            "label": agent_label(record.get("role"), record.get("origin")),
            "start_ms": start,
            "thinking_ms": 0,
            "ongoing": ongoing,
            "tools": [],
            "source_event_ids": [i for i in [_event_id(record)] if i],
            "message": None,
            "details": [],
            "model_inputs": None,
            "transfer": None,
            "turn_num": None,
            "global_turn_num": None,
            "request_index": None,
            "context_tokens": None,
            "dispatch": None,
        }

    def _append_source(self, item: dict, record: dict) -> None:
        event_id = _event_id(record)
        if event_id and event_id not in item["source_event_ids"]:
            item["source_event_ids"].append(event_id)

    def _append_pending(self, key: str, record: dict) -> None:
        event_id = _event_id(record)
        if event_id is None:
            return
        values = self.pending_control.setdefault(key, [])
        if event_id not in values:
            values.append(event_id)

    def _consume_pending(self, key: str, item: dict) -> None:
        earlier = self.pending_control.pop(key, [])
        if earlier:
            item["source_event_ids"] = earlier + [
                i for i in item["source_event_ids"] if i not in earlier
            ]

    def _attach_dispatch(self, key: str, item: dict) -> None:
        """First input item of a delegated child carries its dispatch state."""
        summary = self.dispatch.pop(key, None)
        if summary is not None:
            item["dispatch"] = summary

    # ---------- the fold ----------

    def run(self) -> list[dict]:
        for record in self.records:
            event = _event(record)
            event_type = event.get("type")
            key = _agent_key(record)
            stamp = _stamp(record)
            if stamp is None:
                continue
            if record.get(ANNOTATION_KEY, {}).get("suppress_work"):
                continue
            if event_type == "agent_start":
                self._append_pending(key, record)
            elif event_type == "turn_start":
                self._append_pending(key, record)
                turn = _human_turn(event.get("turnIndex"))
                if turn is not None:
                    self.active_turns[key] = turn
                    self.observed_turns[key] = max(self.observed_turns.get(key, 0), turn)
            elif event_type == "model_input_images":
                continue
            elif event_type == "message_start" and _message_role(record) == "user":
                item = self._create(self._work_id(record, stamp, "input"), record, stamp, False)
                self._attach_dispatch(key, item)
                self.items.append(item)
                self.user_starts[key] = item
            elif event_type == "message_end" and _message_role(record) == "user":
                item = self.user_starts.get(key)
                if item is None:
                    item = self._create(self._work_id(record, stamp, "input"), record, stamp, False)
                    self._attach_dispatch(key, item)
                    self.items.append(item)
                item["message"] = self._message_payload(record)
                item["message"]["blocks"] = self._fill_input_images(
                    key, item["message"]["blocks"])
                self._append_source(item, record)
                self.last_user_images[key] = {
                    block.get("sha256") for block in item["message"]["blocks"]
                    if isinstance(block, dict) and block.get("type") == "image"
                    and isinstance(block.get("sha256"), str)
                }
                self.user_starts.pop(key, None)
            elif event_type == "message_start" and _message_role(record) == "assistant":
                request_index = _valid_request_index(record.get("request_index"))
                if request_index is None:
                    request_index = _valid_request_index(event.get("requestIndex"))
                inputs = self._inputs_for(key, request_index) if request_index is not None else []
                item = self._create(self._work_id(record, stamp, "turn"), record, stamp, True)
                if inputs:
                    for entry in inputs:
                        self.matched.add(self.model_inputs.index(entry))
                        self._split_echoed(entry["request"], key)
                    item["model_inputs"] = [entry["request"] for entry in inputs]
                    item["source_event_ids"] = (
                        [i for entry in inputs for i in [_event_id(entry["record"])] if i]
                        + item["source_event_ids"]
                    )
                self._consume_pending(key, item)
                item["request_index"] = request_index
                if key in self.active_turns:
                    item["turn_num"] = self.active_turns[key]
                else:
                    self.observed_turns[key] = self.observed_turns.get(key, 0) + 1
                    item["turn_num"] = self.observed_turns[key]
                item["global_turn_num"] = _valid_turn(record.get("global_turn_num"))
                self.items.append(item)
                self.starts[key] = item
                self.current[key] = item
            elif event_type == "turn_end":
                turn = _human_turn(event.get("turnIndex")) or self.active_turns.get(key)
                item = self.current.get(key)
                if item is not None:
                    self._append_source(item, record)
                    if turn is not None:
                        item["turn_num"] = turn
                    if item["context_tokens"] is None:
                        item["context_tokens"] = _usage_context_tokens(event.get("usage"))
                self.active_turns.pop(key, None)
            elif event_type == "message_end" and _message_role(record) == "assistant":
                item = self.starts.get(key)
                if item is None:
                    item = self._create(self._work_id(record, stamp, "turn"), record, stamp, False)
                    self._consume_pending(key, item)
                    request_index = _valid_request_index(record.get("request_index"))
                    if request_index is None:
                        request_index = _valid_request_index(event.get("requestIndex"))
                    item["request_index"] = request_index
                    item["global_turn_num"] = _valid_turn(record.get("global_turn_num"))
                    self.items.append(item)
                if item["global_turn_num"] is None:
                    item["global_turn_num"] = _valid_turn(record.get("global_turn_num"))
                item["message"] = self._message_payload(record)
                message = _message(record) or {}
                item["context_tokens"] = _usage_context_tokens(message.get("usage"))
                self._append_source(item, record)
                item["thinking_ms"] = max(0, stamp - item["start_ms"])
                item["ongoing"] = False
                self.starts.pop(key, None)
                self.current[key] = item
            elif event_type == "tool_execution_start":
                call_id = event.get("toolCallId") or self._work_id(record, stamp, "call")
                tool = {
                    "id": call_id,
                    "name": event.get("toolName") or "unknown",
                    "args": event.get("args"),
                    "start_ms": stamp,
                    "end_ms": None,
                    "progress": None,
                    "result": None,
                    "is_error": None,
                    "source_event_ids": [i for i in [_event_id(record)] if i],
                }
                self.tools[call_id] = tool
                owner = self.current.get(key)
                if owner is None:
                    owner = self._create(f"{key}:tool:{call_id}", record, stamp, False)
                    self._consume_pending(key, owner)
                    self.items.append(owner)
                    self.current[key] = owner
                owner["tools"].append(tool)
                self.tool_owners[call_id] = owner
                self._append_source(owner, record)
            elif event_type == "tool_execution_update":
                call_id = event.get("toolCallId")
                tool = self.tools.get(call_id) if call_id else None
                owner = self.tool_owners.get(call_id) if call_id else None
                if tool is not None:
                    tool["progress"] = event.get("progress")
                    self._append_source(tool, record)
                if owner is not None:
                    self._append_source(owner, record)
            elif event_type == "tool_execution_end":
                call_id = event.get("toolCallId")
                tool = self.tools.get(call_id) if call_id else None
                owner = self.tool_owners.get(call_id) if call_id else None
                if tool is not None:
                    tool["end_ms"] = stamp
                    tool["result"] = event.get("result")
                    tool["is_error"] = bool(event.get("isError"))
                    self._append_source(tool, record)
                if owner is not None:
                    self._append_source(owner, record)
                transfer = record.get(ANNOTATION_KEY, {}).get("call_return")
                if transfer:
                    received = self._create(
                        f"{key}:boundary:{call_id or record.get('sequence') or stamp}",
                        record, stamp, False,
                    )
                    received["transfer"] = {
                        key: transfer.get(key) for key in (
                            "from", "to", "trajectory_id", "attempts",
                            "dispatch_status", "execution_status",
                            "agent_outcome", "exit_code", "aborted",
                        ) if transfer.get(key) is not None
                    }
                    received["tools"].append({
                        "id": f"{call_id or stamp}:received",
                        "name": event.get("toolName") or (tool or {}).get("name") or "boundary",
                        "args": (tool or {}).get("args"),
                        "start_ms": stamp,
                        "end_ms": stamp,
                        "progress": (tool or {}).get("progress"),
                        "result": event.get("result"),
                        "is_error": bool(event.get("isError")),
                        "source_event_ids": [i for i in [_event_id(record)] if i],
                    })
                    self.items.append(received)
                if call_id:
                    self.tool_owners.pop(call_id, None)

        for item in self.starts.values():
            item["thinking_ms"] = max(0, self.cursor - item["start_ms"])
        for index, entry in enumerate(self.model_inputs):
            if index in self.matched:
                continue
            record = entry["record"]
            stamp = _stamp(record)
            item = self._create(
                f"{entry['agent_key']}:model-input:{record.get('sequence', record.get('trace_index'))}",
                record, stamp if stamp is not None else self.cursor, False,
            )
            item["model_inputs"] = [entry["request"]]
            self.items.append(item)
        return sorted(self.items, key=lambda item: item["start_ms"])

    def _inputs_for(self, key: str, request_index: int) -> list[dict]:
        matched = []
        for index, entry in enumerate(self.model_inputs):
            if index in self.matched:
                continue
            if entry["agent_key"] == key and entry["request_index"] == request_index:
                matched.append(index)
        return [self.model_inputs[i] for i in matched]

    def _fill_input_images(self, key: str, blocks: list) -> list:
        """Recover content-addressed references for user-message image blocks
        the producer recorded without a digest (only {type, mimeType}): the
        agent's first model-input request lists the same images in message
        order. Blocks are copied — cached source records are never mutated."""
        pool = self.input_image_pool.get(key)
        if not pool:
            return blocks
        filled = []
        for block in blocks:
            if (isinstance(block, dict) and block.get("type") == "image"
                    and not isinstance(block.get("path"), str) and pool):
                reference = pool.pop(0)
                filled.append({**block, **{
                    k: v for k, v in reference.items() if k != "type"
                }})
            else:
                filled.append(block)
        return filled

    def _split_echoed(self, request: dict, key: str) -> None:
        """Move new-classified images that duplicate the agent's latest user
        input into `echoed_images`: factual for counting, not re-rendered."""
        echoed = self.last_user_images.get(key)
        if not echoed:
            return
        keep, moved = [], []
        for image in request["new_images"]:
            (moved if image.get("sha256") in echoed else keep).append(image)
        if moved:
            request["new_images"] = keep
            request["echoed_images"] = moved

    def _message_payload(self, record: dict) -> dict:
        message = _message(record) or {}
        return {
            "role": message.get("role"),
            "blocks": message.get("content") if isinstance(message.get("content"), list) else [],
            "stop_reason": message.get("stopReason"),
            "error_message": message.get("errorMessage"),
            "error_code": message.get("errorCode"),
            "usage": message.get("usage") if isinstance(message.get("usage"), dict) else None,
        }


