"""Durable AFT jobs, reports, concrete issues and taxonomy mappings."""

from __future__ import annotations

import hashlib
import json
import sqlite3
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path

from .aft_taxonomy import (
    RESEARCH_FOUNDATION_SOURCE_IDS, RESEARCH_MAP_VERSION, RESEARCH_WINDOW,
    SOURCE_SECTION_LOCATORS, SOURCE_SUPPORT_NOTES, SOURCES, TAGS,
    TAG_AUTHORITY_WEIGHTS, TAG_METADATA, TAG_SOURCE_LOCATORS, TAG_SOURCE_NOTES,
    TAG_SUPPORTING_SOURCES, TAXONOMY_VERSION,
)

CACHE_MAX_ENTRIES = 5_000


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


class AftStore:
    def __init__(self, path: str):
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        self.lock = threading.RLock()
        self.db = sqlite3.connect(path, check_same_thread=False, timeout=10)
        self.db.row_factory = sqlite3.Row
        self.db.execute('PRAGMA journal_mode=WAL')
        self.db.execute('PRAGMA foreign_keys=ON')
        self._initialize()
        self._seed_taxonomy()

    def _initialize(self):
        with self.db:
            self.db.executescript('''
                CREATE TABLE IF NOT EXISTS taxonomy_versions (
                    version_id TEXT PRIMARY KEY, status TEXT NOT NULL,
                    research_window_start TEXT, research_window_end TEXT,
                    checksum TEXT NOT NULL, created_at TEXT NOT NULL, changelog TEXT);
                CREATE TABLE IF NOT EXISTS taxonomy_sources (
                    source_id TEXT PRIMARY KEY, title TEXT NOT NULL, url TEXT NOT NULL,
                    published_at TEXT, accessed_at TEXT NOT NULL, source_type TEXT NOT NULL,
                    primary_source INTEGER NOT NULL, organization TEXT,
                    authority_tier TEXT, authority_weight REAL NOT NULL DEFAULT 0.5,
                    claim_scope TEXT, reproducibility_level TEXT,
                    independence_group TEXT, version_or_commit TEXT);
                CREATE TABLE IF NOT EXISTS problem_tags (
                    version_id TEXT NOT NULL, tag_id TEXT NOT NULL, name_zh TEXT NOT NULL,
                    name_en TEXT NOT NULL, category TEXT NOT NULL, description TEXT NOT NULL,
                    detection_signals TEXT NOT NULL, exclusions TEXT NOT NULL,
                    default_severity TEXT NOT NULL, source_basis TEXT NOT NULL,
                    active INTEGER NOT NULL, authority_weight REAL NOT NULL DEFAULT 0.5,
                    research_priority TEXT NOT NULL DEFAULT 'supplemental',
                    fault_side TEXT, definition_source_id TEXT,
                    definition_locator TEXT,
                    PRIMARY KEY(version_id, tag_id));
                CREATE TABLE IF NOT EXISTS tag_source_links (
                    version_id TEXT NOT NULL, tag_id TEXT NOT NULL, source_id TEXT NOT NULL,
                    support_kind TEXT NOT NULL, evidence_relation TEXT,
                    domain_fit REAL NOT NULL DEFAULT 1.0,
                    effective_weight REAL NOT NULL DEFAULT 0.5, support_note TEXT,
                    support_locator TEXT, support_url TEXT,
                    PRIMARY KEY(version_id, tag_id, source_id));
                CREATE TABLE IF NOT EXISTS aft_jobs (
                    job_id TEXT PRIMARY KEY, kind TEXT NOT NULL, run_id TEXT NOT NULL,
                    task_key TEXT, status TEXT NOT NULL, model TEXT NOT NULL,
                    progress TEXT NOT NULL, error TEXT, created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL);
                CREATE INDEX IF NOT EXISTS aft_jobs_scope
                    ON aft_jobs(kind, run_id, task_key, created_at DESC);
                CREATE TABLE IF NOT EXISTS aft_task_reports (
                    report_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, task_key TEXT NOT NULL,
                    revision INTEGER NOT NULL, model TEXT NOT NULL,
                    taxonomy_version TEXT NOT NULL, trajectory_sha256 TEXT NOT NULL,
                    content TEXT NOT NULL, document TEXT NOT NULL, created_at TEXT NOT NULL,
                    UNIQUE(run_id, task_key, revision));
                CREATE INDEX IF NOT EXISTS aft_task_reports_scope
                    ON aft_task_reports(run_id, task_key, revision DESC);
                CREATE TABLE IF NOT EXISTS aft_run_reports (
                    report_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, revision INTEGER NOT NULL,
                    model TEXT NOT NULL, taxonomy_version TEXT NOT NULL, content TEXT NOT NULL,
                    document TEXT NOT NULL, created_at TEXT NOT NULL,
                    UNIQUE(run_id, revision));
                CREATE TABLE IF NOT EXISTS aft_analysis_cache (
                    cache_key TEXT PRIMARY KEY, stage TEXT NOT NULL,
                    trajectory_sha256 TEXT NOT NULL, model TEXT NOT NULL,
                    pipeline_version TEXT NOT NULL, taxonomy_version TEXT,
                    payload TEXT NOT NULL, created_at TEXT NOT NULL,
                    last_used_at TEXT NOT NULL);
                CREATE INDEX IF NOT EXISTS aft_analysis_cache_lookup
                    ON aft_analysis_cache(stage, trajectory_sha256, model,
                                          pipeline_version, taxonomy_version);
                CREATE TABLE IF NOT EXISTS analysis_issues (
                    issue_id TEXT PRIMARY KEY, report_id TEXT NOT NULL, report_kind TEXT NOT NULL,
                    run_id TEXT NOT NULL, task_key TEXT, summary TEXT NOT NULL,
                    expected_behavior TEXT, actual_behavior TEXT, impact TEXT,
                    severity TEXT NOT NULL, confidence REAL NOT NULL,
                    responsibility TEXT NOT NULL, harness_layer TEXT,
                    mapping_status TEXT NOT NULL, created_at TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS issue_tag_mappings (
                    issue_id TEXT NOT NULL, taxonomy_version TEXT NOT NULL, tag_id TEXT NOT NULL,
                    is_primary INTEGER NOT NULL, confidence REAL NOT NULL, rationale TEXT NOT NULL,
                    PRIMARY KEY(issue_id, taxonomy_version, tag_id));
                CREATE TABLE IF NOT EXISTS issue_evidence (
                    evidence_id TEXT PRIMARY KEY, issue_id TEXT NOT NULL,
                    trajectory_id TEXT, turn_id TEXT, tool_call_id TEXT,
                    timestamp_ms INTEGER, evidence_role TEXT NOT NULL, excerpt TEXT);
                CREATE TABLE IF NOT EXISTS issue_facets (
                    issue_id TEXT NOT NULL, facet TEXT NOT NULL,
                    PRIMARY KEY(issue_id, facet));
            ''')
            source_columns = {row[1] for row in self.db.execute('PRAGMA table_info(taxonomy_sources)')}
            if 'organization' not in source_columns:
                self.db.execute('ALTER TABLE taxonomy_sources ADD COLUMN organization TEXT')
            if 'authority_tier' not in source_columns:
                self.db.execute('ALTER TABLE taxonomy_sources ADD COLUMN authority_tier TEXT')
            if 'authority_weight' not in source_columns:
                self.db.execute('ALTER TABLE taxonomy_sources ADD COLUMN authority_weight REAL NOT NULL DEFAULT 0.5')
            for column in ('claim_scope', 'reproducibility_level',
                           'independence_group', 'version_or_commit'):
                if column not in source_columns:
                    self.db.execute(f'ALTER TABLE taxonomy_sources ADD COLUMN {column} TEXT')
            tag_columns = {row[1] for row in self.db.execute('PRAGMA table_info(problem_tags)')}
            if 'authority_weight' not in tag_columns:
                self.db.execute('ALTER TABLE problem_tags ADD COLUMN authority_weight REAL NOT NULL DEFAULT 0.5')
            if 'research_priority' not in tag_columns:
                self.db.execute("ALTER TABLE problem_tags ADD COLUMN research_priority TEXT NOT NULL DEFAULT 'supplemental'")
            for column in ('fault_side', 'definition_source_id', 'definition_locator'):
                if column not in tag_columns:
                    self.db.execute(f'ALTER TABLE problem_tags ADD COLUMN {column} TEXT')
            link_columns = {row[1] for row in self.db.execute('PRAGMA table_info(tag_source_links)')}
            if 'evidence_relation' not in link_columns:
                self.db.execute('ALTER TABLE tag_source_links ADD COLUMN evidence_relation TEXT')
            if 'domain_fit' not in link_columns:
                self.db.execute('ALTER TABLE tag_source_links ADD COLUMN domain_fit REAL NOT NULL DEFAULT 1.0')
            if 'effective_weight' not in link_columns:
                self.db.execute('ALTER TABLE tag_source_links ADD COLUMN effective_weight REAL NOT NULL DEFAULT 0.5')
            if 'support_note' not in link_columns:
                self.db.execute('ALTER TABLE tag_source_links ADD COLUMN support_note TEXT')
            if 'support_locator' not in link_columns:
                self.db.execute('ALTER TABLE tag_source_links ADD COLUMN support_locator TEXT')
            if 'support_url' not in link_columns:
                self.db.execute('ALTER TABLE tag_source_links ADD COLUMN support_url TEXT')
            self.db.execute('''UPDATE aft_jobs SET status='failed',
                error='analysis service restarted', updated_at=?
                WHERE status IN ('queued','running','analyzing','synthesizing')''', (_now(),))

    def _seed_taxonomy(self):
        payload = json.dumps({
            'tags': TAGS, 'research_map': RESEARCH_MAP_VERSION,
            'supporting_sources': TAG_SUPPORTING_SOURCES,
        }, ensure_ascii=False, sort_keys=True)
        checksum = hashlib.sha256(payload.encode()).hexdigest()
        timestamp = _now()
        with self.lock, self.db:
            self.db.execute('INSERT OR IGNORE INTO taxonomy_versions VALUES (?,?,?,?,?,?,?)', (
                TAXONOMY_VERSION, 'active', RESEARCH_WINDOW[0], RESEARCH_WINDOW[1],
                checksum, timestamp,
                'Eight source-grounded long-horizon harness problem nodes derived from recent papers, active projects, and authoritative organizations.',
            ))
            self.db.executemany('''INSERT OR REPLACE INTO taxonomy_sources
                (source_id,title,url,published_at,accessed_at,source_type,primary_source,
                 organization,authority_tier,authority_weight,claim_scope,
                 reproducibility_level,independence_group,version_or_commit)
                 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)''', [
                (identity, title, url, published, timestamp,
                 ('internal' if tier.startswith('T4_') else
                  'project' if 'project' in tier else
                  'authoritative-organization'
                  if tier.startswith('T3_') else 'paper'),
                 int(not tier.startswith('T4_')), organization, tier, weight,
                 ('discovery_only' if tier.startswith('T4_') else
                  'implementation' if tier.startswith(('T0_', 'T3_')) else 'empirical_research'),
                 ('high' if tier.startswith(('T0_', 'T1_')) else
                  'medium' if tier.startswith(('T2_', 'T3_')) else 'low'),
                 organization.casefold(), url.rsplit('/', 1)[-1] if tier.startswith('T0_') else None)
                for identity, title, url, published, organization, tier, weight in SOURCES
            ])
            source_weights = {identity: weight for identity, _, _, _, _, _, weight in SOURCES}
            self.db.execute('DELETE FROM tag_source_links WHERE version_id=?', (TAXONOMY_VERSION,))
            for (tag_id, zh, en, description, signals, exclusions, severity,
                 basis, sources) in TAGS:
                authority_weight = TAG_AUTHORITY_WEIGHTS[tag_id]
                priority = 'core-harness'
                interaction_edge, fault_side, locator = TAG_METADATA[tag_id]
                self.db.execute('''INSERT OR REPLACE INTO problem_tags
                    (version_id,tag_id,name_zh,name_en,category,description,
                     detection_signals,exclusions,default_severity,source_basis,active,
                     authority_weight,research_priority,fault_side,definition_source_id,
                     definition_locator) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)''', (
                    TAXONOMY_VERSION, tag_id, zh, en, interaction_edge, description,
                    json.dumps(signals, ensure_ascii=False),
                    json.dumps(exclusions, ensure_ascii=False), severity, basis, 1,
                    authority_weight, priority, fault_side,
                    sources[0] if sources else None, locator,
                ))
                self.db.executemany('''INSERT OR REPLACE INTO tag_source_links
                    (version_id,tag_id,source_id,support_kind,evidence_relation,
                     domain_fit,effective_weight,support_note,support_locator,support_url)
                     VALUES (?,?,?,?,?,?,?,?,?,?)''', [
                    *[(TAXONOMY_VERSION, tag_id, source, 'definition', 'defines', 1.0,
                       source_weights.get(source, .5),
                       'Verbatim failure-mode name and definition provenance.',
                       *(SOURCE_SECTION_LOCATORS.get(source) or (None, None)))
                      for source in sources],
                    *[(TAXONOMY_VERSION, tag_id, source, 'supporting',
                       'supports-diagnosis', 1.0, source_weights.get(source, .5),
                       TAG_SOURCE_NOTES.get((tag_id, source),
                                            SOURCE_SUPPORT_NOTES.get(source)),
                       *(TAG_SOURCE_LOCATORS.get((tag_id, source))
                         or SOURCE_SECTION_LOCATORS.get(source) or (None, None)))
                      for source in TAG_SUPPORTING_SOURCES.get(tag_id, [])],
                ])

    @staticmethod
    def _decode(row):
        if row is None:
            return None
        value = dict(row)
        for key in ('progress', 'document'):
            if key in value:
                value[key] = json.loads(value[key])
        return value

    def taxonomy(self):
        with self.lock:
            version = self.db.execute(
                'SELECT * FROM taxonomy_versions WHERE version_id=?', (TAXONOMY_VERSION,),
            ).fetchone()
            rows = self.db.execute('''SELECT * FROM problem_tags
                WHERE version_id=? AND active=1 ORDER BY category, tag_id''',
                (TAXONOMY_VERSION,)).fetchall()
            links = self.db.execute('''SELECT l.tag_id,l.support_kind,l.evidence_relation,
                l.domain_fit,l.effective_weight,l.support_note,l.support_locator,
                l.support_url,s.* FROM tag_source_links l
                JOIN taxonomy_sources s ON s.source_id=l.source_id
                WHERE l.version_id=? ORDER BY l.tag_id,
                CASE l.support_kind WHEN 'definition' THEN 0 ELSE 1 END,
                l.effective_weight DESC,s.published_at''', (TAXONOMY_VERSION,)).fetchall()
            foundation_rows = self.db.execute('SELECT * FROM taxonomy_sources').fetchall()
        sources = {}
        for row in links:
            source = {key: row[key] for key in (
                'source_id', 'title', 'url', 'published_at', 'source_type', 'primary_source',
                'organization', 'authority_tier', 'authority_weight',
                'claim_scope', 'reproducibility_level', 'independence_group',
                'version_or_commit', 'support_kind', 'evidence_relation',
                'domain_fit', 'effective_weight', 'support_note', 'support_locator',
                'support_url',
            )}
            sources.setdefault(row['tag_id'], []).append(source)
        tags = []
        for row in rows:
            item = dict(row)
            item['detection_signals'] = json.loads(item['detection_signals'])
            item['exclusions'] = json.loads(item['exclusions'])
            item['active'] = bool(item['active'])
            item['sources'] = sources.get(item['tag_id'], [])
            tags.append(item)
        foundation_by_id = {row['source_id']: dict(row) for row in foundation_rows}
        foundation = [foundation_by_id[source_id] for source_id in RESEARCH_FOUNDATION_SOURCE_IDS
                      if source_id in foundation_by_id]
        for source in foundation:
            source['support_note'] = SOURCE_SUPPORT_NOTES.get(source['source_id'])
        return {
            'version': dict(version), 'research_map_version': RESEARCH_MAP_VERSION,
            'research_foundation': foundation, 'tags': tags,
        }

    def create_job(self, kind: str, run: str, task: str | None, model: str):
        with self.lock, self.db:
            row = self.db.execute('''SELECT * FROM aft_jobs
                WHERE kind=? AND run_id=? AND task_key IS ?
                AND status IN ('queued','running','analyzing','synthesizing')
                ORDER BY created_at DESC LIMIT 1''', (kind, run, task)).fetchone()
            if row:
                return self._decode(row), False
            timestamp, job_id = _now(), 'aft-job-' + uuid.uuid4().hex
            progress = {'completed': 0, 'total': 1 if kind == 'task' else 0, 'failed': 0}
            self.db.execute('INSERT INTO aft_jobs VALUES (?,?,?,?,?,?,?,?,?,?)', (
                job_id, kind, run, task, 'queued', model, json.dumps(progress), None,
                timestamp, timestamp,
            ))
            return self.job(job_id), True

    def job(self, job_id: str):
        with self.lock:
            return self._decode(self.db.execute(
                'SELECT * FROM aft_jobs WHERE job_id=?', (job_id,),
            ).fetchone())

    def latest_job(self, kind: str, run: str, task: str | None = None):
        with self.lock:
            return self._decode(self.db.execute('''SELECT * FROM aft_jobs
                WHERE kind=? AND run_id=? AND task_key IS ?
                ORDER BY created_at DESC LIMIT 1''', (kind, run, task)).fetchone())

    def update_job(self, job_id: str, status: str, *, progress=None, error=None):
        with self.lock, self.db:
            current = self.job(job_id)
            if current is None:
                return
            self.db.execute('''UPDATE aft_jobs SET status=?, progress=?, error=?, updated_at=?
                WHERE job_id=?''', (
                status, json.dumps(progress if progress is not None else current['progress']),
                error, _now(), job_id,
            ))

    def latest_task_report(self, run: str, task: str):
        with self.lock:
            return self._decode(self.db.execute('''SELECT * FROM aft_task_reports
                WHERE run_id=? AND task_key=? ORDER BY revision DESC LIMIT 1''',
                (run, task)).fetchone())

    def latest_run_report(self, run: str):
        with self.lock:
            return self._decode(self.db.execute('''SELECT * FROM aft_run_reports
                WHERE run_id=? ORDER BY revision DESC LIMIT 1''', (run,)).fetchone())

    def cached_analysis(self, cache_key: str):
        with self.lock, self.db:
            row = self.db.execute(
                'SELECT payload FROM aft_analysis_cache WHERE cache_key=?', (cache_key,),
            ).fetchone()
            if row is None:
                return None
            self.db.execute(
                'UPDATE aft_analysis_cache SET last_used_at=? WHERE cache_key=?',
                (_now(), cache_key),
            )
            try:
                value = json.loads(row['payload'])
            except (TypeError, ValueError):
                return None
            return value if isinstance(value, dict) else None

    def cache_analysis(self, cache_key: str, *, stage: str, digest: str,
                       model: str, pipeline_version: str,
                       taxonomy_version: str | None, payload: dict):
        timestamp = _now()
        with self.lock, self.db:
            self.db.execute('''INSERT OR REPLACE INTO aft_analysis_cache
                (cache_key,stage,trajectory_sha256,model,pipeline_version,
                 taxonomy_version,payload,created_at,last_used_at)
                VALUES (?,?,?,?,?,?,?,?,?)''', (
                    cache_key, stage, digest, model, pipeline_version,
                    taxonomy_version, json.dumps(payload, ensure_ascii=False),
                    timestamp, timestamp,
                ))
            self.db.execute('''DELETE FROM aft_analysis_cache WHERE cache_key IN (
                SELECT cache_key FROM aft_analysis_cache
                ORDER BY last_used_at DESC LIMIT -1 OFFSET ?
            )''', (CACHE_MAX_ENTRIES,))

    def _revision(self, table: str, run: str, task: str | None = None):
        clause, params = ('run_id=?', [run])
        if task is not None:
            clause += ' AND task_key=?'; params.append(task)
        row = self.db.execute(f'SELECT MAX(revision) FROM {table} WHERE {clause}', params).fetchone()
        return int(row[0] or 0) + 1

    def save_task_report(self, run: str, task: str, model: str, digest: str,
                         content: str, document: dict):
        with self.lock, self.db:
            revision = self._revision('aft_task_reports', run, task)
            report_id = 'aft-task-' + uuid.uuid4().hex
            created = _now()
            self.db.execute('INSERT INTO aft_task_reports VALUES (?,?,?,?,?,?,?,?,?,?)', (
                report_id, run, task, revision, model, TAXONOMY_VERSION, digest,
                content, json.dumps(document, ensure_ascii=False), created,
            ))
            self._save_issues(
                report_id, 'task', run, task,
                document.get('main_issues', document.get('issues', [])), created,
            )
            return self.latest_task_report(run, task)

    def save_run_report(self, run: str, model: str, content: str, document: dict):
        with self.lock, self.db:
            revision = self._revision('aft_run_reports', run)
            report_id = 'aft-run-' + uuid.uuid4().hex
            created = _now()
            self.db.execute('INSERT INTO aft_run_reports VALUES (?,?,?,?,?,?,?,?)', (
                report_id, run, revision, model, TAXONOMY_VERSION, content,
                json.dumps(document, ensure_ascii=False), created,
            ))
            self._save_issues(report_id, 'run', run, None, document.get('issues', []), created)
            return self.latest_run_report(run)

    def _save_issues(self, report_id, kind, run, task, issues, created):
        for index, issue in enumerate(issues):
            logical_issue_id = str(issue.get('issue_id') or f'issue-{index + 1}')
            # Logical IDs remain stable in report documents. Persistence IDs
            # are revision-scoped so a forced reanalysis can coexist with all
            # prior immutable reports.
            issue_id = f'{report_id}:{logical_issue_id}'
            self.db.execute('INSERT INTO analysis_issues VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', (
                issue_id, report_id, kind, run, task,
                str(issue.get('summary') or issue.get('title') or 'Issue'),
                issue.get('expected_behavior'),
                issue.get('actual_behavior') or issue.get('description'), issue.get('impact'),
                str(issue.get('severity') or 'medium'), float(issue.get('confidence') or 0),
                str(issue.get('responsibility') or 'unknown'), issue.get('harness_layer'),
                str(issue.get('mapping_status') or 'unmapped'), created,
            ))
            mapping = issue.get('tag_mapping') or {}
            self.db.executemany('INSERT OR IGNORE INTO issue_facets VALUES (?,?)', [
                (issue_id, str(facet)) for facet in issue.get('facets') or [] if str(facet)
            ])
            tags = []
            if mapping.get('primary_tag'):
                tags.append((mapping['primary_tag'], 1))
            tags.extend((tag, 0) for tag in mapping.get('secondary_tags') or [])
            for tag, primary in tags:
                self.db.execute('INSERT OR IGNORE INTO issue_tag_mappings VALUES (?,?,?,?,?,?)', (
                    issue_id, TAXONOMY_VERSION, tag, primary,
                    float(mapping.get('confidence') or 0), str(mapping.get('rationale') or ''),
                ))
            evidence_items = issue.get('evidence') or [
                {'turn_id': turn_id} for turn_id in issue.get('turn_ids') or []
            ]
            for evidence_index, evidence in enumerate(evidence_items):
                self.db.execute('INSERT INTO issue_evidence VALUES (?,?,?,?,?,?,?,?)', (
                    f'{issue_id}:evidence-{evidence_index + 1}', issue_id,
                    evidence.get('trajectory_id'), evidence.get('turn_id'),
                    evidence.get('tool_call_id'), evidence.get('timestamp_ms'),
                    str(evidence.get('role') or 'corroborating'), evidence.get('excerpt'),
                ))

    def list_run_reports(self):
        with self.lock:
            rows = self.db.execute('''SELECT r.*, j.status AS job_status
                FROM aft_run_reports r LEFT JOIN aft_jobs j ON j.job_id=(
                    SELECT job_id FROM aft_jobs WHERE kind='run' AND run_id=r.run_id
                    ORDER BY created_at DESC LIMIT 1)
                WHERE r.revision=(
                    SELECT MAX(latest.revision) FROM aft_run_reports latest
                    WHERE latest.run_id=r.run_id)
                ORDER BY r.created_at DESC''').fetchall()
        return [{key: row[key] for key in (
            'report_id', 'run_id', 'revision', 'model', 'taxonomy_version',
            'created_at', 'job_status',
        )} for row in rows]

    def close(self):
        with self.lock:
            self.db.close()
