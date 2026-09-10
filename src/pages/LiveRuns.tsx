import { useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import clsx from 'clsx'
import { Activity, CalendarDays, Check, ChevronDown, ChevronRight, Layers3, ListFilter, RefreshCw, Sparkles } from 'lucide-react'
import { PageHeader } from '../components/Layout'
import { Loading, StatusBadge } from '../components/ui'
import { STATUS_STYLES } from '../lib/format'
import {
  fetchAftRunStatuses, fetchLiveRuns, startRunAnalysis,
  type AftRunStatus, type RunSummary,
} from '../lib/ossReplay'
import { isActiveJob, isStaleReport } from '../lib/analysisJobs'

const TERMINAL_RUNS = new Set(['completed', 'completed_with_failures', 'succeeded', 'failed', 'interrupted', 'cancelled', 'error'])
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

function CountBadge({ status, count }: { status: string; count: number }) {
  return <span className={clsx('chip capitalize', STATUS_STYLES[status] ?? STATUS_STYLES.error)}>
    {status.replaceAll('_', ' ')} <span className="font-semibold tabular-nums">{count}</span>
  </span>
}

function validDate(value: string | null): value is string {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const parsed = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value
}

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
        <span
          id="run-status-options"
          role="listbox"
          aria-label="Run status options"
          className="absolute left-0 top-[calc(100%+0.4rem)] z-50 min-w-44 overflow-hidden rounded-xl border border-ink-700 bg-ink-900/95 p-1.5 shadow-2xl shadow-black/50 backdrop-blur-xl"
        >
          {RUN_STATUS_OPTIONS.map((option) => {
            const active = option.value === value
            return (
              <button
                key={option.value || 'all'}
                type="button"
                role="option"
                aria-selected={active}
                data-status-value={option.value}
                onClick={() => {
                  onChange(option.value)
                  setOpen(false)
                }}
                className={clsx(
                  'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-xs outline-none transition-colors',
                  'focus-visible:bg-ink-700 focus-visible:text-white',
                  active ? 'bg-accent/10 text-white' : 'text-zinc-400 hover:bg-ink-800 hover:text-zinc-100',
                )}
              >
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
  const [latestDate, setLatestDate] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [reload, setReload] = useState(0)
  const [analysis, setAnalysis] = useState<Record<string, AftRunStatus>>({})
  const [analysisError, setAnalysisError] = useState<string | null>(null)
  const [analysisReload, setAnalysisReload] = useState(0)
  const [starting, setStarting] = useState<string | null>(null)
  const dateParam = searchParams.get('date')
  const requestedDate = validDate(dateParam) ? dateParam : null
  const statusParam = searchParams.get('status')
  const selectedStatus = validRunStatus(statusParam) ? statusParam : ''
  const filteredRuns = runs?.filter((run) => !selectedStatus || run.status === selectedStatus) ?? null

  useEffect(() => {
    setRuns(null)
  }, [requestedDate])

  useEffect(() => {
    const controller = new AbortController()
    setError(null)
    void fetchLiveRuns(requestedDate, controller.signal).then((payload) => {
        setRuns(payload.runs)
        setDate(payload.date)
        setLatestDate(payload.latest_date)
      })
      .catch((reason) => { if (!controller.signal.aborted) setError(String(reason)) })
    return () => controller.abort()
  }, [reload, requestedDate])

  useEffect(() => {
    const controller = new AbortController()
    setAnalysisError(null)
    void fetchAftRunStatuses(controller.signal)
      .then((statuses) => setAnalysis(statuses.runs))
      .catch((reason) => { if (!controller.signal.aborted) setAnalysisError(String(reason)) })
    return () => controller.abort()
  }, [analysisReload])

  useEffect(() => {
    if (!Object.values(analysis).some((item) => isActiveJob(item.job))) return
    const timer = setTimeout(() => setAnalysisReload((value) => value + 1), 3000)
    return () => clearTimeout(timer)
  }, [analysis])

  const analyze = async (run: RunSummary, force = false) => {
    setStarting(run.batch_id)
    setError(null)
    try {
      const next = await startRunAnalysis(run.batch_id, analysis[run.batch_id]?.report?.model, undefined, force)
      setAnalysis((current) => ({ ...current, [run.batch_id]: {
        job: next.job, report: next.report,
      } }))
    } catch (reason) {
      setAnalysisError(String(reason))
    } finally {
      setStarting(null)
    }
  }

  const selectDate = (value: string | null) => {
    setSearchParams((current) => {
      const next = new URLSearchParams(current)
      if (value) next.set('date', value)
      else next.delete('date')
      return next
    })
  }

  const selectStatus = (value: string) => {
    setSearchParams((current) => {
      const next = new URLSearchParams(current)
      if (validRunStatus(value)) next.set('status', value)
      else next.delete('status')
      return next
    })
  }

  return (
    <>
      <PageHeader
        title="OSS runs"
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            <label className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-lg border border-ink-700 bg-ink-800/80 px-2.5 transition-colors hover:border-ink-600 hover:bg-ink-800" title="Filter runs by date">
              <CalendarDays size={13} className="text-accent" aria-hidden="true" />
              <input
                type="date"
                aria-label="Filter runs by date"
                value={requestedDate ?? date}
                max={latestDate || undefined}
                onChange={(event) => selectDate(event.target.value || null)}
                className="cursor-pointer bg-transparent font-mono text-xs text-accent outline-none [color-scheme:dark]"
              />
            </label>
            {requestedDate && (
              <button type="button" onClick={() => selectDate(null)} className="text-xs text-zinc-500 hover:text-zinc-200">
                Latest
              </button>
            )}
            <StatusFilter value={selectedStatus} onChange={selectStatus} />
            <span className="text-zinc-500">· live catalog from the standalone Replay backend</span>
          </span>
        }
        actions={
          <button className="btn-ghost" onClick={() => {
            setReload((value) => value + 1)
            setAnalysisReload((value) => value + 1)
          }}>
            <RefreshCw size={15} /> Refresh
          </button>
        }
      />
      {error ? (
        <div className="p-8">
          <div className="card border-rose-500/30 p-5 text-sm text-rose-300">
            Could not reach the Replay API on port 18769. Check the backend service or set REPLAY_BACKEND_URL for the Vite proxy.
            <div className="mt-2 font-mono text-xs text-rose-400/80">{error}</div>
          </div>
        </div>
      ) : !runs ? <Loading label="Loading OSS runs…" /> : runs.length === 0 ? (
        <div className="p-8">
          <div className="card px-5 py-10 text-center text-sm text-zinc-500">No OSS runs found for {date}.</div>
        </div>
      ) : filteredRuns?.length === 0 ? (
        <div className="p-8">
          <div className="card px-5 py-10 text-center text-sm text-zinc-500">No {selectedStatus} OSS runs found for {date}.</div>
        </div>
      ) : (
        <div className="p-8">
          {analysisError && (
            <div role="alert" className="card mb-4 border-amber-500/30 px-4 py-3 text-xs text-amber-300">
              AFT status is temporarily unavailable. Run cards remain usable.
            </div>
          )}
          <div className="grid gap-4 lg:grid-cols-2 2xl:grid-cols-3">
          {filteredRuns?.map((run) => {
            const aft = analysis[run.batch_id]
            const active = isActiveJob(aft?.job)
            const reportStale = isStaleReport(aft?.report)
            const taskProgress = aft?.job?.progress?.task_reports
            const runHref = `/live/runs/${encodeURIComponent(run.batch_id)}`
            return <div key={run.batch_id} data-testid="live-run-card" data-run-status={run.status} className="card group p-5 transition-colors hover:border-accent/40 hover:bg-ink-800/55">
              <div className="flex items-start justify-between gap-4">
                <Link to={runHref} className="min-w-0 flex-1 rounded outline-none focus-visible:ring-2 focus-visible:ring-accent/60">
                  <h2 className="truncate font-medium text-white transition-colors group-hover:text-accent">{run.batch_name || run.batch_id}</h2>
                  <div className="mt-1 truncate font-mono text-[11px] text-zinc-600">{run.batch_id}</div>
                </Link>
                <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
                  <StatusBadge status={run.status} />
                  {TERMINAL_RUNS.has(run.status) && <>
                    {aft?.report && <Link className="chip bg-accent/10 py-1 text-accent ring-1 ring-accent/25 transition-colors hover:bg-accent/20"
                      title={aft.job?.status === 'completed_partial'
                        ? `${taskProgress?.completed ?? 0}/${taskProgress?.total ?? run.task_count} tasks analyzed`
                        : undefined}
                      to={`/aft-reports/${encodeURIComponent(aft.report.report_id)}`}>
                      <Sparkles size={11} />
                      {aft.job?.status === 'completed_partial' ? 'View partial AFT' : 'View AFT'}
                    </Link>}
                    {reportStale && !active && <span className="chip bg-amber-500/10 py-1 text-amber-300 ring-1 ring-amber-500/25"
                      title="Report is stale: model, pipeline, taxonomy or evaluator context changed">
                      过期
                    </span>}
                    {active ? (
                    <span className="chip bg-cyan-500/10 py-1 text-cyan-300 ring-1 ring-cyan-500/25"
                      title={aft.job?.progress?.evidence_requests ? `${aft.job.progress.evidence_requests} evidence tool calls` : undefined}>
                      <Activity size={11} className="animate-pulse" />
                      Analyzing {taskProgress?.completed ?? 0}/{taskProgress?.total ?? run.task_count}
                    </span>
                  ) : (
                    <button type="button"
                      className="chip bg-accent/10 py-1 text-accent ring-1 ring-accent/25 transition-colors hover:bg-accent/20 disabled:cursor-wait disabled:opacity-60"
                      title={reportStale ? 'The stored report is stale, so this run will be analysed again' : undefined}
                      disabled={starting === run.batch_id} onClick={() => void analyze(run, reportStale)}>
                      {aft?.report ? <RefreshCw size={11} /> : <Sparkles size={11} />}
                      {starting === run.batch_id ? 'Starting…' : aft?.report ? 'Regenerate' : 'Analyze AFT'}
                    </button>
                  )}</>}
                </div>
              </div>
              <Link to={runHref}
                className="mt-4 flex min-h-10 items-center gap-3 border-t border-line pt-3 text-xs text-zinc-500 outline-none transition-colors hover:text-zinc-300 focus-visible:text-zinc-200">
                <span className="flex shrink-0 items-center gap-1.5">
                  <Layers3 size={13} className="text-zinc-600" />
                  <span className="tabular-nums">{run.task_count}</span> task{run.task_count === 1 ? '' : 's'}
                </span>
                <span className="flex min-w-0 flex-1 flex-wrap justify-end gap-1.5">
                  {Object.entries(run.counts ?? {}).map(([status, count]) => (
                    <CountBadge key={status} status={status} count={count} />
                  ))}
                </span>
                <ChevronRight size={14} className="shrink-0 text-zinc-700 transition-transform group-hover:translate-x-0.5 group-hover:text-accent" />
              </Link>
            </div>
          })}
          </div>
        </div>
      )}
    </>
  )
}
