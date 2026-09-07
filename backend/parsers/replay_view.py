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


def materialize_live_trajectory(records, terminal=False):
    """Fold compact native stream records into an analysis-safe ATIF snapshot."""
    documents, parents = {}, {}

    def document(identity):
        if not isinstance(identity, str) or not identity:
            return None
        return documents.setdefault(identity, {
            'id': identity, 'role': 'agent', 'origin': None, 'steps': {},
        })

    for record in records:
        if record.get('trace_format') != 'atif-stream' \
                or record.get('stream_schema_version') != STREAM_VERSION:
            continue
        doc = document(record.get('trajectory_id'))
        op = record.get('op')
        if op in ('begin_step', 'append_step', 'upsert_step') and doc is not None:
            step = deepcopy(record.get('step'))
            if not isinstance(step, dict) or type(step.get('step_id')) is not int:
                continue
            doc['steps'][step['step_id']] = step
            provenance = (step.get('extra', {}).get('osworld_harness', {})
                          .get('provenance', {}))
            if isinstance(provenance.get('role'), str):
                doc['role'] = provenance['role']
            if isinstance(provenance.get('origin'), str):
                doc['origin'] = provenance['origin']
        elif op == 'append_harness_event':
            event = record.get('event') or {}
            detail = event.get('record') or {}
            if event.get('event_type') != 'subagent_lifecycle':
                continue
            child, parent = detail.get('id'), detail.get('parentAgentId')
            if isinstance(child, str) and child and isinstance(parent, str) and parent:
                parents[child] = {
                    'parent': parent,
                    'call_id': detail.get('parentToolCallId'),
                    'role': detail.get('agent'),
                }

    complete = {}
    for identity, doc in documents.items():
        ordered = [doc['steps'][index] for index in sorted(doc['steps'])]
        if ordered and all(step.get('step_id') == index
                           for index, step in enumerate(ordered, 1)):
            complete[identity] = {**doc, 'steps': ordered}
    if not complete:
        return None

    for child, relation in parents.items():
        parent = complete.get(relation['parent'])
        if child not in complete or parent is None:
            continue
        if isinstance(relation.get('role'), str):
            complete[child]['role'] = relation['role']
        call_id = relation.get('call_id')
        if not isinstance(call_id, str):
            continue
        for step in parent['steps']:
            if not any(call.get('tool_call_id') == call_id
                       for call in step.get('tool_calls', [])):
                continue
            results = step.setdefault('observation', {}).setdefault('results', [])
            result = next((item for item in results
                           if item.get('source_call_id') == call_id), None)
            if result is None:
                result = {'source_call_id': call_id, 'content': ''}
                results.append(result)
            refs = result.setdefault('subagent_trajectory_ref', [])
            if not any(ref.get('trajectory_id') == child for ref in refs):
                refs.append({'trajectory_id': child})
            break

    root_id = next((identity for identity in complete if identity not in parents),
                   next(iter(complete)))

    def build(identity, ancestors):
        doc = complete[identity]
        path = {*ancestors, identity}
        children = [child for child, relation in parents.items()
                    if relation['parent'] == identity and child in complete
                    and child not in path]
        harness = {'role': doc['role'], 'agent_id': identity}
        if doc.get('origin'):
            harness['origin'] = doc['origin']
        value = {
            'schema_version': 'ATIF-v1.8', 'trajectory_id': identity,
            'agent': {'name': 'osworld-stateact', 'version': 'live',
                      'extra': {'osworld_harness': harness}},
            'steps': doc['steps'],
        }
        if children:
            value['subagent_trajectories'] = [build(child, path) for child in children]
        return value

    trajectory = build(root_id, set())
    trajectory['final_metrics'] = {
        'total_steps': sum(len(doc['steps']) for doc in complete.values()),
    }
    trajectory['extra'] = {'osworld_harness': {
        'schema_version': 'osworld-harness/v1',
        'trace_format': 'atif',
        'source': {'format': 'atif', 'adapter': 'omp-native-live/v1'},
        'run': {'execution_status': 'terminal' if terminal else 'snapshot',
                'terminal': bool(terminal)},
    }}
    return trajectory


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
        # Progress updates are transient and can be extremely repetitive. The
        # ATIF viewer does not materialize them, and retaining every historical
        # snapshot makes a compact replay view larger than the source window it
        # is meant to serve. The terminal result is folded by
        # tool_execution_end above.
        elif op not in ('tool_execution_start', 'tool_execution_update', 'tool_execution_end', 'seal_step'):
            self.other.append(record)

    def records(self):
        return [{'trace_format': 'atif-stream', 'stream_schema_version': STREAM_VERSION,
                 'trajectory_id': identity, 'op': 'append_step', 'step': step}
                for (identity, _), step in self.steps.items()] + self.other
