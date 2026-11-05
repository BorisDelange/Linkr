/**
 * Suggestion engines: what precomputes a mapping project's suggestions. The
 * agent can see the workspace's embedding configurations and search the OMOP
 * vocabulary by meaning. Computing scores and building an index are the user's
 * to start from the app; the tools that start them stay for an explicit request
 * (scripts, tests). Installing the runtime and downloading models stay in the
 * app (gigabytes, an administrator's decision).
 */
import { fromJsonSchema } from '@modelcontextprotocol/server'
import { SYNTACTIC_METHODS, type TargetFilters } from '@/lib/api/suggestion-engines'
import { describeEngines, describeMatch, pickConfig } from './mapping-engines.js'
import { READ, WRITE, api, failure, guard, text, type Server } from './shared.js'

const MANAGE = 'mapping editor › Suggestions panel › Manage suggestions › Compute › Models and configurations'

const scopeSchema = {
  domains: { type: 'array', items: { type: 'string' }, description: 'Target domains, e.g. ["Measurement"]. Default: all.' },
  vocabularies: { type: 'array', items: { type: 'string' }, description: 'Target vocabularies, e.g. ["LOINC"]. Default: all.' },
  concept_classes: {
    type: 'array', items: { type: 'string' },
    description: 'Target concept classes, e.g. ["Clinical Drug", "Quant Clinical Drug"]. Default: all.',
  },
  standard_only: { type: 'boolean', description: 'Default true.' },
  valid_only: { type: 'boolean', description: 'Default true.' },
} as const

interface ScopeArgs {
  domains?: string[]; vocabularies?: string[]; concept_classes?: string[]; standard_only?: boolean; valid_only?: boolean
}

function filtersOf(a: ScopeArgs): TargetFilters {
  return {
    onlyStandard: a.standard_only ?? true,
    onlyValid: a.valid_only ?? true,
    domains: a.domains ?? [],
    vocabularies: a.vocabularies ?? [],
    conceptClasses: a.concept_classes ?? [],
  }
}

async function workspaceOfProject(mappingProjectId: string): Promise<string> {
  return (await api.getMappingProject(mappingProjectId)).workspaceId
}

export function registerMappingEngineTools(server: Server) {
  server.registerTool('list_suggestion_engines', {
    description: 'What can precompute a mapping project\'s suggestions in this workspace: the embeddings runtime, '
      + 'the embedding models, and the embedding configurations (each writes the method semantic/<slug>) with the '
      + 'state of their index per vocabulary: whether semantic_search_vocabulary can run, and over which concepts.',
    annotations: READ,
    inputSchema: fromJsonSchema<{ mapping_project_id: string }>({
      type: 'object', properties: { mapping_project_id: { type: 'string' } }, required: ['mapping_project_id'],
    }),
  }, guard(async ({ mapping_project_id }) => {
    return text(describeEngines(await api.suggestionEngines(await workspaceOfProject(mapping_project_id))))
  }))

  server.registerTool('semantic_search_vocabulary', {
    description: 'Find candidate OMOP target concepts by meaning: each text is encoded by the embedding model of a '
      + 'configuration and compared with its index (cosine similarity). Finds what a word search misses — '
      + 'synonyms, paraphrases, brand names, other wordings. Write the texts as a clinician would, in English '
      + '(several at once, up to 50). Loads the model on each call: batch your texts. Narrow the scope (domains, '
      + 'vocabularies, concept_classes) to what the source can be. A similarity is not an equivalence: check the '
      + 'finalists with get_vocabulary_concept.',
    annotations: READ,
    inputSchema: fromJsonSchema<ScopeArgs & { mapping_project_id: string; texts: string[]; config?: string; limit?: number }>({
      type: 'object',
      properties: {
        mapping_project_id: { type: 'string' },
        texts: { type: 'array', items: { type: 'string' }, description: 'One query per source concept, e.g. ["heart rate", "serum potassium"].' },
        config: { type: 'string', description: 'Configuration slug (or id). Default: the only one with an index.' },
        limit: { type: 'number', description: 'Matches per text. Default 10, max 100.' },
        ...scopeSchema,
      },
      required: ['mapping_project_id', 'texts'],
    }),
  }, guard(async ({ mapping_project_id, texts, config, limit = 10, ...scope }) => {
    const cleaned = texts.map((t) => t.trim()).filter(Boolean)
    if (cleaned.length === 0) return failure('Give at least one text.')
    if (cleaned.length > 50) return failure('At most 50 texts per call.')
    const workspaceId = await workspaceOfProject(mapping_project_id)
    const engines = await api.suggestionEngines(workspaceId)
    if (!engines.runtime.installed) return failure(`The embeddings runtime is not installed. Ask the user to install it in Linkr: ${MANAGE}.`)
    const picked = pickConfig(engines, config)
    if (typeof picked === 'string') return failure(picked)
    const hasScope = scope.domains?.length || scope.vocabularies?.length || scope.concept_classes?.length
      || scope.standard_only !== undefined || scope.valid_only !== undefined
    const found = await api.semanticSearch(workspaceId, picked.id, {
      texts: cleaned,
      topK: Math.min(Math.max(1, Math.floor(limit)), 100),
      ...(hasScope ? { filters: filtersOf(scope) } : {}),
    })
    const blocks = found.results.map((r) => [
      `"${r.text}":`,
      ...(r.matches.length ? r.matches.map((m) => `- ${describeMatch(m)}`) : ['- no match in the scope']),
    ].join('\n'))
    return text(`Method ${found.method}.\n\n${blocks.join('\n\n')}`)
  }))

  server.registerTool('compute_suggestion_scores', {
    description: 'Have the server compute precomputed suggestions for a mapping project\'s source concepts, as a '
      + 'background job: syntactic methods (string similarity) and/or the semantic method of an embedding '
      + 'configuration. Each method computed replaces that method\'s rows in the project (only_missing: only adds '
      + 'the concepts it has not scored yet); AI suggestions are never touched. Can run for minutes to hours. '
      + 'The user normally starts it from the app (Manage suggestions › Compute): call it only when they explicitly '
      + 'ask you to, then follow it with get_job_status.',
    annotations: WRITE,
    inputSchema: fromJsonSchema<ScopeArgs & {
      mapping_project_id: string; methods?: string[]; config?: string; top_k?: number; only_missing?: boolean
    }>({
      type: 'object',
      properties: {
        mapping_project_id: { type: 'string' },
        methods: {
          type: 'array', items: { type: 'string', enum: [...SYNTACTIC_METHODS] },
          description: 'Syntactic methods. syntactic/ngram-idf is slow (about an hour of CPU unfiltered).',
        },
        config: { type: 'string', description: 'Embedding configuration slug (or id) for the semantic method.' },
        top_k: { type: 'number', description: 'Candidates kept per concept and method. Default 20.' },
        only_missing: { type: 'boolean', description: 'Only the concepts these methods have not scored yet. Default false.' },
        ...scopeSchema,
      },
      required: ['mapping_project_id'],
    }),
  }, guard(async ({ mapping_project_id, methods = [], config, top_k = 20, only_missing = false, ...scope }) => {
    if (!methods.length && !config) return failure('Give methods, config, or both.')
    let configId: string | null = null
    if (config) {
      const engines = await api.suggestionEngines(await workspaceOfProject(mapping_project_id))
      const picked = pickConfig(engines, config)
      if (typeof picked === 'string') return failure(picked)
      configId = picked.id
    }
    const job = await api.computeScores(mapping_project_id, {
      methods, configId, filters: filtersOf(scope), topK: Math.min(Math.max(1, Math.floor(top_k)), 200), onlyMissing: only_missing,
    })
    return text(`Started job ${job.id} (${job.label}). Follow it with get_job_status; the scores appear in the `
      + 'Suggestions panel once it is done.')
  }))

  server.registerTool('build_embedding_index', {
    description: 'Encode the target concepts of an embedding configuration (the vocabularies its index lacks or '
      + 'has out of date; all with rebuild), as a background job. Needed before its semantic scores or search. '
      + 'Hours for the whole vocabulary. The user normally starts it from the app: call it only when they explicitly '
      + 'ask you to, then follow it with get_job_status.',
    annotations: WRITE,
    inputSchema: fromJsonSchema<{ mapping_project_id: string; config: string; rebuild?: boolean }>({
      type: 'object',
      properties: {
        mapping_project_id: { type: 'string', description: 'Any mapping project of the workspace.' },
        config: { type: 'string', description: 'Configuration slug (or id).' },
        rebuild: { type: 'boolean', description: 'Re-encode every vocabulary. Default false.' },
      },
      required: ['mapping_project_id', 'config'],
    }),
  }, guard(async ({ mapping_project_id, config, rebuild = false }) => {
    const workspaceId = await workspaceOfProject(mapping_project_id)
    const engines = await api.suggestionEngines(workspaceId)
    const picked = engines.configs.find((c) => c.id === config || c.slug === config || c.method === config)
    if (!picked) return failure(`No embedding configuration "${config}".`)
    const job = await api.buildEmbeddingIndex(workspaceId, picked.id, rebuild)
    return text(`Started job ${job.id} (${job.label}). Follow it with get_job_status.`)
  }))
}
