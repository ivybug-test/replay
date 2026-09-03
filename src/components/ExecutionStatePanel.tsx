import { memo, useEffect, useMemo, useState } from 'react'
import clsx from 'clsx'
import type { ExecutionStateEvent, ExecutionStateFeed, ExecutionStateKind } from '../lib/ossReplay'

type Filter = 'all' | ExecutionStateKind
const PAGE_SIZE = 40

const FILTERS: Array<{ kind: Filter; label: string }> = [
  { kind: 'all', label: 'All' },
  { kind: 'goal', label: 'Goals' },
  { kind: 'attempt', label: 'Attempts' },
  { kind: 'evidence', label: 'Evidence' },
  { kind: 'failure', label: 'Failures' },
  { kind: 'declaration', label: 'Declarations' },
]

const KIND_STYLE: Record<ExecutionStateKind, string> = {
  declaration: 'bg-zinc-500/15 text-zinc-300 ring-zinc-500/30',
  goal: 'bg-sky-500/15 text-sky-300 ring-sky-500/30',
  attempt: 'bg-violet-500/15 text-violet-300 ring-violet-500/30',
  evidence: 'bg-emerald-500/15 text-emerald-300 ring-emerald-500/30',
  failure: 'bg-rose-500/15 text-rose-300 ring-rose-500/30',
}

function kindOf(event: ExecutionStateEvent): ExecutionStateKind {
  return event.event.replace('execution_state_', '') as ExecutionStateKind
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function value(value: unknown, fallback = '—'): string {
  if (value == null || value === '') return fallback
  return typeof value === 'string' ? value : JSON.stringify(value)
}

function list(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => String(item)) : []
}

function clock(ms: number): string {
  const safe = Math.max(0, ms)
  const minutes = Math.floor(safe / 60_000)
  const seconds = Math.floor((safe % 60_000) / 1000)
  const millis = Math.floor(safe % 1000)
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(millis).padStart(3, '0')}`
}

function Badge({ children, tone = 'bg-ink-800 text-zinc-400' }: { children: React.ReactNode; tone?: string }) {
  return <span className={clsx('rounded px-1.5 py-0.5 text-[10px] font-medium', tone)}>{children}</span>
}

function ReferenceList({ label, values }: { label: string; values: string[] }) {
  if (!values.length) return null
  return (
    <div className="flex flex-wrap items-center gap-1 text-[10px]">
      <span className="text-zinc-600">{label}</span>
      {values.map((item) => <code key={item} className="rounded bg-ink-800 px-1.5 py-0.5 text-zinc-400">{item}</code>)}
    </div>
  )
}

function StateBody({ event }: { event: ExecutionStateEvent }) {
  const kind = kindOf(event)
  if (kind === 'declaration') {
    const turn = object(event.source_turn)
    return (
      <>
        <div className="flex flex-wrap gap-1.5">
          <Badge tone={event.status === 'valid' ? 'bg-emerald-500/15 text-emerald-300' : 'bg-amber-500/15 text-amber-300'}>{value(event.status)}</Badge>
          <Badge>{value(event.actor)}</Badge>
        </div>
        {turn.tool_call_id && <ReferenceList label="source" values={[String(turn.tool_call_id)]} />}
      </>
    )
  }

  if (kind === 'goal') {
    const goal = object(event.goal)
    return (
      <>
        <div className="flex flex-wrap gap-1.5">
          <Badge tone="bg-sky-500/15 text-sky-300">{value(event.transition)}</Badge>
          <Badge>{value(goal.status)}</Badge>
          {goal.provisional === true && <Badge tone="bg-amber-500/15 text-amber-300">provisional</Badge>}
        </div>
        <p className="text-sm font-medium leading-relaxed text-zinc-200">{value(goal.statement)}</p>
        <p className="text-xs leading-relaxed text-zinc-400"><span className="text-zinc-600">Done when: </span>{value(goal.done_when)}</p>
        <div className="flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-zinc-500">
          <code>{value(goal.id)}</code><span>{value(goal.owner)}</span>
          {goal.parent_id && <span>parent <code>{String(goal.parent_id)}</code></span>}
        </div>
      </>
    )
  }

  if (kind === 'attempt') {
    const record = object(event.record)
    return (
      <>
        <div className="flex flex-wrap gap-1.5">
          <Badge tone={record.tool_status === 'error' ? 'bg-rose-500/15 text-rose-300' : 'bg-violet-500/15 text-violet-300'}>{value(record.tool)} · {value(record.tool_status)}</Badge>
          <Badge>{value(record.goal_id)}</Badge>
        </div>
        <p className="text-sm leading-relaxed text-zinc-200">{value(record.intent)}</p>
        <p className="text-xs leading-relaxed text-zinc-400"><span className="text-zinc-600">Expected: </span>{value(record.expected_effect)}</p>
        <div className="flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-zinc-500"><code>{value(record.id)}</code><span>{value(record.actor)}</span></div>
      </>
    )
  }

  if (kind === 'evidence') {
    const window = object(event.window)
    return (
      <>
        <div className="flex flex-wrap gap-1.5">
          <Badge tone={window.effect === 'achieved' ? 'bg-emerald-500/15 text-emerald-300' : window.effect === 'not_achieved' ? 'bg-rose-500/15 text-rose-300' : 'bg-amber-500/15 text-amber-300'}>{value(window.effect)}</Badge>
          <Badge>{value(window.progress)}</Badge>
          <Badge>goal {value(window.goal_satisfied)}</Badge>
          <Badge>{value(window.updater_status)} updater</Badge>
        </div>
        {window.observed_change && <p className="text-xs leading-relaxed text-zinc-300">{String(window.observed_change)}</p>}
        <div className="flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-zinc-500"><code>{value(window.id)}</code><code>{value(window.goal_id)}</code><span>{value(window.status)}</span></div>
        <ReferenceList label="attempts" values={list(window.attempt_ids)} />
        <ReferenceList label="basis" values={list(window.basis)} />
        {window.response_excerpt && (
          <pre className="max-h-32 overflow-auto whitespace-pre-wrap rounded bg-ink-950 p-2 text-[10px] leading-relaxed text-zinc-500">{String(window.response_excerpt)}</pre>
        )}
      </>
    )
  }

  const record = object(event.record)
  const route = object(record.failed_route)
  return (
    <>
      <div className="flex flex-wrap gap-1.5">
        <Badge tone="bg-rose-500/15 text-rose-300">{value(event.transition)}</Badge>
        <Badge>{value(record.status)}</Badge>
        <Badge>{value(record.scope)}</Badge>
      </div>
      <p className="text-sm leading-relaxed text-zinc-200">{value(route.intent)}</p>
      <p className="text-xs leading-relaxed text-zinc-400"><span className="text-zinc-600">Expected: </span>{value(route.expected_effect)}</p>
      <div className="text-[10px] text-zinc-500"><code>{value(record.id)}</code> · <code>{value(record.goal_id)}</code></div>
      <ReferenceList label="attempts" values={list(record.attempt_ids)} />
      <ReferenceList label="evidence" values={list(record.evidence_window_ids)} />
    </>
  )
}

function RawEvent({ event }: { event: ExecutionStateEvent }) {
  const [open, setOpen] = useState(false)
  return (
    <details className="mt-2 border-t border-ink-800 pt-2" onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary className="cursor-pointer text-[10px] text-zinc-600 hover:text-zinc-400">Raw event · sequence {event.sequence}</summary>
      {open && (
        <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded bg-ink-950 p-2 text-[9px] leading-relaxed text-zinc-500">{JSON.stringify(event, null, 2)}</pre>
      )}
    </details>
  )
}

const StateEventCard = memo(function StateEventCard({
  event,
  current,
  onJump,
}: {
  event: ExecutionStateEvent
  current: boolean
  onJump: (atMs: number) => void
}) {
  const kind = kindOf(event)
  return (
    <article className={clsx('rounded-lg border bg-ink-900/50 p-3 transition-colors', current ? 'border-amber-400/60 ring-1 ring-amber-400/20' : 'border-ink-700')}>
      <div className="mb-2 flex items-center gap-2">
        <span className={clsx('rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ring-1', KIND_STYLE[kind])}>{kind}</span>
        {current && <span className="text-[9px] uppercase tracking-wide text-amber-300">current</span>}
        <button onClick={() => onJump(event.episode_elapsed_ms)} className="ml-auto font-mono text-[10px] tabular-nums text-sky-300 hover:text-sky-200" title="Move Desktop and Steps to this event">
          {clock(event.episode_elapsed_ms)} ↗
        </button>
      </div>
      <div className="space-y-2"><StateBody event={event} /></div>
      <RawEvent event={event} />
    </article>
  )
})

function ExecutionStatePanel({
  feed,
  playheadMs,
  onJump,
}: {
  feed: ExecutionStateFeed
  playheadMs: number
  onJump: (atMs: number) => void
}) {
  const [filter, setFilter] = useState<Filter>('all')
  const [page, setPage] = useState(0)
  const events = useMemo(
    () => [...feed.events].sort((a, b) => a.episode_elapsed_ms - b.episode_elapsed_ms || a.sequence - b.sequence),
    [feed.events],
  )
  const visible = useMemo(
    () => filter === 'all' ? events : events.filter((event) => kindOf(event) === filter),
    [events, filter],
  )
  const pageCount = Math.max(1, Math.ceil(visible.length / PAGE_SIZE))
  const pagedEvents = useMemo(
    () => visible.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE),
    [page, visible],
  )
  const currentTime = useMemo(() => {
    let low = 0
    let high = events.length - 1
    let match = -1
    while (low <= high) {
      const middle = Math.floor((low + high) / 2)
      if (events[middle].episode_elapsed_ms <= playheadMs) {
        match = events[middle].episode_elapsed_ms
        low = middle + 1
      } else {
        high = middle - 1
      }
    }
    return match
  }, [events, playheadMs])

  useEffect(() => setPage(0), [filter])

  return (
    <div className="space-y-3">
      <div className="rounded-lg border border-ink-700 bg-ink-950 p-3">
        <div className="flex items-center justify-between gap-2">
          <div>
            <h2 className="text-sm font-semibold text-zinc-100">Execution State</h2>
            <p className="mt-0.5 text-[10px] text-zinc-500">{feed.version} · {events.length} events · playhead {clock(playheadMs)}</p>
          </div>
          <Badge tone="bg-emerald-500/15 text-emerald-300">trace-backed</Badge>
        </div>
      </div>

      <div className="flex flex-wrap gap-1">
        {FILTERS.map(({ kind, label }) => {
          const count = kind === 'all' ? events.length : feed.counts[kind] ?? 0
          return (
            <button key={kind} onClick={() => setFilter(kind)} className={clsx('rounded px-2 py-1 text-[10px] ring-1 transition-colors', filter === kind ? kind === 'all' ? 'bg-accent text-white ring-accent' : KIND_STYLE[kind] : 'bg-ink-800 text-zinc-500 ring-ink-700 hover:text-zinc-300')}>
              {label} {count}
            </button>
          )
        })}
      </div>

      <div className="space-y-2">
        {pagedEvents.map((event) => (
          <StateEventCard
            key={`${event.sequence}:${event.event}`}
            event={event}
            current={event.episode_elapsed_ms === currentTime}
            onJump={onJump}
          />
        ))}
      </div>

      {pageCount > 1 && (
        <div className="sticky bottom-0 flex items-center justify-between rounded-lg border border-ink-700 bg-ink-950/95 p-2 text-[10px] text-zinc-500 backdrop-blur">
          <button className="btn-ghost px-2 py-1 disabled:opacity-30" disabled={page === 0} onClick={() => setPage((value) => Math.max(0, value - 1))}>← Previous</button>
          <span>Page {page + 1} / {pageCount} · {visible.length} events</span>
          <button className="btn-ghost px-2 py-1 disabled:opacity-30" disabled={page >= pageCount - 1} onClick={() => setPage((value) => Math.min(pageCount - 1, value + 1))}>Next →</button>
        </div>
      )}
    </div>
  )
}

export default memo(ExecutionStatePanel)
