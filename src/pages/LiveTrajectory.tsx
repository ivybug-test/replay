import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { Loading } from '../components/ui'
import { fetchViewerBundle, type ViewerBundle } from '../lib/ossReplay'
import TrajectoryViewer from './TrajectoryViewer'

export default function LiveTrajectory() {
  const { batchId = '', taskKey = '' } = useParams()
  const [bundle, setBundle] = useState<ViewerBundle | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    setBundle(null)
    setError(null)
    fetchViewerBundle(batchId, taskKey, controller.signal)
      .then(setBundle)
      .catch((reason) => { if (!controller.signal.aborted) setError(String(reason)) })
    return () => controller.abort()
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
      backTo={`/live/runs/${encodeURIComponent(batchId)}`}
    />
  )
}
