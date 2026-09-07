export const OSWORLD_PLANNER_STATE_SCHEMA = 'planner-state/v1' as const

export interface PlannerNodeV1 {
  id: string
  agent: 'stateact_coder' | 'stateact_gui' | 'stateact_browser'
  task: string
  max_turns: number
  satisfies?: string[]
  resolves?: string[]
  deliverables?: string[]
  success_conditions?: string[]
  evidence_requirements?: string[]
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
    plan_review?: 'draft' | 'approved' | 'rejected'
    task_contract?: {
      review: 'draft' | 'approved' | 'rejected'
      requirements: Array<{
        id: string
        text: string
        source: string
        status: 'pending' | 'claimed' | 'verified' | 'failed' | 'unknown'
        claimed_by: string[]
      }>
      deliverables: Array<{
        id: string
        path: string
        operation: 'create' | 'modify_in_place'
      }>
      constraints: Array<{ id: string; text: string }>
      ambiguities: Array<string | {
        id: string
        text: string
        status: 'pending' | 'claimed' | 'verified' | 'failed' | 'unknown'
        claimed_by: string[]
      }>
    }
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

function validateTaskContract(value: unknown, path: string, issues: string[]) {
  if (!object(value)) {
    issues.push(`${path} must be an object`)
    return
  }
  if (!['draft', 'approved', 'rejected'].includes(String(value.review))) issues.push(`${path}.review is invalid`)
  if (!Array.isArray(value.requirements)) issues.push(`${path}.requirements must be an array`)
  else value.requirements.forEach((item, index) => {
    const itemPath = `${path}.requirements[${index}]`
    if (!object(item)) return issues.push(`${itemPath} must be an object`)
    for (const field of ['id', 'text', 'source']) requireString(item, field, itemPath, issues)
    if (!['pending', 'claimed', 'verified', 'failed', 'unknown'].includes(String(item.status))) issues.push(`${itemPath}.status is invalid`)
    if (!Array.isArray(item.claimed_by)) issues.push(`${itemPath}.claimed_by must be an array`)
  })
  if (!Array.isArray(value.deliverables)) issues.push(`${path}.deliverables must be an array`)
  if (!Array.isArray(value.constraints)) issues.push(`${path}.constraints must be an array`)
  if (!Array.isArray(value.ambiguities)) issues.push(`${path}.ambiguities must be an array`)
  else value.ambiguities.forEach((item, index) => {
    if (typeof item === 'string') return
    const itemPath = `${path}.ambiguities[${index}]`
    if (!object(item)) return issues.push(`${itemPath} must be a string or object`)
    for (const field of ['id', 'text']) requireString(item, field, itemPath, issues)
    if (!['pending', 'claimed', 'verified', 'failed', 'unknown'].includes(String(item.status))) issues.push(`${itemPath}.status is invalid`)
    if (!Array.isArray(item.claimed_by)) issues.push(`${itemPath}.claimed_by must be an array`)
  })
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
    if (value.plan.plan_review != null && !['draft', 'approved', 'rejected'].includes(String(value.plan.plan_review))) {
      issues.push(`${path}.plan.plan_review is invalid`)
    }
    if (value.plan.task_contract != null) validateTaskContract(value.plan.task_contract, `${path}.plan.task_contract`, issues)
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
