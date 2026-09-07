"""OSS layout reader shared by catalog, replay and background synchronization."""
import json
import math
import re
import threading
from dataclasses import dataclass
from .cache import ReadCache
from .oss_io.client import OssNoSuchKey, OssObjectTooLarge, OssProtocolError
from .oss_io.file import read_bytes
from .services import InvalidQuery, ResourceNotFound

ATIF_PATHS = ("trajectory.json", "agent/trajectory.json", "runtime-artifacts/trajectory.json")
SEGMENT = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,159}\Z")


def segment(value):
    if not isinstance(value, str) or not SEGMENT.fullmatch(value):
        raise InvalidQuery("Invalid execution identifier")
    return value


def relative_path(value):
    if (not isinstance(value, str) or not value or len(value) > 4096
            or ":" in value or "\\" in value
            or any(ord(c) < 32 or ord(c) == 127 for c in value)
            or any(p in ("", ".", "..") for p in value.split("/"))):
        raise InvalidQuery("Invalid relative artifact path")
    return value


def json_value(raw):
    def clean(value):
        if isinstance(value, float) and not math.isfinite(value):
            raise ValueError('Non-finite number')
        if isinstance(value, str):
            return value.encode("utf-8", errors="replace").decode("utf-8")
        if isinstance(value, list):
            return [clean(x) for x in value]
        if isinstance(value, dict):
            return {clean(k): clean(v) for k, v in value.items()}
        return value
    try:
        return clean(json.loads(raw, parse_constant=lambda x: (_ for _ in ()).throw(ValueError(x))))
    except (ValueError, UnicodeError, RecursionError) as exc:
        raise OssProtocolError("Invalid artifact JSON") from exc


@dataclass(frozen=True)
class Execution:
    run: str
    task: str
    root: str
    batch: dict
    summary: dict


class ArtifactReader:
    def __init__(self, client, prefix="", *, cache=None, live_ttl=2.0,
                 max_object_bytes=64 * 1024 * 1024, concurrency=4):
        self.client = client
        prefix = prefix.strip("/")
        if prefix:
            relative_path(prefix)
        self.root = (prefix + "/" if prefix else "") + "harness/"
        self.cache = cache if cache is not None else ReadCache()
        self.live_ttl = live_ttl
        self.max_object_bytes = max_object_bytes
        self.slots = threading.BoundedSemaphore(concurrency)

    def bytes(self, key, *, optional=False, immutable=False, max_bytes=None):
        budget = min(max_bytes if max_bytes is not None else self.max_object_bytes, self.max_object_bytes)
        def load():
            with self.slots:
                return read_bytes(self.client, key, max_bytes=budget)
        try:
            return self.cache.get(("bytes", key, budget), load, ttl=3600 if immutable else self.live_ttl)
        except OssNoSuchKey:
            if optional:
                return None
            raise

    def json(self, key, *, optional=False, immutable=False):
        body = self.bytes(key, optional=optional, immutable=immutable, max_bytes=8 * 1024 * 1024)
        if body is None:
            return None
        value = json_value(body)
        if not isinstance(value, dict):
            raise OssProtocolError("Expected an object document")
        return value

    def batches(self, *, stop=None):
        cursor, seen = None, set()
        while not stop or not stop.is_set():
            with self.slots:
                page = self.client.list_objects(self.root, delimiter="/", cursor=cursor)
            for prefix in page.prefixes:
                if stop and stop.is_set():
                    return
                if not prefix.startswith(self.root) or not prefix.endswith("/"):
                    raise OssProtocolError("Invalid batch prefix")
                run = prefix[len(self.root):-1]
                if SEGMENT.fullmatch(run):
                    yield run
            cursor = page.next_cursor
            if cursor is None:
                return
            if cursor in seen:
                raise OssProtocolError("Batch cursor repeated")
            seen.add(cursor)

    def batch(self, run, *, optional=False):
        run = segment(run)
        doc = self.json(f"{self.root}{run}/batch.json", optional=optional)
        if doc is None:
            return None
        if doc.get("batch_id") != run or not isinstance(doc.get("tasks"), list):
            raise OssProtocolError("Invalid batch identity/tasks")
        seen = set()
        for item in doc["tasks"]:
            if (not isinstance(item, dict) or not isinstance(item.get("key"), str)
                    or not SEGMENT.fullmatch(item["key"])):
                raise OssProtocolError("Invalid task entry")
            if item["key"] in seen:
                raise OssProtocolError("Duplicate task key")
            seen.add(item["key"])
        return doc

    def batch_config(self, run, *, optional=True):
        """Read the public launch configuration used to enrich catalog metrics."""
        run = segment(run)
        return self.json(f"{self.root}{run}/batch-config.json", optional=optional,
                         immutable=True)

    def execution(self, run, task, *, batch=None):
        run, task = segment(run), segment(task)
        batch = batch if batch is not None else self.batch(run)
        summary = next((t for t in batch["tasks"] if t["key"] == task), None)
        if summary is None:
            raise ResourceNotFound("Execution not in batch")
        directory = summary.get("run_dir") or f"tasks/{task}"
        try:
            relative_path(directory)
            base = f"tasks/{task}"
            if directory != base and not directory.startswith(base + "/"):
                raise InvalidQuery("run_dir escapes task")
        except InvalidQuery as exc:
            raise OssProtocolError("Invalid execution directory in batch") from exc
        return Execution(run, task, f"{self.root}{run}/{directory}", batch, summary)

    def key(self, execution, path):
        return f"{execution.root}/{relative_path(path)}"

    def read_json(self, execution, path, **kwargs):
        return self.json(self.key(execution, path), **kwargs)

    def read_bytes(self, execution, path, **kwargs):
        return self.bytes(self.key(execution, path), **kwargs)

    def native_trajectory(self, execution):
        for path in ATIF_PATHS:
            raw = self.read_bytes(execution, path, optional=True)
            if raw is not None:
                return json_value(raw), path
        return None, None

    def lines(self, execution, path, *, optional=False, immutable=False):
        raw = self.read_bytes(execution, path, optional=optional, immutable=immutable)
        if raw is None:
            return None
        records = []
        for line in raw.splitlines():
            if line.strip():
                value = json_value(line)
                if not isinstance(value, dict):
                    raise OssProtocolError("Invalid JSONL record")
                records.append(value)
                if len(records) > 1_000_000:
                    raise OssObjectTooLarge("Too many trajectory records")
        return records
