import type { Step, StepAgent } from './types'

export interface AgentStepGroup {
  agent: StepAgent
  steps: Step[]
  children: AgentStepGroup[]
  totalSteps: number
}

/** Build a navigation tree without reordering the playback step array. */
export function buildStepTree(steps: Step[]): AgentStepGroup[] {
  const groups = new Map<string, AgentStepGroup>()
  for (const step of steps) {
    const agent = step.agent ?? { id: 'unattributed', label: 'Steps' }
    let group = groups.get(agent.id)
    if (!group) {
      group = { agent, steps: [], children: [], totalSteps: 0 }
      groups.set(agent.id, group)
    }
    group.steps.push(step)
  }
  const roots: AgentStepGroup[] = []
  for (const group of groups.values()) {
    const parent = group.agent.parentId ? groups.get(group.agent.parentId) : undefined
    const seen = new Set([group.agent.id])
    let ancestor = parent
    let cyclic = false
    while (ancestor) {
      if (seen.has(ancestor.agent.id)) { cyclic = true; break }
      seen.add(ancestor.agent.id)
      ancestor = ancestor.agent.parentId ? groups.get(ancestor.agent.parentId) : undefined
    }
    if (parent && !cyclic) parent.children.push(group)
    else roots.push(group)
  }
  const count = (group: AgentStepGroup): number => {
    group.totalSteps = group.steps.length + group.children.reduce((n, child) => n + count(child), 0)
    return group.totalSteps
  }
  roots.forEach(count)
  return roots
}

export function stepTitle(step: Step): string {
  if (step.toolCalls?.length) return step.toolCalls.map((tool) => tool.name).join(', ')
  if (step.role === 'tool') return `${step.toolName ?? 'tool'} result`
  if (step.text) return step.text.replace(/\s+/g, ' ').slice(0, 60)
  if (step.observation) return 'observation'
  return step.role
}
