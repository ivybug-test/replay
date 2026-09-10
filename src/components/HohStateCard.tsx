import type { HohClaim, HohState } from '../lib/hohState'

function TextList({ items }: { items?: string[] }) {
  return items?.length ? <ul className="mt-1 space-y-1 pl-4 list-disc text-xs text-zinc-300">
    {items.map((item, index) => <li key={index} className="whitespace-pre-wrap break-words">{item}</li>)}
  </ul> : <p className="mt-1 text-xs text-zinc-500">None</p>
}

function Evidence({ items, title = 'Evidence' }: { items?: HohClaim['evidence']; title?: string }) {
  return !!items?.length && <details className="mt-2 text-xs text-zinc-400">
    <summary className="cursor-pointer">{title} · {items.length}</summary>
    {items.map((evidence, index) => <div key={index} className="mt-2 border-l border-ink-600 pl-2">
      <p className="break-all font-mono text-[10px] text-sky-300">{evidence.ref}</p>
      <p className="mt-1 whitespace-pre-wrap break-words">{evidence.observation}</p>
    </div>)}
  </details>
}

function Claims({ title, claims, tone, pending = false }: { title: string; claims?: HohClaim[]; tone: string; pending?: boolean }) {
  return <section aria-label={title} className="space-y-2">
    <h4 className={`text-xs font-semibold ${tone}`}>{title} · {claims?.length ?? '—'}</h4>
    {pending && <p className="text-xs text-zinc-500">Unverified claims awaiting Verifier review.</p>}
    {claims === undefined ? <p className="text-xs text-zinc-500">Not recorded yet.</p>
      : !claims.length ? <p className="text-xs text-zinc-500">No {title.toLowerCase()} recorded.</p>
        : claims.map(claim => <article key={claim.id} className="rounded-lg border border-ink-700 bg-ink-950/40 p-2.5">
          <div className="flex flex-wrap gap-2 text-[10px] font-mono text-zinc-400">
            <span>{claim.id}</span>
            <span>{claim.kind === 'basis' ? 'Execution basis' : 'Delivery requirement'}</span>
            {pending && <span className="text-amber-300">Unverified</span>}
            {claim.artifact_ids?.map(id => <span key={id} className="rounded bg-sky-400/10 px-1.5 text-sky-300">{id}</span>)}
          </div>
          <p className="mt-1 whitespace-pre-wrap break-words text-xs text-zinc-200">{claim.claim}</p>
          {claim.reason && <p className="mt-1 whitespace-pre-wrap break-words text-xs text-zinc-400">{claim.reason}</p>}
          {claim.kind === 'basis' && <div className="mt-2 text-xs text-zinc-400">
            <p>Execution knowledge; confirmation does not establish delivery completion.</p>
            {claim.source_files?.length ? <div className="mt-1">Source files
              {claim.source_files.map(path => <p key={path} className="mt-1 break-all font-mono text-[10px]">{path}</p>)}
            </div> : <p className="mt-1">Dynamic source · confirmation expires after the next Executor round.</p>}
          </div>}
          <Evidence items={claim.evidence} />
        </article>)}
  </section>
}

const reasons: Record<string, string> = {
  file_changed: 'File changed', file_unavailable: 'File unavailable',
  no_baseline: 'No verification baseline', round_expired: 'Expired after Executor round',
}

export default function HohStateCard({ state, atMs, onJump }: {
  state: HohState; atMs: number; onJump: (ms: number) => void
}) {
  const clock = `${String(Math.floor(atMs / 60000)).padStart(2, '0')}:${String(Math.floor(atMs % 60000 / 1000)).padStart(2, '0')}`
  return <div data-hoh-state className="space-y-4 rounded-xl border border-sky-400/40 bg-ink-900/50 p-3">
    <div className="flex items-start justify-between gap-2">
      <div><h3 className="text-sm font-semibold text-zinc-100">Harness · HoH · Loop {state.loop}</h3>
        <p className="mt-1 text-[11px] text-zinc-500">{state.stage.replace('hoh_', '')}
          {state.revision != null && ` · State revision ${state.revision}`}</p></div>
      <button className="shrink-0 font-mono text-[10px] text-sky-300" onClick={() => onJump(atMs)} title="Jump to this Harness state update">{clock} ↗</button>
    </div>
    {state.done && <p className="rounded-lg bg-sky-400/10 p-2 text-xs text-sky-300">Planner declared the task complete.</p>}
    <details open className="rounded-lg border border-ink-700 p-2.5">
      <summary className="cursor-pointer text-xs font-semibold text-zinc-200">Artifacts · {state.artifacts?.length ?? '—'}</summary>
      {state.artifacts === undefined && <p className="mt-2 text-xs text-zinc-500">Artifacts not recorded by this run.</p>}
      {state.artifacts?.map(artifact => <div key={artifact.id} className="mt-3">
        <p className="text-xs text-zinc-200"><span className="mr-2 font-mono text-sky-300">{artifact.id}</span>{artifact.description}</p>
        {artifact.file_path && <p className="mt-1 break-all font-mono text-[10px] text-zinc-400">{artifact.file_path}</p>}
        <TextList items={artifact.requirements} />
      </div>)}
    </details>
    <section aria-label="Task items" className="space-y-2">
      <h4 className="text-xs font-semibold text-sky-300">Task items · {state.task_items?.length ?? '—'}</h4>
      {state.task_items === undefined && <p className="text-xs text-zinc-500">Plan not recorded yet.</p>}
      {state.task_items?.map((item, index) => <article key={index} className="rounded-lg border border-ink-700 bg-ink-950/40 p-2.5">
        <p className="whitespace-pre-wrap break-words text-xs text-zinc-200"><span className="text-zinc-500">{index + 1}. Target · </span>{typeof item.target === 'string' ? item.target : item.target.description}</p>
        {typeof item.target !== 'string' && <div aria-label="Target artifacts" className="mt-1 flex flex-wrap gap-2 text-[10px] font-mono">
          {item.target.artifact_ids.map(id => <span key={id} className="rounded bg-sky-400/10 px-1.5 text-sky-300">{id}</span>)}
        </div>}
        <p className="mt-2 text-[10px] uppercase text-zinc-500">Preserve</p><TextList items={item.preserve} />
        <p className="mt-2 text-[10px] uppercase text-zinc-500">Gate</p><TextList items={item.gate} />
      </article>)}
    </section>
    {state.claims !== undefined && <Claims title="Candidate claims" claims={state.claims} tone="text-sky-300" pending />}
    <Claims title="Verified" claims={state.verified} tone="text-emerald-300" />
    <Claims title="Gaps" claims={state.gaps} tone="text-amber-300" />
    {!!(state.artifact_changes.length || state.invalidated_verified.length) && <details className="text-xs text-zinc-400" open={!!state.invalidated_verified.length}>
      <summary className="cursor-pointer">Evidence freshness · {state.invalidated_verified.length} verified removed</summary>
      {!!state.invalidated_verified.length && <p className="mt-2 break-all font-mono text-amber-300">Removed: {state.invalidated_verified.join(', ')}</p>}
      {state.artifact_changes.map(change => <p className="mt-1" key={change.artifact_id}>{change.artifact_id} · {reasons[change.reason] ?? change.reason}</p>)}
    </details>}
  </div>
}
