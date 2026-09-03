// Canonical ATIF v1.8 boundary used by Replay.
// Keep this model aligned with Harbor's reference Pydantic models. Source
// adapters may produce this shape, but the viewer itself must never interpret
// a producer-specific trace event.

export type AtifSchemaVersion =
  | 'ATIF-v1.0' | 'ATIF-v1.1' | 'ATIF-v1.2' | 'ATIF-v1.3'
  | 'ATIF-v1.4' | 'ATIF-v1.5' | 'ATIF-v1.6' | 'ATIF-v1.7' | 'ATIF-v1.8'

export type AtifImageMediaType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'
export type AtifAudioMediaType =
  | 'audio/wav' | 'audio/mpeg' | 'audio/mp4' | 'audio/aac'
  | 'audio/ogg' | 'audio/flac' | 'audio/webm' | 'audio/aiff'

export interface AtifImageSource {
  media_type: AtifImageMediaType
  path: string
}

export interface AtifAudioSource {
  media_type: AtifAudioMediaType
  path: string
  duration_sec?: number | null
}

export type AtifContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; source: AtifImageSource }
  | { type: 'audio'; source: AtifAudioSource }

export type AtifContent = string | AtifContentPart[]

export interface AtifToolCall {
  tool_call_id: string
  function_name: string
  arguments: Record<string, unknown>
  extra?: Record<string, unknown> | null
}

export interface AtifObservationResult {
  source_call_id?: string | null
  content?: AtifContent | null
  subagent_trajectory_ref?: Array<{
    trajectory_id?: string | null
    trajectory_path?: string | null
    session_id?: string | null
    extra?: Record<string, unknown> | null
  }> | null
  extra?: Record<string, unknown> | null
}

export interface AtifMetrics {
  prompt_tokens?: number | null
  completion_tokens?: number | null
  cached_tokens?: number | null
  cost_usd?: number | null
  prompt_token_ids?: number[] | null
  completion_token_ids?: number[] | null
  logprobs?: number[] | null
  extra?: Record<string, unknown> | null
}

export interface AtifStep {
  step_id: number
  timestamp?: string | null
  source: 'system' | 'user' | 'agent'
  model_name?: string | null
  reasoning_effort?: string | number | null
  message: AtifContent
  reasoning_content?: string | null
  tool_calls?: AtifToolCall[] | null
  observation?: { results: AtifObservationResult[] } | null
  metrics?: AtifMetrics | null
  is_copied_context?: boolean | null
  llm_call_count?: number | null
  extra?: Record<string, unknown> | null
}

export interface AtifAgent {
  name: string
  version: string
  model_name?: string | null
  tool_definitions?: Record<string, unknown>[] | null
  extra?: Record<string, unknown> | null
}

export interface AtifTrajectory {
  schema_version: AtifSchemaVersion
  session_id?: string | null
  trajectory_id?: string | null
  agent: AtifAgent
  steps: AtifStep[]
  notes?: string | null
  final_metrics?: {
    total_prompt_tokens?: number | null
    total_completion_tokens?: number | null
    total_cached_tokens?: number | null
    total_cost_usd?: number | null
    total_steps?: number | null
    extra?: Record<string, unknown> | null
  } | null
  continued_trajectory_ref?: string | null
  extra?: Record<string, unknown> | null
  subagent_trajectories?: AtifTrajectory[] | null
}

export class AtifValidationError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Invalid ATIF trajectory:\n${issues.map((issue) => `- ${issue}`).join('\n')}`)
    this.name = 'AtifValidationError'
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

function validIsoTimestamp(value: unknown): boolean {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value))
}

function validateContent(content: unknown, path: string, issues: string[]) {
  if (typeof content === 'string') return
  if (!Array.isArray(content)) {
    issues.push(`${path} must be a string or ContentPart array`)
    return
  }
  content.forEach((part, index) => {
    const partPath = `${path}[${index}]`
    if (!record(part)) {
      issues.push(`${partPath} must be an object`)
      return
    }
    if (part.type === 'text') {
      if (typeof part.text !== 'string') issues.push(`${partPath}.text is required for type=text`)
      if ('source' in part) issues.push(`${partPath}.source is not allowed for type=text`)
      return
    }
    if (part.type !== 'image' && part.type !== 'audio') {
      issues.push(`${partPath}.type must be text, image, or audio`)
      return
    }
    if (!record(part.source)) {
      issues.push(`${partPath}.source is required for type=${part.type}`)
      return
    }
    if (typeof part.source.path !== 'string' || !part.source.path) issues.push(`${partPath}.source.path must be a non-empty string`)
    const mediaType = part.source.media_type
    if (part.type === 'image' && !['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(String(mediaType))) {
      issues.push(`${partPath}.source.media_type is not a supported ATIF image MIME type`)
    }
    if (part.type === 'audio' && !['audio/wav', 'audio/mpeg', 'audio/mp4', 'audio/aac', 'audio/ogg', 'audio/flac', 'audio/webm', 'audio/aiff'].includes(String(mediaType))) {
      issues.push(`${partPath}.source.media_type is not a supported ATIF audio MIME type`)
    }
  })
}

/** Validate an untrusted producer payload at the ATIF boundary. */
export function parseAtifTrajectory(value: unknown, requireV18 = false): AtifTrajectory {
  const issues: string[] = []
  if (!record(value)) throw new AtifValidationError(['root must be an object'])
  const schema = value.schema_version
  const supported = /^ATIF-v1\.[0-8]$/.test(String(schema))
  if (!supported) issues.push('schema_version must be a supported ATIF-v1.x version')
  if (requireV18 && schema !== 'ATIF-v1.8') issues.push('schema_version must be ATIF-v1.8')
  if (!record(value.agent)) issues.push('agent must be an object')
  else {
    if (typeof value.agent.name !== 'string' || !value.agent.name) issues.push('agent.name must be a non-empty string')
    if (typeof value.agent.version !== 'string' || !value.agent.version) issues.push('agent.version must be a non-empty string')
  }
  if (!Array.isArray(value.steps) || value.steps.length === 0) issues.push('steps must be a non-empty array')
  else value.steps.forEach((rawStep, index) => {
    const path = `steps[${index}]`
    if (!record(rawStep)) {
      issues.push(`${path} must be an object`)
      return
    }
    if (rawStep.step_id !== index + 1) issues.push(`${path}.step_id must be ${index + 1}`)
    if (!['system', 'user', 'agent'].includes(String(rawStep.source))) issues.push(`${path}.source must be system, user, or agent`)
    if (!('message' in rawStep)) issues.push(`${path}.message is required`)
    else validateContent(rawStep.message, `${path}.message`, issues)
    if (rawStep.timestamp != null && !validIsoTimestamp(rawStep.timestamp)) issues.push(`${path}.timestamp must be ISO 8601`)
    const agentOnly = ['model_name', 'reasoning_effort', 'reasoning_content', 'tool_calls', 'metrics']
    if (rawStep.source !== 'agent') {
      for (const field of agentOnly) if (rawStep[field] != null) issues.push(`${path}.${field} is only valid for source=agent`)
    }
    if (rawStep.llm_call_count === 0 && rawStep.source === 'agent' && (rawStep.metrics != null || rawStep.reasoning_content != null)) {
      issues.push(`${path} cannot contain metrics/reasoning_content when llm_call_count=0`)
    }
    const callIds = new Set<string>()
    if (rawStep.tool_calls != null) {
      if (!Array.isArray(rawStep.tool_calls)) issues.push(`${path}.tool_calls must be an array`)
      else rawStep.tool_calls.forEach((call, callIndex) => {
        const callPath = `${path}.tool_calls[${callIndex}]`
        if (!record(call)) issues.push(`${callPath} must be an object`)
        else {
          if (typeof call.tool_call_id !== 'string' || !call.tool_call_id) issues.push(`${callPath}.tool_call_id must be a non-empty string`)
          else if (callIds.has(call.tool_call_id)) issues.push(`${callPath}.tool_call_id must be unique within the step`)
          else callIds.add(call.tool_call_id)
          if (typeof call.function_name !== 'string' || !call.function_name) issues.push(`${callPath}.function_name must be a non-empty string`)
          if (!record(call.arguments)) issues.push(`${callPath}.arguments must be an object`)
        }
      })
    }
    if (rawStep.observation != null) {
      if (!record(rawStep.observation) || !Array.isArray(rawStep.observation.results)) issues.push(`${path}.observation.results must be an array`)
      else rawStep.observation.results.forEach((result, resultIndex) => {
        const resultPath = `${path}.observation.results[${resultIndex}]`
        if (!record(result)) issues.push(`${resultPath} must be an object`)
        else {
          if (result.content != null) validateContent(result.content, `${resultPath}.content`, issues)
          if (result.source_call_id != null && (!callIds.has(String(result.source_call_id)))) {
            issues.push(`${resultPath}.source_call_id does not reference a tool call in this step`)
          }
        }
      })
    }
  })
  if (issues.length) throw new AtifValidationError(issues)
  return value as unknown as AtifTrajectory
}

