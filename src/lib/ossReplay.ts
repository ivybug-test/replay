import type { Agent, Edit, Mutation, Run, RunStatus, Step, Task, Vendor } from './types'

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

interface MessageBlock {
  type?: string
  text?: string
  thinking?: string
  path?: string
  sha256?: string
  [key: string]: unknown
}

interface ModelImage {
  path: string
  sha256: string
}

interface WorkTool {
  id: string
  name: string
  args?: unknown
  result?: unknown
  is_error: boolean | null
  start_ms: number
  end_ms: number | null
}

interface WorkItem {
  id: string
  agent_id: string
  label: string
  role?: string
  origin?: string
  start_ms: number
  thinking_ms: number
  ongoing: boolean
  turn_num?: number
  global_turn_num?: number
  context_tokens?: number
  model_inputs?: Array<{
    new_images?: ModelImage[]
    context_images?: ModelImage[]
  }>
  tools: WorkTool[]
  message?: {
    role: 'assistant' | 'user'
    blocks: MessageBlock[]
    usage?: Record<string, unknown>
    error_message?: string
  }
  details: Array<
    | { kind: 'thinking'; text: string }
    | { kind: 'text'; text: string }
    | { kind: 'tool'; tool_id: string }
  >
}

interface EpisodeWork {
  terminal: boolean
  duration_ms: number
  task_status?: string
  agents: Array<{ id: string; label: string; role?: string; origin?: string }>
  items: WorkItem[]
}

interface TimelineStamp {
  at_ms: number
  frame_index?: number
}

interface TimelineWindow {
  duration_ms: number
  terminal: boolean
  timeline?: { agent: TimelineStamp[]; desktop: TimelineStamp[] }
}

export interface ViewerBundle {
  task: Task
  run: Run
  agent: Agent
  vendor: Vendor
}

const apiBase = String(import.meta.env.VITE_REPLAY_API_BASE ?? '').replace(/\/$/, '')

function apiPath(path: string): string {
  return `${apiBase}${path}`
}

async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(apiPath(path), { cache: 'no-store', signal })
  if (!response.ok) throw new Error(`Replay API returned HTTP ${response.status}`)
  return response.json() as Promise<T>
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
  const [batch, work, window] = await Promise.all([
    fetchBatch(batchId, signal),
    getJson<EpisodeWork>(`/api/agent-work?${query}&center_ms=-1`, signal),
    getJson<TimelineWindow>(`/api/window?${query}&center_ms=0&before_ms=5000&after_ms=5000`, signal),
  ])
  const taskSummary = batch.tasks.find((task) => task.key === taskKey)
  if (!taskSummary) throw new Error(`Task ${taskKey} is not present in ${batchId}.`)
  return toViewerBundle(batch, taskSummary, work, window.timeline?.desktop ?? [])
}

export function frameUrl(batchId: string, taskKey: string, frameIndex: number): string {
  const query = new URLSearchParams({ run: batchId, task: taskKey, frame: String(frameIndex) })
  return apiPath(`/api/frame?${query}`)
}

function modelImageUrl(batchId: string, taskKey: string, image: ModelImage): string {
  const query = new URLSearchParams({ run: batchId, task: taskKey, path: image.path, sha256: image.sha256 })
  return apiPath(`/api/model-image?${query}`)
}

function asText(value: unknown): string {
  if (typeof value === 'string') return value
  try { return JSON.stringify(value, null, 2) }
  catch { return String(value) }
}

function latestFrame(frames: TimelineStamp[], atMs: number): number | null {
  let match: number | null = null
  for (const frame of frames) {
    if (frame.at_ms > atMs) break
    if (typeof frame.frame_index === 'number') match = frame.frame_index
  }
  return match
}

function computerEdit(tool: WorkTool): Edit | null {
  if (!/computer|browser|pyautogui/i.test(tool.name)) return null
  const args = tool.args && typeof tool.args === 'object' ? tool.args as Record<string, unknown> : {}
  const coordinate = args.coordinate ?? args.coord
  const coord = Array.isArray(coordinate) && coordinate.length >= 2
    ? [Number(coordinate[0]), Number(coordinate[1])] as [number, number]
    : null
  return {
    t: 'computer',
    action: typeof args.action === 'string' ? args.action : tool.name,
    coord,
    text: typeof args.text === 'string' ? args.text : null,
  }
}

function workItemToStep(
  item: WorkItem,
  index: number,
  batchId: string,
  taskKey: string,
  frames: TimelineStamp[],
): Step {
  const blocks = item.message?.blocks ?? []
  const messageText = blocks
    .filter((block) => block.type === 'text' && block.text)
    .map((block) => block.text)
    .join('\n\n')
  const detailText = item.details
    .filter((detail) => detail.kind === 'text')
    .map((detail) => detail.text)
    .join('\n\n')
  const thinking = item.details
    .filter((detail) => detail.kind === 'thinking')
    .map((detail) => detail.text)
    .join('\n\n')
  const toolCalls = item.tools.map((tool) => ({ name: tool.name, args: asText(tool.args) }))
  const observations = item.tools
    .filter((tool) => tool.result != null)
    .map((tool) => `${tool.name}${tool.is_error ? ' (error)' : ''}\n${asText(tool.result)}`)
  if (item.message?.error_message) observations.push(item.message.error_message)

  const edits: Edit[] = item.tools.map(computerEdit).filter((edit): edit is Edit => edit != null)
  const frame = latestFrame(frames, item.start_ms)
  if (frame != null) {
    edits.push({ t: 'screenshot', url: frameUrl(batchId, taskKey, frame) })
  } else {
    const image = item.model_inputs?.flatMap((input) => input.new_images ?? input.context_images ?? [])[0]
      ?? blocks.find((block) => block.path && block.sha256) as ModelImage | undefined
    if (image?.path && image.sha256) edits.push({ t: 'screenshot', url: modelImageUrl(batchId, taskKey, image) })
  }

  const mutations: Mutation[] = item.tools.map((tool) => ({
    kind: /write|edit|patch|file/i.test(tool.name) ? 'file' : 'command',
    tool: tool.name,
    target: undefined,
    summary: tool.is_error ? 'tool failed' : tool.end_ms == null ? 'tool running' : 'tool completed',
    detail: tool.result == null ? undefined : asText(tool.result),
  }))
  const usage = item.message?.usage ?? {}
  const prompt = typeof usage.input_tokens === 'number' ? usage.input_tokens : undefined
  const completion = typeof usage.output_tokens === 'number' ? usage.output_tokens : undefined

  return {
    index,
    role: item.message?.role === 'user' ? 'user' : 'assistant',
    text: messageText || detailText || null,
    reasoning: thinking ? `${item.label}\n\n${thinking}` : null,
    toolCalls: toolCalls.length ? toolCalls : null,
    observation: observations.length ? observations.join('\n\n') : null,
    tokens: prompt != null || completion != null ? { prompt, completion } : null,
    timestamp: null,
    tSec: item.start_ms / 1000,
    mutations: mutations.length ? mutations : null,
    edits: edits.length ? edits : null,
  }
}

function toRunStatus(task: TaskSummary): RunStatus {
  if (task.status === 'running') return 'running'
  if (task.status === 'interrupted') return 'interrupted'
  if (task.error) return 'error'
  if (typeof task.score === 'number') return task.score >= 0.999 ? 'passed' : 'failed'
  return task.status === 'succeeded' ? 'completed' : 'error'
}

function durationSeconds(task: TaskSummary, fallbackMs: number): number {
  const started = task.started_at ? Date.parse(task.started_at) : NaN
  const finished = task.finished_at ? Date.parse(task.finished_at) : NaN
  return Number.isFinite(started) && Number.isFinite(finished)
    ? Math.max(0, (finished - started) / 1000)
    : fallbackMs / 1000
}

function toViewerBundle(
  batch: BatchDocument,
  taskSummary: TaskSummary,
  work: EpisodeWork,
  frames: TimelineStamp[],
): ViewerBundle {
  const configuration = batch.configuration ?? {}
  const agentLabel = work.agents.map((agent) => agent.label).join(', ') || String(configuration.orchestration ?? 'agent')
  const runtime = String(configuration.runtime_name ?? configuration.model ?? agentLabel)
  const taskId = `oss-${batch.batch_id}-${taskSummary.key}`
  const runId = `${taskId}-run`
  const agentId = `${taskId}-agent`
  const steps = work.items.map((item, index) => workItemToStep(item, index, batch.batch_id, taskSummary.key, frames))
  const firstUserText = steps.find((step) => step.role === 'user' && step.text)?.text
  const artifacts = [...new Set(steps.flatMap((step) => (step.mutations ?? []).map((mutation) => mutation.target).filter(Boolean) as string[]))]
  const promptTokens = steps.reduce((sum, step) => sum + (step.tokens?.prompt ?? 0), 0)
  const completionTokens = steps.reduce((sum, step) => sum + (step.tokens?.completion ?? 0), 0)

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
      agents: work.agents,
    },
  }
  const score = typeof taskSummary.score === 'number' ? taskSummary.score : null
  const run: Run = {
    id: runId,
    taskId,
    agentId,
    vendorId: vendor.id,
    format: 'harbor',
    status: toRunStatus(taskSummary),
    passed: score != null && score >= 0.999,
    reward: score,
    steps,
    stepCount: steps.length,
    turns: steps.filter((step) => step.role === 'assistant').length,
    durationSec: durationSeconds(taskSummary, work.duration_ms),
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
  return { task, run, agent, vendor }
}
