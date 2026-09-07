"""Isolated Codex App Server client for structured AFT workers."""

from __future__ import annotations

import json
import os
from pathlib import Path
import queue
import shutil
import shlex
import subprocess
import tempfile
import threading
import time
from typing import Any, Callable


class CodexError(RuntimeError):
    pass


class CodexCancelled(CodexError):
    pass


_DISABLED_FEATURES = (
    'apps', 'browser_use', 'browser_use_external', 'browser_use_full_cdp_access',
    'computer_use', 'goals', 'hooks', 'image_generation', 'multi_agent', 'plugins',
    'remote_plugin', 'shell_snapshot', 'shell_tool', 'skill_search', 'tool_suggest',
    'unified_exec', 'view_image', 'workspace_dependencies',
)


def _app_server_executable() -> str:
    """Prefer the packaged native binary, avoiding one Node shim per worker."""
    override = os.environ.get('REPLAY_CODEX_BINARY')
    if override and Path(override).is_file() and os.access(override, os.X_OK):
        return override
    wrapper = shutil.which('codex') or 'codex'
    resolved = Path(wrapper).resolve()
    if resolved.is_file() and resolved.suffix != '.js':
        try:
            lines = resolved.read_text(errors='replace')[:16_384].splitlines()
        except OSError:
            lines = []
        for line in reversed(lines):
            try:
                parts = shlex.split(line.strip())
            except ValueError:
                continue
            if len(parts) >= 2 and parts[0] == 'exec' and Path(parts[1]).is_absolute() \
                    and Path(parts[1]).name == 'codex':
                resolved = Path(parts[1]).resolve()
                break
    # Standard npm installation: @openai/codex/bin/codex.js plus one
    # platform package below @openai/codex/node_modules/@openai/.
    if resolved.name == 'codex.js' and resolved.parent.name == 'bin':
        candidates = sorted(resolved.parent.parent.glob(
            'node_modules/@openai/codex-*/vendor/*/bin/codex'
        ))
        executable = [item for item in candidates if item.is_file() and os.access(item, os.X_OK)]
        if len(executable) == 1:
            return str(executable[0])
    return wrapper


class _AppServer:
    """Small single-threaded JSONL RPC bridge; one instance serves one worker."""

    def __init__(self, cwd: str):
        command = [_app_server_executable(), 'app-server', '-c', 'mcp_servers={}',
                   '-c', 'web_search="live"']
        for feature in _DISABLED_FEATURES:
            command.extend(('--disable', feature))
        self.process = subprocess.Popen(
            command, cwd=cwd, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, text=True, bufsize=1,
            env={**os.environ, 'PYTHONUNBUFFERED': '1'},
        )
        self.messages: queue.Queue[dict | None] = queue.Queue()
        self.stderr = bytearray()
        self._request_id = 0
        self._write_lock = threading.Lock()
        self._reader = threading.Thread(target=self._read_stdout, daemon=True)
        self._errors = threading.Thread(target=self._read_stderr, daemon=True)
        self._reader.start()
        self._errors.start()
        self.request('initialize', {
            'clientInfo': {'name': 'replay_aft', 'title': 'Replay AFT', 'version': '0.1.0'},
            'capabilities': {'experimentalApi': True, 'requestAttestation': False},
        }, timeout=30)
        self.notify('initialized', {})

    def _read_stdout(self):
        try:
            for line in self.process.stdout or ():
                try:
                    value = json.loads(line)
                except ValueError:
                    continue
                if not isinstance(value, dict):
                    continue
                # App Server emits high-volume reasoning/text deltas. This
                # client only needs RPC responses, the final agent message and
                # turn completion. Filtering before the unbounded hand-off
                # queue prevents one long trace from retaining hundreds of MiB.
                if 'id' in value:
                    self.messages.put(value)
                    continue
                method = value.get('method')
                if method == 'turn/completed':
                    self.messages.put(value)
                elif method == 'item/completed':
                    params = value.get('params')
                    item = params.get('item') if isinstance(params, dict) else None
                    item_type = str(item.get('type', '') if isinstance(item, dict) else '')
                    if 'agentmessage' in item_type.replace('_', '').lower():
                        self.messages.put(value)
        finally:
            self.messages.put(None)

    def _read_stderr(self):
        for chunk in iter(lambda: (self.process.stderr.read(4096) if self.process.stderr else ''), ''):
            encoded = chunk.encode('utf-8', errors='replace')
            self.stderr.extend(encoded)
            if len(self.stderr) > 64 * 1024:
                del self.stderr[:-64 * 1024]

    def send(self, value: dict):
        body = json.dumps(value, ensure_ascii=True, separators=(',', ':'))
        with self._write_lock:
            if self.process.poll() is not None or self.process.stdin is None:
                raise CodexError('Codex App Server is not running')
            self.process.stdin.write(body + '\n')
            self.process.stdin.flush()

    def notify(self, method: str, params: dict):
        self.send({'method': method, 'params': params})

    def respond(self, request_id: Any, result: dict):
        """Respond to an App Server initiated JSON-RPC request."""
        self.send({'id': request_id, 'result': result})

    def request(self, method: str, params: dict, *, timeout: float = 30,
                notification=None):
        self._request_id += 1
        request_id = self._request_id
        self.send({'method': method, 'id': request_id, 'params': params})
        deadline = time.monotonic() + timeout
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise CodexError(f'Codex {method} timed out')
            try:
                message = self.messages.get(timeout=remaining)
            except queue.Empty as exc:
                raise CodexError(f'Codex {method} timed out') from exc
            if message is None:
                error = bytes(self.stderr).decode('utf-8', errors='replace')[-2000:]
                raise CodexError(f'Codex App Server closed unexpectedly: {error}')
            if message.get('id') == request_id:
                if isinstance(message.get('error'), dict):
                    error = message['error']
                    raise CodexError(f'Codex {method} failed: {error.get("message", "unknown error")}')
                return message.get('result')
            if 'method' in message and 'id' not in message and notification:
                notification(message)

    def next_message(self, *, timeout: float):
        try:
            message = self.messages.get(timeout=timeout)
        except queue.Empty:
            return {}
        if message is None:
            error = bytes(self.stderr).decode('utf-8', errors='replace')[-2000:]
            raise CodexError(f'Codex App Server closed unexpectedly: {error}')
        return message

    def close(self):
        if self.process.stdin:
            try:
                self.process.stdin.close()
            except OSError:
                pass
        if self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=3)


class _ServerSlot:
    """A recyclable app-server process owned by one pool borrower at a time."""

    def __init__(self, recycle_after: int):
        self.recycle_after = recycle_after
        self.uses = 0
        self.directory: tempfile.TemporaryDirectory | None = None
        self.server: _AppServer | None = None

    def acquire(self) -> _AppServer:
        if self.server is None or self.server.process.poll() is not None:
            self.close()
            self.directory = tempfile.TemporaryDirectory(prefix='replay-aft-worker-')
            self.server = _AppServer(self.directory.name)
            self.uses = 0
        return self.server

    def used(self):
        self.uses += 1
        if self.uses >= self.recycle_after:
            self.close()

    def close(self):
        if self.server is not None:
            self.server.close()
            self.server = None
        if self.directory is not None:
            self.directory.cleanup()
            self.directory = None
        self.uses = 0


class CodexRunner:
    """Run isolated structured turns on a bounded persistent app-server pool."""

    def __init__(self, *, timeout: float = 900, workers: int = 4,
                 recycle_after: int = 24):
        if workers < 1 or recycle_after < 1:
            raise ValueError('workers and recycle_after must be positive')
        self.timeout = timeout
        self._models: dict | None = None
        self._models_at = 0.0
        self._models_lock = threading.Lock()
        self._pool: queue.LifoQueue[_ServerSlot] = queue.LifoQueue(workers)
        self._slots = [_ServerSlot(recycle_after) for _ in range(workers)]
        for slot in self._slots:
            self._pool.put(slot)
        self._closed = False
        self._close_lock = threading.Lock()

    def models(self) -> dict:
        with self._models_lock:
            if self._models is not None and time.monotonic() - self._models_at < 300:
                return self._models
        try:
            completed = subprocess.run(
                ['codex', 'debug', 'models'], check=True, capture_output=True,
                text=True, timeout=30,
            )
            document = json.loads(completed.stdout)
        except (OSError, subprocess.SubprocessError, ValueError) as exc:
            raise CodexError('Could not load the Codex model catalog') from exc
        output = []
        for item in document.get('models', []):
            if not isinstance(item, dict) or item.get('visibility') not in (None, 'list'):
                continue
            model = item.get('slug') or item.get('model') or item.get('id')
            if not isinstance(model, str) or not model:
                continue
            output.append({
                'id': model, 'model': model,
                'displayName': item.get('display_name') or item.get('displayName') or model,
                'description': item.get('description') or '',
                'isDefault': bool(item.get('is_default') or item.get('isDefault')),
                'defaultReasoningEffort': item.get('default_reasoning_level') or item.get('defaultReasoningEffort'),
                'supportedReasoningEfforts': [
                    {'reasoningEffort': effort.get('effort') or effort.get('reasoningEffort'),
                     'description': effort.get('description') or ''}
                    for effort in item.get('supported_reasoning_levels', item.get('supportedReasoningEfforts', []))
                    if isinstance(effort, dict)
                ],
                'inputModalities': item.get('input_modalities', item.get('inputModalities', ['text'])),
            })
        if output and not any(item['isDefault'] for item in output):
            output[0]['isDefault'] = True
        document = {'models': output}
        with self._models_lock:
            self._models, self._models_at = document, time.monotonic()
        return document

    def run_json(self, prompt: str, *, schema: dict, model: str,
                 developer_instructions: str, effort: str = 'medium',
                 timeout: float | None = None,
                 unbounded: bool = False,
                 cancel_event: threading.Event | None = None,
                 tools: list[dict] | None = None,
                 skills: list[dict[str, str]] | None = None,
                 tool_handler: Callable[[str, Any], Any] | None = None,
                 tool_audit: list[dict] | None = None,
                 on_tool_call: Callable[[dict], None] | None = None,
                 max_tool_calls: int = 128) -> dict:
        deadline = None if unbounded else time.monotonic() + (
            timeout if timeout is not None else self.timeout
        )

        def remaining(limit: float = 30) -> float:
            if cancel_event is not None and cancel_event.is_set():
                raise CodexCancelled('Codex analysis cancelled')
            if deadline is None:
                return limit
            value = deadline - time.monotonic()
            if value <= 0:
                raise CodexError('Codex analysis timed out')
            return min(value, limit)

        slot = None
        while slot is None:
            with self._close_lock:
                if self._closed:
                    raise CodexError('Codex runner is closed')
            try:
                slot = self._pool.get(timeout=remaining(1))
            except queue.Empty:
                continue
        healthy = False
        messages: list[str] = []
        try:
            client = slot.acquire()
            thread_params = {
                    'model': model, 'cwd': slot.directory.name, 'approvalPolicy': 'never',
                    'sandbox': 'read-only', 'developerInstructions': developer_instructions,
                    'serviceName': 'replay_aft', 'ephemeral': True,
                    'config': {'mcp_servers': {}},
                }
            if tools:
                if tool_handler is None:
                    raise ValueError('tool_handler is required when dynamic tools are supplied')
                thread_params['dynamicTools'] = tools
            thread_result = client.request('thread/start', thread_params, timeout=remaining())
            thread = thread_result.get('thread') if isinstance(thread_result, dict) else None
            thread_id = thread.get('id') if isinstance(thread, dict) else None
            if not isinstance(thread_id, str):
                raise CodexError('Codex did not return a thread id')
            turn_input = []
            for skill in skills or []:
                name, path = skill.get('name'), skill.get('path')
                if not isinstance(name, str) or not name or not isinstance(path, str) or not path:
                    raise ValueError('skill inputs require non-empty name and path')
                turn_input.append({'type': 'skill', 'name': name, 'path': path})
            turn_input.append({'type': 'text', 'text': prompt})
            turn_result = client.request('turn/start', {
                    'threadId': thread_id,
                    'input': turn_input,
                    'model': model, 'effort': effort, 'outputSchema': schema,
                    'approvalPolicy': 'never',
                    'sandboxPolicy': {'type': 'readOnly', 'networkAccess': True},
                }, timeout=remaining())
            turn = turn_result.get('turn') if isinstance(turn_result, dict) else None
            turn_id = turn.get('id') if isinstance(turn, dict) else None
            if not isinstance(turn_id, str):
                raise CodexError('Codex did not return a turn id')
            tool_call_count = 0
            while True:
                event = client.next_message(timeout=remaining(1 if cancel_event else 30))
                method, params = event.get('method'), event.get('params')
                if not isinstance(params, dict) or params.get('threadId') != thread_id:
                    continue
                if method == 'item/tool/call' and 'id' in event:
                    tool_call_count += 1
                    if tool_call_count > max_tool_calls:
                        raise CodexError('Codex analysis exceeded the dynamic tool-call limit')
                    tool = str(params.get('tool') or '')
                    arguments = params.get('arguments')
                    started = time.monotonic()
                    success = True
                    try:
                        output = tool_handler(tool, arguments) if tool_handler else None
                        content_items = (output.get('_codex_content_items')
                                         if isinstance(output, dict) else None)
                        if not isinstance(content_items, list):
                            text = output if isinstance(output, str) else json.dumps(
                                output, ensure_ascii=False, sort_keys=True,
                            )
                            content_items = [{'type': 'inputText', 'text': text}]
                    except Exception as exc:
                        success = False
                        content_items = [{'type': 'inputText',
                                          'text': f'{type(exc).__name__}: {exc}'[:4000]}]
                    audit = {
                        'sequence': tool_call_count, 'tool': tool, 'success': success,
                        'arguments': arguments if isinstance(arguments, dict) else {},
                        'duration_ms': round((time.monotonic() - started) * 1000),
                    }
                    if tool_audit is not None:
                        tool_audit.append(audit)
                    if on_tool_call is not None:
                        on_tool_call(audit)
                    client.respond(event['id'], {
                        'contentItems': content_items,
                        'success': success,
                    })
                elif method == 'item/completed':
                    item = params.get('item')
                    if isinstance(item, dict) and 'agentmessage' in str(item.get('type', '')).replace('_', '').lower():
                        value = item.get('text')
                        if isinstance(value, str) and value.strip():
                            messages.append(value)
                elif method == 'turn/completed':
                    final_turn = params.get('turn')
                    status = final_turn.get('status') if isinstance(final_turn, dict) else 'completed'
                    if str(status).lower() not in {'completed', 'success', 'succeeded'}:
                        raise CodexError(f'Codex analysis ended as {status}')
                    break
            if not messages:
                raise CodexError('Codex analysis returned no final message')
            value = None
            # Agentic turns may emit progress messages between tool calls. The
            # output-schema result is the last JSON object, not a concatenation
            # of every assistant message in the turn.
            for candidate in reversed(messages):
                try:
                    parsed = json.loads(candidate.strip())
                except ValueError:
                    continue
                if isinstance(parsed, dict):
                    value = parsed
                    break
            if value is None:
                raise CodexError('Codex analysis did not return valid JSON')
            healthy = True
            slot.used()
            return value
        finally:
            if not healthy:
                slot.close()
            with self._close_lock:
                closed = self._closed
            if closed:
                slot.close()
            else:
                self._pool.put(slot)

    def close(self):
        with self._close_lock:
            self._closed = True
        self.trim_idle()

    def trim_idle(self):
        """Release process memory while retaining reusable empty pool slots."""
        idle = []
        while True:
            try:
                idle.append(self._pool.get_nowait())
            except queue.Empty:
                break
        for slot in idle:
            slot.close()
            with self._close_lock:
                closed = self._closed
            if not closed:
                self._pool.put(slot)
