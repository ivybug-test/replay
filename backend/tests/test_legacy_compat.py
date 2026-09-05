"""Synthetic compatibility pins migrated with the legacy fold from oss-replay."""

import unittest

from backend.parsers.legacy_trace import annotate_for_work, build_episode_work

from backend.parsers.legacy_work_helpers import agent_label

def record(index: int, stamp: int, role: str, event_type: str, agent: str | None = None,
           origin: str | None = None, **event) -> dict:
    return {
        "trace_index": index, "episode_elapsed_ms": stamp, "sequence": index + 1,
        "role": f"stateact_{role}", "agentId": agent or f"{role}-agent",
        **({"origin": origin} if origin else {}),
        "event": {"type": event_type, **event},
    }

def user_message_end(index, stamp, role="main", **extra):
    return record(index, stamp, role, "message_end", message={
        "role": "user", "content": [{"type": "text", "text": "do the thing"}],
    }, **extra)

class WorkModelTests(unittest.TestCase):

    def work(self, records, cursor=10_000, **kwargs):
        return build_episode_work(annotate_for_work(records), cursor, **kwargs)

    def test_assistant_turn_folds_message_tools_and_turn_end(self):
        zero_usage = {"input": 1, "output": 1, "totalTokens": 2}
        records = [
            user_message_end(0, 0),
            record(1, 100, "main", "message_start", message={"role": "assistant", "content": []},
                   global_turn_num=1),
            record(2, 110, "main", "tool_execution_start", toolCallId="call-1",
                   toolName="bash", args={"cmd": "ls"}),
            record(3, 150, "main", "tool_execution_update", toolCallId="call-1",
                   progress={"partial": "file"}),
            record(4, 200, "main", "tool_execution_end", toolCallId="call-1",
                   toolName="bash", result={"text": "file"}, isError=False),
            record(5, 210, "main", "message_end", message={"role": "assistant",
                "content": [
                    {"type": "thinking", "text": "plan"},
                    {"type": "toolCall", "name": "bash", "toolCallId": "call-1",
                     "arguments": {"cmd": "ls"}},
                    {"type": "text", "text": "ran ls"},
                ], "usage": zero_usage,
                "stopReason": "endTurn"}, global_turn_num=1),
            record(6, 220, "main", "turn_end", turnIndex=0, usage=zero_usage),
        ]
        work = self.work(records, cursor=300)
        self.assertEqual(len(work["items"]), 2)  # user input + assistant turn
        turn = work["items"][1]
        self.assertEqual(turn["label"], "stateact_main")
        self.assertEqual(turn["global_turn_num"], 1)
        self.assertEqual(turn["turn_num"], 1)
        self.assertEqual(turn["context_tokens"], 1)  # input + cacheRead + cacheWrite
        self.assertFalse(turn["ongoing"])
        self.assertEqual(turn["thinking_ms"], 110)
        self.assertEqual(len(turn["tools"]), 1)
        tool = turn["tools"][0]
        self.assertEqual((tool["name"], tool["start_ms"], tool["end_ms"]), ("bash", 110, 200))
        self.assertEqual(tool["result"], {"text": "file"})
        self.assertFalse(tool["is_error"])
        # Details interleave blocks with the matched tool.
        self.assertEqual([d["kind"] for d in turn["details"]],
                         ["thinking", "tool", "text"])
        self.assertEqual(turn["details"][1]["tool_id"], "call-1")

    def test_ongoing_assistant_without_end_uses_cursor(self):
        records = [
            record(0, 100, "main", "message_start", message={"role": "assistant", "content": []}),
            record(1, 110, "main", "tool_execution_start", toolCallId="c", toolName="bash"),
        ]
        work = self.work(records, cursor=5_000)
        ongoing = work["items"][0]
        self.assertTrue(ongoing["ongoing"])
        self.assertEqual(ongoing["thinking_ms"], 4_900)
        self.assertIsNone(ongoing["tools"][0]["end_ms"])

        terminal = self.work(records, cursor=5_000, terminal=True)
        interrupted = terminal["items"][0]
        self.assertFalse(interrupted["ongoing"])
        self.assertEqual(interrupted["tools"][0]["end_ms"], 5_000)
        self.assertTrue(interrupted["tools"][0]["is_error"])
        self.assertEqual(
            interrupted["tools"][0]["result"]["details"]["status"],
            "interrupted",
        )

    def test_transfer_item_on_delegation_edge(self):
        records = [
            record(0, 0, "main", "agent_start"),
            record(1, 10, "main", "tool_execution_start", toolCallId="task-1",
                   toolName="task", args={"agent": "stateact_gui"}),
            record(2, 20, "gui", "agent_start", agent="gui-agent", origin="gui_worker"),
            record(3, 30, "gui", "message_end", agent="gui-agent", origin="gui_worker",
                   message={"role": "assistant", "content": [{"type": "text", "text": "ok"}]}),
            record(4, 40, "main", "tool_execution_end", toolCallId="task-1",
                   toolName="task", result={"text": "report"}, isError=False),
        ]
        work = self.work(records, cursor=100)
        transfers = [item for item in work["items"] if item.get("transfer")]
        self.assertEqual(len(transfers), 1)
        self.assertEqual(transfers[0]["transfer"], {
            "from": "GUI", "to": "MAIN", "attempts": 1,
            "execution_status": "success",
        })
        self.assertEqual(transfers[0]["tools"][0]["name"], "task")

    def test_model_input_matches_assistant_request_and_labels_agent(self):
        image = {"sha256": "a" * 64, "bytes": 10, "mimeType": "image/png",
                 "path": f"frames/{'a' * 64}.png"}
        records = [
            record(0, 0, "gui", "model_input_images", agent="gui-agent",
                   origin="gui_reviewer", requestIndex=0, images=[image],
                   newImageIndexes=[0], contextImageIndexes=[]),
            record(1, 10, "gui", "message_start", agent="gui-agent",
                   origin="gui_reviewer", message={"role": "assistant", "content": []},
                   requestIndex=0),
        ]
        work = self.work(records, cursor=100)
        self.assertEqual(len(work["items"]), 1)
        item = work["items"][0]
        self.assertEqual(item["label"], "stateact_gui · reviewer")
        self.assertEqual(item["model_inputs"][0]["images"], [image])
        self.assertTrue(item["model_inputs"][0]["classification_known"])
        # The model-input event id is part of the item's evidence ids.
        self.assertIn("trace:0", item["source_event_ids"])

    def test_unmatched_model_input_becomes_its_own_item(self):
        image = {"sha256": "b" * 64, "bytes": 4, "mimeType": "image/png",
                 "path": f"frames/{'b' * 64}.png"}
        records = [
            # A participant agent (it has an assistant message later) whose
            # model-input request never matches an assistant start index.
            record(0, 50, "gui", "model_input_images", agent="gui-agent",
                   images=[image], requestIndex=0),
            record(1, 60, "gui", "message_start", agent="gui-agent",
                   message={"role": "assistant", "content": []}, requestIndex=7),
        ]
        work = self.work(records, cursor=100)
        standalone = [i for i in work["items"] if i["model_inputs"]]
        self.assertEqual(len(standalone), 1)
        self.assertEqual(standalone[0]["model_inputs"][0]["images"], [image])
        self.assertEqual(standalone[0]["agent_id"], "gui-agent")

    def test_turn_items_expose_request_index_on_both_creation_paths(self):
        # The index joins a turn item to the standalone model-input item its
        # request may have produced in a window that missed the response.
        full = [
            record(0, 10, "gui", "message_start", agent="gui-agent",
                   message={"role": "assistant", "content": []}, requestIndex=3),
            record(1, 20, "gui", "message_end", agent="gui-agent",
                   message={"role": "assistant", "content": []}, requestIndex=3),
        ]
        self.assertEqual(self.work(full, cursor=100)["items"][0]["request_index"], 3)
        # A window that only contains the message_end reconstructs the turn
        # from that record and must still expose the request index.
        tail_only = [full[1]]
        self.assertEqual(
            self.work(tail_only, cursor=100)["items"][0]["request_index"], 3)

    def test_observer_only_model_inputs_are_suppressed(self):
        image = {"sha256": "c" * 64, "bytes": 4, "mimeType": "image/png",
                 "path": f"frames/{'c' * 64}.png"}
        records = [
            record(0, 50, "gui", "model_input_images", agent="gui-agent",
                   images=[image], requestIndex=0),
        ]
        work = self.work(records, cursor=100)
        self.assertEqual(work["items"], [])

    def test_pi_era_roles_get_assignment_labels_via_synthetic_origin(self):
        records = [
            record(0, 0, "gui_reviewer", "message_start",
                   agent="stateact_gui_reviewer-x", message={"role": "assistant", "content": []}),
        ]
        # The loader synthesizes origin from the pi-era role suffix; the
        # projection then labels the assignment, not just the role.
        for item_record in records:
            item_record.setdefault("origin", "gui_reviewer")
        work = self.work(records, cursor=100)
        self.assertEqual(work["items"][0]["label"], "stateact_gui_reviewer · reviewer")

class DispatchStateTests(unittest.TestCase):

    def work(self, records, cursor=10_000):
        return build_episode_work(annotate_for_work(records), cursor)

    def test_computer_probe_binds_to_child_assignment_with_attach_outcome(self):
        records = [
            orchestration(0, 0, "delegation_state", stage="probe", surface="computer",
                          attached=True, path="/run/delegation-state/x.png"),
            orchestration(1, 5, "subagent_lifecycle", agent="stateact_gui",
                          id="gui-1", status="started"),
            record(2, 10, "gui", "message_start", agent="gui-1",
                   message={"role": "user", "content": []}),
            record(3, 20, "gui", "message_end", agent="gui-1", message={
                "role": "user", "content": [{"type": "text", "text": "open the app"}],
            }),
            orchestration(4, 25, "delegation_state", stage="attach",
                          childId="gui-1", attached=True),
            record(5, 30, "gui", "message_start", agent="gui-1",
                   message={"role": "assistant", "content": []}),
        ]
        work = self.work(records)
        [assignment] = [item for item in work["items"] if (item.get("message") or {}).get("role") == "user"]
        self.assertEqual(assignment["dispatch"], {
            "surface": "computer", "probe_attached": True,
            "path": "/run/delegation-state/x.png", "attach_attached": True,
        })

    def test_browser_probe_carries_tab_count_and_no_attach(self):
        records = [
            orchestration(0, 0, "delegation_state", stage="probe", surface="browser",
                          attached=True, browser={"running": True, "port": 9222, "tabs": [
                              {"title": "Docs", "url": "https://docs.local"},
                              {"title": "Mail", "url": "https://mail.local"},
                          ]}),
            orchestration(1, 5, "subagent_lifecycle", agent="stateact_browser",
                          id="brw-1", status="started"),
            user_message_end(2, 10, "browser", agent="brw-1"),
        ]
        work = self.work(records)
        [assignment] = [item for item in work["items"] if (item.get("message") or {}).get("role") == "user"]
        self.assertEqual(assignment["dispatch"], {
            "surface": "browser", "probe_attached": True, "tabs": 2,
        })
        # Only the first input item carries the dispatch; a second input for
        # the same child stays unannotated.
        records.append(user_message_end(4, 100, "browser", agent="brw-1"))
        work = self.work(records)
        annotated = [item for item in work["items"]
                     if (item.get("message") or {}).get("role") == "user" and item.get("dispatch")]
        self.assertEqual(len(annotated), 1)

    def test_unbound_probe_and_non_gui_lifecycle_annotate_nothing(self):
        records = [
            orchestration(0, 0, "delegation_state", stage="probe", surface="computer",
                          attached=True, path="/run/x.png"),
            # A gate spawn consumes no probe: only GUI roles bind.
            orchestration(1, 5, "subagent_lifecycle", agent="stateact_gate",
                          id="gate-1", status="started"),
            user_message_end(2, 10, "gate", agent="gate-1"),
            # Later GUI child without a preceding probe stays unannotated.
            orchestration(3, 20, "subagent_lifecycle", agent="stateact_gui",
                          id="gui-2", status="started"),
            user_message_end(4, 30, "gui", agent="gui-2"),
        ]
        work = self.work(records)
        self.assertTrue(all("dispatch" not in item for item in work["items"]))

class AgentLabelTests(unittest.TestCase):

    def test_qualifies_known_origins_and_leaves_roles_alone(self):
        self.assertEqual(agent_label("stateact_gui", "gui_worker"), "stateact_gui · worker")
        self.assertEqual(agent_label("stateact_gui", "gui_reviewer"), "stateact_gui · reviewer")
        self.assertEqual(agent_label("stateact_main", "main"), "stateact_main")
        self.assertEqual(agent_label("stateact_gate", None), "stateact_gate")
        self.assertEqual(agent_label(None, None), "agent")

class EchoedInputImageTests(unittest.TestCase):

    def test_input_images_render_inline_and_are_not_repeated_in_prelude(self):
        image = {"type": "image", "sha256": "e" * 64, "bytes": 100,
                 "mimeType": "image/png", "path": f"frames/{'e' * 64}.png"}
        records = [
            record(0, 0, "main", "message_end", message={"role": "user", "content": [
                {"type": "text", "text": "instruction"},
                image,
            ]}),
            record(1, 100, "main", "model_input_images", requestIndex=0,
                   images=[image], newImageIndexes=[0], contextImageIndexes=[]),
            record(2, 110, "main", "message_start", message={"role": "assistant", "content": []}),
        ]
        work = build_episode_work(annotate_for_work(records), cursor_ms=200)
        user_item = work["items"][0]
        self.assertEqual(user_item["message"]["role"], "user")
        # The input item carries the image block for inline rendering.
        self.assertIn(image, user_item["message"]["blocks"])
        turn = work["items"][1]
        request = turn["model_inputs"][0]
        self.assertEqual(request["images"], [image])
        # Factually new for the model, but already rendered in the input:
        # the prelude skips it and counts it as echoed instead.
        self.assertEqual(request["new_images"], [])
        self.assertEqual(request["echoed_images"], [image])
        self.assertTrue(request["classification_known"])

    def test_pathless_input_image_blocks_recover_references_from_first_request(self):
        """Real producer shape: the user-message image block records without
        sha256/path; the same image's content-addressed reference lives in the
        agent's first model_input_images request."""
        reference = {"sha256": "f" * 64, "bytes": 12, "mimeType": "image/png",
                     "path": f"frames/{'f' * 64}.png"}
        records = [
            record(0, 0, "main", "message_end", message={"role": "user", "content": [
                {"type": "text", "text": "look"},
                {"type": "image", "mimeType": "image/png"},
            ]}),
            record(1, 100, "main", "model_input_images", requestIndex=0,
                   images=[reference], newImageIndexes=[0], contextImageIndexes=[]),
            record(2, 110, "main", "message_start", message={"role": "assistant", "content": []}),
        ]
        work = build_episode_work(annotate_for_work(records), cursor_ms=200)
        user_item = work["items"][0]
        image_block = user_item["message"]["blocks"][1]
        self.assertEqual(image_block["path"], reference["path"])
        self.assertEqual(image_block["sha256"], reference["sha256"])
        turn = work["items"][1]
        request = turn["model_inputs"][0]
        self.assertEqual(request["new_images"], [])
        self.assertEqual(request["echoed_images"], [reference])


def orchestration(index: int, stamp: int, event: str, **fields) -> dict:
    return {
        "trace_index": index, "episode_elapsed_ms": stamp, "sequence": index + 1,
        "category": "orchestration", "event": event, **fields,
    }
