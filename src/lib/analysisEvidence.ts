export interface AnalysisEvidence {
  turn_id: string
  timestamp_ms: number
  excerpt?: string
}

export interface AnalysisTurnRef {
  turn_id: string
  global_turn: number
}

/** One jump target per Turn, ordered in the same direction as the replay. */
export function uniqueSortedTurnEvidence<T extends AnalysisEvidence>(
  evidence: T[],
  turns: AnalysisTurnRef[],
): Array<{ evidence: T; globalTurn?: number }> {
  const turnById = new Map(turns.map((turn) => [turn.turn_id, turn.global_turn]))
  const unique = new Map<string, { evidence: T; globalTurn?: number }>()

  for (const item of evidence) {
    const globalTurn = turnById.get(item.turn_id)
    const key = globalTurn == null ? `id:${item.turn_id}` : `turn:${globalTurn}`
    if (!unique.has(key)) unique.set(key, { evidence: item, globalTurn })
  }

  return [...unique.values()].sort((left, right) => {
    if (left.globalTurn != null && right.globalTurn != null) {
      return left.globalTurn - right.globalTurn
    }
    if (left.globalTurn != null) return -1
    if (right.globalTurn != null) return 1
    return left.evidence.timestamp_ms - right.evidence.timestamp_ms
      || left.evidence.turn_id.localeCompare(right.evidence.turn_id)
  })
}
