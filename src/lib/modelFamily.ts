/**
 * Provider family for one model or harness label. Display-only.
 *
 * This is the single frontend owner of the classification: the OSS live path
 * and the upload/bundled path both used to carry their own partial rule sets,
 * so the same model could be classified differently depending on where its run
 * came from. scripts/ingest.py bakes the same labels at build time.
 */
export function modelFamily(raw?: string | null): string {
  const value = String(raw ?? '').toLowerCase()
  if (value.includes('claude') || value.includes('anthropic')) return 'Anthropic'
  if (value.includes('gemini') || value.includes('google')) return 'Google'
  if (value.includes('qwen')) return 'Alibaba'
  if (value.includes('gpt') || value.includes('codex') || value.includes('openai')) return 'OpenAI'
  return 'unknown'
}
