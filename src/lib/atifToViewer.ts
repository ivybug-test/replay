import type { AtifContent, AtifContentPart, AtifImageSource, AtifStep, AtifToolCall, AtifTrajectory } from './atif'
import { parseAtifTrajectory } from './atif'
import type { Edit, Mutation, Step, StepImage } from './types'

export interface AtifViewerOptions {
  /** Resolve relative media paths (for example, files inside an uploaded ZIP). */
  resolveImage?: (source: AtifImageSource, step: AtifStep) => string | undefined
  /** Require the live producer contract rather than accepting older ATIF files. */
  requireV18?: boolean
}

function stringify(value: unknown): string {
  if (typeof value === 'string') return value
  try { return JSON.stringify(value, null, 2) }
  catch { return String(value) }
}

function contentParts(content: AtifContent): { text: string | null; images: AtifImageSource[] } {
  if (typeof content === 'string') return { text: content || null, images: [] }
  const texts: string[] = []
  const images: AtifImageSource[] = []
  for (const part of content) {
    if (part.type === 'text') texts.push(part.text)
    else if (part.type === 'image') images.push(part.source)
  }
  return { text: texts.join('\n') || null, images }
}

function defaultImageUrl(source: AtifImageSource): string | undefined {
  return /^(data:|blob:|https?:)/.test(source.path) ? source.path : undefined
}

function replayTiming(step: AtifStep): { startMs?: number; endMs?: number } {
  const harness = step.extra?.osworld_harness
  if (harness && typeof harness === 'object' && !Array.isArray(harness)) {
    const timing = harness.timing
    if (timing && typeof timing === 'object' && !Array.isArray(timing)) {
      const startMs = typeof timing.start_ms === 'number' ? timing.start_ms : undefined
      const endMs = typeof timing.end_ms === 'number' ? timing.end_ms : undefined
      if (startMs != null || endMs != null) return { startMs, endMs }
    }
  }
  // Compatibility for trajectories produced by Replay before the namespace
  // contract was introduced.
  const replay = step.extra?.replay
  if (!replay || typeof replay !== 'object' || Array.isArray(replay)) return {}
  const startMs = typeof replay.start_ms === 'number' ? replay.start_ms : undefined
  const endMs = typeof replay.end_ms === 'number' ? replay.end_ms : undefined
  return { startMs, endMs }
}

function computerEdit(call: AtifToolCall): Edit | null {
  if (!/computer|browser|pyautogui/i.test(call.function_name)) return null
  const args = call.arguments
  const coordinate = args.coordinate ?? args.coord
  const coord = Array.isArray(coordinate) && coordinate.length >= 2
    ? [Number(coordinate[0]), Number(coordinate[1])] as [number, number]
    : null
  return {
    t: 'computer',
    action: typeof args.action === 'string' ? args.action : call.function_name,
    coord,
    text: typeof args.text === 'string' ? args.text : null,
  }
}

function mutation(call: AtifToolCall): Mutation {
  const name = call.function_name
  const args = call.arguments
  const target = [args.path, args.filepath, args.file_path, args.repo_path]
    .find((value): value is string => typeof value === 'string')
  const kind: Mutation['kind'] = /git/i.test(name) ? 'git'
    : /excel|sheet/i.test(name) ? 'spreadsheet'
      : /word|document/i.test(name) ? 'document'
        : /write|edit|patch|file/i.test(name) ? 'file'
          : /finish|final_answer/i.test(name) ? 'answer'
            : 'command'
  return { kind, tool: name, target, summary: `${name} call` }
}

function imageEntries(
  sources: AtifImageSource[],
  step: AtifStep,
  kind: StepImage['kind'],
  source: StepImage['source'],
  label: string,
  atSec: number | null,
  options: AtifViewerOptions,
): StepImage[] {
  return sources.flatMap((image) => {
    const url = options.resolveImage?.(image, step) ?? defaultImageUrl(image)
    return url ? [{
      url,
      kind,
      source,
      label,
      mimeType: image.media_type,
      atSec,
    }] : []
  })
}

/**
 * The sole ATIF -> Viewer projection. Native ATIF and legacy traces converted
 * to ATIF both pass through this function, so the UI has no producer-specific
 * event parsing.
 */
export function atifTrajectoryToSteps(input: unknown, options: AtifViewerOptions = {}): Step[] {
  const trajectory: AtifTrajectory = parseAtifTrajectory(input, options.requireV18 ?? false)
  const firstTimestamp = trajectory.steps
    .map((step) => step.timestamp ? Date.parse(step.timestamp) : NaN)
    .find(Number.isFinite)

  return trajectory.steps.map((atifStep, index) => {
    const timing = replayTiming(atifStep)
    const timestampMs = atifStep.timestamp ? Date.parse(atifStep.timestamp) : NaN
    const startMs = timing.startMs ?? (
      Number.isFinite(timestampMs) && firstTimestamp != null
        ? Math.max(0, timestampMs - firstTimestamp)
        : undefined
    )
    const endMs = timing.endMs ?? startMs
    const message = contentParts(atifStep.message)
    const toolById = new Map((atifStep.tool_calls ?? []).map((call) => [call.tool_call_id, call]))
    const observationTexts: string[] = []
    const images: StepImage[] = []

    images.push(...imageEntries(
      message.images,
      atifStep,
      atifStep.source === 'agent' ? 'output' : 'input',
      'message',
      atifStep.source === 'agent' ? 'Agent message image' : `${atifStep.source} message image`,
      startMs == null ? null : startMs / 1000,
      options,
    ))

    for (const result of atifStep.observation?.results ?? []) {
      if (result.content == null) continue
      const content = contentParts(result.content)
      const call = result.source_call_id ? toolById.get(result.source_call_id) : undefined
      if (content.text) observationTexts.push(call ? `${call.function_name}\n${content.text}` : content.text)
      images.push(...imageEntries(
        content.images,
        atifStep,
        'output',
        'tool',
        call ? `${call.function_name} result` : 'Observation image',
        endMs == null ? null : endMs / 1000,
        options,
      ))
    }

    const calls = atifStep.tool_calls ?? []
    return {
      index,
      role: atifStep.source,
      text: message.text,
      reasoning: atifStep.reasoning_content ?? null,
      toolCalls: calls.length ? calls.map((call) => ({
        name: call.function_name,
        args: stringify(call.arguments),
      })) : null,
      observation: observationTexts.join('\n\n') || null,
      tokens: atifStep.metrics ? {
        prompt: atifStep.metrics.prompt_tokens ?? undefined,
        completion: atifStep.metrics.completion_tokens ?? undefined,
      } : null,
      timestamp: atifStep.timestamp ?? null,
      tSec: startMs == null ? null : startMs / 1000,
      endSec: endMs == null ? null : endMs / 1000,
      images: images.length ? images : null,
      mutations: calls.length ? calls.map(mutation) : null,
      edits: calls.map(computerEdit).filter((edit): edit is Edit => edit != null),
    }
  })
}
