"""Byte-bounded TTL/LRU memoization with per-key in-flight request sharing."""
import sys
import threading
import time
from collections import OrderedDict
from concurrent.futures import Future
from itertools import chain


def retained_size(value, limit):
    """Adapted from oss-replay/cache_size.py; count containers, not JSON size."""
    seen, pending, total = set(), [iter((value,))], 0
    while pending:
        try:
            item = next(pending[-1])
        except StopIteration:
            pending.pop()
            continue
        if id(item) in seen:
            continue
        seen.add(id(item))
        total += sys.getsizeof(item)
        if total > limit:
            break
        if isinstance(item, dict):
            pending.append(chain(item.keys(), item.values()))
        elif isinstance(item, (list, tuple, set, frozenset)):
            pending.append(iter(item))
    return total


class ReadCache:
    def __init__(self, max_bytes=32 * 1024 * 1024, max_entries=512, clock=time.monotonic):
        self.max_bytes, self.max_entries, self.clock = max_bytes, max_entries, clock
        self.bytes = 0
        self.entries = OrderedDict()
        self.pending = {}
        self.lock = threading.Lock()

    def _remove(self, key):
        _, size, _ = self.entries.pop(key)
        self.bytes -= size

    def _expire(self):
        now = self.clock()
        for key in [k for k, (expires, _, _) in self.entries.items() if expires <= now]:
            self._remove(key)

    def prune(self):
        with self.lock:
            self._expire()

    def clear(self):
        with self.lock:
            self.entries.clear()
            self.bytes = 0

    def get(self, key, loader, ttl=2.0):
        with self.lock:
            self._expire()
            if key in self.entries:
                self.entries.move_to_end(key)
                return self.entries[key][2]
            future = self.pending.get(key)
            owner = future is None
            if owner:
                future = self.pending[key] = Future()
        if not owner:
            return future.result()
        try:
            value = loader()
            size = retained_size((key, value), self.max_bytes)
            with self.lock:
                self._expire()
                if value is not None and ttl > 0 and size <= self.max_bytes:
                    while self.entries and (self.bytes + size > self.max_bytes
                                            or len(self.entries) >= self.max_entries):
                        self._remove(next(iter(self.entries)))
                    self.entries[key] = (self.clock() + ttl, size, value)
                    self.bytes += size
            future.set_result(value)
            return value
        except BaseException as exc:
            future.set_exception(exc)
            raise
        finally:
            with self.lock:
                self.pending.pop(key, None)
