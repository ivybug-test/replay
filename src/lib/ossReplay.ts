import { atifTrajectoryToSteps } from './atifToViewer'
import { observerEvents, plannerEvents } from './observerFeed'
import { parseAtifTrajectory, type AtifTrajectory } from './atif'
import {
  atifLiveToTrajectory, mergeAtifLiveSnapshot,
  type AtifLiveSnapshot, type AtifLiveStream,
} from './atifLive'
import { legacyTraceToAtif, type LegacyEpisodeWork } from './legacyTraceToAtif'
import { parseOsworldAtifExtensions } from './osworldAtifExtra'
import type { Agent, Run, RunStatus, Task, Vendor } from './types'

export interface RunSummary {
  batch_id: string
  batch_name?: string | null
  status: string
  counts?: Record<string, number>
  created_at?: string | null
  started_at?: string | null
  finished_at?: string | null
  task_count: number
}

export interface TaskSummary {
  key: string
  task_id: string
  status: string
  score?: number | null
  error?: string | null
  run_dir?: string | null
  started_at?: string | null
  finished_at?: string | null
  agent_outcome?: string | null
  evaluation_status?: string | null
}

export interface BatchDocument {
  batch_id: string
  batch_name?: string | null
  status?: string
  started_at?: string | null
  finished_at?: string | null
  configuration?: Record<string, unknown>
  tasks: TaskSummary[]
}

interface TimelineStamp {
  at_ms: number
  frame_index?: number
}

export interface ViewerBundle {
  hasMore?: boolean
  task: Task
  run: Run
  agent: Agent
  vendor: Vendor
  desktopTimeline: DesktopFrame[]
  executionState?: ExecutionStateFeed
}

export interface DesktopFrame {
  atMs: number
  frameIndex: number
  url: string
}

export type ExecutionStateKind =
  | 'declaration' | 'goal' | 'action' | 'checkpoint'
  | 'attempt' | 'evidence' | 'failure' | 'recovery' | 'observer' | 'planner'

export interface ExecutionStateEvent {
  sequence: number
  episode_elapsed_ms: number
  time?: string | null
  event: `execution_state_${ExecutionStateKind}` | 'observer_interval' | 'planner_state'
  version?: string
  status?: string
  transition?: string
  actor?: string
  source_turn?: Record<string, unknown>
  goal?: Record<string, unknown>
  record?: Record<string, unknown>
  window?: Record<string, unknown>
  [key: string]: unknown
}

export interface ExecutionStateFeed {
  version: string
  counts: Partial<Record<ExecutionStateKind, number>>
  events: ExecutionStateEvent[]
  duration_ms: number
  terminal: boolean
  task_status?: string | null
  source?: 'trajectory_extra'
  final_state?: Record<string, unknown>
}

const apiBase = String(import.meta.env.VITE_REPLAY_API_BASE ?? '').replace(/\/$/, '')
const atifLiveCache = new Map<string, AtifLiveSnapshot>()
export const standaloneBackend = import.meta.env.VITE_REPLAY_BACKEND_MODE === 'standalone'

export interface ExecutionSummary {
  batch_id: string
  batch_name?: string | null
  task_key: string
  task_id: string
  status: string
  model?: string | null
  framework?: string | null
  evaluation_status?: string | null
  agent_outcome?: string | null
  score: number | null
  started_at?: string | null
  duration_ms?: number | null
}

export interface TaskRunPage {
  task_id: string
  runs: ExecutionSummary[]
  next_cursor: string | null
  sync: { status: string; last_success: string | null; failed_batches?: number }
}

export interface TaskStat {
  task_id: string
  runs: number
  scored: number
  passed: number
  full_marks: number
  partials: number
  zeros: number
  mean_score: number | null
  completed: number
  pass_rate: number | null
  status_counts: Record<string, number>
  latest: Pick<ExecutionSummary,
    'batch_id' | 'batch_name' | 'task_key' | 'status' | 'score' | 'started_at' | 'model' | 'framework'> | null
}

export interface TaskStatsPayload {
  tasks: TaskStat[]
  task_count: number
  runs: number
  sync: { status: string; last_success: string | null; failed_batches?: number }
}

export interface LeaderboardRow {
  model: string
  framework: string
  frameworks: string[]
  attempts: number
  scored: number
  passed: number
  completed: number
  task_count: number
  scored_task_count: number
  batch_count: number
  completion_rate: number
  pass_rate: number | null
  score: { avg: number | null; min: number | null; max: number | null }
  duration_ms_avg: number | null
}

export interface LeaderboardPayload {
  rows: LeaderboardRow[]
  attempts: number
  excluded_smoke_attempts: number
  excluded_out_of_suite_attempts: number
  aggregation: 'mean_per_model_task'
  filters: { date_from: string | null; date_to: string | null; include_smoke: boolean }
  sync: { status: string; last_success: string | null; failed_batches?: number }
}

export interface ExecutionAnalysisReport {
  report_id?: string
  revision?: number
  model?: string
  content?: string
  content_format?: string
  created_at?: string
  evidence?: unknown[]
  payload?: {
    schema_version?: string
    content?: string
    content_format?: string
    model?: string
    evidence?: unknown[]
    [key: string]: unknown
  }
}

export interface AnalysisJob {
  job_id: string
  status: string
  stage?: string
  error?: { message?: string } | null
  model?: string
  progress?: {
    scanned_tasks?: number
    total_tasks?: number
    phase?: string
    failed_phase?: string
    percent?: number
    chunks_completed?: number
    evidence_requests?: number
    task_analyses_read?: number
    reused?: number
    task_reports?: { completed?: number; total?: number; running?: number; failed?: number }
  }
}

export interface ExecutionAnalysisState {
  run_id: string
  task_key: string
  report: ExecutionAnalysisReport | null
  report_origin?: string | null
  oss_status?: string | null
  job: AnalysisJob | null
}

export interface AnalysisModel {
  id: string
  model: string
  displayName: string
  description: string
  isDefault: boolean
  defaultReasoningEffort?: string | null
  supportedReasoningEfforts?: Array<{ reasoningEffort: string; description?: string }>
  inputModalities?: string[]
}

export interface AftRunReportSummary {
  report_id: string
  run_id: string
  revision: number
  model: string
  taxonomy_version: string
  created_at: string
  job_status?: string | null
}

export interface AftRunStatus {
  job: AnalysisJob | null
  report: AftRunReportSummary | null
}

export interface ResearchSource {
  source_id: string
  title: string
  url: string
  published_at?: string
  source_type?: string
  organization?: string
  authority_tier?: string
  authority_weight?: number
  claim_scope?: string
  reproducibility_level?: string
  independence_group?: string
  version_or_commit?: string
  support_kind?: 'definition' | 'supporting'
  evidence_relation?: string
  effective_weight?: number
  support_note?: string
  support_locator?: string
  support_url?: string
}

export interface ProblemTag {
  version_id: string
  tag_id: string
  name_zh: string
  name_en: string
  category: string
  description: string
  detection_signals: string[]
  exclusions: string[]
  default_severity: string
  source_basis: string
  authority_weight: number
  research_priority: 'core' | 'supported' | 'supplemental' | 'source-taxonomy' | 'core-harness'
  fault_side?: string
  definition_source_id?: string
  definition_locator?: string
  active: boolean
  sources: ResearchSource[]
}

export interface AftRunReport extends AftRunReportSummary {
  content: string
  document: {
    schema_version: string
    summary: Record<string, unknown>
    tasks: Array<Record<string, unknown>>
    issues: Array<Record<string, unknown>>
  }
}

export function fetchTaskRuns(taskId: string, filters: { cursor?: string; model?: string; status?: string }, signal?: AbortSignal) {
  const query = new URLSearchParams({ task_id: taskId, limit: '50' })
  for (const [key, value] of Object.entries(filters)) if (value) query.set(key, value)
  return getJson<TaskRunPage>(`/api/task-runs?${query}`, signal)
}

export function fetchTaskStats(signal?: AbortSignal) {
  return getJson<TaskStatsPayload>('/api/task-stats', signal)
}

export function fetchLeaderboard(filters: {
  dateFrom?: string; dateTo?: string; includeSmoke?: boolean
}, signal?: AbortSignal) {
  const query = new URLSearchParams()
  if (filters.dateFrom) query.set('date_from', filters.dateFrom)
  if (filters.dateTo) query.set('date_to', filters.dateTo)
  if (filters.includeSmoke) query.set('include_smoke', 'true')
  const suffix = query.size ? `?${query}` : ''
  return getJson<LeaderboardPayload>(`/api/leaderboard${suffix}`, signal)
}

function apiPath(path: string): string {
  return `${apiBase}${path}`
}

async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(apiPath(path), { cache: 'no-store', signal })
  if (!response.ok) throw new Error(`Replay API returned HTTP ${response.status}`)
  return response.json() as Promise<T>
}

async function getOptionalJson<T>(path: string, signal?: AbortSignal): Promise<T | null> {
  const response = await fetch(apiPath(path), { cache: 'no-store', signal })
  if (response.status === 404) return null
  if (!response.ok) throw new Error(`Replay API returned HTTP ${response.status}`)
  return response.json() as Promise<T>
}

async function postJson<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(apiPath(path), {
    method: 'POST', cache: 'no-store', signal,
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
  if (!response.ok) throw new Error(`Replay API returned HTTP ${response.status}`)
  return response.json() as Promise<T>
}

export function fetchExecutionAnalysis(batchId: string, taskKey: string, signal?: AbortSignal) {
  const query = new URLSearchParams({ run: batchId, task: taskKey })
  return getJson<ExecutionAnalysisState>(`/api/execution-analysis?${query}`, signal)
}

export function fetchAnalysisModels(signal?: AbortSignal) {
  return getJson<{ models: AnalysisModel[] }>('/api/analysis-models', signal)
}

export function startExecutionAnalysis(
  batchId: string, taskKey: string, model?: string, signal?: AbortSignal, force = false,
) {
  return postJson<ExecutionAnalysisState>('/api/execution-analysis', {
    run: batchId, task: taskKey, ...(model ? { model } : {}), ...(force ? { force: true } : {}),
  }, signal)
}

export function fetchAftRunStatuses(signal?: AbortSignal) {
  return getJson<{ runs: Record<string, AftRunStatus> }>('/api/run-analysis-statuses', signal)
}

export function fetchRunAnalysis(batchId: string, signal?: AbortSignal) {
  const query = new URLSearchParams({ run: batchId })
  return getJson<{ run_id: string; job: AnalysisJob | null; report: AftRunReportSummary | null }>(
    `/api/run-analysis?${query}`, signal,
  )
}

export function startRunAnalysis(batchId: string, model?: string, signal?: AbortSignal, force = false) {
  return postJson<{ run_id: string; job: AnalysisJob | null; report: AftRunReportSummary | null }>(
    '/api/run-analysis', { run: batchId, ...(model ? { model } : {}), ...(force ? { force: true } : {}) }, signal,
  )
}

export function fetchProblemTags(signal?: AbortSignal) {
  return getJson<{
    version: Record<string, unknown>
    research_map_version?: string
    research_foundation?: ResearchSource[]
    tags: ProblemTag[]
  }>('/api/problem-tags', signal)
}

export function fetchAftReports(signal?: AbortSignal) {
  return getJson<{ reports: AftRunReportSummary[] }>('/api/aft-reports', signal)
}

export function fetchAftReport(reportId: string, signal?: AbortSignal) {
  return getJson<AftRunReport>(`/api/aft-reports/${encodeURIComponent(reportId)}`, signal)
}

async function getAtifLive(
  batchId: string,
  taskKey: string,
  query: URLSearchParams,
  signal?: AbortSignal,
): Promise<AtifLiveStream | null> {
  const key = `${batchId}/${taskKey}`
  const prior = atifLiveCache.get(key)
  const liveQuery = new URLSearchParams(query)
  liveQuery.set('after', String(prior?.cursor ?? 0))
  const delta = await getOptionalJson<AtifLiveStream>(`/api/atif-live?${liveQuery}`, signal)
  if (!delta) return prior?.stream ?? null
  const complete = mergeAtifLiveSnapshot(prior, delta)
  atifLiveCache.set(key, complete)
  if (atifLiveCache.size > 8) atifLiveCache.delete(atifLiveCache.keys().next().value!)
  return complete.stream
}

export async function fetchLiveRuns(date?: string | null, signal?: AbortSignal) {
  const query = new URLSearchParams()
  if (date) query.set('date', date)
  const suffix = query.size ? `?${query}` : ''
  return getJson<{ date: string; latest_date: string; runs: RunSummary[] }>(`/api/runs${suffix}`, signal)
}

export async function fetchBatch(batchId: string, signal?: AbortSignal): Promise<BatchDocument> {
  const query = new URLSearchParams({ run: batchId })
  const payload = await getJson<{ batch: BatchDocument | null }>(`/api/batch?${query}`, signal)
  if (!payload.batch) throw new Error('This run does not have a batch document yet.')
  return { ...payload.batch, tasks: payload.batch.tasks ?? [] }
}

export async function fetchViewerBundle(
  batchId: string,
  taskKey: string,
  signal?: AbortSignal,
): Promise<ViewerBundle> {
  const query = new URLSearchParams({ run: batchId, task: taskKey })
  const [batch, source] = await Promise.all([
    fetchBatch(batchId, signal),
    getOptionalJson<AtifTrajectory>(`/api/trajectory?${query}`, signal).then(async (terminalTrajectory) => {
      if (terminalTrajectory) {
        atifLiveCache.delete(`${batchId}/${taskKey}`)
        return { trajectory: terminalTrajectory, work: null, hasMore: false }
      }
      let liveError: unknown
      try {
        const live = await getAtifLive(batchId, taskKey, query, signal)
        const trajectory = live ? atifLiveToTrajectory(live) : null
        if (trajectory) return { trajectory, work: null, hasMore: Boolean(live?.has_more) }
      } catch (error) {
        if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) throw error
        liveError = error
        // A broken live manifest must not prevent reading the legacy trace.
        // Start fresh on the next refresh so a recovered stream can take over.
        atifLiveCache.delete(`${batchId}/${taskKey}`)
      }
      if (standaloneBackend) {
        if (liveError) throw liveError
        throw new Error('No trajectory steps are available yet. Retrying…')
      }
      const work = await getJson<LegacyEpisodeWork>(`/api/agent-work?${query}&center_ms=-1`, signal)
      if (liveError && !work.items.length) {
        throw new Error(`Live trajectory could not be loaded (${String(liveError)}), and no legacy steps are available. Retrying…`)
      }
      return { trajectory: null, work, hasMore: false }
    }),
  ])
  const taskSummary = batch.tasks.find((task) => task.key === taskKey)
  if (!taskSummary) throw new Error(`Task ${taskKey} is not present in ${batchId}.`)
  // Native trajectories and live ATIF pages carry their desktop timeline in
  // the harness extension. Do not block first paint on /window, which must
  // scan the complete history of a long-running stream.
  return { ...toViewerBundle(batch, taskSummary, source.work, source.trajectory, []),
    hasMore: source.hasMore }
}

export async function fetchExecutionState(
  batchId: string,
  taskKey: string,
  signal?: AbortSignal,
): Promise<ExecutionStateFeed> {
  const query = new URLSearchParams({ run: batchId, task: taskKey })
  return getJson<ExecutionStateFeed>(`/api/execution-state?${query}`, signal)
}

export function frameUrl(batchId: string, taskKey: string, frameIndex: number): string {
  const query = new URLSearchParams({ run: batchId, task: taskKey, frame: String(frameIndex) })
  return apiPath(`/api/frame?${query}`)
}

function modelImageUrl(batchId: string, taskKey: string, image: { path: string; sha256: string }): string {
  const query = new URLSearchParams({ run: batchId, task: taskKey, path: image.path, sha256: image.sha256 })
  return apiPath(`/api/model-image?${query}`)
}

function atifMediaUrl(batchId: string, taskKey: string, path: string): string {
  const query = new URLSearchParams({ run: batchId, task: taskKey, path })
  return apiPath(`/api/atif-media?${query}`)
}

function toRunStatus(task: TaskSummary): RunStatus {
  if (task.status === 'running') return 'running'
  if (task.status === 'interrupted') return 'interrupted'
  if (task.error) return 'error'
  if (typeof task.score === 'number') return task.score >= 0.999 ? 'passed' : 'failed'
  return task.status === 'succeeded' ? 'completed' : 'error'
}

function durationSeconds(task: TaskSummary, fallbackMs: number): number {
  if (Number.isFinite(fallbackMs) && fallbackMs > 0) return fallbackMs / 1000
  const started = task.started_at ? Date.parse(task.started_at) : NaN
  const finished = task.finished_at ? Date.parse(task.finished_at) : NaN
  return Number.isFinite(started) && Number.isFinite(finished)
    ? Math.max(0, (finished - started) / 1000)
    : fallbackMs / 1000
}

function toViewerBundle(
  batch: BatchDocument,
  taskSummary: TaskSummary,
  work: LegacyEpisodeWork | null,
  nativeTrajectory: AtifTrajectory | null,
  frames: TimelineStamp[],
): ViewerBundle {
  const configuration = batch.configuration ?? {}
  const native = nativeTrajectory ? parseAtifTrajectory(nativeTrajectory, true) : null
  const legacyAgentLabel = work?.agents.map((agent) => agent.label).join(', ')
  const agentLabel = native?.agent.name ?? (legacyAgentLabel || String(configuration.orchestration ?? 'agent'))
  const runtime = String(native?.agent.model_name ?? configuration.runtime_name ?? configuration.model ?? agentLabel)
  const taskId = `oss-${batch.batch_id}-${taskSummary.key}`
  const runId = `${taskId}-run`
  const agentId = `${taskId}-agent`
  const trajectory = native ?? (work?.items.length ? legacyTraceToAtif(work, {
    sessionId: `${batch.batch_id}/${taskSummary.key}`,
    trajectoryId: `${batch.batch_id}/${taskSummary.key}/root`,
    agentName: String(configuration.orchestration ?? agentLabel),
    agentVersion: typeof configuration.agent_version === 'string' ? configuration.agent_version : 'unknown',
    modelName: runtime,
    imageUrl: (image) => modelImageUrl(batch.batch_id, taskSummary.key, image),
  }) : null)
  const extensions = trajectory ? parseOsworldAtifExtensions(trajectory) : {}
  const steps = trajectory ? atifTrajectoryToSteps(trajectory, {
    requireV18: true,
    resolveImage: (source) => /^(data:|blob:|https?:|\/api\/)/.test(source.path)
      ? source.path
      : atifMediaUrl(batch.batch_id, taskSummary.key, source.path),
  }) : []
  const sidecarDesktopTimeline = frames
    .filter((frame): frame is TimelineStamp & { frame_index: number } => typeof frame.frame_index === 'number')
    .map((frame) => ({
      atMs: frame.at_ms,
      frameIndex: frame.frame_index,
      url: frameUrl(batch.batch_id, taskSummary.key, frame.frame_index),
    }))
    .sort((a, b) => a.atMs - b.atMs)
  const embeddedDesktopTimeline = (extensions.harness?.desktop_timeline?.frames ?? []).map((frame) => ({
    atMs: frame.episode_elapsed_ms,
    frameIndex: frame.frame_index,
    url: /^(data:|blob:|https?:|\/api\/)/.test(frame.image.source.path)
      ? frame.image.source.path
      : atifMediaUrl(batch.batch_id, taskSummary.key, frame.image.source.path),
  }))
  // Existing trace sidecars remain authoritative while producers migrate.
  // Native ATIF can become self-contained as soon as it embeds this extension.
  const desktopTimeline = sidecarDesktopTimeline.length ? sidecarDesktopTimeline : embeddedDesktopTimeline
  const firstUserText = steps.find((step) => step.role === 'user' && step.text)?.text
  const artifacts = [...new Set(steps.flatMap((step) => (step.mutations ?? []).map((mutation) => mutation.target).filter(Boolean) as string[]))]
  const promptTokens = steps.reduce((sum, step) => sum + (step.tokens?.prompt ?? 0), 0)
  const completionTokens = steps.reduce((sum, step) => sum + (step.tokens?.completion ?? 0), 0)
  const traceDurationMs = typeof extensions.harness?.run?.duration_ms === 'number'
    ? extensions.harness.run.duration_ms
    : work?.duration_ms ?? Math.max(0, ...steps.map((step) => (step.endSec ?? step.tSec ?? 0) * 1000))

  const vendor: Vendor = {
    id: 'oss-replay',
    name: 'OSS Replay',
    coverage: 'Live OSWorld runs loaded from the existing oss-replay API.',
  }
  const agent: Agent = {
    id: agentId,
    harness: String(configuration.orchestration ?? agentLabel),
    model: runtime,
    family: /qwen/i.test(runtime) ? 'Alibaba' : /gpt|codex|openai/i.test(runtime) ? 'OpenAI' : 'unknown',
    vendorId: vendor.id,
  }
  const task: Task = {
    id: taskId,
    vendorId: vendor.id,
    title: `OSWorld ${taskSummary.task_id} · ${taskSummary.key}`,
    source: 'harbor',
    category: batch.batch_name ?? batch.batch_id,
    difficulty: '',
    instruction: firstUserText ?? undefined,
    files: firstUserText ? [{ path: 'instruction.md', kind: 'markdown', content: firstUserText }] : [],
    metadata: {
      batch_id: batch.batch_id,
      task_key: taskSummary.key,
      task_id: taskSummary.task_id,
      execution_status: taskSummary.status,
      evaluation_status: taskSummary.evaluation_status,
      agent_outcome: taskSummary.agent_outcome,
      agents: work?.agents ?? [{ id: native?.trajectory_id ?? 'agent', label: native?.agent.name ?? agentLabel }],
    },
  }
  const score = typeof taskSummary.score === 'number' ? taskSummary.score : null
  const run: Run = {
    id: runId,
    taskId,
    agentId,
    vendorId: vendor.id,
    format: 'atif',
    status: toRunStatus(taskSummary),
    passed: score != null && score >= 0.999,
    reward: score,
    steps,
    stepCount: steps.length,
    turns: steps.filter((step) => step.role === 'assistant' || step.role === 'agent').length,
    durationSec: durationSeconds(taskSummary, traceDurationMs),
    artifacts,
    tokens: promptTokens || completionTokens ? { prompt: promptTokens, completion: completionTokens } : null,
    grade: score == null ? null : {
      score,
      maxScore: 1,
      subscores: [],
      summary: `Official evaluator score: ${score}. Agent outcome: ${taskSummary.agent_outcome ?? 'not reported'}.`,
    },
    failureReason: taskSummary.error ?? null,
  }
  const reports = trajectory ? observerEvents(trajectory) : []
  const planUpdates = trajectory ? plannerEvents(trajectory) : []
  const stateEvents = [...planUpdates, ...reports]
    .sort((a, b) => a.episode_elapsed_ms - b.episode_elapsed_ms || a.sequence - b.sequence)
  const executionState: ExecutionStateFeed | undefined = trajectory ? {
    version: 'harness-state/v1', source: 'trajectory_extra',
    duration_ms: traceDurationMs, terminal: taskSummary.status !== 'running',
    task_status: taskSummary.status,
    counts: { observer: reports.length, planner: planUpdates.length }, events: stateEvents,
  } : undefined
  return { task, run, agent, vendor, desktopTimeline, executionState }
}
