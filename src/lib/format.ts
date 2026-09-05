export const FORMAT_LABELS: Record<string, string> = {
  atif: 'ATIF',
  harbor: 'Harbor',
  osworld: 'OSWorld 2.0',
  // `snorkel` and `fleet` are legacy RunFormat variants that aren't produced
  // by the bundled ingest but remain renderable so forks that pipe in those
  // shapes don't have to add labels.
  snorkel: 'OAI-messages',
  fleet: 'OAI-messages',
}

export function fmtDuration(sec: number | null | undefined): string {
  if (sec == null || sec < 1) return '—'
  if (sec < 60) return `${Math.round(sec)}s`
  const m = Math.floor(sec / 60)
  const s = Math.round(sec % 60)
  return s ? `${m}m ${s}s` : `${m}m`
}

export function fmtPct(x: number): string {
  return `${(x * 100).toFixed(0)}%`
}

export function fmtReward(x: number | null | undefined): string {
  return x == null ? '—' : x.toFixed(2)
}

export function fmtInt(x: number): string {
  return Math.round(x).toString()
}

export function fmtTokens(n: number | null | undefined): string {
  if (n == null) return '—'
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`
  return String(n)
}

/** Format JSON for UI display. Tool payloads sometimes wrap a complete JSON
 * object in a string (for example `{ "result": "{\\"data\\": ...}" }`).
 * Callers can opt into expanding those embedded objects without changing
 * ordinary strings such as shell commands or prose. */
export function formatJsonForDisplay(content: string | null | undefined, expandEmbedded = false): string {
  if (!content) return ''
  try {
    const parsed: unknown = JSON.parse(content)
    return JSON.stringify(expandEmbedded ? expandEmbeddedJson(parsed) : parsed, null, 2)
  } catch {
    return content
  }
}

function expandEmbeddedJson(value: unknown, depth = 0): unknown {
  if (depth >= 8) return value
  if (typeof value === 'string') {
    const candidate = value.trim()
    if (!((candidate.startsWith('{') && candidate.endsWith('}')) || (candidate.startsWith('[') && candidate.endsWith(']')))) return value
    try {
      const parsed: unknown = JSON.parse(candidate)
      // Only promote containers. JSON-looking scalar strings should remain
      // visibly strings rather than silently changing type in the viewer.
      if (parsed === null || typeof parsed !== 'object') return value
      return expandEmbeddedJson(parsed, depth + 1)
    } catch {
      return value
    }
  }
  if (Array.isArray(value)) return value.map((item) => expandEmbeddedJson(item, depth + 1))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, expandEmbeddedJson(item, depth + 1)]))
  }
  return value
}

/** Prettify the ugly slash-delimited model strings some sources ship. */
export function prettyModel(model?: string | null): string {
  if (!model) return 'not reported'
  return model
    .replace(/^openrouter\//, '')
    .replace(/^anthropic[_/]/, '')
    .replace(/^openai[_/]/, '')
    .replace(/_/g, '-')
}

export function agentHarness(harness?: string | null): string {
  return harness ?? '—'
}

export const FAMILY_STYLES: Record<string, string> = {
  Anthropic: 'bg-orange-500/15 text-orange-300',
  OpenAI: 'bg-emerald-500/15 text-emerald-300',
  Google: 'bg-sky-500/15 text-sky-300',
  unknown: 'bg-zinc-500/15 text-zinc-400',
}

export const STATUS_STYLES: Record<string, string> = {
  passed: 'bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-500/30',
  failed: 'bg-rose-500/15 text-rose-300 ring-1 ring-rose-500/30',
  partial: 'bg-amber-500/15 text-amber-300 ring-1 ring-amber-500/30',
  completed: 'bg-sky-500/15 text-sky-300 ring-1 ring-sky-500/30',
  running: 'bg-cyan-500/15 text-cyan-300 ring-1 ring-cyan-500/30',
  succeeded: 'bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-500/30',
  interrupted: 'bg-amber-500/15 text-amber-300 ring-1 ring-amber-500/30',
  error: 'bg-zinc-500/15 text-zinc-300 ring-1 ring-zinc-500/30',
}

export const SEVERITY_STYLES: Record<string, string> = {
  critical: 'bg-rose-500/15 text-rose-300 ring-1 ring-rose-500/30',
  major: 'bg-amber-500/15 text-amber-300 ring-1 ring-amber-500/30',
  minor: 'bg-sky-500/15 text-sky-300 ring-1 ring-sky-500/30',
}

export const ROLE_STYLES: Record<string, string> = {
  user: 'bg-sky-500/15 text-sky-300',
  agent: 'bg-violet-500/15 text-violet-300',
  assistant: 'bg-violet-500/15 text-violet-300',
  system: 'bg-zinc-500/15 text-zinc-400',
  tool: 'bg-emerald-500/15 text-emerald-300',
}
