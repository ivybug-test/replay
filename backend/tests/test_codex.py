"""Persistent Codex worker-pool behavior."""

import json
from pathlib import Path
import shutil
import unittest
from unittest.mock import patch

from backend.codex import CodexRunner


class FakeProcess:
    def poll(self):
        return None


class FakeServer:
    created = 0
    closed = 0
    thread_start_params = []
    turn_start_params = []

    def __init__(self, cwd):
        type(self).created += 1
        self.process = FakeProcess()
        self.thread_id = ''
        self.events = []

    def request(self, method, params, **kwargs):
        if method == 'thread/start':
            type(self).thread_start_params.append(params)
            self.thread_id = f'thread-{type(self).created}'
            return {'thread': {'id': self.thread_id}}
        if method == 'turn/start':
            type(self).turn_start_params.append(params)
            body = json.dumps({'ok': True})
            self.events = [
                {'method': 'item/completed', 'params': {
                    'threadId': self.thread_id,
                    'item': {'type': 'agent_message', 'text': 'working through tools'},
                }},
                {'method': 'item/completed', 'params': {
                    'threadId': self.thread_id,
                    'item': {'type': 'agent_message', 'text': body},
                }},
                {'method': 'turn/completed', 'params': {
                    'threadId': self.thread_id, 'turn': {'status': 'completed'},
                }},
            ]
            return {'turn': {'id': 'turn-1'}}
        raise AssertionError(method)

    def next_message(self, **kwargs):
        return self.events.pop(0)

    def close(self):
        type(self).closed += 1


class FakeToolServer(FakeServer):
    responses = []

    def request(self, method, params, **kwargs):
        if method == 'turn/start':
            type(self).turn_start_params.append(params)
            body = json.dumps({'ok': True})
            self.events = [
                {'id': 91, 'method': 'item/tool/call', 'params': {
                    'threadId': self.thread_id, 'tool': 'get_artifact',
                    'arguments': {'path': 'screen.png'},
                }},
                {'method': 'item/completed', 'params': {
                    'threadId': self.thread_id,
                    'item': {'type': 'agent_message', 'text': body},
                }},
                {'method': 'turn/completed', 'params': {
                    'threadId': self.thread_id, 'turn': {'status': 'completed'},
                }},
            ]
            return {'turn': {'id': 'turn-1'}}
        return super().request(method, params, **kwargs)

    def respond(self, request_id, result):
        type(self).responses.append((request_id, result))


class CodexRunnerTests(unittest.TestCase):
    def setUp(self):
        FakeServer.created = FakeServer.closed = 0
        FakeServer.thread_start_params = []
        FakeServer.turn_start_params = []
        FakeToolServer.responses = []

    @patch('backend.codex._AppServer', FakeServer)
    def test_sequential_calls_reuse_and_periodically_recycle_worker(self):
        runner = CodexRunner(workers=2, recycle_after=2)
        arguments = {
            'schema': {'type': 'object'}, 'model': 'gpt-test',
            'developer_instructions': 'test', 'timeout': 2,
        }
        self.assertEqual(runner.run_json('one', **arguments), {'ok': True})
        self.assertEqual(runner.run_json('two', **arguments), {'ok': True})
        self.assertTrue(all(
            params.get('ephemeral') is True
            for params in FakeServer.thread_start_params
        ))
        self.assertEqual(FakeServer.created, 1)
        self.assertEqual(FakeServer.closed, 1)
        self.assertEqual(runner.run_json('three', **arguments), {'ok': True})
        self.assertEqual(FakeServer.created, 2)
        runner.close()
        self.assertEqual(FakeServer.closed, 2)

    @patch('backend.codex._AppServer', FakeServer)
    def test_worker_with_deleted_working_directory_is_replaced(self):
        runner = CodexRunner(workers=1)
        arguments = {
            'schema': {'type': 'object'}, 'model': 'gpt-test',
            'developer_instructions': 'test', 'timeout': 2,
        }
        try:
            self.assertEqual(runner.run_json('one', **arguments), {'ok': True})
            old_cwd = FakeServer.thread_start_params[-1]['cwd']
            shutil.rmtree(old_cwd)
            self.assertEqual(runner.run_json('two', **arguments), {'ok': True})
            new_cwd = FakeServer.thread_start_params[-1]['cwd']
            self.assertNotEqual(new_cwd, old_cwd)
            self.assertTrue(Path(new_cwd).is_dir())
            self.assertEqual(FakeServer.created, 2)
            self.assertEqual(FakeServer.closed, 1)
        finally:
            runner.close()
        self.assertFalse(Path(new_cwd).exists())
        self.assertEqual(FakeServer.closed, 2)

    @patch('backend.codex._AppServer', FakeServer)
    def test_unbounded_turn_ignores_wall_timeout(self):
        runner = CodexRunner(workers=1)
        try:
            value = runner.run_json(
                'analyze', schema={'type': 'object'}, model='gpt-test',
                developer_instructions='test', timeout=-1, unbounded=True,
            )
            self.assertEqual(value, {'ok': True})
        finally:
            runner.close()

    @patch('backend.codex._AppServer', FakeServer)
    def test_explicit_skill_is_sent_as_native_turn_input(self):
        runner = CodexRunner(workers=1)
        try:
            runner.run_json(
                'analyze', schema={'type': 'object'}, model='gpt-test',
                developer_instructions='test', timeout=2,
                skills=[{'name': 'single-task-execution-analysis',
                         'path': '/srv/replay/skills/single-task-execution-analysis/SKILL.md'}],
            )
            self.assertEqual(FakeServer.turn_start_params[-1]['input'], [
                {'type': 'skill', 'name': 'single-task-execution-analysis',
                 'path': '/srv/replay/skills/single-task-execution-analysis/SKILL.md'},
                {'type': 'text', 'text': 'analyze'},
            ])
        finally:
            runner.close()

    @patch('backend.codex._AppServer', FakeToolServer)
    def test_dynamic_tool_can_return_image_content(self):
        runner = CodexRunner(workers=1)
        try:
            value = runner.run_json(
                'analyze', schema={'type': 'object'}, model='gpt-test',
                developer_instructions='test', timeout=2,
                tools=[{'name': 'get_artifact'}],
                tool_handler=lambda _name, _args: {'_codex_content_items': [
                    {'type': 'inputText', 'text': '{"path":"screen.png"}'},
                    {'type': 'inputImage', 'imageUrl': 'data:image/png;base64,AA=='},
                ]},
            )
            self.assertEqual(value, {'ok': True})
            self.assertEqual(FakeToolServer.responses, [(91, {
                'contentItems': [
                    {'type': 'inputText', 'text': '{"path":"screen.png"}'},
                    {'type': 'inputImage', 'imageUrl': 'data:image/png;base64,AA=='},
                ],
                'success': True,
            })])
        finally:
            runner.close()


if __name__ == '__main__':
    unittest.main()
