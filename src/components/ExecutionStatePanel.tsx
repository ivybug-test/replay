import { memo, useMemo, useState } from 'react'
import clsx from 'clsx'
import type { ExecutionStateFeed } from '../lib/ossReplay'

const PAGE_SIZE = 40
function clock(ms: number): string {
  const safe = Math.max(0, ms)
  return `${String(Math.floor(safe / 60_000)).padStart(2, '0')}:${String(Math.floor(safe % 60_000 / 1000)).padStart(2, '0')}`
}

function ExecutionStatePanel({ feed, playheadMs, onJump }: {
  feed: ExecutionStateFeed
  playheadMs: number
  onJump: (atMs: number) => void
}) {
  const [page, setPage] = useState(0)
  const events = useMemo(() => feed.events.filter(event => event.event === 'observer_interval')
    .sort((a, b) => Number(a.record?.interval_id) - Number(b.record?.interval_id)), [feed.events])
  const pageCount = Math.max(1, Math.ceil(events.length / PAGE_SIZE))
  const activePage = Math.min(page, pageCount - 1)
  const past = events.filter(event => event.episode_elapsed_ms <= playheadMs)
  const current = past[past.length - 1]
  return (
    <section className="space-y-3" aria-label="Execution State">
      <div>
        <h2 className="text-sm font-semibold text-zinc-100">Execution State</h2>
        <p className="mt-1 text-xs text-zinc-500">Observer · {events.length} intervals</p>
      </div>
      {!events.length && <p className="text-sm text-zinc-500">{feed.terminal ? 'No Observer descriptions recorded.' : 'Waiting for Observer descriptions…'}</p>}
      {events.slice(activePage * PAGE_SIZE, (activePage + 1) * PAGE_SIZE).map(event => {
        const record = event.record ?? {}
        const failed = record.status === 'failed'
        return (
          <article key={event.sequence} className={clsx('rounded-lg border bg-ink-900/50 p-3', current === event ? 'border-amber-400/60' : 'border-ink-700')}>
            <div className="mb-2 flex items-center gap-2 text-[10px] text-zinc-500">
              <span className="font-semibold text-sky-300">Observer</span>
              <span>Interval {String(record.interval_id)} · {String(record.model_turns ?? 0)} turns</span>
              <button onClick={() => onJump(event.episode_elapsed_ms)} className="ml-auto font-mono text-sky-300 hover:text-sky-200" title="Move Desktop and Steps to this event">{clock(event.episode_elapsed_ms)} ↗</button>
            </div>
            <p className={clsx('whitespace-pre-wrap text-sm leading-relaxed', failed ? 'text-amber-300' : 'text-zinc-200')}>
              {failed ? `Observer unavailable: ${String(record.error ?? 'No description returned')}` : String(record.description ?? '')}
            </p>
          </article>
        )
      })}
      {pageCount > 1 && <div className="flex items-center justify-between text-xs text-zinc-500">
        <button disabled={activePage === 0} onClick={() => setPage(activePage - 1)} className="btn-ghost disabled:opacity-30">← Previous</button>
        <span>{activePage + 1} / {pageCount}</span>
        <button disabled={activePage === pageCount - 1} onClick={() => setPage(activePage + 1)} className="btn-ghost disabled:opacity-30">Next →</button>
      </div>}
    </section>
  )
}

export default memo(ExecutionStatePanel)
