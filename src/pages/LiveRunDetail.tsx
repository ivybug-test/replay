import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { PageHeader } from '../components/Layout'
import { Loading, StatusBadge } from '../components/ui'
import { fetchBatch, type BatchDocument } from '../lib/ossReplay'

export default function LiveRunDetail() {
  const { batchId = '' } = useParams()
  const [batch, setBatch] = useState<BatchDocument | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    fetchBatch(batchId, controller.signal)
      .then(setBatch)
      .catch((reason) => { if (!controller.signal.aborted) setError(String(reason)) })
    return () => controller.abort()
  }, [batchId])

  if (error) return <div className="p-8 text-rose-400">Failed to load run: {error}</div>
  if (!batch) return <Loading label="Loading run tasks…" />

  return (
    <>
      <PageHeader
        title={batch.batch_name || batch.batch_id}
        subtitle={`${batch.tasks.length} tasks · ${batch.batch_id}`}
        actions={<Link to="/live" className="btn-ghost">← OSS runs</Link>}
      />
      <div className="p-8">
        <div className="card overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-ink-700 text-left text-xs uppercase tracking-wide text-zinc-500">
                <th className="px-4 py-3 font-medium">Task</th>
                <th className="px-4 py-3 font-medium">Execution</th>
                <th className="px-4 py-3 font-medium">Outcome</th>
                <th className="px-4 py-3 font-medium">Score</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {batch.tasks.map((task) => (
                <tr key={task.key} className="border-b border-ink-800 last:border-0 hover:bg-ink-800/40">
                  <td className="px-4 py-3">
                    <div className="font-medium text-zinc-200">OSWorld {task.task_id}</div>
                    <div className="font-mono text-[11px] text-zinc-600">{task.key}</div>
                  </td>
                  <td className="px-4 py-3"><StatusBadge status={task.status} /></td>
                  <td className="px-4 py-3 text-zinc-400">{task.agent_outcome ?? '—'}</td>
                  <td className="px-4 py-3 tabular-nums text-zinc-300">{task.score == null ? '—' : task.score.toFixed(2)}</td>
                  <td className="px-4 py-3 text-right">
                    <Link
                      className="btn-ghost"
                      to={`/live/runs/${encodeURIComponent(batch.batch_id)}/tasks/${encodeURIComponent(task.key)}`}
                    >
                      Replay →
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  )
}
