import { useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import clsx from 'clsx'
import { Check, ChevronDown, ListFilter, RefreshCw } from 'lucide-react'
import { PageHeader } from '../components/Layout'
import { Loading, StatusBadge } from '../components/ui'
import { fetchLiveRuns, type RunSummary } from '../lib/ossReplay'

const RUN_STATUSES = ['running', 'interrupted', 'completed'] as const
type RunStatusFilter = typeof RUN_STATUSES[number]
const RUN_STATUS_OPTIONS: ReadonlyArray<{
  value: RunStatusFilter | ''
  label: string
  dot: string
}> = [
  { value: '', label: 'All statuses', dot: 'bg-zinc-500' },
  { value: 'running', label: 'Running', dot: 'bg-cyan-400 shadow-[0_0_7px_rgba(34,211,238,0.65)]' },
  { value: 'interrupted', label: 'Interrupted', dot: 'bg-amber-400' },
  { value: 'completed', label: 'Completed', dot: 'bg-sky-400' },
]

function validRunStatus(value: string | null): value is RunStatusFilter {
  return RUN_STATUSES.some((status) => status === value)
}

function StatusFilter({ value, onChange }: {
  value: RunStatusFilter | ''
  onChange: (value: string) => void
}) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLSpanElement>(null)
  const selected = RUN_STATUS_OPTIONS.find((option) => option.value === value) ?? RUN_STATUS_OPTIONS[0]

  useEffect(() => {
    if (!open) return
    const closeOnOutsideClick = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false)
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', closeOnOutsideClick)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('mousedown', closeOnOutsideClick)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [open])

  return (
    <span ref={root} className="relative inline-flex">
      <button
        type="button"
        aria-label="Filter runs by status"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls="run-status-options"
        onClick={() => setOpen((current) => !current)}
        className={clsx(
          'inline-flex h-8 min-w-36 items-center gap-2 rounded-lg border px-2.5 text-xs font-medium outline-none transition-all',
          'focus-visible:ring-2 focus-visible:ring-accent/50',
          open
            ? 'border-accent/60 bg-accent/10 text-white shadow-[0_0_0_1px_rgba(124,92,255,0.08)]'
            : 'border-ink-700 bg-ink-800/80 text-zinc-300 hover:border-ink-600 hover:bg-ink-800 hover:text-white',
        )}
      >
        <ListFilter size={13} className={open ? 'text-accent' : 'text-zinc-500'} aria-hidden="true" />
        <span className={clsx('h-1.5 w-1.5 shrink-0 rounded-full', selected.dot)} aria-hidden="true" />
        <span className="flex-1 text-left">{selected.label}</span>
        <ChevronDown size={13} className={clsx('text-zinc-500 transition-transform duration-150', open && 'rotate-180 text-accent')} aria-hidden="true" />
      </button>
      {open && (
        <span id="run-status-options" role="listbox" aria-label="Run status options"
          className="absolute left-0 top-[calc(100%+0.4rem)] z-50 min-w-44 overflow-hidden rounded-xl border border-ink-700 bg-ink-900/95 p-1.5 shadow-2xl shadow-black/50 backdrop-blur-xl">
          {RUN_STATUS_OPTIONS.map((option) => {
            const active = option.value === value
            return (
              <button key={option.value || 'all'} type="button" role="option" aria-selected={active}
                data-status-value={option.value} onClick={() => { onChange(option.value); setOpen(false) }}
                className={clsx(
                  'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-xs outline-none transition-colors',
                  'focus-visible:bg-ink-700 focus-visible:text-white',
                  active ? 'bg-accent/10 text-white' : 'text-zinc-400 hover:bg-ink-800 hover:text-zinc-100',
                )}>
                <span className={clsx('h-2 w-2 shrink-0 rounded-full', option.dot)} aria-hidden="true" />
                <span className="flex-1">{option.label}</span>
                {active && <Check size={13} className="text-accent" aria-hidden="true" />}
              </button>
            )
          })}
        </span>
      )}
    </span>
  )
}

export default function LiveRuns() {
  const [searchParams, setSearchParams] = useSearchParams()
  const [runs, setRuns] = useState<RunSummary[] | null>(null)
  const [date, setDate] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [reload, setReload] = useState(0)
  const statusParam = searchParams.get('status')
  const selectedStatus = validRunStatus(statusParam) ? statusParam : ''
  const filteredRuns = runs?.filter((run) => !selectedStatus || run.status === selectedStatus) ?? null

  const selectStatus = (value: string) => {
    setSearchParams((current) => {
      const next = new URLSearchParams(current)
      if (validRunStatus(value)) next.set('status', value)
      else next.delete('status')
      return next
    })
  }

  useEffect(() => {
    const controller = new AbortController()
    setError(null)
    fetchLiveRuns(null, controller.signal)
      .then((payload) => { setRuns(payload.runs); setDate(payload.date) })
      .catch((reason) => { if (!controller.signal.aborted) setError(String(reason)) })
    return () => controller.abort()
  }, [reload])

  return (
    <>
      <PageHeader
        title="OSS runs"
        subtitle={date ? `${date} · live catalog from the existing replay backend` : 'Live catalog from the existing replay backend'}
        actions={
          <>
            <StatusFilter value={selectedStatus} onChange={selectStatus} />
            <button className="btn-ghost" onClick={() => setReload((value) => value + 1)}>
              <RefreshCw size={15} /> Refresh
            </button>
          </>
        }
      />
      {error ? (
        <div className="p-8">
          <div className="card border-rose-500/30 p-5 text-sm text-rose-300">
            Could not reach the oss-replay API. Start it on port 18767 or set REPLAY_BACKEND_URL for the Vite proxy.
            <div className="mt-2 font-mono text-xs text-rose-400/80">{error}</div>
          </div>
        </div>
      ) : !runs ? <Loading label="Loading OSS runs…" /> : filteredRuns?.length === 0 ? (
        <div className="p-8">
          <div className="card px-5 py-10 text-center text-sm text-zinc-500">No {selectedStatus} OSS runs found for {date}.</div>
        </div>
      ) : (
        <div className="grid gap-4 p-8 lg:grid-cols-2 2xl:grid-cols-3">
          {filteredRuns?.map((run) => (
            <Link
              key={run.batch_id}
              data-testid="live-run-card"
              data-run-status={run.status}
              to={`/live/runs/${encodeURIComponent(run.batch_id)}`}
              className="card group p-5 transition-colors hover:border-accent/50 hover:bg-ink-800/70"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h2 className="truncate font-medium text-white">{run.batch_name || run.batch_id}</h2>
                  <div className="mt-1 truncate font-mono text-[11px] text-zinc-600">{run.batch_id}</div>
                </div>
                <StatusBadge status={run.status} />
              </div>
              <div className="mt-5 flex items-end justify-between border-t border-ink-700 pt-3 text-xs text-zinc-500">
                <div>{run.task_count} task{run.task_count === 1 ? '' : 's'}</div>
                <div className="flex flex-wrap justify-end gap-2">
                  {Object.entries(run.counts ?? {}).map(([status, count]) => <span key={status}>{status} {count}</span>)}
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}
    </>
  )
}
