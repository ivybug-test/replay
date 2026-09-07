"""Immutable non-AFT cohort reports stored beside, but separate from, AFT data."""

from __future__ import annotations

import hashlib
import json
import sqlite3
import threading
from pathlib import Path

from .services import ResourceNotFound

MAX_REPORT_BYTES = 16 * 1024 * 1024
SCHEMA_VERSION = "todolist-quality-cohort-report/v1"
ANALYSIS_TYPE = "todolist-quality"


class CohortReportStore:
    def __init__(self, path: str):
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        self.lock = threading.RLock()
        self.db = sqlite3.connect(path, check_same_thread=False, timeout=10)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA journal_mode=WAL")
        with self.db:
            self.db.execute("""
                CREATE TABLE IF NOT EXISTS cohort_reports (
                    report_id TEXT PRIMARY KEY,
                    analysis_type TEXT NOT NULL,
                    run_id TEXT NOT NULL,
                    revision INTEGER NOT NULL,
                    title TEXT NOT NULL,
                    summary TEXT NOT NULL,
                    content TEXT NOT NULL,
                    document TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    UNIQUE(analysis_type, run_id, revision)
                )
            """)

    @staticmethod
    def _validated(document: dict, content: str, title: str, summary: str):
        if document.get("schema_version") != SCHEMA_VERSION:
            raise ValueError("unsupported cohort report schema")
        if document.get("analysis_type") != ANALYSIS_TYPE:
            raise ValueError("unsupported cohort analysis type")
        run_id, revision = document.get("run_id"), document.get("revision")
        if not isinstance(run_id, str) or not run_id or not isinstance(revision, int) or revision < 1:
            raise ValueError("cohort report run_id and positive revision are required")
        if not isinstance(document.get("samples"), list) or not document["samples"]:
            raise ValueError("cohort report samples are required")
        if not isinstance(document.get("group_summary"), dict):
            raise ValueError("cohort report group_summary is required")
        if not all(isinstance(value, str) and value.strip() for value in (content, title, summary)):
            raise ValueError("cohort report title, summary, and markdown are required")
        encoded = json.dumps(document, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        if len(encoded.encode()) + len(content.encode()) > MAX_REPORT_BYTES:
            raise ValueError("cohort report exceeds storage limit")
        return run_id, revision, encoded

    def create(self, document: dict, content: str, title: str, summary: str) -> dict:
        run_id, revision, encoded = self._validated(document, content, title, summary)
        digest = hashlib.sha256(encoded.encode()).hexdigest()
        report_id = f"cohort-{digest[:32]}"
        values = (report_id, ANALYSIS_TYPE, run_id, revision, title.strip(), summary.strip(),
                  content, encoded, str(document.get("created_at") or ""))
        with self.lock, self.db:
            existing = self.db.execute("""
                SELECT report_id, document FROM cohort_reports
                WHERE analysis_type=? AND run_id=? AND revision=?
            """, (ANALYSIS_TYPE, run_id, revision)).fetchone()
            if existing:
                if existing["document"] != encoded:
                    raise ValueError("cohort report revision already exists with different content")
                return self.get(existing["report_id"])
            self.db.execute("INSERT INTO cohort_reports VALUES (?,?,?,?,?,?,?,?,?)", values)
        return self.get(report_id)

    def list_reports(self) -> dict:
        with self.lock:
            rows = self.db.execute("""
                SELECT r.* FROM cohort_reports r
                WHERE revision=(SELECT MAX(latest.revision) FROM cohort_reports latest
                    WHERE latest.analysis_type=r.analysis_type AND latest.run_id=r.run_id)
                ORDER BY created_at DESC, report_id DESC
            """).fetchall()
        keys = ("report_id", "analysis_type", "run_id", "revision", "title", "summary", "created_at")
        return {"reports": [{key: row[key] for key in keys} for row in rows]}

    def get(self, report_id: str) -> dict:
        with self.lock:
            row = self.db.execute("SELECT * FROM cohort_reports WHERE report_id=?", (report_id,)).fetchone()
        if row is None:
            raise ResourceNotFound("cohort report not found")
        result = dict(row)
        result["document"] = json.loads(result["document"])
        return result

    def close(self):
        with self.lock:
            self.db.close()
