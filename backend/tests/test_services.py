"""Services against an in-memory OSS wire substitute, with actual parsers/SQLite."""
import base64
from concurrent.futures import ThreadPoolExecutor
import copy
import hashlib
import io
import json
from pathlib import Path
import tempfile
import threading
import unittest
from fastapi.testclient import TestClient

from backend.app import create_app, create_oss_app
from backend.artifacts import ArtifactReader
from backend.cache import ReadCache
from backend.catalog import CatalogService
from backend.config import Settings
from backend.execution_index import ExecutionIndex
from backend.oss_io.client import ObjectPage, ObjectStream, OssError, OssNoSuchKey, OssProtocolError
from backend.parsers.atif_stream import MANIFEST_VERSION, STREAM_VERSION
from backend.replay import ReplayService
from backend.services import InvalidQuery, ResourceNotFound
from backend.sync import IndexSynchronizer

RUN = '20260904T100000Z-test'
TASK = '0001-003'
PNG = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jHioAAAAASUVORK5CYII=')
SHA = hashlib.sha256(PNG).hexdigest()


def step(message='hello'):
    return {'step_id': 1, 'source': 'agent', 'message': message, 'llm_call_count': 1,
            'extra': {'osworld_harness': {'timing': {'start_ms': 100, 'end_ms': 200}}}}


def trajectory():
    return {'schema_version': 'ATIF-v1.8', 'trajectory_id': 'root', 'session_id': 'session',
            'agent': {'name': 'test', 'version': '1'}, 'steps': [step()]}


def patch(op, **kwargs):
    return {'trace_format': 'atif-stream', 'stream_schema_version': STREAM_VERSION,
            'trajectory_id': 'root', 'op': op, **kwargs}


def record(stamp, kind, **kwargs):
    return {'episode_elapsed_ms': stamp, 'role': 'stateact_main', 'agentId': 'main',
            'event': {'type': kind, **kwargs}}


class Store:
    def __init__(self):
        self.data, self.reads = {}, []

    def put(self, key, value):
        self.data[key] = value if isinstance(value, bytes) else json.dumps(value).encode()

    def batch(self, run=RUN, tasks=None):
        self.put(f'harness/{run}/batch.json', {'batch_id': run, 'status': 'running',
            'configuration': {'runtime_name': 'a-runtime'},
            'tasks': tasks or [{'key': TASK, 'task_id': '003', 'status': 'running', 'score': None}]})

    def artifact(self, path, value, run=RUN, task=TASK):
        self.put(f'harness/{run}/tasks/{task}/{path}', value)

    def get_object(self, key):
        self.reads.append(key)
        value = self.data.get(key)
        if isinstance(value, Exception):
            raise value
        if value is None:
            raise OssNoSuchKey(404, 'NoSuchKey', 'missing')
        response = io.BytesIO(value)
        response.headers = {'Content-Length': str(len(value))}
        return ObjectStream(response)

    def list_objects(self, prefix, delimiter='/', cursor=None):
        names = sorted({key[len(prefix):].split('/')[0] for key in self.data if key.startswith(prefix)})
        start = int(cursor or 0)
        return ObjectPage((), tuple(prefix + name + '/' for name in names[start:start+2]),
                          str(start+2) if start+2 < len(names) else None)


class ServiceTests(unittest.TestCase):
    def setUp(self):
        self.store = Store()
        self.store.batch()
        self.reader = ArtifactReader(self.store, live_ttl=0)
        self.index = ExecutionIndex(':memory:')
        self.addCleanup(self.index.close)
        self.catalog = CatalogService(self.reader, self.index)
        self.replay = ReplayService(self.reader)

    def test_catalog_cross_date_paging_score_and_pending_state(self):
        self.assertEqual(self.catalog.list_task_runs(task_id='003')['sync']['status'], 'pending')
        older = '20260820T100000Z-old'
        self.store.batch(older, [{'key': TASK, 'task_id': 3, 'status': 'failed', 'score': 0},
                                 {'key': '0002-003', 'task_id': '003', 'status': 'running'}])
        self.store.put('harness/20260905T000000Z-orphan/unpublished', b'')
        sync = IndexSynchronizer(self.catalog, self.index)
        self.assertEqual(sync.scan_once()['status'], 'ready')
        self.assertFalse(any('trace' in path or 'frames/' in path for path in self.store.reads))
        listing = self.catalog.list_runs()
        self.assertEqual(listing['latest_date'], '2026-09-04')
        first = self.catalog.list_task_runs(task_id='003', limit=1)
        self.assertEqual(first['runs'][0]['batch_id'], RUN)
        self.assertIsNone(first['runs'][0]['model'])
        self.assertIsNone(first['runs'][0]['score'])
        second = self.catalog.list_task_runs(task_id='003', cursor=first['next_cursor'])
        self.assertEqual(len(second['runs']), 2)
        self.assertEqual(second['runs'][1]['score'], 0)
        with self.assertRaises(InvalidQuery):
            self.catalog.list_task_runs(task_id='003', cursor=first['next_cursor'], status='failed')
        self.assertEqual(len(self.catalog.list_task_runs(task_id='003', status='failed')['runs']), 1)

    def test_leaderboard_aggregates_scores_and_filters_smoke_and_dates(self):
        self.store.batch(tasks=[
            {'key': TASK, 'task_id': '003', 'status': 'succeeded',
             'score': 1, 'started_at': '2026-09-04T10:00:00Z',
             'finished_at': '2026-09-04T10:01:00Z'},
            {'key': '0002-003', 'task_id': '003', 'status': 'succeeded', 'score': 0},
            {'key': '0003-004', 'task_id': '004', 'status': 'succeeded', 'score': 1},
        ])
        self.store.put(f'harness/{RUN}/batch-config.json', {
            'model_name': 'qwen-test', 'orchestration': 'stateact', 'runtime_name': 'omp-qwen',
        })
        smoke = '20260905T100000Z-check-smoke'
        self.store.batch(smoke, [{'key': TASK, 'task_id': '003', 'status': 'succeeded', 'score': 0}])
        outside = '20260903T100000Z-outside-suite'
        self.store.batch(outside, [{'key': TASK, 'task_id': '082', 'status': 'succeeded', 'score': 1}])
        sync = IndexSynchronizer(self.catalog, self.index)
        sync.scan_once()
        board = self.catalog.leaderboard()
        self.assertEqual(board['attempts'], 3)
        self.assertEqual(board['excluded_smoke_attempts'], 1)
        self.assertEqual(board['excluded_out_of_suite_attempts'], 1)
        self.assertEqual(board['rows'][0]['model'], 'qwen-test')
        self.assertEqual(board['rows'][0]['task_count'], 2)
        self.assertEqual(board['rows'][0]['scored_task_count'], 2)
        self.assertEqual(board['rows'][0]['pass_rate'], 0.75)
        self.assertEqual(board['rows'][0]['score']['avg'], 0.75)
        self.assertEqual(board['rows'][0]['score']['min'], 0.5)
        self.assertEqual(board['rows'][0]['score']['max'], 1)
        self.assertEqual(board['rows'][0]['duration_ms_avg'], 60000)
        self.assertEqual(self.catalog.leaderboard(date_from='2026-09-05')['attempts'], 0)
        self.assertEqual(self.catalog.leaderboard(include_smoke=True)['attempts'], 4)
        with self.assertRaises(InvalidQuery):
            self.catalog.leaderboard(date_from='2026-09-05', date_to='2026-09-04')

        stats = self.catalog.task_stats()
        self.assertEqual(stats['task_count'], 107)
        task = next(item for item in stats['tasks'] if item['task_id'] == '003')
        self.assertEqual((task['runs'], task['scored'], task['passed']), (3, 3, 1))
        self.assertEqual((task['full_marks'], task['partials'], task['zeros']), (1, 0, 2))
        self.assertAlmostEqual(task['mean_score'], 1 / 3)
        self.assertAlmostEqual(task['pass_rate'], 1 / 3)
        self.assertEqual(task['latest']['batch_id'], smoke)
        self.assertEqual(next(item for item in stats['tasks'] if item['task_id'] == '004')['runs'], 1)

    def test_leaderboard_ranks_unique_coverage_before_task_average_score(self):
        def attempt(batch_id, task_key, task_id, model, score):
            return {
                'batch_id': batch_id, 'batch_name': batch_id, 'task_key': task_key,
                'task_id': task_id, 'model': model, 'framework': 'stateact',
                'status': 'succeeded', 'score': score,
            }

        self.index.replace_batch('20260901T000000Z-narrow', [
            attempt('20260901T000000Z-narrow', '0001-001', '001', 'narrow-perfect', 1),
        ])
        self.index.replace_batch('20260901T000001Z-wide-low', [
            attempt('20260901T000001Z-wide-low', '0001-001', '001', 'wide-low', 0),
            attempt('20260901T000001Z-wide-low', '0002-002', '002', 'wide-low', 0),
        ])
        self.index.replace_batch('20260901T000002Z-wide-high', [
            attempt('20260901T000002Z-wide-high', '0001-001', '001', 'wide-high', 1),
            attempt('20260901T000002Z-wide-high', '0002-002', '002', 'wide-high', 1),
        ])

        rows = self.index.leaderboard()['rows']
        self.assertEqual([row['model'] for row in rows], [
            'wide-high', 'wide-low', 'narrow-perfect',
        ])
        self.assertEqual([row['task_count'] for row in rows], [2, 2, 1])

    def test_index_failure_retains_previous_data_and_complete_scan_removes_deleted(self):
        sync = IndexSynchronizer(self.catalog, self.index)
        sync.scan_once()
        key = f'harness/{RUN}/batch.json'
        self.store.data[key] = OssError(403, 'AccessDenied', 'no')
        self.assertEqual(sync.scan_once()['status'], 'failed')
        self.assertEqual(len(self.catalog.list_task_runs(task_id='003')['runs']), 1)
        del self.store.data[key]
        self.assertEqual(sync.scan_once()['status'], 'ready')
        self.assertEqual(self.catalog.list_task_runs(task_id='003')['runs'], [])

    def test_historical_execution_directory_is_confined(self):
        directory = f'tasks/{TASK}/historical-run'
        self.store.batch(tasks=[{'key': TASK, 'task_id': '003', 'run_dir': directory}])
        self.store.artifact('historical-run/trajectory.json', trajectory())
        self.assertEqual(len(self.replay.get_trajectory(run=RUN, task=TASK)['steps']), 1)
        self.store.batch(tasks=[{'key': TASK, 'task_id': '003', 'run_dir': 'tasks/another-task'}])
        with self.assertRaises(OssProtocolError):
            self.reader.execution(RUN, TASK)
        with self.assertRaises(ResourceNotFound):
            self.reader.execution(RUN, 'unknown')

    def test_native_complete_media_rebasing_and_digest(self):
        doc = trajectory()
        doc['steps'][0]['message'] = [{'type': 'image', 'source': {'path': f'images/{SHA}.png', 'media_type': 'image/png'}}]
        self.store.artifact('agent/trajectory.json', doc)
        self.store.artifact(f'agent/images/{SHA}.png', PNG)
        value = self.replay.get_trajectory(run=RUN, task=TASK)
        path = value['steps'][0]['message'][0]['source']['path']
        self.assertEqual(path, f'agent/images/{SHA}.png')
        self.assertEqual(self.replay.get_atif_media(run=RUN, task=TASK, path=path).data, PNG)
        self.assertEqual(self.replay.get_model_image(run=RUN, task=TASK, path=path, sha256=SHA).data, PNG)
        with self.assertRaises(OssProtocolError):
            self.replay.get_model_image(run=RUN, task=TASK, path=path, sha256='0'*64)
        with self.assertRaises(InvalidQuery):
            self.replay.get_atif_media(run=RUN, task=TASK, path='../secret')

    def live(self):
        event = {'event_type': 'goal', 'episode_elapsed_ms': 125, 'record': {'id': 'goal'}}
        records = [patch('begin_step', step=step()), patch('append_execution_state_event', event=event)]
        self.store.artifact('trajectory-tail.meta.json', {
            'trace_format': 'atif-stream', 'stream_schema_version': STREAM_VERSION,
            'manifest_schema_version': MANIFEST_VERSION, 'total_lines': 2,
            'chunks': [{'start': 0, 'count': 1}, {'start': 1, 'count': 1}], 'terminal': False})
        for index, entry in enumerate(records):
            self.store.artifact(f'trajectory-tail.jsonl.chunks/{index:012d}-{index+1:012d}.jsonl', json.dumps(entry).encode()+b'\n')

    def test_native_live_cursor_skips_consumed_chunks_and_projects_state(self):
        self.live()
        live = self.replay.get_atif_live(run=RUN, task=TASK, after=1)
        self.assertEqual(live['start_line'], 1)
        self.assertEqual(len(live['records']), 1)
        self.assertFalse(any('000000000000-000000000001' in key for key in self.store.reads))
        self.assertEqual(self.replay.get_atif_live(run=RUN, task=TASK, after=2)['records'], [])
        self.assertEqual(self.replay.get_atif_live(run=RUN, task=TASK, after=3)['start_line'], 0)
        state = self.replay.get_execution_state(run=RUN, task=TASK)
        self.assertEqual(state['counts']['goal'], 1)
        with self.assertRaises(ResourceNotFound):
            self.replay.get_trajectory(run=RUN, task=TASK)
        snapshot = self.replay.get_analysis_trajectory(run=RUN, task=TASK)
        self.assertEqual(snapshot['trajectory_id'], 'root')
        self.assertEqual(snapshot['steps'][0]['message'], 'hello')
        self.assertEqual(snapshot['extra']['osworld_harness']['run']['execution_status'],
                         'snapshot')
        self.store.artifact('trajectory.json', trajectory())
        self.assertEqual(len(self.replay.get_trajectory(run=RUN, task=TASK)['steps']), 1)

    def test_native_pages_continue_from_consumed_lines_and_projection_drops_old_upserts(self):
        self.live()
        ex = self.reader.execution(RUN, TASK)
        meta = self.reader.read_json(ex, 'trajectory-tail.meta.json')
        first = self.replay._stream(ex, meta, page_bytes=1)
        self.assertEqual(len(first['records']), 1)
        self.assertTrue(first['has_more'])
        second = self.replay._stream(ex, meta, after=1, page_bytes=1)
        self.assertFalse(second['has_more'])
        self.assertEqual(second['start_line'], 1)
        from backend.parsers.replay_view import NativeProjection
        projection = NativeProjection()
        projection.add(patch('begin_step', step=step('old')))
        projection.add(patch('upsert_step', step=step('new')))
        projection.add(patch('tool_execution_start', step_id=1, tool_call={
            'tool_call_id':'c','function_name':'bash','arguments':{}}))
        projection.add(patch('tool_execution_end', step_id=1, result={'source_call_id':'c','content':'done'}))
        projection.add(patch('tool_execution_update', step_id=1, tool_call_id='c',
                             progress={'content': 'discard me'}))
        records = projection.records()
        self.assertEqual(len(records), 1)
        self.assertEqual(records[0]['step']['message'], 'new')
        self.assertEqual(records[0]['step']['observation']['results'][0]['source_call_id'], 'c')

    def test_native_compaction_streams_past_aggregate_source_limit(self):
        ex = self.reader.execution(RUN, TASK)
        records = [patch('begin_step', step=step())]
        records.extend(patch('tool_execution_update', step_id=1, tool_call_id='c',
                             progress={'content': 'x' * 700}) for _ in range(12))
        chunks = []
        for index, entry in enumerate(records):
            body = json.dumps(entry).encode() + b'\n'
            self.assertLess(len(body), 1024)
            self.store.artifact(
                f'trajectory-tail.jsonl.chunks/{index:012d}-{index+1:012d}.jsonl', body)
            chunks.append({'start': index, 'count': 1})
        meta = {'trace_format': 'atif-stream', 'stream_schema_version': STREAM_VERSION,
                'manifest_schema_version': MANIFEST_VERSION, 'total_lines': len(records),
                'chunks': chunks, 'terminal': False}
        self.reader.max_object_bytes = 1024
        compact = self.replay._stream(ex, meta, compact=True)
        self.assertEqual(len(compact['records']), 1)
        self.assertEqual(compact['records'][0]['op'], 'append_step')

    def test_overlapping_native_stream_recovers_without_retaining_update_history(self):
        ex = self.reader.execution(RUN, TASK)
        begin = patch('begin_step', step=step())
        updates = [patch('tool_execution_update', step_id=1, tool_call_id='c',
                         progress={'content': str(index)}) for index in range(20)]
        records = [begin, *updates]
        groups = [(0, records[:11]), (10, records[10:])]
        chunks = []
        for start, group in groups:
            end = start + len(group)
            self.store.artifact(
                f'trajectory-tail.jsonl.chunks/{start:012d}-{end:012d}.jsonl',
                b'\n'.join(json.dumps(record).encode() for record in group) + b'\n')
            chunks.append({'start': start, 'count': len(group)})
        meta = {'trace_format': 'atif-stream', 'stream_schema_version': STREAM_VERSION,
                'manifest_schema_version': MANIFEST_VERSION, 'total_lines': len(records),
                'chunks': chunks, 'terminal': False}
        compact = self.replay._stream(ex, meta, compact=True)
        self.assertEqual(len(compact['records']), 1)
        self.assertEqual(compact['stream']['recovered_duplicate_records'], 1)
        page = self.replay._stream(ex, meta, after=10, page_bytes=1)
        self.assertEqual(page['start_line'], 10)
        self.assertEqual(len(page['records']), 1)
        self.assertTrue(page['has_more'])

    def test_native_window_folds_calls_before_slicing_and_response_limit_is_explicit(self):
        from backend.parsers.replay_view import window_steps
        from unittest.mock import patch as mock_patch
        records = [patch('begin_step', step=step()),
                   patch('tool_execution_start', step_id=1, tool_call={
                       'tool_call_id':'call','function_name':'bash','arguments':{}}),
                   patch('tool_execution_end', step_id=1, result={'source_call_id':'call','content':'done'}),
                   patch('seal_step', step_id=1, timing={'start_ms':100,'end_ms':20100})]
        selected = window_steps(None, records, 5000, 10000, 20200)
        self.assertEqual(selected[0]['step']['observation']['results'][0]['content'], 'done')
        self.store.artifact('trajectory.json', trajectory())
        with TestClient(create_app(replay=self.replay)) as client, mock_patch('backend.router.MAX_JSON_BYTES',32):
            response = client.get('/api/trajectory',params={'run':RUN,'task':TASK})
            self.assertEqual(response.status_code,502)
            self.assertEqual(response.json()['error']['code'],'artifact_too_large')

    def test_advertised_missing_chunk_and_forbidden_metadata_are_upstream_errors(self):
        self.live()
        del self.store.data[f'harness/{RUN}/tasks/{TASK}/trajectory-tail.jsonl.chunks/000000000001-000000000002.jsonl']
        with TestClient(create_app(catalog=self.catalog, replay=self.replay)) as client:
            self.assertEqual(client.get('/api/atif-live', params={'run':RUN,'task':TASK}).status_code, 502)
            self.store.data[f'harness/{RUN}/batch.json'] = OssError(403, 'AccessDenied', 'secret')
            response = client.get('/api/batch', params={'run': RUN})
            self.assertEqual(response.status_code, 502)
            self.assertNotIn('secret', response.text)

    def test_legacy_rolling_tail_then_authoritative_complete_and_tool_pairing(self):
        records = [record(100,'message_start',message={'role':'assistant','content':[]}),
                   record(110,'tool_execution_start',toolCallId='call',toolName='bash',args={'cmd':'pwd'})]
        self.store.artifact('trace-tail.meta.json', {'total_lines':12,'count':2})
        self.store.artifact('trace-tail.jsonl', b'\n'.join(json.dumps(r).encode() for r in records))
        work = self.replay.get_agent_work(run=RUN, task=TASK)
        self.assertEqual(work['trace_coverage_start'], 10)
        self.assertIsNone(work['items'][0]['tools'][0]['end_ms'])
        live = self.replay.get_atif_live(run=RUN, task=TASK, after=999)
        self.assertEqual(live['start_line'], 0)
        self.assertTrue(live['stream']['reset'])
        records += [record(20100,'tool_execution_end',toolCallId='call',toolName='bash',result={'text':'/tmp'},isError=False),
                    record(20200,'message_end',message={'role':'assistant','content':[{'type':'text','text':'done'}]})]
        self.store.artifact('runtime-artifacts/runtime-trace.jsonl', b'\n'.join(json.dumps(r).encode() for r in records))
        work = self.replay.get_agent_work(run=RUN, task=TASK, center_ms=100,before_ms=5000,after_ms=5000)
        self.assertEqual(work['trace_coverage_start'], 0)
        self.assertEqual(work['items'][0]['tools'][0]['end_ms'], 20100)
        doc = self.replay.get_trajectory(run=RUN, task=TASK)
        self.assertEqual(doc['steps'][0]['tool_calls'][0]['tool_call_id'], 'call')
        self.assertEqual(doc['steps'][0]['observation']['results'][0]['source_call_id'], 'call')

    def test_frame_only_execution_is_available_and_window_keeps_previous_screen(self):
        self.store.artifact('replay/meta.json', {'total_frames':2,'episode_elapsed_ms':20000})
        for index, stamp in enumerate([1000, 10000]):
            self.store.artifact(f'replay/events/{index:012d}.json', {'frame_index':index,'episode_elapsed_ms':stamp,
                'image':{'path':f'frames/{SHA}.png','sha256':SHA}})
        self.store.artifact(f'replay/frames/{SHA}.png', PNG)
        window = self.replay.get_window(run=RUN,task=TASK,center_ms=12000,before_ms=5000,after_ms=5000)
        self.assertEqual([f['frame_index'] for f in window['frames']], [0,1])
        self.assertEqual(self.replay.get_frame(run=RUN,task=TASK,frame=1).content_type, 'image/png')
        self.assertEqual(self.replay.get_execution_state(run=RUN,task=TASK)['events'], [])
        with self.assertRaises(ResourceNotFound):
            self.replay.get_trajectory(run=RUN,task=TASK)


class InfrastructureTests(unittest.TestCase):
    def test_index_restart_preserves_history_cursor_and_marks_stale(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)/'index.sqlite3'
            index=ExecutionIndex(path, namespace='one')
            index.replace_batch(RUN,[{'batch_id':RUN,'task_key':TASK,'task_id':'003'}])
            index.set_state({'status':'ready','last_success':'earlier'})
            identity=index.identity
            index.close()
            index=ExecutionIndex(path, namespace='one')
            self.assertEqual(index.identity,identity)
            self.assertEqual(index.state()['status'],'stale')
            index.close()
            with self.assertRaises(ValueError):
                ExecutionIndex(path, namespace='two')

    def test_cache_shares_inflight_and_expires_evicts_and_recovers_failure(self):
        now=[0]
        cache=ReadCache(max_bytes=1000,max_entries=1,clock=lambda:now[0])
        entered, release=threading.Event(),threading.Event()
        calls=[]
        def load():
            calls.append(1); entered.set(); release.wait(2); return b'value'
        with ThreadPoolExecutor(2) as pool:
            first=pool.submit(cache.get,'a',load)
            self.assertTrue(entered.wait(1))
            second=pool.submit(cache.get,'a',load)
            release.set()
            self.assertEqual(first.result(),second.result())
        self.assertEqual(len(calls),1)
        cache.get('b',lambda:b'other')
        self.assertNotIn('a',cache.entries)
        now[0]=3; cache.prune()
        self.assertEqual(cache.bytes,0)
        with self.assertRaises(ValueError):
            cache.get('bad',lambda:(_ for _ in ()).throw(ValueError()))
        self.assertEqual(cache.get('bad',lambda:42),42)
        cache.get('large',lambda:b'x'*2000)
        self.assertNotIn('large',cache.entries)

    def test_real_app_factory_lifecycle_with_injected_transport(self):
        from unittest.mock import patch as mock_patch
        store=Store(); store.batch(); store.artifact('trajectory.json',trajectory())
        cfg={'access_key_id':'test','access_key_secret':'secret','bucket':'test','endpoint':'https://example.com','region':'region'}
        with tempfile.TemporaryDirectory() as directory, mock_patch('backend.oss_io.client.OssClient',return_value=store):
            app=create_oss_app(Settings(
                credentials=cfg, index_path=directory+'/index.sqlite3',
                aft_path=directory+'/aft.sqlite3',
            ))
            with TestClient(app) as client:
                self.assertTrue(client.get('/api/health').json()['services_configured']['catalog'])
                self.assertEqual(client.get('/api/trajectory',params={'run':RUN,'task':TASK}).status_code,200)
                app.state.sync.scan_once()
                self.assertEqual(len(client.get('/api/task-runs',params={'task_id':'003'}).json()['runs']),1)
            self.assertFalse(app.state.sync.thread.is_alive())


if __name__ == '__main__':
    unittest.main()
