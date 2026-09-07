import { useCallback, useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { Loading } from '../components/ui'
import { fetchExecutionState, fetchViewerBundle, type ViewerBundle } from '../lib/ossReplay'
import TrajectoryViewer from './TrajectoryViewer'

const TERMINAL_TASK_STATUSES = new Set(['succeeded', 'failed', 'interrupted', 'completed', 'error'])

export default function LiveTrajectory() {
  const { batchId = '', taskKey = '' } = useParams()
  const [bundle, setBundle] = useState<ViewerBundle | null>(null)
  const [error, setError] = useState<string | null>(null)
  const loadExecutionState = useCallback(
    (signal?: AbortSignal) => fetchExecutionState(batchId, taskKey, signal),
    [batchId, taskKey],
  )

  useEffect(() => {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    let hasBundle = false
    let consecutiveFailures = 0
    setBundle(null)
    setError(null)
    const refresh = async () => {
      try {
        const next = await fetchViewerBundle(batchId, taskKey, controller.signal)
        if (controller.signal.aborted) return
        hasBundle = true
        consecutiveFailures = 0
        setBundle(next)
        setError(null)
        const status = String(next.task.metadata?.execution_status ?? '')
        if (next.hasMore || !TERMINAL_TASK_STATUSES.has(status)) timer = setTimeout(refresh, next.hasMore ? 100 : 2_000)
      } catch (reason) {
        if (controller.signal.aborted) return
        if (!hasBundle) setError(String(reason))
        consecutiveFailures += 1
        const retryMs = Math.min(30_000, 2_000 * (2 ** Math.min(consecutiveFailures - 1, 4)))
        timer = setTimeout(refresh, retryMs)
      }
    }
    void refresh()
    return () => {
      controller.abort()
      if (timer) clearTimeout(timer)
    }
  }, [batchId, taskKey])

  if (error) return <div className="p-8 text-rose-400">Failed to prepare trajectory: {error}</div>
  if (!bundle) return <Loading label="Building the full trajectory view…" />
  return (
    <TrajectoryViewer
      taskOverride={bundle.task}
      runOverride={bundle.run}
      agentOverride={bundle.agent}
      vendorOverride={bundle.vendor}
      desktopTimeline={bundle.desktopTimeline}
      executionState={bundle.executionState}
      loadExecutionState={loadExecutionState}
      backTo={`/live/runs/${encodeURIComponent(batchId)}`}
    />
  )
}
