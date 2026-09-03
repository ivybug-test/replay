import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { RefreshCw } from 'lucide-react'
import { PageHeader } from '../components/Layout'
import { Loading, StatusBadge } from '../components/ui'
import { fetchLiveRuns, type RunSummary } from '../lib/ossReplay'

export default function LiveRuns() {
  const [runs, setRuns] = useState<RunSummary[] | null>(null)
  const [date, setDate] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [reload, setReload] = useState(0)

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
          <button className="btn-ghost" onClick={() => setReload((value) => value + 1)}>
            <RefreshCw size={15} /> Refresh
          </button>
        }
      />
      {error ? (
        <div className="p-8">
          <div className="card border-rose-500/30 p-5 text-sm text-rose-300">
            Could not reach the oss-replay API. Start it on port 18767 or set REPLAY_BACKEND_URL for the Vite proxy.
            <div className="mt-2 font-mono text-xs text-rose-400/80">{error}</div>
          </div>
        </div>
      ) : !runs ? <Loading label="Loading OSS runs…" /> : (
        <div className="grid gap-4 p-8 lg:grid-cols-2 2xl:grid-cols-3">
          {runs.map((run) => (
            <Link
              key={run.batch_id}
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
