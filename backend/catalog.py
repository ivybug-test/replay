"""Batch metadata and cross-date execution history over the shared OSS reader."""
from datetime import date as Date
import re
from .cache import ReadCache
from .metadata import execution_summary
from .services import InvalidQuery, JsonDocument, ServiceUnavailable


class CatalogService:
    def __init__(self, reader, index=None):
        self.reader, self.index = reader, index
        self.cache = ReadCache(max_bytes=8 * 1024 * 1024, max_entries=64)

    def list_runs(self, *, date: str | None = None) -> JsonDocument:
        """List published batches on the requested/latest date without reading traces."""
        if date is not None:
            try:
                if Date.fromisoformat(date).isoformat() != date:
                    raise ValueError
            except (TypeError, ValueError) as exc:
                raise InvalidQuery('date must use YYYY-MM-DD') from exc
        def load():
            runs = self.cache.get('directories', lambda: tuple(self.reader.batches()), ttl=10)
            days = {}
            for run in runs:
                if not re.match(r'^\d{8}T', run):
                    continue
                day = f'{run[:4]}-{run[4:6]}-{run[6:8]}'
                try:
                    Date.fromisoformat(day)
                except ValueError:
                    continue
                days.setdefault(day, []).append(run)
            def summaries(day):
                out = []
                for run in sorted(days.get(day, []), reverse=True):
                    batch = self.reader.batch(run, optional=True)
                    if batch is None:
                        continue  # Unpublished directory, not an upstream failure.
                    out.append({**{k: batch.get(k) for k in (
                        'batch_id', 'batch_name', 'status', 'counts', 'created_at', 'started_at', 'finished_at',
                    )}, 'task_count': len(batch['tasks'])})
                return out
            latest, latest_runs = None, []
            for day in sorted(days, reverse=True):
                latest_runs = summaries(day)
                if latest_runs:
                    latest = day
                    break
            selected = date or latest or Date.today().isoformat()
            return {'date': selected, 'latest_date': latest,
                    'runs': latest_runs if selected == latest else summaries(selected)}
        return self.cache.get(('runs', date), load, ttl=self.reader.live_ttl)

    def get_batch(self, *, run: str, stop=None) -> JsonDocument:
        """Load one batch and enrich attempts with independently reported evaluation."""
        batch = self.reader.batch(run)
        public_config = self.reader.batch_config(run, optional=True) or {}
        attempts = []
        for task in batch['tasks']:
            if stop and stop.is_set():
                raise ServiceUnavailable('Index synchronization stopped')
            execution = self.reader.execution(run, task['key'], batch=batch)
            result = self.reader.read_json(execution, 'result.json', optional=True)
            attempts.append(execution_summary(execution, result, public_config=public_config))
        return {**batch, 'tasks': attempts}

    def leaderboard(self, *, date_from: str | None = None, date_to: str | None = None,
                    include_smoke: bool = False) -> JsonDocument:
        """Aggregate indexed OSWorld attempts without reading trajectories."""
        if self.index is None:
            raise ServiceUnavailable('Execution index is not connected')
        return self.index.leaderboard(date_from=date_from, date_to=date_to,
                                      include_smoke=include_smoke)

    def task_stats(self) -> JsonDocument:
        """Return compact all-time statistics for the Tasks catalog."""
        if self.index is None:
            raise ServiceUnavailable('Execution index is not connected')
        return self.index.task_stats()

    def list_task_runs(self, *, task_id: str, cursor: str | None = None, limit: int = 50,
                       model: str | None = None, status: str | None = None) -> JsonDocument:
        """Page cross-date execution summaries, including index synchronization status."""
        if not isinstance(task_id, str) or not re.fullmatch(r'[0-9]{3}', task_id):
            raise InvalidQuery('Expected a three-digit task ID')
        if type(limit) is not int or not 1 <= limit <= 100 or (cursor is not None and (
                not isinstance(cursor, str) or not cursor or len(cursor) > 2048)):
            raise InvalidQuery('Invalid pagination')
        if self.index is None:
            raise ServiceUnavailable('Execution index is not connected')
        return self.index.query(task_id=task_id, cursor=cursor, limit=limit, model=model, status=status)
