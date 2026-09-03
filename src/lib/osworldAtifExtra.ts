import type { AtifImageMediaType, AtifTrajectory } from './atif'

/** Stable namespaces owned by the OSWorld Harness, not by core ATIF. */
export const OSWORLD_HARNESS_SCHEMA = 'osworld-harness/v1' as const
export const OSWORLD_DESKTOP_TIMELINE_SCHEMA = 'desktop-timeline/v1' as const
export const OSWORLD_EXECUTION_STATE_SCHEMA = 'execution-state/v2' as const

export type OsworldSurface = 'desktop' | 'browser' | 'terminal' | 'filesystem' | 'other'
export type ExecutionStateEventType =
  | 'declaration' | 'goal' | 'action' | 'checkpoint'
  | 'attempt' | 'evidence' | 'failure' | 'recovery'

export interface OsworldHarnessTiming {
  clock: 'episode_elapsed_ms'
  start_ms: number
  end_ms?: number | null
}

export interface OsworldHarnessRun {
  batch_id?: string
  batch_name?: string | null
  task_key?: string
  task_id?: string
  route?: string | null
  attempt?: number | null
  worker_id?: string | null
  execution_status?: string | null
  evaluation_status?: string | null
  agent_outcome?: string | null
  started_at?: string | null
  finished_at?: string | null
  duration_ms?: number | null
  terminal?: boolean
  [key: string]: unknown
}

export interface OsworldDesktopFrameImage {
  type: 'image'
  source: {
    media_type: AtifImageMediaType
    path: string
  }
  /** Integrity metadata is Harness-owned and therefore lives outside ATIF source. */
  sha256?: string
  bytes?: number
}

export interface OsworldDesktopFrame {
  frame_index: number
  episode_elapsed_ms: number
  kind: 'initial' | 'first_observed' | 'changed' | 'terminal'
  image: OsworldDesktopFrameImage
  captured_at?: string | null
  comparison?: Record<string, unknown> | null
  [key: string]: unknown
}

export interface OsworldDesktopTimelineV1 {
  schema_version: typeof OSWORLD_DESKTOP_TIMELINE_SCHEMA
  clock: 'episode_elapsed_ms'
  frames: OsworldDesktopFrame[]
  total_frames?: number
  status?: 'enabled' | 'disabled' | 'degraded' | 'unknown'
  terminal?: boolean
  warnings?: string[]
  [key: string]: unknown
}

export interface OsworldHarnessRootExtraV1 {
  schema_version: typeof OSWORLD_HARNESS_SCHEMA
  clock?: {
    field: 'episode_elapsed_ms'
    unit: 'ms'
    origin: 'episode_start'
  }
  run?: OsworldHarnessRun
  source?: {
    format?: string
    adapter?: string
    [key: string]: unknown
  }
  desktop_timeline?: OsworldDesktopTimelineV1
  [key: string]: unknown
}

export interface OsworldHarnessStepExtraV1 {
  timing?: OsworldHarnessTiming
  provenance?: {
    source_format?: string
    kind?: string
    work_id?: string
    agent_id?: string
    role?: string
    origin?: string
    turn_num?: number
    global_turn_num?: number
    [key: string]: unknown
  }
  execution_state_event_refs?: string[]
  [key: string]: unknown
}

export interface OsworldHarnessToolCallExtraV1 {
  actor?: string
  surface?: OsworldSurface
  timing?: OsworldHarnessTiming
  execution_state_action_id?: string
  [key: string]: unknown
}

export interface OsworldHarnessObservationExtraV1 {
  tool_status?: 'completed' | 'error' | 'cancelled' | 'unknown'
  result_ref?: string
  execution_state_action_id?: string
  [key: string]: unknown
}

export interface ExecutionStateGoalRecord {
  id: string
  statement: string
  done_when: string
  status: string
  owner?: string | null
  parent_id?: string | null
  provisional?: boolean
  [key: string]: unknown
}

export interface ExecutionStateActionRecord {
  id: string
  actor: string
  tool: string
  tool_status: 'completed' | 'error'
  action_ref: string
  result_ref: string
  [key: string]: unknown
}

export interface ExecutionStateCheckpointRecord {
  id: string
  actor: string
  action_ids: string[]
  trigger: 'action_limit' | 'tool_error' | 'blocked' | 'delegation' | 'return'
  status: 'complete' | 'incomplete'
  before_ref?: string | null
  after_ref?: string | null
  [key: string]: unknown
}

export interface ExecutionStateAttemptRecord {
  id: string
  goal_id: string
  focus?: string | null
  route?: Record<string, unknown> | null
  intent: string
  expected_effect: string
  actor?: string | null
  checkpoint_ids?: string[]
  action_ids?: string[]
  status?: string
  [key: string]: unknown
}

export interface ExecutionStateEvidenceRecord {
  id: string
  goal_id: string
  attempt_id?: string | null
  attempt_ids?: string[]
  checkpoint_id?: string | null
  facts?: unknown[]
  information_gained?: string | null
  progress?: string | null
  goal_satisfied?: boolean | null
  before_ref?: string | null
  after_ref?: string | null
  result_refs?: string[]
  [key: string]: unknown
}

export interface ExecutionStateFailureRecord {
  id: string
  goal_id: string
  focus?: string | null
  attempt_ids: string[]
  failed_route?: Record<string, unknown> | null
  observed_invariant?: string | null
  evidence_ids?: string[]
  status: string
  [key: string]: unknown
}

export interface ExecutionStateRecoveryRecord {
  id: string
  goal_id: string
  failure_ids: string[]
  kind: string
  intent?: string | null
  question?: string | null
  first_step?: string | null
  observable_success?: string | null
  why_different?: string | null
  status: string
  [key: string]: unknown
}

export interface ExecutionStateDeclarationRecord {
  id?: string
  actor?: string
  status?: string
  source_turn?: Record<string, unknown>
  [key: string]: unknown
}

export interface ExecutionStateEventRecordMap {
  declaration: ExecutionStateDeclarationRecord
  goal: ExecutionStateGoalRecord
  action: ExecutionStateActionRecord
  checkpoint: ExecutionStateCheckpointRecord
  attempt: ExecutionStateAttemptRecord
  evidence: ExecutionStateEvidenceRecord
  failure: ExecutionStateFailureRecord
  recovery: ExecutionStateRecoveryRecord
}

export type ExecutionStateEventV2 = {
  [K in ExecutionStateEventType]: {
    event_type: K
    episode_elapsed_ms: number
    record: ExecutionStateEventRecordMap[K]
    sequence?: number
    time?: string | null
    [key: string]: unknown
  }
}[ExecutionStateEventType]

export interface ExecutionStateFinalStateV2 {
  current_goal_id?: string | null
  current_focus?: string | null
  active_failure_ids?: string[]
  goals?: ExecutionStateGoalRecord[]
  attempts?: ExecutionStateAttemptRecord[]
  evidence?: ExecutionStateEvidenceRecord[]
  failures?: ExecutionStateFailureRecord[]
  recovery_items?: ExecutionStateRecoveryRecord[]
  [key: string]: unknown
}

export interface ExecutionStateExtensionV2 {
  schema_version: typeof OSWORLD_EXECUTION_STATE_SCHEMA
  events: ExecutionStateEventV2[]
  final_state?: ExecutionStateFinalStateV2
  [key: string]: unknown
}

export interface OsworldAtifExtensions {
  harness?: OsworldHarnessRootExtraV1
  executionState?: ExecutionStateExtensionV2
}

export class OsworldAtifExtraValidationError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Invalid OSWorld ATIF extra:\n${issues.map((issue) => `- ${issue}`).join('\n')}`)
    this.name = 'OsworldAtifExtraValidationError'
  }
}

function object(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0
}

function requireString(record: Record<string, unknown>, field: string, path: string, issues: string[]) {
  if (typeof record[field] !== 'string' || !record[field]) issues.push(`${path}.${field} must be a non-empty string`)
}

function validateStateRecord(eventType: string, value: unknown, path: string, issues: string[]) {
  if (!object(value)) {
    issues.push(`${path} must be an object`)
    return
  }
  if (eventType !== 'declaration') requireString(value, 'id', path, issues)
  if (eventType === 'goal') {
    for (const field of ['statement', 'done_when', 'status']) requireString(value, field, path, issues)
  } else if (eventType === 'action') {
    for (const field of ['actor', 'tool', 'action_ref', 'result_ref']) requireString(value, field, path, issues)
    if (!['completed', 'error'].includes(String(value.tool_status))) issues.push(`${path}.tool_status must be completed or error`)
  } else if (eventType === 'checkpoint') {
    requireString(value, 'actor', path, issues)
    if (!Array.isArray(value.action_ids) || value.action_ids.length === 0) issues.push(`${path}.action_ids must be a non-empty array`)
    if (!['action_limit', 'tool_error', 'blocked', 'delegation', 'return'].includes(String(value.trigger))) issues.push(`${path}.trigger is not supported`)
    if (!['complete', 'incomplete'].includes(String(value.status))) issues.push(`${path}.status must be complete or incomplete`)
  } else if (eventType === 'attempt') {
    for (const field of ['goal_id', 'intent', 'expected_effect']) requireString(value, field, path, issues)
  } else if (eventType === 'evidence') {
    requireString(value, 'goal_id', path, issues)
  } else if (eventType === 'failure') {
    for (const field of ['goal_id', 'status']) requireString(value, field, path, issues)
    if (!Array.isArray(value.attempt_ids)) issues.push(`${path}.attempt_ids must be an array`)
  } else if (eventType === 'recovery') {
    for (const field of ['goal_id', 'kind', 'status']) requireString(value, field, path, issues)
    if (!Array.isArray(value.failure_ids)) issues.push(`${path}.failure_ids must be an array`)
  }
}

function validateTimeline(value: unknown, issues: string[]): value is OsworldDesktopTimelineV1 {
  const path = 'extra.osworld_harness.desktop_timeline'
  if (!object(value)) {
    issues.push(`${path} must be an object`)
    return false
  }
  if (value.schema_version !== OSWORLD_DESKTOP_TIMELINE_SCHEMA) {
    issues.push(`${path}.schema_version must be ${OSWORLD_DESKTOP_TIMELINE_SCHEMA}`)
  }
  if (value.clock !== 'episode_elapsed_ms') issues.push(`${path}.clock must be episode_elapsed_ms`)
  if (!Array.isArray(value.frames)) {
    issues.push(`${path}.frames must be an array`)
    return false
  }
  let lastTime = -1
  let lastIndex = -1
  value.frames.forEach((frame, index) => {
    const framePath = `${path}.frames[${index}]`
    if (!object(frame)) {
      issues.push(`${framePath} must be an object`)
      return
    }
    if (!nonNegativeInteger(frame.frame_index)) issues.push(`${framePath}.frame_index must be a non-negative integer`)
    else if (frame.frame_index <= lastIndex) issues.push(`${framePath}.frame_index must be strictly increasing`)
    else lastIndex = frame.frame_index
    if (!nonNegativeInteger(frame.episode_elapsed_ms)) issues.push(`${framePath}.episode_elapsed_ms must be a non-negative integer`)
    else if (frame.episode_elapsed_ms < lastTime) issues.push(`${framePath}.episode_elapsed_ms must be monotonic`)
    else lastTime = frame.episode_elapsed_ms
    if (!['initial', 'first_observed', 'changed', 'terminal'].includes(String(frame.kind))) {
      issues.push(`${framePath}.kind is not supported`)
    }
    if (!object(frame.image) || frame.image.type !== 'image' || !object(frame.image.source)) {
      issues.push(`${framePath}.image must contain an ATIF-style image source`)
    } else {
      if (typeof frame.image.source.path !== 'string' || !frame.image.source.path) issues.push(`${framePath}.image.source.path is required`)
      if (!['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(String(frame.image.source.media_type))) {
        issues.push(`${framePath}.image.source.media_type is not supported`)
      }
    }
  })
  return true
}

function validateExecutionState(value: unknown, issues: string[]): value is ExecutionStateExtensionV2 {
  const path = 'extra.osworld_execution_state'
  if (!object(value)) {
    issues.push(`${path} must be an object`)
    return false
  }
  if (value.schema_version !== OSWORLD_EXECUTION_STATE_SCHEMA) {
    issues.push(`${path}.schema_version must be ${OSWORLD_EXECUTION_STATE_SCHEMA}`)
  }
  if (!Array.isArray(value.events)) {
    issues.push(`${path}.events must be an array`)
    return false
  }
  let lastTime = -1
  value.events.forEach((event, index) => {
    const eventPath = `${path}.events[${index}]`
    if (!object(event)) {
      issues.push(`${eventPath} must be an object`)
      return
    }
    if (!['declaration', 'goal', 'action', 'checkpoint', 'attempt', 'evidence', 'failure', 'recovery'].includes(String(event.event_type))) {
      issues.push(`${eventPath}.event_type is not supported`)
    }
    if (!nonNegativeInteger(event.episode_elapsed_ms)) issues.push(`${eventPath}.episode_elapsed_ms must be a non-negative integer`)
    else if (event.episode_elapsed_ms < lastTime) issues.push(`${eventPath}.episode_elapsed_ms must be monotonic`)
    else lastTime = event.episode_elapsed_ms
    validateStateRecord(String(event.event_type), event.record, `${eventPath}.record`, issues)
  })
  if (value.final_state != null && !object(value.final_state)) issues.push(`${path}.final_state must be an object`)
  return true
}

/** Parse only the namespaced Harness extensions. Unknown root extra keys stay untouched. */
export function parseOsworldAtifExtensions(trajectory: AtifTrajectory): OsworldAtifExtensions {
  const root = trajectory.extra
  if (!root) return {}
  const issues: string[] = []
  let harness: OsworldHarnessRootExtraV1 | undefined
  let executionState: ExecutionStateExtensionV2 | undefined
  if ('osworld_harness' in root) {
    if (!object(root.osworld_harness)) issues.push('extra.osworld_harness must be an object')
    else {
      if (root.osworld_harness.schema_version !== OSWORLD_HARNESS_SCHEMA) {
        issues.push(`extra.osworld_harness.schema_version must be ${OSWORLD_HARNESS_SCHEMA}`)
      }
      if (root.osworld_harness.desktop_timeline != null) validateTimeline(root.osworld_harness.desktop_timeline, issues)
      harness = root.osworld_harness as unknown as OsworldHarnessRootExtraV1
    }
  }
  if ('osworld_execution_state' in root) {
    validateExecutionState(root.osworld_execution_state, issues)
    if (object(root.osworld_execution_state)) executionState = root.osworld_execution_state as unknown as ExecutionStateExtensionV2
  }
  if (issues.length) throw new OsworldAtifExtraValidationError(issues)
  return { harness, executionState }
}
