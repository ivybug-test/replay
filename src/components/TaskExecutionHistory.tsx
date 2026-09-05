import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { fetchTaskRuns, type TaskRunPage, type ExecutionSummary } from '../lib/ossReplay'
import { fmtDuration } from '../lib/format'

/** OSS execution summaries are queried independently of the frontend task catalog. */
export default function TaskExecutionHistory({ taskId }: { taskId: string }) {
  const [filters, setFilters] = useState({ model: '', status: '', cursor: '' })
  const [modelInput, setModelInput] = useState('')
  const [page, setPage] = useState<TaskRunPage | null>(null)
  const [runs, setRuns] = useState<ExecutionSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [revision, setRevision] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    setLoading(true)
    setError(null)
    void fetchTaskRuns(taskId, filters, controller.signal).then((next) => {
      if (controller.signal.aborted) return
      setPage(next)
      setRuns((prior) => {
        if (!filters.cursor) return next.runs
        const unique = new Map(prior.map((run) => [`${run.batch_id}/${run.task_key}`, run]))
        for (const run of next.runs) unique.set(`${run.batch_id}/${run.task_key}`, run)
        return [...unique.values()]
      })
      if (!filters.cursor) timer = setTimeout(() => setRevision((value) => value + 1), 15000)
    }).catch((reason) => {
      if (controller.signal.aborted) return
      setError(String(reason))
      if (!filters.cursor) timer = setTimeout(() => setRevision((value) => value + 1), 15000)
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false)
    })
    return () => { controller.abort(); clearTimeout(timer) }
  }, [taskId, filters, revision])

  const changeFilters = (next: { model: string; status: string }) => {
    setRuns([])
    setPage(null)
    setFilters({ ...next, cursor: '' })
  }
  const syncStatus = page?.sync.status
  const syncMessage = syncStatus === 'pending' || syncStatus === 'syncing'
    ? 'Updating execution history. More runs may appear shortly.'
    : syncStatus === 'stale' || syncStatus === 'failed'
      ? 'Showing saved history. The latest update is incomplete.' : null

  return (
    <section data-tour="task-runs" data-testid="oss-task-runs">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500">Agent runs ({runs.length}{page?.next_cursor ? '+' : ''})</h2>
        <button className="btn-ghost" disabled={loading} onClick={() => {
          setFilters((prior) => ({ ...prior, cursor: '' }))
        }}>Refresh</button>
      </div>
      <form className="mb-3 flex flex-wrap items-end gap-3" onSubmit={(event) => {
        event.preventDefault()
        changeFilters({ model: modelInput.trim(), status: filters.status })
      }}>
        <label className="text-xs text-zinc-400">Model
          <input aria-label="Execution model" value={modelInput} onChange={(event) => setModelInput(event.target.value)}
            placeholder="Exact model name" className="ml-2 rounded border border-ink-700 bg-ink-900 px-3 py-2 text-sm text-zinc-200" />
        </label>
        <label className="text-xs text-zinc-400">Status
          <select aria-label="Execution status" value={filters.status} onChange={(event) => {
            changeFilters({ model: filters.model, status: event.target.value })
          }} className="ml-2 rounded border border-ink-700 bg-ink-900 px-3 py-2 text-sm text-zinc-200">
            <option value="">All statuses</option>
            {['pending', 'running', 'succeeded', 'failed', 'interrupted', 'cancelled', 'completed', 'error'].map((status) =>
              <option key={status} value={status}>{status}</option>)}
          </select>
        </label>
        <button className="btn-ghost" type="submit">Apply</button>
      </form>
      {syncMessage && <p className="mb-3 text-sm text-amber-300" role="status">{syncMessage}</p>}
      {error && <p className="mb-3 text-sm text-rose-400" role="alert">Could not load execution history: {error}</p>}
      {loading && <p className="mb-3 text-sm text-zinc-400" role="status">Loading execution history…</p>}
      {!loading && !error && !runs.length && syncStatus === 'ready' && <p className="card p-6 text-sm text-zinc-500">No executions match these filters.</p>}
      {!!runs.length && <div className="card overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-ink-700 text-xs uppercase text-zinc-500"><tr>
            {['Batch / execution', 'Model', 'Framework', 'Execution', 'Evaluation', 'Score', 'Duration', ''].map((label) =>
              <th key={label} className="px-4 py-3">{label}</th>)}
          </tr></thead>
          <tbody>{runs.map((run) => <tr key={`${run.batch_id}/${run.task_key}`} className="border-b border-ink-800 last:border-0 hover:bg-ink-800/40">
            <td className="px-4 py-3"><div className="max-w-sm truncate text-zinc-200" title={run.batch_id}>{run.batch_name || run.batch_id}</div>
              <div className="mt-1 text-xs text-zinc-500">{run.task_key} · {run.started_at ? new Date(run.started_at).toLocaleString() : 'Start time not reported'}</div></td>
            <td className="px-4 py-3 text-zinc-300">{run.model || 'Not reported'}</td>
            <td className="px-4 py-3 text-zinc-400">{run.framework || '—'}</td>
            <td className="px-4 py-3 text-zinc-300">{run.status}</td>
            <td className="px-4 py-3 text-zinc-400">{run.evaluation_status || '—'}</td>
            <td className="px-4 py-3 tabular-nums text-zinc-300">{run.score ?? '—'}</td>
            <td className="px-4 py-3 tabular-nums text-zinc-300">{run.duration_ms == null ? '—' : fmtDuration(run.duration_ms / 1000)}</td>
            <td className="px-4 py-3"><Link className="btn-ghost whitespace-nowrap" to={`/live/runs/${encodeURIComponent(run.batch_id)}/tasks/${encodeURIComponent(run.task_key)}`}>View trajectory →</Link></td>
          </tr>)}</tbody>
        </table>
      </div>}
      {page?.next_cursor && <button className="btn-ghost mt-3" disabled={loading} onClick={() => {
        setFilters((prior) => ({ ...prior, cursor: page.next_cursor! }))
      }}>Load more</button>}
    </section>
  )
}
