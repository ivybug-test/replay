"""ATIF analysis projection preserves turns and standard subagent links."""

import unittest

from backend.aft_atif import build_aft_trace


class AtifAnalysisTests(unittest.TestCase):
    def test_turns_and_call_edges_do_not_require_harness_extensions(self):
        child = {
            'schema_version': 'ATIF-v1.8', 'trajectory_id': 'child',
            'agent': {'name': 'worker', 'version': '1'},
            'steps': [
                {'step_id': 1, 'source': 'user', 'timestamp': '2026-09-06T00:00:02Z',
                 'message': 'delegated task'},
                {'step_id': 2, 'source': 'agent', 'timestamp': '2026-09-06T00:00:03Z',
                 'message': 'done'},
            ],
        }
        root = {
            'schema_version': 'ATIF-v1.8', 'trajectory_id': 'root',
            'agent': {'name': 'producer', 'version': '1', 'extra': {
                'any_future_harness': {'role': 'suite_planner'},
            }},
            'steps': [
                {'step_id': 1, 'source': 'user', 'timestamp': '2026-09-06T00:00:00Z',
                 'message': 'task'},
                {'step_id': 2, 'source': 'agent', 'timestamp': '2026-09-06T00:00:01Z',
                 'message': 'delegate', 'reasoning_content': 'need help',
                 'tool_calls': [{'tool_call_id': 'call-1', 'function_name': 'delegate',
                                 'arguments': {'agent': 'suite_coder', 'i': 'Inspect files',
                                               'task': 'delegated task'}}],
                 'observation': {'results': [{
                     'source_call_id': 'call-1', 'content': 'accepted',
                     'subagent_trajectory_ref': [{'trajectory_id': 'child'}],
                 }]}},
            ],
            'subagent_trajectories': [child],
        }
        value = build_aft_trace(root, started_at='2026-09-06T00:00:00Z')
        self.assertEqual(value['turn_count'], 2)
        self.assertEqual(value['agent_count'], 2)
        self.assertEqual([item['global_turn'] for item in value['turns']], [1, 2])
        self.assertEqual(value['turns'][0]['inputs'][0]['message'], 'task')
        self.assertEqual(value['turns'][0]['at_ms'], 1000)
        self.assertEqual(value['call_edges'], [{
            'parent_trajectory_id': 'root', 'child_trajectory_id': 'child',
            'parent_turn': 1, 'tool_call_id': 'call-1', 'tool_name': 'delegate',
        }])
        self.assertEqual(value['agents'][1]['assignment'], 'delegated task')
        self.assertEqual([item['role'] for item in value['agents']], ['planner', 'coder'])
        self.assertEqual([item['declared_role'] for item in value['agents']],
                         ['suite_planner', 'suite_coder'])
        self.assertEqual(value['analysis_input_quality'], {
            'trace_coverage': 1.0, 'missing_event_types': [],
            'provenance_complete': True, 'limits_mapping_confidence': False,
        })

    def test_missing_tool_result_is_input_quality_not_agent_issue(self):
        value = build_aft_trace({
            'schema_version': 'ATIF-v1.8', 'trajectory_id': 'root',
            'steps': [{'step_id': 1, 'source': 'agent',
                       'timestamp': '2026-09-06T00:00:00Z',
                       'tool_calls': [{'tool_call_id': 'call-1',
                                      'function_name': 'read', 'arguments': {}}]}],
        })
        self.assertIn('tool_result', value['analysis_input_quality']['missing_event_types'])
        self.assertTrue(value['analysis_input_quality']['limits_mapping_confidence'])


if __name__ == '__main__':
    unittest.main()
