"""Pure frame/state/timeline projections shared across native and legacy views."""
from copy import deepcopy
from .execution_state import execution_state_extension_feed, execution_state_feed
from .atif_stream import STREAM_VERSION
from ..oss_io.client import OssProtocolError


def milliseconds(value):
    return value if type(value) is int and value >= 0 else 0


def frame_event(frame):
    if not isinstance(frame, dict) or not isinstance(frame.get('image', {}), dict):
        raise OssProtocolError('Invalid desktop frame')
    result = deepcopy(frame)
    image = result.get('image') or {}
    source = image.get('source')
    if isinstance(source, dict):
        result['image'] = {**image, 'path': source.get('path'), 'mime_type': source.get('media_type')}
    return result


def portable_frame(frame):
    result = deepcopy(frame)
    image = result.get('image') or {}
    if not isinstance(image.get('source'), dict):
        path = image.get('path', '')
        result['image'] = {**image, 'type': 'image', 'source': {
            'media_type': image.get('mime_type') or 'image/png',
            'path': 'replay/' + path if path.startswith('frames/') else path,
        }}
        result['image'].pop('path', None)
    return result


def state_from_live(records):
    extension = None
    for record in records:
        if record['op'] == 'replace_execution_state':
            extension = deepcopy(record.get('execution_state'))
        elif record['op'] == 'append_execution_state_event':
            if extension is None:
                extension = {'schema_version': 'execution-state/v2', 'events': []}
            extension['events'].append(record['event'])
    return execution_state_extension_feed({'extra': {'osworld_execution_state': extension}})


def state_extension(feed):
    events = []
    for event in feed['events']:
        name = event.get('event')
        name = name.get('type') if isinstance(name, dict) else name
        events.append({**event, 'event_type': name.removeprefix('execution_state_'),
                       'record': event.get('record') or {k: v for k, v in event.items()
                                                       if k not in ('event', 'sequence', 'episode_elapsed_ms')}})
    return {'schema_version': 'execution-state/v2', 'events': events,
            **({'final_state': feed['final_state']} if 'final_state' in feed else {})}


def agent_stamps(trajectory, records):
    stamps = []
    def visit(doc):
        for step in doc.get('steps', []):
            if step.get('source') != 'agent':
                continue
            timing = step.get('extra', {}).get('osworld_harness', {}).get('timing', {})
            at = timing.get('end_ms') if timing.get('end_ms') is not None else timing.get('start_ms')
            stamps.append({'at_ms': milliseconds(at), 'step_id': step['step_id'],
                           'trajectory_id': doc.get('trajectory_id')})
        for child in doc.get('subagent_trajectories', []):
            visit(child)
    if trajectory:
        visit(trajectory)
    else:
        latest = {}
        for record in records:
            if record['op'] in ('begin_step', 'append_step', 'upsert_step'):
                latest[(record.get('trajectory_id'), record['step']['step_id'])] = record['step']
            elif record['op'] == 'seal_step':
                step = latest.get((record.get('trajectory_id'), record.get('step_id')))
                if step:
                    step = deepcopy(step)
                    step.setdefault('extra', {}).setdefault('osworld_harness', {})['timing'] = record.get('timing') or {}
                    latest[(record.get('trajectory_id'), record.get('step_id'))] = step
        for (identity, _), step in latest.items():
            visit({'trajectory_id': identity, 'steps': [step]})
    return sorted(stamps, key=lambda x: x['at_ms'])


def snapshot_updates(trajectory, frames, feed, terminal):
    records = []
    def append(identity, op, **extra):
        records.append({'trace_format': 'atif-stream', 'stream_schema_version': STREAM_VERSION,
                        'trajectory_id': identity, 'op': op, **extra})
    def visit(doc, parent=None):
        identity = doc.get('trajectory_id') or 'root'
        for step in doc['steps']:
            append(identity, 'append_step', step=step)
        if parent:
            call_id = None
            for step in parent['steps']:
                for result in (step.get('observation') or {}).get('results', []):
                    if any(ref.get('trajectory_id') == identity for ref in result.get('subagent_trajectory_ref', [])):
                        call_id = result.get('source_call_id')
            append(identity, 'append_harness_event', event={'event_type': 'subagent_lifecycle', 'record': {
                'id': identity, 'parentAgentId': parent.get('trajectory_id') or 'root', 'parentToolCallId': call_id,
            }})
        for child in doc.get('subagent_trajectories', []):
            visit(child, doc)
    visit(trajectory)
    identity = trajectory.get('trajectory_id') or 'root'
    for frame in frames:
        append(identity, 'append_desktop_frame', frame=portable_frame(frame))
    append(identity, 'replace_execution_state', execution_state=state_extension(feed))
    return {'trace_format': 'atif-stream', 'stream_schema_version': STREAM_VERSION,
            'total_lines': len(records), 'start_line': 0, 'records': records, 'terminal': terminal,
            'stream': {'reset': True, 'source_format': 'normalized-snapshot'}}


def window_steps(trajectory, records, low, high, duration):
    """Window whole semantic steps, folding live tool patches before slicing."""
    steps = {}
    def visit(doc):
        for step in doc.get('steps', []):
            steps[(doc.get('trajectory_id') or 'root', step['step_id'])] = step
        for child in doc.get('subagent_trajectories', []):
            visit(child)
    if trajectory:
        visit(trajectory)
    else:
        for record in records:
            op = record.get('op')
            identity = record.get('trajectory_id') or 'root'
            if op in ('append_step', 'begin_step', 'upsert_step'):
                step = deepcopy(record['step'])
                steps[(identity, step['step_id'])] = step
                continue
            step = steps.get((identity, record.get('step_id')))
            if step is None:
                continue
            if op == 'tool_execution_start':
                call = deepcopy(record['tool_call'])
                calls = step.setdefault('tool_calls', [])
                calls[:] = [c for c in calls if c['tool_call_id'] != call['tool_call_id']] + [call]
            elif op == 'tool_execution_end':
                result = deepcopy(record['result'])
                results = step.setdefault('observation', {}).setdefault('results', [])
                results[:] = [r for r in results if r.get('source_call_id') != result['source_call_id']] + [result]
            elif op == 'seal_step':
                step.setdefault('extra', {}).setdefault('osworld_harness', {})['timing'] = record.get('timing') or {}
    selected = []
    for (identity, _), step in steps.items():
        timing = step.get('extra', {}).get('osworld_harness', {}).get('timing', {})
        start = milliseconds(timing.get('start_ms'))
        end = timing.get('end_ms')
        end = duration if end is None else milliseconds(end)
        for call in step.get('tool_calls', []):
            tool_end = call.get('extra', {}).get('osworld_harness', {}).get('timing', {}).get('end_ms')
            end = max(end, duration if tool_end is None else milliseconds(tool_end))
        if start <= high and end >= low:
            selected.append({'trajectory_id': identity, 'step': step})
    return selected


class NativeProjection:
    """Retain current steps and frame/state events instead of every historical upsert."""
    def __init__(self):
        self.steps = {}
        self.other = []

    def add(self, record):
        op = record.get('op')
        identity = record.get('trajectory_id') or 'root'
        if op in ('append_step', 'begin_step', 'upsert_step'):
            self.steps[(identity, record['step']['step_id'])] = record['step']
            return
        step = self.steps.get((identity, record.get('step_id')))
        if op == 'tool_execution_start' and step is not None:
            call = record['tool_call']
            calls = step.setdefault('tool_calls', [])
            calls[:] = [c for c in calls if c['tool_call_id'] != call['tool_call_id']] + [call]
        elif op == 'tool_execution_end' and step is not None:
            result = record['result']
            results = step.setdefault('observation', {}).setdefault('results', [])
            results[:] = [r for r in results if r.get('source_call_id') != result['source_call_id']] + [result]
        elif op == 'seal_step' and step is not None:
            step.setdefault('extra', {}).setdefault('osworld_harness', {})['timing'] = record.get('timing') or {}
        elif op not in ('tool_execution_start', 'tool_execution_end', 'seal_step'):
            self.other.append(record)

    def records(self):
        return [{'trace_format': 'atif-stream', 'stream_schema_version': STREAM_VERSION,
                 'trajectory_id': identity, 'op': 'append_step', 'step': step}
                for (identity, _), step in self.steps.items()] + self.other
