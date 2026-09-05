"""Python port of src/lib/legacyTraceToAtif.ts; legacy semantics stay server-side."""
import json
from pathlib import PurePosixPath


def _string(value):
    return value if isinstance(value, str) else json.dumps(value, ensure_ascii=False, indent=2)


def _object(value):
    if isinstance(value, dict):
        return value
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
            if isinstance(parsed, dict):
                return parsed
        except ValueError:
            pass
    return {} if value is None else {'_raw': value}


def _image(image):
    path = image['path']
    mime = image.get('mimeType', '').lower()
    if mime not in ('image/png', 'image/jpeg', 'image/webp', 'image/gif'):
        mime = {'.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
                '.webp': 'image/webp'}.get(PurePosixPath(path).suffix.lower(), 'image/png')
    if path.startswith('frames/'):
        path = 'replay/' + path
    return {'type': 'image', 'source': {'media_type': mime, 'path': path}}


def _image_refs(value, depth=0, budget=None):
    budget = [2048] if budget is None else budget
    if depth > 8 or value is None or budget[0] <= 0:
        return []
    budget[0] -= 1
    found = []
    if isinstance(value, dict):
        if value.get('type') == 'image' and isinstance(value.get('path'), str) and isinstance(value.get('sha256'), str):
            found.append(value)
        children = value.values()
    elif isinstance(value, list):
        children = value
    else:
        return []
    for child in children:
        found.extend(_image_refs(child, depth + 1, budget))
        if len(found) >= 32 or budget[0] <= 0:
            break
    return found[:32]


def _message(item):
    parts = []
    for block in (item.get('message') or {}).get('blocks', []):
        if block.get('type') == 'text' and isinstance(block.get('text'), str):
            parts.append({'type': 'text', 'text': block['text']})
        elif block.get('type') == 'image' and isinstance(block.get('path'), str) and isinstance(block.get('sha256'), str):
            parts.append(_image(block))
    if not any(p['type'] == 'text' for p in parts):
        text = '\n\n'.join(d['text'] for d in item['details'] if d['kind'] == 'text')
        if text:
            parts.insert(0, {'type': 'text', 'text': text})
    if not parts:
        return ''
    return parts[0]['text'] if len(parts) == 1 and parts[0]['type'] == 'text' else parts


def _result(value):
    images = _image_refs(value)
    text = _string(value)
    if not images:
        return text
    seen, parts = set(), [{'type': 'text', 'text': text}]
    for image in images:
        if image['sha256'] not in seen:
            seen.add(image['sha256']); parts.append(_image(image))
    return parts


def _metrics(item):
    usage = (item.get('message') or {}).get('usage')
    if not usage:
        return None
    number = lambda key: usage[key] if type(usage.get(key)) in (float, int) else 0
    cost = usage.get('cost')
    values = {
        'prompt_tokens': number('input_tokens') or number('input') + number('cacheRead') + number('cacheWrite'),
        'completion_tokens': number('output_tokens') or number('output'),
        'cached_tokens': number('cached_tokens') or number('cacheRead'),
        'cost_usd': (cost.get('total') or 0) if isinstance(cost, dict) else number('cost_usd'),
    }
    return {key: value for key, value in values.items() if value} or None


def _provenance(item, kind):
    fields = {'source_format': 'oss-agent-work', 'kind': kind,
              'work_id': item['id'], 'agent_id': item['agent_id']}
    for key in ('role', 'origin', 'turn_num', 'global_turn_num'):
        if key in item:
            fields[key] = item[key]
    if kind == 'model_input':
        fields.pop('turn_num', None); fields.pop('global_turn_num', None)
    return fields


def legacy_to_atif(work, *, run, task, agent_name='agent', model=None, agent_version='unknown'):
    steps = []
    for item in work['items']:
        seen, inputs = set(), []
        for request in item.get('model_inputs', []):
            for image in request.get('new_images', []):
                if image['sha256'] not in seen:
                    seen.add(image['sha256']); inputs.append(_image(image))
        start = item['start_ms']
        if inputs:
            steps.append({'source': 'system', 'message': inputs, 'extra': {'osworld_harness': {
                'timing': {'clock': 'episode_elapsed_ms', 'start_ms': start, 'end_ms': start},
                'provenance': _provenance(item, 'model_input'),
            }}})
        end = max([start + max(0, item['thinking_ms'])] + [
            tool['end_ms'] if tool['end_ms'] is not None else tool['start_ms'] for tool in item['tools']])
        source = 'user' if (item.get('message') or {}).get('role') == 'user' else 'agent'
        step = {'source': source, 'message': _message(item), 'extra': {'osworld_harness': {
            'timing': {'clock': 'episode_elapsed_ms', 'start_ms': start, 'end_ms': end},
            'provenance': _provenance(item, 'agent_work'),
        }}}
        if source == 'agent':
            llm = bool(item.get('message'))
            step['llm_call_count'] = max(1, len(item.get('model_inputs', []))) if llm else 0
            if model:
                step['model_name'] = model
            if llm:
                metrics = _metrics(item)
                reasoning = '\n\n'.join(d['text'] for d in item['details'] if d['kind'] == 'thinking')
                if metrics:
                    step['metrics'] = metrics
                if reasoning:
                    step['reasoning_content'] = reasoning
            calls, results = [], []
            for tool in item['tools']:
                calls.append({'tool_call_id': tool['id'], 'function_name': tool['name'],
                              'arguments': _object(tool.get('args')), 'extra': {'osworld_harness': {
                                  'actor': item['agent_id'], 'timing': {'clock': 'episode_elapsed_ms',
                                  'start_ms': tool['start_ms'], 'end_ms': tool['end_ms']}}}})
                if tool.get('result') is not None:
                    status = 'error' if tool['is_error'] is True else 'completed' if tool['is_error'] is False else 'unknown'
                    results.append({'source_call_id': tool['id'], 'content': _result(tool['result']),
                                    'extra': {'osworld_harness': {'tool_status': status}}})
            error = (item.get('message') or {}).get('error_message')
            if error:
                results.append({'content': error})
            if calls:
                step['tool_calls'] = calls
            if results:
                step['observation'] = {'results': results}
        steps.append(step)
    for index, step in enumerate(steps, 1):
        step['step_id'] = index
    totals = {}
    for field in ('prompt_tokens', 'completion_tokens', 'cached_tokens', 'cost_usd'):
        total = sum(step.get('metrics', {}).get(field, 0) for step in steps if step['source'] == 'agent')
        if total:
            totals['total_' + field] = total
    return {
        'schema_version': 'ATIF-v1.8', 'session_id': f'{run}/{task}',
        'trajectory_id': f'{run}/{task}/root',
        'agent': {'name': agent_name, 'version': agent_version, **({'model_name': model} if model else {}),
                  'extra': {'osworld_harness': {'source_format': 'oss-agent-work', 'adapter': 'legacy-trace-to-atif/v1'}}},
        'steps': steps, 'notes': 'Converted from the legacy OSS Harness trace stream by Replay.',
        'final_metrics': {**totals, 'total_steps': len(steps), 'extra': {'source_duration_ms': work['duration_ms']}},
        'extra': {'osworld_harness': {
            'schema_version': 'osworld-harness/v1',
            'clock': {'field': 'episode_elapsed_ms', 'unit': 'ms', 'origin': 'episode_start'},
            'source': {'format': 'oss-agent-work', 'adapter': 'legacy-trace-to-atif/v1'},
            'run': {'duration_ms': work['duration_ms'], 'terminal': work['terminal'],
                    'execution_status': work.get('task_status')},
        }},
    }
