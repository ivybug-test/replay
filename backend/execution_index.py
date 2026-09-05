"""Rebuildable SQLite execution summaries with stable, filter-bound keyset paging."""
import base64
import hashlib
import json
import sqlite3
import threading
import uuid
from pathlib import Path
from .services import InvalidQuery


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

    def retain_batches(self, batch_ids):
        with self.lock, self.db:
            present = {row[0] for row in self.db.execute('SELECT DISTINCT batch_id FROM attempts')}
            self.db.executemany('DELETE FROM attempts WHERE batch_id=?',
                                [(name,) for name in present - set(batch_ids)])

    def close(self):
        with self.lock:
            self.db.close()
