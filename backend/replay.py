"""Concrete replay service: native ATIF plus server-side legacy normalization."""
from copy import deepcopy
import hashlib
from pathlib import PurePosixPath
import re
import threading

from .artifacts import ATIF_PATHS, json_value, relative_path
from .cache import ReadCache
from .metadata import TERMINAL, execution_summary
from .oss_io.client import OssNoSuchKey, OssObjectTooLarge, OssProtocolError
from .parsers.atif_stream import STREAM_VERSION, assemble_records, descriptors, validate_records, validate_trajectory
from .parsers.execution_state import execution_state_feed, execution_state_extension_feed
from .parsers.legacy_trace import annotate_for_work, build_episode_work, slice_episode_work
from .parsers.legacy_to_atif import legacy_to_atif
from .parsers.replay_view import (agent_stamps, frame_event, milliseconds, portable_frame,
                                  snapshot_updates, state_extension, state_from_live, window_steps, NativeProjection)
from .services import ImageContent, InvalidQuery, JsonDocument, ResourceNotFound


class ReplayService:
    def __init__(self, reader, *, cache=None, concurrency=2, max_frames=20000):
        self.reader = reader
        self.cache = cache if cache is not None else ReadCache(max_bytes=64 * 1024 * 1024, max_entries=16)
        self.slots = threading.BoundedSemaphore(concurrency)
        self.max_frames = max_frames

    def _stream(self, execution, meta, *, after=0, legacy=False, compact=False, page_bytes=None):
        chunks = descriptors(meta, legacy=legacy)
        start = after if after <= meta['total_lines'] else 0
        records, used = [], 0
        recovery = not legacy and any(chunk['start'] != (chunks[i-1]['start'] + chunks[i-1]['count'] if i else 0)
                                     for i, chunk in enumerate(chunks))
        recovery = recovery or (not legacy and bool(chunks) and chunks[-1]['start'] + chunks[-1]['count'] != meta['total_lines'])
        parts = []
        projection = NativeProjection() if compact else None
        budget = self.reader.max_object_bytes * (8 if compact else 1)
        name = 'trace-tail.jsonl' if legacy else 'trajectory-tail.jsonl'
        for chunk in chunks:
            end = chunk['start'] + chunk['count']
            if end <= start and not recovery:
                continue
            path = f"{name}.chunks/{chunk['start']:012d}-{end:012d}.jsonl"
            try:
                raw = self.reader.read_bytes(execution, path, immutable=True,
                                             max_bytes=min(self.reader.max_object_bytes, budget - used))
            except OssNoSuchKey as exc:
                raise OssProtocolError('Published stream chunk is missing') from exc
            used += len(raw)
            parsed = [json_value(line) for line in raw.splitlines() if line.strip()]
            if len(parsed) != chunk['count'] or not all(isinstance(x, dict) for x in parsed):
                raise OssProtocolError('Chunk contents disagree with manifest')
            if not legacy:
                validate_records(parsed)
            if recovery:
                parts.append(parsed)
            elif projection is not None:
                for record in parsed:
                    projection.add(record)
            else:
                records.extend(parsed[max(0, start - chunk['start']):])
                if page_bytes is not None and used >= page_bytes:
                    break
        stream = dict(meta.get('stream') or {})
        if recovery:
            records, duplicates = assemble_records(meta, parts)
            records = records[start:]
            if duplicates:
                stream['recovered_duplicate_records'] = duplicates
            if projection is not None:
                for record in records:
                    projection.add(record)
        if projection is not None:
            records = projection.records()
        has_more = not compact and start + len(records) < meta['total_lines']
        return {'trace_format': 'atif-stream', 'stream_schema_version': STREAM_VERSION,
                'start_line': start, 'total_lines': meta['total_lines'], 'records': records,
                'terminal': bool(meta.get('terminal')), 'has_more': has_more, 'stream': stream}

    def _legacy_records(self, execution):
        records = None
        for path in ('runtime-artifacts/runtime-trace.jsonl', 'runtime-trace.jsonl'):
            records = self.reader.lines(execution, path, optional=True)
            if records is not None:
                break
        complete, base = records is not None, 0
        if records is None:
            meta = self.reader.read_json(execution, 'trace-tail.meta.json', optional=True)
            if meta and meta.get('schema_version') == '2.0':
                records = self._stream(execution, meta, legacy=True)['records']
            else:
                records = self.reader.lines(execution, 'trace-tail.jsonl', optional=True)
                if records is not None and meta:
                    total, count = meta.get('total_lines', len(records)), meta.get('count', len(records))
                    if type(total) is not int or type(count) is not int or count != len(records) or total < count:
                        raise OssProtocolError('Invalid rolling trace tail')
                    base = total - count
        if records is None:
            raise ResourceNotFound('No trajectory available')
        normalized = []
        for index, original in enumerate(records, base):
            record = {**original, 'trace_index': index}
            if not record.get('origin'):
                for suffix in ('gui_worker', 'gui_reviewer'):
                    if str(record.get('role', '')).endswith(suffix):
                        record['origin'] = suffix
            normalized.append(record)
        # Match prior Replay: annotate numbering in append order, then sort by
        # real episode time. Producer wall-clock changes must not reorder work.
        normalized = annotate_for_work(normalized)
        if all(type(x.get('episode_elapsed_ms')) is int for x in normalized):
            normalized.sort(key=lambda x: (x['episode_elapsed_ms'], x.get('sequence', 0)))
        return normalized, complete, base

    def _sidecar_frames(self, execution, meta):
        if not meta:
            return []
        total = meta.get('total_frames')
        if type(total) is not int or not 0 <= total <= self.max_frames:
            raise OssProtocolError('Invalid replay frame count')
        frames, used = [], 0
        for index in range(total):
            try:
                raw = self.reader.read_bytes(execution, f'replay/events/{index:012d}.json', immutable=True,
                                             max_bytes=self.reader.max_object_bytes - used)
                used += len(raw)
                event = json_value(raw)
            except OssNoSuchKey as exc:
                raise OssProtocolError('Published frame event is missing') from exc
            if not isinstance(event, dict) or event.get('frame_index') != index:
                raise OssProtocolError('Invalid replay frame index')
            frames.append(event)
        return frames

    @staticmethod
    def _rebase(doc, path):
        parent = str(PurePosixPath(path).parent)
        if parent == '.':
            return doc
        def visit(value):
            if isinstance(value, dict):
                source = value.get('source')
                if value.get('type') == 'image' and isinstance(source, dict):
                    media = source.get('path')
                    if isinstance(media, str) and not re.match(r'^(https?:|data:|blob:|/api/)', media):
                        try:
                            source['path'] = parent + '/' + relative_path(media)
                        except InvalidQuery as exc:
                            raise OssProtocolError('Invalid stored ATIF media path') from exc
                for child in value.values():
                    visit(child)
            elif isinstance(value, list):
                for child in value:
                    visit(child)
        visit(doc)
        return doc

    def _load_view(self, run, task):
        with self.slots:
            ex = self.reader.execution(run, task)
            result = self.reader.read_json(ex, 'result.json', optional=True) or {}
            state = self.reader.read_json(ex, 'run_state.json', optional=True) or {}
            summary = execution_summary(ex, result, state)
            replay_meta = self.reader.read_json(ex, 'replay/meta.json', optional=True)
            native, path = self.reader.native_trajectory(ex)
            records, work, coverage = [], None, 0
            if native is not None:
                trajectory = self._rebase(validate_trajectory(native), path)
                harness = trajectory.get('extra', {}).get('osworld_harness', {})
                timeline = harness.get('desktop_timeline')
                frames = [frame_event(f) for f in timeline.get('frames', [])] if isinstance(timeline, dict) else None
                terminal = True
                feed = execution_state_extension_feed(trajectory) or execution_state_feed([])
            else:
                manifest = self.reader.read_json(ex, 'trajectory-tail.meta.json', optional=True)
                if manifest is not None:
                    live = self._stream(ex, manifest, compact=True)
                    records = live['records']
                    frames = [frame_event(r['frame']) for r in records if r['op'] == 'append_desktop_frame']
                    terminal = live['terminal']
                    feed = state_from_live(records) or execution_state_feed([])
                    trajectory = None
                    if not frames:
                        frames = None
                else:
                    try:
                        records, complete, coverage = self._legacy_records(ex)
                    except ResourceNotFound:
                        records, complete, coverage = [], False, 0
                    terminal = complete or bool((replay_meta or {}).get('terminal')) or summary['status'] in TERMINAL
                    frames = None
                    feed = execution_state_feed(records)
                    trajectory = None
            if frames is None:
                frames = self._sidecar_frames(ex, replay_meta)
            if len(frames) > self.max_frames:
                raise OssObjectTooLarge('Too many replay frames')
            by_id = {}
            for frame in frames:
                if type(frame.get('frame_index')) is not int or frame['frame_index'] < 0:
                    raise OssProtocolError('Invalid desktop frame')
                by_id[frame['frame_index']] = frame
            frames = sorted(by_id.values(), key=lambda f: (milliseconds(f.get('episode_elapsed_ms')), f['frame_index']))
            duration = max([0, summary.get('duration_ms') or 0,
                            milliseconds(harness.get('run', {}).get('duration_ms')) if native is not None else 0,
                            milliseconds((replay_meta or {}).get('episode_elapsed_ms'))]
                           + [milliseconds(f.get('episode_elapsed_ms')) for f in frames]
                           + [milliseconds(r.get('episode_elapsed_ms')) for r in records]
                           + [milliseconds(e.get('episode_elapsed_ms')) for e in feed['events']])
            if native is None and not any(r.get('trace_format') == 'atif-stream' for r in records):
                # Empty native stream is still native, not a legacy fold.
                if manifest is None:
                    work = build_episode_work(records, duration, terminal=terminal, duration_ms=duration)
                    work['task_status'] = summary['status']
                    config = ex.batch.get('configuration') or {}
                    trajectory = legacy_to_atif(work, run=run, task=task,
                                                agent_name=config.get('orchestration') or 'agent',
                                                model=summary.get('model'), agent_version=config.get('agent_version') or 'unknown')
                    if trajectory['steps']:
                        validate_trajectory(trajectory)
            stamps = agent_stamps(trajectory, records if work is None else [])
            duration = max([duration] + [s['at_ms'] for s in stamps])
            feed = {**feed, 'duration_ms': duration, 'terminal': terminal, 'task_status': summary['status']}
            if trajectory:
                extra = trajectory.setdefault('extra', {})
                harness = extra.setdefault('osworld_harness', {})
                harness.setdefault('schema_version', 'osworld-harness/v1')
                harness['run'] = {**harness.get('run', {}), **{
                    'batch_id': run, 'task_key': task, 'task_id': summary['task_id'],
                    'execution_status': summary['status'], 'evaluation_status': summary['evaluation_status'],
                    'agent_outcome': summary['agent_outcome'], 'score': summary['score'],
                    'duration_ms': duration, 'terminal': terminal,
                }}
                harness['desktop_timeline'] = {'schema_version': 'desktop-timeline/v1', 'clock': 'episode_elapsed_ms',
                    'frames': [portable_frame(f) for f in frames], 'total_frames': len(frames),
                    'terminal': terminal, 'status': 'enabled' if frames else 'disabled', 'warnings': []}
                if feed['events']:
                    extra['osworld_execution_state'] = state_extension(feed)
            return {'trajectory': trajectory, 'records': records, 'work': work,
                    'frames': frames, 'state': feed, 'duration_ms': duration, 'terminal': terminal,
                    'agent_stamps': stamps, 'coverage_start': coverage}

    def _view(self, run, task):
        # Plain containers let retained_size account for the complete view.
        return self.cache.get((run, task), lambda: self._load_view(run, task), ttl=self.reader.live_ttl)

    def get_trajectory(self, *, run: str, task: str) -> JsonDocument:
        """Return complete native ATIF or a normalized snapshot of legacy work."""
        ex = self.reader.execution(run, task)
        native, _ = self.reader.native_trajectory(ex)
        if native is None and self.reader.read_json(ex, 'trajectory-tail.meta.json', optional=True) is not None:
            # A live execution need not download its history to report that the
            # terminal document has not been published yet.
            raise ResourceNotFound('Complete ATIF document not published yet')
        view = self._view(run, task)
        if not view['trajectory'] or not view['trajectory']['steps']:
            raise ResourceNotFound('Complete ATIF document not available; use live endpoint')
        return view['trajectory']

    def get_atif_live(self, *, run: str, task: str, after: int = 0) -> JsonDocument:
        """Read native append-only lines; legacy snapshots explicitly reset to line zero."""
        if type(after) is not int or not 0 <= after <= 1_000_000:
            raise InvalidQuery('Invalid ATIF cursor')
        ex = self.reader.execution(run, task)
        manifest = self.reader.read_json(ex, 'trajectory-tail.meta.json', optional=True)
        if manifest is not None:
            with self.slots:
                return self._stream(ex, manifest, after=after, page_bytes=8 * 1024 * 1024)
        view = self._view(run, task)
        if not view['trajectory'] or not view['trajectory']['steps']:
            raise ResourceNotFound('No trajectory records yet')
        return snapshot_updates(view['trajectory'], view['frames'], view['state'], view['terminal'])

    def get_window(self, *, run: str, task: str, center_ms: int = -1, before_ms: int = 30000,
                   after_ms: int = 60000, include_timeline: bool = True) -> JsonDocument:
        """Return timed records/whole steps and frames, retaining the preceding screen."""
        view = self._view(run, task)
        target = view['duration_ms'] if center_ms == -1 else min(view['duration_ms'], max(0, center_ms))
        low, high = max(0, target - before_ms), min(view['duration_ms'], target + after_ms)
        frames = [f for f in view['frames'] if low <= milliseconds(f.get('episode_elapsed_ms')) <= high]
        previous = [f for f in view['frames'] if milliseconds(f.get('episode_elapsed_ms')) < low]
        if previous:
            frames.insert(0, previous[-1])
        response = {'start_ms': low, 'end_ms': high, 'duration_ms': view['duration_ms'], 'terminal': view['terminal'],
                    'frames': frames, 'records': [r for r in view['records']
                                                 if low <= milliseconds(r.get('episode_elapsed_ms')) <= high]}
        if view['work'] is not None:
            # Fold before slicing: calls/results remain paired across a window boundary.
            response['work'] = slice_episode_work(view['work'], low, high, view['duration_ms'])
        response['steps'] = window_steps(view['trajectory'], view['records'], low, high, view['duration_ms'])
        if include_timeline:
            response['timeline'] = {'agent': view['agent_stamps'], 'desktop': [
                {'at_ms': milliseconds(f.get('episode_elapsed_ms')), 'frame_index': f['frame_index']} for f in view['frames']]}
        return response

    def get_execution_state(self, *, run: str, task: str) -> JsonDocument:
        """Project the producer's execution-state events, counts and final state."""
        return self._view(run, task)['state']

    def _image(self, ex, path, digest=None):
        body = self.reader.read_bytes(ex, path, max_bytes=32 * 1024 * 1024)
        if digest is not None and (not isinstance(digest, str) or not re.fullmatch('[0-9a-fA-F]{64}', digest)
                                   or hashlib.sha256(body).hexdigest() != digest.lower()):
            raise OssProtocolError('Image digest mismatch')
        mime = None
        if len(body) >= 24 and body.startswith(b'\x89PNG\r\n\x1a\n'):
            mime = 'image/png'
        elif len(body) >= 4 and body.startswith(b'\xff\xd8\xff'):
            mime = 'image/jpeg'
        elif len(body) >= 12 and body.startswith(b'RIFF') and body[8:12] == b'WEBP':
            mime = 'image/webp'
        elif len(body) >= 10 and body.startswith((b'GIF87a', b'GIF89a')):
            mime = 'image/gif'
        if mime is None:
            raise OssProtocolError('Invalid image data')
        return ImageContent(body, mime)

    def get_frame(self, *, run: str, task: str, frame: int) -> ImageContent:
        """Resolve a desktop frame index and verify its image bytes and digest."""
        if type(frame) is not int or frame < 0:
            raise InvalidQuery('Invalid frame index')
        ex = self.reader.execution(run, task)
        event = self.reader.read_json(ex, f'replay/events/{frame:012d}.json', optional=True, immutable=True)
        if event is None:
            event = next((f for f in self._view(run, task)['frames'] if f['frame_index'] == frame), None)
        if event is None:
            raise ResourceNotFound('Frame not found')
        if event.get('frame_index') != frame:
            raise OssProtocolError('Frame index mismatch')
        image = frame_event(event).get('image') or {}
        path = relative_path(image.get('path'))
        if path.startswith('frames/'):
            path = 'replay/' + path
        return self._image(ex, path, image.get('sha256'))

    def get_model_image(self, *, run: str, task: str, path: str, sha256: str) -> ImageContent:
        """Read a legacy model image confined to this execution and verify SHA-256."""
        ex = self.reader.execution(run, task)
        path = relative_path(path)
        return self._image(ex, 'replay/' + path if path.startswith('frames/') else path, sha256)

    def get_atif_media(self, *, run: str, task: str, path: str) -> ImageContent:
        """Read native/normalized ATIF media, supporting historical document folders."""
        ex = self.reader.execution(run, task)
        path = relative_path(path)
        # Normalized documents use execution-relative paths. Historical raw
        # ATIF callers may still send a path relative to its document folder.
        candidates = [path]
        for filename in ATIF_PATHS:
            parent = str(PurePosixPath(filename).parent)
            if parent != '.':
                candidates.append(parent + '/' + path)
        for candidate in dict.fromkeys(candidates):
            try:
                digest = PurePosixPath(candidate).stem
                return self._image(ex, candidate, digest if re.fullmatch('[0-9a-fA-F]{64}', digest) else None)
            except OssNoSuchKey:
                continue
        raise ResourceNotFound('ATIF image not found')

    def get_agent_work(self, *, run: str, task: str, center_ms: int = -1,
                       before_ms: int | None = None, after_ms: int | None = None) -> JsonDocument:
        """Transitional legacy view; pair tools before applying a time window."""
        view = self._view(run, task)
        if view['work'] is None:
            raise ResourceNotFound('Execution uses native ATIF')
        duration = view['duration_ms']
        target = duration if center_ms == -1 else min(duration, max(0, center_ms))
        low = max(0, target - (before_ms if before_ms is not None else duration))
        high = min(duration, target + (after_ms or 0))
        return {**slice_episode_work(view['work'], low, high, duration),
                'start_ms': low, 'end_ms': high, 'trace_coverage_start': view['coverage_start']}
