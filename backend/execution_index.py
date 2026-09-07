"""Rebuildable SQLite execution summaries with stable, filter-bound keyset paging."""
import base64
import hashlib
import json
import sqlite3
import threading
import uuid
from datetime import date as Date
from pathlib import Path
from .services import InvalidQuery

OSWORLD_V2_TASK_IDS = frozenset(f'{number:03d}' for number in range(1, 109) if number != 82)


class ExecutionIndex:
    def __init__(self, path, *, namespace='default'):
        if str(path) != ':memory:':
            Path(path).parent.mkdir(parents=True, exist_ok=True)
        self.lock = threading.RLock()
        self.db = sqlite3.connect(str(path), check_same_thread=False, timeout=10)
        self.db.execute('PRAGMA journal_mode=WAL')
        self.db.executescript('''
            CREATE TABLE IF NOT EXISTS attempts (
                batch_id TEXT NOT NULL, task_key TEXT NOT NULL, task_id TEXT NOT NULL,
                model TEXT, status TEXT, body TEXT NOT NULL,
                PRIMARY KEY(batch_id, task_key));
            CREATE INDEX IF NOT EXISTS task_history ON attempts(task_id, batch_id DESC, task_key DESC);
            CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        ''')
        prior_namespace = self.db.execute("SELECT value FROM meta WHERE key='namespace'").fetchone()
        if prior_namespace and prior_namespace[0] != namespace:
            self.db.close()
            raise ValueError('Index belongs to another OSS location; choose a separate REPLAY_INDEX_PATH')
        with self.db:
            self.db.execute('INSERT OR IGNORE INTO meta VALUES (?, ?)', ('namespace', namespace))
            self.db.execute('INSERT OR IGNORE INTO meta VALUES (?, ?)', ('identity', str(uuid.uuid4())))
        self.identity = self.db.execute("SELECT value FROM meta WHERE key='identity'").fetchone()[0]
        prior = self._state()
        # A crash during a scan must not leave a permanent 'syncing' claim.
        self.set_state({**prior, 'status': 'stale' if prior.get('last_success') else 'pending'})

    def _state(self):
        row = self.db.execute("SELECT value FROM meta WHERE key='sync'").fetchone()
        return json.loads(row[0]) if row else {'status': 'pending', 'last_success': None}

    def state(self):
        with self.lock:
            return self._state()

    def set_state(self, value):
        with self.lock, self.db:
            self.db.execute('INSERT OR REPLACE INTO meta VALUES (?, ?)', ('sync', json.dumps(value)))

    def replace_batch(self, batch_id, attempts):
        # Replace atomically so removed/rekeyed entries cannot survive forever.
        rows = [(batch_id, a['task_key'], a['task_id'], a.get('model'), a.get('status'),
                 json.dumps(a, ensure_ascii=True, allow_nan=False)) for a in attempts]
        with self.lock, self.db:
            self.db.execute('DELETE FROM attempts WHERE batch_id=?', (batch_id,))
            self.db.executemany('INSERT INTO attempts VALUES (?, ?, ?, ?, ?, ?)', rows)

    def query(self, *, task_id, cursor, limit, model, status):
        filters = [task_id, model, status]
        fingerprint = hashlib.sha256(json.dumps(filters, ensure_ascii=True).encode()).hexdigest()
        after = None
        if cursor:
            try:
                decoded = base64.b64decode(cursor + '=' * (-len(cursor) % 4), altchars=b'-_', validate=True)
                token = json.loads(decoded)
                after = token['after']
                if (token.get('v') != 1 or token.get('index') != self.identity
                        or token.get('filters') != fingerprint or not isinstance(after, list)
                        or len(after) != 2 or not all(isinstance(x, str) for x in after)):
                    raise ValueError
            except (ValueError, KeyError, TypeError, UnicodeError) as exc:
                raise InvalidQuery('Invalid history cursor') from exc
        clauses, params = ['task_id=?'], [task_id]
        if model is not None:
            clauses.append('model=?'); params.append(model)
        if status is not None:
            clauses.append('status=?'); params.append(status)
        if after:
            clauses.append('(batch_id, task_key) < (?, ?)'); params.extend(after)
        sql = 'SELECT body FROM attempts WHERE ' + ' AND '.join(clauses)
        sql += ' ORDER BY batch_id DESC, task_key DESC LIMIT ?'
        with self.lock:
            rows = self.db.execute(sql, [*params, limit + 1]).fetchall()
            sync = self._state()
        values = [json.loads(row[0]) for row in rows]
        next_cursor = None
        if len(values) > limit:
            values = values[:limit]
            last = values[-1]
            token = {'v': 1, 'index': self.identity, 'filters': fingerprint,
                     'after': [last['batch_id'], last['task_key']]}
            next_cursor = base64.urlsafe_b64encode(json.dumps(token).encode()).decode().rstrip('=')
        return {'task_id': task_id, 'runs': values, 'next_cursor': next_cursor, 'sync': sync}

    def leaderboard(self, *, date_from=None, date_to=None, include_smoke=False):
        """Return model aggregates, weighting each distinct task equally."""
        def validate_date(value, name):
            if value is None:
                return None
            try:
                if Date.fromisoformat(value).isoformat() != value:
                    raise ValueError
            except (TypeError, ValueError) as exc:
                raise InvalidQuery(f'{name} must use YYYY-MM-DD') from exc
            return value.replace('-', '')

        start, end = validate_date(date_from, 'date_from'), validate_date(date_to, 'date_to')
        if start and end and start > end:
            raise InvalidQuery('date_from must not be after date_to')
        with self.lock:
            rows = [json.loads(row[0]) for row in self.db.execute('SELECT body FROM attempts')]
            sync = self._state()
        groups, excluded_smoke, excluded_out_of_suite, included = {}, 0, 0, 0
        for attempt in rows:
            batch_id = str(attempt.get('batch_id') or '')
            day = batch_id[:8] if len(batch_id) >= 8 and batch_id[:8].isdigit() else None
            if start and (day is None or day < start):
                continue
            if end and (day is None or day > end):
                continue
            batch_name = str(attempt.get('batch_name') or batch_id)
            if attempt.get('task_id') not in OSWORLD_V2_TASK_IDS:
                excluded_out_of_suite += 1
                continue
            if not include_smoke and 'smoke' in batch_name.lower():
                excluded_smoke += 1
                continue
            included += 1
            model = str(attempt.get('model') or attempt.get('runtime_name') or 'not reported')
            framework = str(attempt.get('framework') or 'not reported')
            group = groups.setdefault(model, {
                'model': model, 'attempts': 0, 'scored': 0,
                'passed': 0, 'completed': 0,
                'tasks': {}, 'batches': set(), 'frameworks': set(),
            })
            group['attempts'] += 1
            group['batches'].add(batch_id)
            group['frameworks'].add(framework)
            task_id = str(attempt.get('task_id') or 'unknown')
            task = group['tasks'].setdefault(task_id, {
                'attempts': 0, 'completed': 0, 'scores': [], 'passed': 0, 'durations': [],
            })
            task['attempts'] += 1
            if attempt.get('status') == 'succeeded':
                group['completed'] += 1
                task['completed'] += 1
            score = attempt.get('score')
            if type(score) in (int, float):
                group['scored'] += 1
                task['scores'].append(float(score))
                if score >= 0.999:
                    group['passed'] += 1
                    task['passed'] += 1
            duration = attempt.get('duration_ms')
            if type(duration) in (int, float) and duration >= 0:
                task['durations'].append(float(duration))

        output = []
        for group in groups.values():
            tasks = group.pop('tasks')
            task_scores = [sum(task['scores']) / len(task['scores'])
                           for task in tasks.values() if task['scores']]
            task_pass_rates = [task['passed'] / len(task['scores'])
                               for task in tasks.values() if task['scores']]
            task_completion_rates = [task['completed'] / task['attempts']
                                     for task in tasks.values() if task['attempts']]
            task_durations = [sum(task['durations']) / len(task['durations'])
                              for task in tasks.values() if task['durations']]
            task_count, batch_count = len(tasks), len(group.pop('batches'))
            frameworks = sorted(group.pop('frameworks'))
            output.append({
                **group, 'framework': ', '.join(frameworks), 'frameworks': frameworks,
                'task_count': task_count, 'scored_task_count': len(task_scores),
                'batch_count': batch_count,
                'completion_rate': (sum(task_completion_rates) / len(task_completion_rates)
                                    if task_completion_rates else 0),
                'pass_rate': (sum(task_pass_rates) / len(task_pass_rates)
                              if task_pass_rates else None),
                'score': {
                    'avg': sum(task_scores) / len(task_scores) if task_scores else None,
                    'min': min(task_scores) if task_scores else None,
                    'max': max(task_scores) if task_scores else None,
                },
                'duration_ms_avg': (sum(task_durations) / len(task_durations)
                                    if task_durations else None),
            })
        output.sort(key=lambda item: (
            -item['task_count'],
            -(item['score']['avg'] if item['score']['avg'] is not None else -1),
            item['model'],
        ))
        return {
            'rows': output, 'attempts': included, 'excluded_smoke_attempts': excluded_smoke,
            'excluded_out_of_suite_attempts': excluded_out_of_suite,
            'aggregation': 'mean_per_model_task',
            'filters': {'date_from': date_from, 'date_to': date_to,
                        'include_smoke': include_smoke},
            'sync': sync,
        }

    def task_stats(self):
        """Return compact all-time aggregates for every official OSWorld 2.0 task."""
        with self.lock:
            rows = [json.loads(row[0]) for row in self.db.execute('SELECT body FROM attempts')]
            sync = self._state()
        groups = {task_id: {
            'task_id': task_id, 'runs': 0, 'scored': 0, 'passed': 0,
            'partials': 0, 'zeros': 0, 'score_sum': 0.0,
            'completed': 0, 'status_counts': {}, 'latest': None,
        } for task_id in OSWORLD_V2_TASK_IDS}
        latest_keys = {}
        for attempt in rows:
            task_id = attempt.get('task_id')
            if task_id not in groups:
                continue
            group = groups[task_id]
            group['runs'] += 1
            status = str(attempt.get('status') or 'unknown')
            group['status_counts'][status] = group['status_counts'].get(status, 0) + 1
            if status == 'succeeded':
                group['completed'] += 1
            score = attempt.get('score')
            if type(score) in (int, float):
                group['scored'] += 1
                group['score_sum'] += float(score)
                if score >= 0.999:
                    group['passed'] += 1
                elif score > 0:
                    group['partials'] += 1
                elif score == 0:
                    group['zeros'] += 1
            ordering = (str(attempt.get('batch_id') or ''), str(attempt.get('task_key') or ''))
            if ordering > latest_keys.get(task_id, ('', '')):
                latest_keys[task_id] = ordering
                group['latest'] = {key: attempt.get(key) for key in (
                    'batch_id', 'batch_name', 'task_key', 'status', 'score', 'started_at',
                    'model', 'framework',
                )}
        output = []
        for task_id in sorted(groups):
            group = groups[task_id]
            score_sum = group.pop('score_sum')
            output.append({
                **group,
                'pass_rate': group['passed'] / group['scored'] if group['scored'] else None,
                'mean_score': score_sum / group['scored'] if group['scored'] else None,
                'full_marks': group['passed'],
            })
        return {
            'tasks': output,
            'task_count': len(output),
            'runs': sum(group['runs'] for group in output),
            'sync': sync,
        }

    def retain_batches(self, batch_ids):
        with self.lock, self.db:
            present = {row[0] for row in self.db.execute('SELECT DISTINCT batch_id FROM attempts')}
            self.db.executemany('DELETE FROM attempts WHERE batch_id=?',
                                [(name,) for name in present - set(batch_ids)])

    def close(self):
        with self.lock:
            self.db.close()
