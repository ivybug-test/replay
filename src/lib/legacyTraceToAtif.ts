import type {
  AtifContent,
  AtifContentPart,
  AtifImageMediaType,
  AtifMetrics,
  AtifObservationResult,
  AtifStep,
  AtifTrajectory,
} from './atif'

export interface LegacyModelImage {
  path: string
  sha256: string
  mimeType?: string
}

export interface LegacyMessageBlock {
  type?: string
  text?: string
  thinking?: string
  path?: string
  sha256?: string
  mimeType?: string
  [key: string]: unknown
}

export interface LegacyWorkTool {
  id: string
  name: string
  args?: unknown
  result?: unknown
  is_error: boolean | null
  start_ms: number
  end_ms: number | null
}

export interface LegacyWorkItem {
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
    request_index?: number
    images?: LegacyModelImage[]
    new_images?: LegacyModelImage[]
    context_images?: LegacyModelImage[]
  }>
  tools: LegacyWorkTool[]
  message?: {
    role: 'assistant' | 'user'
    blocks: LegacyMessageBlock[]
    usage?: Record<string, unknown>
    error_message?: string
  }
  details: Array<
    | { kind: 'thinking'; text: string }
    | { kind: 'text'; text: string }
    | { kind: 'tool'; tool_id: string }
  >
}

export interface LegacyEpisodeWork {
  terminal: boolean
  duration_ms: number
  task_status?: string
  agents: Array<{ id: string; label: string; role?: string; origin?: string }>
  items: LegacyWorkItem[]
}

export interface LegacyTraceContext {
  sessionId: string
  trajectoryId: string
  agentName: string
  agentVersion?: string
  modelName?: string
  imageUrl: (image: LegacyModelImage) => string
}

function object(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>
    } catch { /* preserve non-JSON arguments below */ }
  }
  return value == null ? {} : { _raw: value }
}

function stringify(value: unknown): string {
  if (typeof value === 'string') return value
  try { return JSON.stringify(value, null, 2) }
  catch { return String(value) }
}

function imageType(image: LegacyModelImage): AtifImageMediaType {
  const mime = image.mimeType?.toLowerCase()
  if (mime === 'image/jpeg' || mime === 'image/png' || mime === 'image/gif' || mime === 'image/webp') return mime
  if (/\.jpe?g$/i.test(image.path)) return 'image/jpeg'
  if (/\.gif$/i.test(image.path)) return 'image/gif'
  if (/\.webp$/i.test(image.path)) return 'image/webp'
  return 'image/png'
}

function imagePart(image: LegacyModelImage, context: LegacyTraceContext): AtifContentPart {
  return {
    type: 'image',
    source: { media_type: imageType(image), path: context.imageUrl(image) },
  }
}

function imageRefs(value: unknown, depth = 0, budget = { remaining: 2048 }): LegacyModelImage[] {
  if (depth > 8 || value == null || budget.remaining <= 0) return []
  budget.remaining -= 1
  if (Array.isArray(value)) {
    return value.flatMap((item) => imageRefs(item, depth + 1, budget)).slice(0, 32)
  }
  if (typeof value !== 'object') return []
  const source = value as Record<string, unknown>
  const found: LegacyModelImage[] = source.type === 'image' && typeof source.path === 'string' && typeof source.sha256 === 'string'
    ? [{ path: source.path, sha256: source.sha256, mimeType: typeof source.mimeType === 'string' ? source.mimeType : undefined }]
    : []
  for (const item of Object.values(source)) {
    found.push(...imageRefs(item, depth + 1, budget))
    if (found.length >= 32 || budget.remaining <= 0) break
  }
  return found.slice(0, 32)
}

function messageContent(item: LegacyWorkItem, context: LegacyTraceContext): AtifContent {
  const parts: AtifContentPart[] = []
  for (const block of item.message?.blocks ?? []) {
    if (block.type === 'text' && typeof block.text === 'string') parts.push({ type: 'text', text: block.text })
    else if (block.type === 'image' && typeof block.path === 'string' && typeof block.sha256 === 'string') {
      parts.push(imagePart(block as LegacyMessageBlock & LegacyModelImage, context))
    }
  }
  if (!parts.some((part) => part.type === 'text')) {
    const detailText = item.details.filter((detail) => detail.kind === 'text').map((detail) => detail.text).join('\n\n')
    if (detailText) parts.unshift({ type: 'text', text: detailText })
  }
  if (parts.length === 0) return ''
  if (parts.length === 1 && parts[0].type === 'text') return parts[0].text
  return parts
}

function reasoning(item: LegacyWorkItem): string | undefined {
  const text = item.details.filter((detail) => detail.kind === 'thinking').map((detail) => detail.text).join('\n\n')
  return text || undefined
}

function metrics(item: LegacyWorkItem): AtifMetrics | undefined {
  const usage = item.message?.usage
  if (!usage) return undefined
  const number = (key: string) => typeof usage[key] === 'number' ? usage[key] as number : 0
  const prompt = number('input_tokens') || number('input') + number('cacheRead') + number('cacheWrite')
  const completion = number('output_tokens') || number('output')
  const cached = number('cached_tokens') || number('cacheRead')
  const costValue = usage.cost
  const cost = costValue && typeof costValue === 'object' && !Array.isArray(costValue)
    ? (typeof (costValue as Record<string, unknown>).total === 'number' ? (costValue as Record<string, number>).total : 0)
    : number('cost_usd')
  return prompt || completion || cached || cost ? {
    prompt_tokens: prompt || undefined,
    completion_tokens: completion || undefined,
    cached_tokens: cached || undefined,
    cost_usd: cost || undefined,
  } : undefined
}

function resultContent(result: unknown, context: LegacyTraceContext): AtifContent {
  const refs = imageRefs(result)
  if (!refs.length) return stringify(result)
  const seen = new Set<string>()
  const parts: AtifContentPart[] = [{ type: 'text', text: stringify(result) }]
  for (const image of refs) {
    if (seen.has(image.sha256)) continue
    seen.add(image.sha256)
    parts.push(imagePart(image, context))
  }
  return parts
}

function workEnd(item: LegacyWorkItem): number {
  return item.tools.reduce(
    (latest, tool) => Math.max(latest, tool.end_ms ?? tool.start_ms),
    item.start_ms + Math.max(0, item.thinking_ms),
  )
}

function modelInputStep(item: LegacyWorkItem, context: LegacyTraceContext): Omit<AtifStep, 'step_id'> | null {
  const seen = new Set<string>()
  const parts: AtifContentPart[] = []
  for (const input of item.model_inputs ?? []) {
    for (const image of input.new_images ?? []) {
      if (seen.has(image.sha256)) continue
      seen.add(image.sha256)
      parts.push(imagePart(image, context))
    }
  }
  if (!parts.length) return null
  return {
    source: 'system',
    message: parts,
    extra: {
      replay: {
        source: 'legacy_trace',
        kind: 'model_input',
        work_id: item.id,
        agent_id: item.agent_id,
        start_ms: item.start_ms,
        end_ms: item.start_ms,
      },
    },
  }
}

function workStep(item: LegacyWorkItem, context: LegacyTraceContext): Omit<AtifStep, 'step_id'> {
  const source: AtifStep['source'] = item.message?.role === 'user' ? 'user' : 'agent'
  const calls = item.tools.map((tool) => ({
    tool_call_id: tool.id,
    function_name: tool.name,
    arguments: object(tool.args),
    extra: {
      start_ms: tool.start_ms,
      end_ms: tool.end_ms,
      is_error: tool.is_error,
    },
  }))
  const results: AtifObservationResult[] = item.tools
    .filter((tool) => tool.result != null)
    .map((tool) => ({
      source_call_id: tool.id,
      content: resultContent(tool.result, context),
      extra: { is_error: tool.is_error },
    }))
  if (item.message?.error_message) results.push({ content: item.message.error_message })
  const isLlmStep = source === 'agent' && !!item.message
  const stepMetrics = isLlmStep ? metrics(item) : undefined
  const stepReasoning = isLlmStep ? reasoning(item) : undefined
  return {
    source,
    message: messageContent(item, context),
    ...(source === 'agent' ? {
      model_name: context.modelName,
      reasoning_content: stepReasoning,
      tool_calls: calls.length ? calls : undefined,
      observation: results.length ? { results } : undefined,
      metrics: stepMetrics,
      llm_call_count: isLlmStep ? Math.max(1, item.model_inputs?.length ?? 0) : 0,
    } : {}),
    extra: {
      replay: {
        source: 'legacy_trace',
        kind: 'agent_work',
        work_id: item.id,
        agent_id: item.agent_id,
        role: item.role,
        origin: item.origin,
        turn_num: item.turn_num,
        global_turn_num: item.global_turn_num,
        start_ms: item.start_ms,
        end_ms: workEnd(item),
      },
    },
  }
}

/** Compatibility boundary: legacy semantic Agent Work -> valid ATIF v1.8. */
export function legacyTraceToAtif(work: LegacyEpisodeWork, context: LegacyTraceContext): AtifTrajectory {
  const unnumbered: Array<Omit<AtifStep, 'step_id'>> = []
  for (const item of work.items) {
    const input = modelInputStep(item, context)
    if (input) unnumbered.push(input)
    unnumbered.push(workStep(item, context))
  }
  const steps = unnumbered.map((step, index) => ({ ...step, step_id: index + 1 }))
  const agentSteps = steps.filter((step) => step.source === 'agent')
  const total = (field: 'prompt_tokens' | 'completion_tokens' | 'cached_tokens' | 'cost_usd') => agentSteps.reduce(
    (sum, step) => sum + (step.metrics?.[field] ?? 0),
    0,
  )
  return {
    schema_version: 'ATIF-v1.8',
    session_id: context.sessionId,
    trajectory_id: context.trajectoryId,
    agent: {
      name: context.agentName,
      version: context.agentVersion ?? 'unknown',
      model_name: context.modelName,
      extra: { source_format: 'oss-agent-work', adapter: 'legacy-trace-to-atif/v1' },
    },
    steps,
    notes: 'Converted from the legacy OSS Harness trace stream by Replay.',
    final_metrics: {
      total_prompt_tokens: total('prompt_tokens') || undefined,
      total_completion_tokens: total('completion_tokens') || undefined,
      total_cached_tokens: total('cached_tokens') || undefined,
      total_cost_usd: total('cost_usd') || undefined,
      total_steps: steps.length,
      extra: { source_duration_ms: work.duration_ms },
    },
    extra: { source_format: 'oss-agent-work', compatibility_adapter: 'v1' },
  }
}

