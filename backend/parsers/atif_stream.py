"""Pure ATIF validation and published stream-manifest validation."""
from ..oss_io.client import OssProtocolError

STREAM_VERSION = 'osworld-atif-stream/v1'
MANIFEST_VERSION = 'osworld-atif-stream-manifest/v1'
MAX_LINES = 1_000_000
MAX_CHUNKS = 10_000


def descriptors(doc, *, legacy=False):
    if legacy:
        valid = doc.get('schema_version') == '2.0'
    else:
        valid = (doc.get('trace_format') == 'atif-stream'
                 and doc.get('stream_schema_version') == STREAM_VERSION
                 and doc.get('manifest_schema_version') == MANIFEST_VERSION)
    chunks, total = doc.get('chunks'), doc.get('total_lines')
    if (not valid or type(total) is not int or not 0 <= total <= MAX_LINES
            or not isinstance(chunks, list) or len(chunks) > MAX_CHUNKS):
        raise OssProtocolError('Invalid stream manifest')
    position, previous_start = 0, -1
    for chunk in chunks:
        if (not isinstance(chunk, dict) or type(chunk.get('start')) is not int
                or chunk['start'] <= previous_start or chunk['start'] > position
                or type(chunk.get('count')) is not int or chunk['count'] <= 0
                or chunk['start'] + chunk['count'] <= position
                or chunk['start'] + chunk['count'] > MAX_LINES
                or (legacy and chunk['start'] != position)):
            raise OssProtocolError('Non-contiguous stream chunks')
        previous_start = chunk['start']
        position = chunk['start'] + chunk['count']
    if total > position or (chunks and total <= previous_start) or (legacy and position != total):
        raise OssProtocolError('Manifest total does not match chunks')
    return chunks


def validate_records(records):
    for record in records:
        if (record.get('trace_format') != 'atif-stream'
                or record.get('stream_schema_version') != STREAM_VERSION
                or not isinstance(record.get('op'), str)):
            raise OssProtocolError('Invalid ATIF stream record')
        if record['op'] in ('append_step', 'begin_step', 'upsert_step'):
            validate_step(record.get('step'))
        fields = {'append_desktop_frame': 'frame', 'append_execution_state_event': 'event',
                  'replace_execution_state': 'execution_state', 'append_harness_event': 'event',
                  'tool_execution_start': 'tool_call', 'tool_execution_end': 'result', 'seal_step': 'timing'}
        field = fields.get(record['op'])
        if field and not isinstance(record.get(field), dict):
            raise OssProtocolError('Invalid ATIF patch payload')
        if record['op'] == 'tool_execution_start':
            validate_step({'step_id': 1, 'source': 'agent', 'message': '', 'tool_calls': [record['tool_call']]})
        if record['op'] == 'tool_execution_end':
            if not isinstance(record['result'].get('source_call_id'), str):
                raise OssProtocolError('Invalid ATIF tool result')
            if record['result'].get('content') is not None:
                content(record['result']['content'])
    return records


def content(value):
    if isinstance(value, str):
        return
    if not isinstance(value, list):
        raise OssProtocolError('Invalid ATIF content')
    for part in value:
        if not isinstance(part, dict):
            raise OssProtocolError('Invalid ATIF content part')
        if part.get('type') == 'text' and isinstance(part.get('text'), str):
            continue
        source = part.get('source')
        if (part.get('type') != 'image' or not isinstance(source, dict)
                or not isinstance(source.get('path'), str) or not source['path']
                or source.get('media_type') not in ('image/png', 'image/jpeg', 'image/webp', 'image/gif')):
            raise OssProtocolError('Invalid ATIF media reference')


def validate_step(step):
    if (not isinstance(step, dict) or type(step.get('step_id')) is not int
            or step['step_id'] < 1 or step.get('source') not in ('system', 'user', 'agent')):
        raise OssProtocolError('Invalid ATIF step')
    content(step.get('message'))
    extra = step.get('extra', {})
    if (not isinstance(extra, dict) or not isinstance(extra.get('osworld_harness', {}), dict)
            or not isinstance(extra.get('osworld_harness', {}).get('timing', {}), dict)):
        raise OssProtocolError('Invalid step extension')
    calls = step.get('tool_calls') or []
    if not isinstance(calls, list):
        raise OssProtocolError('Invalid ATIF tool calls')
    ids = set()
    for call in calls:
        if (not isinstance(call, dict) or not isinstance(call.get('tool_call_id'), str)
                or not call['tool_call_id'] or call['tool_call_id'] in ids
                or not isinstance(call.get('function_name'), str) or not call['function_name']
                or not isinstance(call.get('arguments'), dict)):
            raise OssProtocolError('Invalid ATIF tool call')
        ids.add(call['tool_call_id'])
    observation = step.get('observation')
    if observation is not None:
        if not isinstance(observation, dict) or not isinstance(observation.get('results'), list):
            raise OssProtocolError('Invalid ATIF observation')
        for result in observation['results']:
            if not isinstance(result, dict) or (result.get('source_call_id') is not None and result['source_call_id'] not in ids):
                raise OssProtocolError('Unpaired ATIF tool result')
            if result.get('content') is not None:
                content(result['content'])


def validate_trajectory(doc, depth=0):
    if (depth > 32 or not isinstance(doc, dict) or doc.get('schema_version') != 'ATIF-v1.8'
            or not isinstance(doc.get('agent'), dict)
            or not isinstance(doc['agent'].get('name'), str) or not doc['agent']['name']
            or not isinstance(doc['agent'].get('version'), str) or not doc['agent']['version']
            or not isinstance(doc.get('steps'), list) or not doc['steps']):
        raise OssProtocolError('Invalid ATIF document')
    for index, step in enumerate(doc['steps'], 1):
        validate_step(step)
        if step['step_id'] != index:
            raise OssProtocolError('Non-contiguous ATIF step IDs')
    extra = doc.get('extra', {})
    if not isinstance(extra, dict) or not isinstance(extra.get('osworld_harness', {}), dict):
        raise OssProtocolError('Invalid ATIF extensions')
    harness = extra.get('osworld_harness', {})
    if not isinstance(harness.get('run', {}), dict):
        raise OssProtocolError('Invalid ATIF run extension')
    timeline = harness.get('desktop_timeline')
    if timeline is not None and (not isinstance(timeline, dict) or not isinstance(timeline.get('frames'), list)):
        raise OssProtocolError('Invalid ATIF desktop timeline')
    children = doc.get('subagent_trajectories', [])
    if not isinstance(children, list):
        raise OssProtocolError('Invalid subagent trajectories')
    for child in children:
        validate_trajectory(child, depth + 1)
    return doc
