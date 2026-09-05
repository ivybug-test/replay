export const OSWORLD_CAPABILITY_LABELS: Record<string, string> = {
  conflict_disambiguation: 'Conflict disambiguation',
  cross_source_reasoning: 'Cross-source reasoning',
  dynamic_environment: 'Dynamic environment',
  human_in_the_loop: 'Human in the loop',
  implicit_state_inference: 'Implicit state inference',
  multi_item_state_tracking: 'Multi-item state tracking',
  multimodal_editing: 'Multimodal editing',
  streaming_interaction: 'Streaming interaction',
  tutorial_following: 'Tutorial following',
  visual_spatial_precision: 'Visual-spatial precision',
}

export function osworldCapabilityLabel(capability: string): string {
  return OSWORLD_CAPABILITY_LABELS[capability] ?? capability.replaceAll('_', ' ')
}

export function osworldCapabilities(task: { metadata?: Record<string, unknown> }): string[] {
  const capabilities = task.metadata?.capabilities
  return Array.isArray(capabilities)
    ? capabilities.filter((value): value is string => typeof value === 'string')
    : []
}
