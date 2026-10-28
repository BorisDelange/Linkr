/**
 * Pure helpers of the suggestion-engine tools (tools-mapping-engines.ts): how an
 * embedding configuration is named by the agent, and how engines and semantic
 * matches read in a tool result.
 */
import type { EmbeddingConfig, SemanticMatch, SuggestionEngines } from '@/lib/api/suggestion-engines'

/** A configuration by id, slug or method (`semantic/<slug>`); without a name, the
 *  only one that has an index. A string is why none matches. */
export function pickConfig(engines: SuggestionEngines, name?: string): EmbeddingConfig | string {
  const usable = engines.configs.filter(hasIndex)
  if (!name) {
    if (usable.length === 1) return usable[0]
    if (usable.length === 0) {
      return engines.configs.length
        ? 'No embedding configuration has an index yet. Ask the user to build one in Linkr: mapping editor › Suggestions panel › Manage suggestions › Compute › Models and configurations.'
        : 'This workspace has no embedding configuration. Ask the user to set one up in Linkr: mapping editor › Suggestions panel › Manage suggestions › Compute › Models and configurations (one click for BioLORD-2023-M).'
    }
    return `Several configurations have an index (${usable.map((c) => c.slug).join(', ')}): give config.`
  }
  const found = engines.configs.find((c) => c.id === name || c.slug === name || c.method === name)
  return found ?? `No embedding configuration "${name}". Known: ${engines.configs.map((c) => c.slug).join(', ') || 'none'}.`
}

export function hasIndex(c: EmbeddingConfig): boolean {
  return c.index.some((s) => s.status !== 'missing' && (s.count ?? 0) > 0)
}

export function describeEngines(engines: SuggestionEngines): string {
  const rt = engines.runtime
  const lines = [
    rt.installed && rt.probe
      ? `Embeddings runtime: installed (torch ${rt.probe.torch}, devices ${rt.probe.gpu ?? rt.probe.devices.join(', ')}).`
      : 'Embeddings runtime: not installed (semantic scores and search need it; syntactic scores do not).',
    '',
    'Models:',
    ...(engines.models.length
      ? engines.models.map((m) => `- ${m.name} (${m.repoId ?? m.serverPath}) — ${m.ready ? 'ready' : 'not downloaded'}`)
      : ['- none']),
    '',
    'Embedding configurations (semantic methods):',
  ]
  if (engines.configs.length === 0) lines.push('- none')
  for (const c of engines.configs) {
    const model = engines.models.find((m) => m.id === c.modelId)
    const built = c.index.filter((s) => s.status === 'built').length
    const stale = c.index.filter((s) => s.status === 'stale').map((s) => s.vocabularyId)
    const missing = c.index.filter((s) => s.status === 'missing').map((s) => s.vocabularyId)
    const scope = [
      c.filters.onlyStandard ? 'standard' : null,
      c.filters.onlyValid ? 'valid' : null,
      c.filters.domains.length ? c.filters.domains.join('/') : 'all domains',
      c.filters.vocabularies.length ? c.filters.vocabularies.join('/') : null,
    ].filter(Boolean).join(', ')
    lines.push(
      `- ${c.slug} → ${c.method}: ${c.name}, model ${model?.name ?? '?'}, ${scope}. `
      + `Index ${built}/${c.index.length} vocabularies built`
      + (stale.length ? `, out of date: ${stale.join(', ')}` : '')
      + (missing.length ? `, not built: ${missing.join(', ')}` : '')
      + (c.jobId ? ' (building now)' : ''),
    )
  }
  lines.push('', 'Syntactic methods (no runtime needed): syntactic/jaro-winkler, syntactic/token-sort, syntactic/ngram-idf (slow).')
  return lines.join('\n')
}

export function describeMatch(m: SemanticMatch): string {
  const flags = [m.domainId, m.conceptClassId, m.standardConcept === 'S' ? 'standard' : m.standardConcept === 'C' ? 'classification' : 'non-standard']
    .filter(Boolean).join(', ')
  return `${m.conceptId} — ${m.conceptName ?? '?'} [${m.vocabularyId ?? '?'}${m.conceptCode ? ` ${m.conceptCode}` : ''}] (${flags}) — similarity ${m.score.toFixed(3)}`
}
