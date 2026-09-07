"""Harness-independent ATIF 1.8 projection for AFT analysis.

The call graph is derived only from ATIF document nesting and
``subagent_trajectory_ref`` links. Producer extensions may enrich the source
document, but they are deliberately not required to reconstruct ownership or
parent/child calls.
"""

from __future__ import annotations

from datetime import datetime
import json
import os
import re
from typing import Any

from .oss_io.client import OssProtocolError

MAX_TEXT = 2_500
MAX_RESULT = 1_500


def _text(value: Any, limit: int = MAX_TEXT) -> str:
    if isinstance(value, str):
        result = value
    elif isinstance(value, list):
        result = '\n'.join(
            str(item.get('text', '')) for item in value
            if isinstance(item, dict) and item.get('type') == 'text'
        )
    elif value is None:
        return ''
    else:
        result = str(value)
    if len(result) <= limit:
        return result
    return result[:limit] + f'\n… [{len(result) - limit} characters omitted]'


def _json_text(value: Any, limit: int = MAX_RESULT) -> str:
    try:
        return _text(json.dumps(value, ensure_ascii=False, sort_keys=True), limit)
    except (TypeError, ValueError):
        return _text(value, limit)


def _timestamp(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        return datetime.fromisoformat(value.replace('Z', '+00:00'))
    except ValueError:
        return None


def _elapsed(value: Any, origin: datetime | None) -> int | None:
    stamp = _timestamp(value)
    if stamp is None or origin is None:
        return None
    return max(0, round((stamp - origin).total_seconds() * 1000))


def _documents(root: dict) -> list[tuple[dict, str | None, int]]:
    output: list[tuple[dict, str | None, int]] = []

    def visit(document: Any, parent_id: str | None, depth: int) -> None:
        if not isinstance(document, dict):
            raise OssProtocolError('ATIF subagent trajectory must be an object')
        identity = document.get('trajectory_id')
        if not isinstance(identity, str) or not identity:
            raise OssProtocolError('ATIF trajectory_id is required for analysis')
        output.append((document, parent_id, depth))
        children = document.get('subagent_trajectories') or []
        if not isinstance(children, list):
            raise OssProtocolError('ATIF subagent_trajectories must be an array')
        for child in children:
            visit(child, identity, depth + 1)

    visit(root, None, 0)
    identities = [item[0]['trajectory_id'] for item in output]
    if len(identities) != len(set(identities)):
        raise OssProtocolError('ATIF trajectory_id values must be unique')
    return output


def _agent_metadata(document: dict) -> dict:
    """Keep ATIF-native work semantics without depending on producer extensions."""
    agent = document.get('agent') if isinstance(document.get('agent'), dict) else {}
    first_input = next((
        step for step in document.get('steps') or []
        if isinstance(step, dict) and step.get('source') != 'agent'
        and _text(step.get('message')).strip()
    ), None)
    final_step = next((
        step for step in reversed(document.get('steps') or [])
        if isinstance(step, dict) and step.get('source') == 'agent'
        and _text(step.get('message')).strip()
    ), None)
    return {
        'name': str(agent.get('name') or 'agent'),
        'version': agent.get('version'),
        'declared_role': _find_role(agent.get('extra')),
        'assignment': _text(first_input.get('message')) if first_input else '',
        'final_output': _text(final_step.get('message')) if final_step else '',
    }


def _find_role(value: Any) -> str | None:
    """Find a producer-declared role without knowing its extension namespace."""
    if not isinstance(value, dict):
        return None
    for key, item in value.items():
        if str(key).casefold() in {'role', 'agent_role'} \
                and isinstance(item, str) and item.strip():
            return item.strip()
    for item in value.values():
        found = _find_role(item)
        if found:
            return found
    return None


def _requested_role(call: dict) -> str | None:
    arguments = call.get('arguments')
    if not isinstance(arguments, dict):
        return None
    for key in ('role', 'agent_role', 'agent'):
        value = arguments.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return _find_role(arguments)


def _role_token(value: str) -> str:
    return re.sub(r'[^a-z0-9]+', '_', value.casefold()).strip('_')


def _display_roles(raw_roles: list[str]) -> dict[str, str]:
    """Remove a shared producer namespace while keeping an open role vocabulary."""
    tokens = [_role_token(value) for value in raw_roles if _role_token(value)]
    unique = sorted(set(tokens))
    prefix = os.path.commonprefix(unique) if len(unique) > 1 else ''
    boundary = max(prefix.rfind('_'), prefix.rfind('-'))
    namespace = prefix[:boundary + 1] if boundary >= 0 else ''
    return {
        raw: (_role_token(raw)[len(namespace):] or _role_token(raw))
        for raw in raw_roles if _role_token(raw)
    }


def extract_call_graph(trajectory: dict) -> dict:
    """Deterministically extract roles and calls from ATIF, without model inference."""
    if not isinstance(trajectory, dict) or trajectory.get('schema_version') != 'ATIF-v1.8':
        raise OssProtocolError('Call graph extraction requires an ATIF-v1.8 trajectory')
    documents = _documents(trajectory)
    child_refs: dict[str, dict] = {}
    for document, _, _ in documents:
        parent_id = document['trajectory_id']
        for step in document.get('steps') or []:
            if not isinstance(step, dict):
                continue
            calls = {item.get('tool_call_id'): item for item in (step.get('tool_calls') or [])
                     if isinstance(item, dict)}
            observation = step.get('observation')
            results = observation.get('results') if isinstance(observation, dict) else []
            for result in results or []:
                if not isinstance(result, dict):
                    continue
                call_id = result.get('source_call_id')
                call = calls.get(call_id) or {}
                for ref in result.get('subagent_trajectory_ref') or []:
                    child_id = ref.get('trajectory_id') if isinstance(ref, dict) else None
                    if isinstance(child_id, str) and child_id:
                        child_refs[child_id] = {
                            'parent_trajectory_id': parent_id,
                            'parent_step_id': step.get('step_id'),
                            'tool_call_id': call_id,
                            'tool_name': call.get('function_name'),
                            'requested_role': _requested_role(call),
                        }
    agents = []
    raw_roles = []
    for document, nested_parent, depth in documents:
        identity = document['trajectory_id']
        metadata = _agent_metadata(document)
        parent = child_refs.get(identity) or ({
            'parent_trajectory_id': nested_parent, 'parent_step_id': None,
            'tool_call_id': None, 'tool_name': None, 'requested_role': None,
        } if nested_parent else None)
        declared = metadata.get('declared_role') or ((parent or {}).get('requested_role'))
        if declared:
            raw_roles.append(declared)
        agents.append({
            'trajectory_id': identity, 'name': metadata['name'],
            'version': metadata.get('version'), 'declared_role': declared,
            'assignment': metadata.get('assignment'),
            'final_output': metadata.get('final_output'),
            'depth': depth, 'parent': parent,
        })
    display = _display_roles(raw_roles)
    parent_ids = {item['parent_trajectory_id'] for item in child_refs.values()}
    for agent in agents:
        agent['role'] = display.get(agent.get('declared_role')) or (
            'planner' if agent['trajectory_id'] in parent_ids else 'coder'
        )
    edges = [{
        'parent_trajectory_id': parent['parent_trajectory_id'],
        'child_trajectory_id': child_id,
        'parent_step_id': parent.get('parent_step_id'),
        'tool_call_id': parent.get('tool_call_id'),
        'tool_name': parent.get('tool_name'),
    } for child_id, parent in child_refs.items()]
    return {'schema_version': 'aft-call-graph/v1', 'agents': agents, 'call_edges': edges}


def build_aft_trace(trajectory: dict, *, started_at: str | None = None) -> dict:
    """Return compact turns and a call graph from a validated ATIF document."""
    if not isinstance(trajectory, dict) or trajectory.get('schema_version') != 'ATIF-v1.8':
        raise OssProtocolError('AFT requires an ATIF-v1.8 trajectory')
    documents = _documents(trajectory)
    graph = extract_call_graph(trajectory)
    origin = _timestamp(started_at)
    if origin is None:
        stamps = [
            _timestamp(step.get('timestamp'))
            for document, _, _ in documents
            for step in (document.get('steps') or []) if isinstance(step, dict)
        ]
        origin = min((stamp for stamp in stamps if stamp is not None), default=None)

    entries = []
    agents = graph['agents']
    agents_by_id = {item['trajectory_id']: item for item in agents}
    for document_index, (document, nested_parent, depth) in enumerate(documents):
        identity = document['trajectory_id']
        agent = agents_by_id[identity]
        parent = agent.get('parent')
        pending_inputs = []
        for order, step in enumerate(document.get('steps') or []):
            if not isinstance(step, dict):
                continue
            source = step.get('source')
            if source != 'agent':
                pending_inputs.append({
                    'source': source,
                    'message': _text(step.get('message')),
                    'timestamp': step.get('timestamp'),
                })
                continue
            results_by_call: dict[str, list[dict]] = {}
            observation = step.get('observation')
            results = observation.get('results') if isinstance(observation, dict) else []
            for result in results or []:
                if not isinstance(result, dict):
                    continue
                call_id = result.get('source_call_id')
                if not isinstance(call_id, str):
                    continue
                results_by_call.setdefault(call_id, []).append({
                    'content': _text(result.get('content'), MAX_RESULT),
                    'error': _json_text(result.get('error')) if result.get('error') else '',
                    'subagent_trajectory_ids': [
                        ref.get('trajectory_id') for ref in result.get('subagent_trajectory_ref') or []
                        if isinstance(ref, dict) and isinstance(ref.get('trajectory_id'), str)
                    ],
                })
            calls = []
            for call in step.get('tool_calls') or []:
                if not isinstance(call, dict):
                    continue
                call_id = str(call.get('tool_call_id') or '')
                calls.append({
                    'tool_call_id': call_id,
                    'name': str(call.get('function_name') or 'unknown'),
                    'arguments': _json_text(call.get('arguments') or {}),
                    'results': results_by_call.get(call_id, []),
                })
            stamp = _timestamp(step.get('timestamp'))
            entries.append({
                '_sort': (stamp.timestamp() if stamp else float('inf'), document_index, order),
                'turn_id': f'{identity}:{step.get("step_id")}',
                'trajectory_id': identity,
                'agent_name': agent['name'],
                'agent_role': agent['role'],
                'depth': depth,
                'parent': parent,
                'source_step_id': step.get('step_id'),
                'timestamp': step.get('timestamp'),
                'at_ms': _elapsed(step.get('timestamp'), origin),
                'inputs': pending_inputs,
                'reasoning': _text(step.get('reasoning_content')),
                'message': _text(step.get('message')),
                'tool_calls': calls,
            })
            pending_inputs = []

    entries.sort(key=lambda item: item.pop('_sort'))
    for index, turn in enumerate(entries, 1):
        turn['global_turn'] = index
    number_by_key = {(item['trajectory_id'], item['source_step_id']): item['global_turn']
                     for item in entries}
    edges = []
    for edge in graph['call_edges']:
        edges.append({
            'parent_trajectory_id': edge['parent_trajectory_id'],
            'child_trajectory_id': edge['child_trajectory_id'],
            'parent_turn': number_by_key.get((edge['parent_trajectory_id'], edge['parent_step_id'])),
            'tool_call_id': edge['tool_call_id'],
            'tool_name': edge['tool_name'],
        })
    calls = [call for turn in entries for call in turn.get('tool_calls', [])]
    children = [agent for agent in agents if agent.get('parent')]
    missing_event_types = []
    calls_with_results = sum(bool(call.get('results')) for call in calls)
    complete_child_links = sum(
        bool((agent.get('parent') or {}).get('tool_call_id'))
        and any(edge['child_trajectory_id'] == agent['trajectory_id']
                and edge.get('parent_turn') is not None for edge in edges)
        for agent in children
    )
    timestamped_turns = sum(turn.get('at_ms') is not None for turn in entries)
    if calls_with_results < len(calls):
        missing_event_types.append('tool_result')
    if complete_child_links < len(children):
        missing_event_types.append('subagent_link')
    if timestamped_turns < len(entries):
        missing_event_types.append('timestamp')
    expected_units = len(entries) * 2 + len(calls) + len(children)
    covered_units = len(entries) + timestamped_turns + calls_with_results + complete_child_links
    input_quality = {
        'trace_coverage': round(covered_units / expected_units, 4) if expected_units else 0.0,
        'missing_event_types': missing_event_types,
        'provenance_complete': not missing_event_types,
        'limits_mapping_confidence': bool(missing_event_types),
    }
    return {
        'schema_version': 'aft-trace/v1',
        'turns': entries,
        'agents': agents,
        'call_edges': edges,
        'turn_count': len(entries),
        'agent_count': len(agents),
        'analysis_input_quality': input_quality,
    }
