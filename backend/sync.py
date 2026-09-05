"""Incrementally commit batch summaries; never scan trajectory or image objects."""
import threading
from datetime import datetime, timezone


def now():
    return datetime.now(timezone.utc).isoformat()


class IndexSynchronizer:
    def __init__(self, catalog, index, interval=60):
        self.catalog, self.index, self.interval = catalog, index, interval
        self.stop_event = threading.Event()
        self.scan_lock = threading.Lock()
        self.thread = None

    def scan_once(self):
        with self.scan_lock:
            previous = self.index.state()
            state = {'status': 'syncing', 'started_at': now(), 'last_success': previous.get('last_success'),
                     'scanned_batches': 0, 'failed_batches': 0, 'error_type': None}
            self.index.set_state(state)
            published = set()
            try:
                for run in self.catalog.reader.batches(stop=self.stop_event):
                    if self.stop_event.is_set():
                        break
                    try:
                        batch = self.catalog.reader.batch(run, optional=True)
                        if batch is None:
                            continue
                        published.add(run)
                        detail = self.catalog.get_batch(run=run, stop=self.stop_event)
                        self.index.replace_batch(run, detail['tasks'])
                        state['scanned_batches'] += 1
                    except Exception as exc:
                        # Retain prior data for a failing batch, mark the scan
                        # incomplete and retry next cycle; never log raw secrets.
                        state['failed_batches'] += 1
                        state['error_type'] = type(exc).__name__
                    self.index.set_state(state)
                if self.stop_event.is_set():
                    state['status'] = 'stale'
                elif state['failed_batches']:
                    state['status'] = 'failed'
                else:
                    self.index.retain_batches(published)
                    state.update(status='ready', last_success=now())
            except Exception as exc:
                state.update(status='failed', error_type=type(exc).__name__)
            self.index.set_state(state)
            return state

    def _loop(self):
        while not self.stop_event.is_set():
            self.scan_once()
            self.catalog.reader.cache.prune()
            self.catalog.cache.prune()
            self.stop_event.wait(self.interval)

    def start(self):
        if self.thread is None:
            self.thread = threading.Thread(target=self._loop, name='execution-index-sync', daemon=True)
            self.thread.start()

    def stop(self):
        self.stop_event.set()
        if self.thread:
            while self.thread.is_alive():
                self.thread.join(timeout=1)
