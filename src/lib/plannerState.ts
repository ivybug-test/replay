export const OSWORLD_PLANNER_STATE_SCHEMA = 'planner-state/v1' as const

export interface PlannerNodeV1 {
  id: string
  agent: 'stateact_coder' | 'stateact_gui' | 'stateact_browser'
  task: string
  max_turns: number
}

export interface CompletedPlannerNodeV1 extends PlannerNodeV1 {
  outcome: 'completed' | 'failed'
}

export interface PlannerStateV1 {
  schema_version: typeof OSWORLD_PLANNER_STATE_SCHEMA
  cause: 'plan_updated' | 'executor_returned' | 'task_returned'
  tool_call_id?: string
  plan: {
    version: number
    completed: CompletedPlannerNodeV1[]
    remaining: PlannerNodeV1[]
    next: PlannerNodeV1 | null
  }
  budget: {
    maxTurns: number | null
    usedTurns: number
    remainingTurns: number | null
  }
  [key: string]: unknown
}

export interface PlannerStateEventV1 {
  event_type: 'planner_state'
  sequence: number
  episode_elapsed_ms: number
  time?: string | null
  actor?: string
  record: PlannerStateV1
}

function object(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0
}

function requireString(record: Record<string, unknown>, field: string, path: string, issues: string[]) {
  if (typeof record[field] !== 'string' || !record[field]) issues.push(`${path}.${field} must be a non-empty string`)
}

function validatePlannerNode(value: unknown, path: string, completed: boolean, issues: string[]) {
  if (!object(value)) {
    issues.push(`${path} must be an object`)
    return
  }
  requireString(value, 'id', path, issues)
  requireString(value, 'task', path, issues)
  if (!['stateact_coder', 'stateact_gui', 'stateact_browser'].includes(String(value.agent))) {
    issues.push(`${path}.agent is not a Planner executor`)
  }
  if (!Number.isInteger(value.max_turns) || Number(value.max_turns) < 5 || Number(value.max_turns) > 30) {
    issues.push(`${path}.max_turns must be an integer from 5 through 30`)
  }
  if (completed && !['completed', 'failed'].includes(String(value.outcome))) {
    issues.push(`${path}.outcome must be completed or failed`)
  }
}

export function validatePlannerState(value: unknown, path: string, issues: string[]): value is PlannerStateV1 {
  if (!object(value)) {
    issues.push(`${path} must be an object`)
    return false
  }
  if (value.schema_version !== OSWORLD_PLANNER_STATE_SCHEMA) issues.push(`${path}.schema_version must be ${OSWORLD_PLANNER_STATE_SCHEMA}`)
  if (!['plan_updated', 'executor_returned', 'task_returned'].includes(String(value.cause))) issues.push(`${path}.cause is not supported`)
  if (!object(value.plan)) {
    issues.push(`${path}.plan must be an object`)
  } else {
    if (!Number.isInteger(value.plan.version) || Number(value.plan.version) < 1) issues.push(`${path}.plan.version must be a positive integer`)
    for (const field of ['completed', 'remaining'] as const) {
      if (!Array.isArray(value.plan[field])) issues.push(`${path}.plan.${field} must be an array`)
      else value.plan[field].forEach((node, index) => validatePlannerNode(node, `${path}.plan.${field}[${index}]`, field === 'completed', issues))
    }
    if (value.plan.next !== null) validatePlannerNode(value.plan.next, `${path}.plan.next`, false, issues)
  }
  if (!object(value.budget)) {
    issues.push(`${path}.budget must be an object`)
  } else {
    if (!nonNegativeInteger(value.budget.usedTurns)) issues.push(`${path}.budget.usedTurns must be a non-negative integer`)
    for (const field of ['maxTurns', 'remainingTurns'] as const) {
      if (value.budget[field] !== null && !nonNegativeInteger(value.budget[field])) issues.push(`${path}.budget.${field} must be a non-negative integer or null`)
    }
  }
  return true
}
