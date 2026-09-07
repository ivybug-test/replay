import { useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { PageHeader } from '../components/Layout'
import { Loading } from '../components/ui'
import { fmtDuration, fmtPct, fmtScore } from '../lib/format'
import { fetchLeaderboard, type LeaderboardPayload } from '../lib/ossReplay'

function ScoreRange({ score }: { score: { avg: number | null; min: number | null; max: number | null } }) {
  if (score.avg == null) return <span className="text-zinc-600">not evaluated</span>
  return (
    <span className="tabular-nums text-zinc-200">
      {fmtScore(score.avg)} <span className="text-xs text-zinc-600">({fmtScore(score.min)}–{fmtScore(score.max)})</span>
    </span>
  )
}

export default function Overview() {
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [includeSmoke, setIncludeSmoke] = useState(false)
  const [payload, setPayload] = useState<LeaderboardPayload | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [revision, setRevision] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    setPayload(null)
    setError(null)
    fetchLeaderboard({ dateFrom, dateTo, includeSmoke }, controller.signal)
      .then(setPayload)
      .catch((reason) => { if (!controller.signal.aborted) setError(String(reason)) })
    return () => controller.abort()
  }, [dateFrom, dateTo, includeSmoke, revision])

  return (
    <>
      <PageHeader
        title="OSWorld model leaderboard"
        subtitle={payload
          ? `${payload.attempts} indexed attempts · ${payload.rows.length} models`
          : 'Official evaluation results from the OSS execution index'}
        actions={
          <button className="btn-ghost" onClick={() => setRevision((value) => value + 1)}>
            <RefreshCw size={15} /> Refresh
          </button>
        }
      />
      <div className="space-y-5 p-8">
        <section className="card space-y-3 p-4">
          <div className="flex flex-wrap items-end gap-4">
            <label className="text-xs text-zinc-400">From
              <input type="date" aria-label="Leaderboard start date" value={dateFrom} max={dateTo || undefined}
                onChange={(event) => setDateFrom(event.target.value)}
                className="ml-2 rounded border border-ink-700 bg-ink-900 px-2 py-1.5 font-mono text-zinc-200 [color-scheme:dark]" />
            </label>
            <label className="text-xs text-zinc-400">To
              <input type="date" aria-label="Leaderboard end date" value={dateTo} min={dateFrom || undefined}
                onChange={(event) => setDateTo(event.target.value)}
                className="ml-2 rounded border border-ink-700 bg-ink-900 px-2 py-1.5 font-mono text-zinc-200 [color-scheme:dark]" />
            </label>
            <label className="inline-flex cursor-pointer items-center gap-2 text-xs text-zinc-400">
              <input type="checkbox" checked={includeSmoke} onChange={(event) => setIncludeSmoke(event.target.checked)}
                className="accent-accent" /> Include batches named smoke
            </label>
            {(dateFrom || dateTo) && <button className="text-xs text-accent hover:underline" onClick={() => { setDateFrom(''); setDateTo('') }}>Clear dates</button>}
          </div>
          <p className="text-[11px] leading-relaxed text-zinc-600">
            Ranked by unique task coverage first, then task-normalized average score. Repeated runs of the same
            task are averaged first, so every distinct task has equal weight. Smoke batches are excluded by
            default; formal benchmark eligibility metadata is not available yet.
          </p>
        </section>

        {error ? (
          <div className="card border-rose-500/30 p-5 text-sm text-rose-300">Could not load leaderboard: {error}</div>
        ) : !payload ? <Loading label="Loading indexed leaderboard…" /> : payload.rows.length === 0 ? (
          <div className="card p-8 text-center text-sm text-zinc-500">No indexed executions match these filters.</div>
        ) : (
          <section className="card overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-ink-700 text-left text-xs uppercase tracking-wide text-zinc-500">
                  {['#', 'Model', 'Framework(s)', 'Coverage', 'Attempts', 'Completion', 'Pass rate', 'Task score (min–max)', 'Avg duration'].map((label) =>
                    <th key={label} className="px-4 py-3 font-medium">{label}</th>)}
                </tr>
              </thead>
              <tbody>
                {payload.rows.map((row, index) => (
                  <tr key={row.model} className="border-b border-ink-800 last:border-0 hover:bg-ink-800/40">
                    <td className="px-4 py-3 tabular-nums text-zinc-600">{index + 1}</td>
                    <td className="px-4 py-3 font-mono text-zinc-100">{row.model}</td>
                    <td className="px-4 py-3 text-zinc-400">{row.framework}</td>
                    <td className="px-4 py-3 text-xs text-zinc-400">{row.task_count} unique tasks · {row.batch_count} batches</td>
                    <td className="px-4 py-3 tabular-nums text-zinc-300">
                      {row.attempts}
                      <span className="ml-1 text-xs text-zinc-600">
                        ({row.scored} scored · {row.scored_task_count} tasks)
                      </span>
                    </td>
                    <td className="px-4 py-3 tabular-nums text-zinc-300">{fmtPct(row.completion_rate)}</td>
                    <td className="px-4 py-3">
                      {row.pass_rate == null ? <span className="text-zinc-600">—</span> : (
                        <div className="flex items-center gap-2">
                          <div className="h-1.5 w-14 overflow-hidden rounded-full bg-ink-700">
                            <div className="h-full rounded-full bg-accent" style={{ width: `${row.pass_rate * 100}%` }} />
                          </div>
                          <span className="tabular-nums text-zinc-200">{fmtPct(row.pass_rate)}</span>
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3"><ScoreRange score={row.score} /></td>
                    <td className="px-4 py-3 tabular-nums text-zinc-400">{row.duration_ms_avg == null ? '—' : fmtDuration(row.duration_ms_avg / 1000)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}
        {payload && payload.excluded_smoke_attempts > 0 && !includeSmoke && (
          <p className="text-xs text-zinc-600">Excluded {payload.excluded_smoke_attempts} attempts from batches whose name contains “smoke”.</p>
        )}
        {payload && payload.excluded_out_of_suite_attempts > 0 && (
          <p className="text-xs text-zinc-600">Excluded {payload.excluded_out_of_suite_attempts} attempts outside the official OSWorld 2.0 107-task set.</p>
        )}
      </div>
    </>
  )
}
