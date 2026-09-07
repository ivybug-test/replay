import type { Step } from './types'

/** Resolve the analysis report's 1-based global Agent Turn to a viewer step. */
export function stepIndexForTurn(steps: Step[], turn: number): number | null {
  if (!Number.isInteger(turn) || turn < 1) return null

  const explicit = steps.findIndex((step) => step.turn === turn)
  if (explicit >= 0) return explicit

  let globalTurn = 0
  for (let index = 0; index < steps.length; index++) {
    if (steps[index].role !== 'agent' && steps[index].role !== 'assistant') continue
    globalTurn++
    if (globalTurn === turn) return index
  }
  return null
}
