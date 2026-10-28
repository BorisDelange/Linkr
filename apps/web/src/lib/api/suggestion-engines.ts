/**
 * Suggestion engines (server mode): the embeddings runtime, a workspace's
 * embedding models and configurations with their per-vocabulary indexes, and
 * computing a mapping project's precomputed suggestions. Backend
 * `api/v1/routes/suggestion_engines.py`. Long work comes back as a Job.
 */
import { apiRequest } from '@/lib/api-client'
import { getJob } from './query-jobs'
import { notifyJobsChanged, type Job } from './environments'

export interface TargetFilters {
  onlyStandard: boolean
  onlyValid: boolean
  domains: string[]
  vocabularies: string[]
}

export interface RuntimeProbe {
  torch: string
  sentenceTransformers: string
  devices: string[]
  gpu: string | null
}

export interface EmbeddingModel {
  id: string
  name: string
  source: 'huggingface' | 'server'
  repoId?: string
  serverPath?: string
  dimension?: number | null
  sizeBytes?: number | null
  installedAt?: string
  ready: boolean
  jobId: string | null
}

export type IndexStatus = 'built' | 'stale' | 'missing'

export interface EmbeddingConfig {
  id: string
  name: string
  slug: string
  modelId: string
  template: 'name_class' | 'name'
  filters: TargetFilters
  device: 'auto' | 'cpu' | 'cuda' | 'mps'
  batchSize: number
  /** The scores method it writes: `semantic/<slug>`. */
  method: string
  index: { vocabularyId: string; status: IndexStatus; count: number | null; builtAt: string | null }[]
  jobId: string | null
}

export interface SuggestionEngines {
  runtime: { installed: boolean; probe: RuntimeProbe | null; jobId: string | null; torchBackend: string }
  models: EmbeddingModel[]
  configs: EmbeddingConfig[]
  /** Vocabularies of the workspace library. */
  vocabularies: string[]
  defaultModel: { repoId: string; domains: string[] }
  /** The one-click BioLORD setup in flight, if any. */
  setupJobId: string | null
}

export type ConfigInput = Partial<Pick<EmbeddingConfig, 'name' | 'slug' | 'modelId' | 'template' | 'filters' | 'device' | 'batchSize'>>

export interface SemanticMatch {
  conceptId: number
  score: number
  conceptName?: string
  conceptCode?: string
  vocabularyId?: string
  domainId?: string
  conceptClassId?: string
  standardConcept?: string | null
}

export interface SemanticSearchResult {
  method: string
  results: { text: string; matches: SemanticMatch[] }[]
}

export const SYNTACTIC_METHODS = ['syntactic/jaro-winkler', 'syntactic/token-sort', 'syntactic/ngram-idf'] as const

const base = (workspaceId: string) => `/workspaces/${workspaceId}/suggestion-engines`

function started(job: Job): Job {
  notifyJobsChanged()
  return job
}

export function getSuggestionEngines(workspaceId: string): Promise<SuggestionEngines> {
  return apiRequest(base(workspaceId))
}

export async function installEmbeddingsRuntime(workspaceId: string): Promise<Job> {
  return started(await apiRequest<Job>(`${base(workspaceId)}/runtime/install`, { method: 'POST' }))
}

/** One click: the runtime if needed, BioLORD-2023-M and its configuration. */
export async function setupDefaultEngine(workspaceId: string): Promise<Job> {
  return started(await apiRequest<Job>(`${base(workspaceId)}/setup-default`, { method: 'POST' }))
}

export async function addEmbeddingModel(
  workspaceId: string,
  body: { source: 'huggingface'; repoId: string; name?: string } | { source: 'server'; serverPath: string; name?: string },
): Promise<{ model: EmbeddingModel; job: Job | null }> {
  const res = await apiRequest<{ model: EmbeddingModel; job: Job | null }>(`${base(workspaceId)}/models`, {
    method: 'POST',
    body: JSON.stringify(body),
  })
  if (res.job) notifyJobsChanged()
  return res
}

export async function downloadEmbeddingModel(workspaceId: string, modelId: string): Promise<Job> {
  return started(await apiRequest<Job>(`${base(workspaceId)}/models/${modelId}/download`, { method: 'POST' }))
}

export function deleteEmbeddingModel(workspaceId: string, modelId: string): Promise<void> {
  return apiRequest(`${base(workspaceId)}/models/${modelId}`, { method: 'DELETE' })
}

export function createEmbeddingConfig(workspaceId: string, body: ConfigInput): Promise<EmbeddingConfig> {
  return apiRequest(`${base(workspaceId)}/configs`, { method: 'POST', body: JSON.stringify(body) })
}

export function updateEmbeddingConfig(workspaceId: string, configId: string, body: ConfigInput): Promise<EmbeddingConfig> {
  return apiRequest(`${base(workspaceId)}/configs/${configId}`, { method: 'PATCH', body: JSON.stringify(body) })
}

export function deleteEmbeddingConfig(workspaceId: string, configId: string): Promise<void> {
  return apiRequest(`${base(workspaceId)}/configs/${configId}`, { method: 'DELETE' })
}

export async function buildEmbeddingIndex(workspaceId: string, configId: string, rebuild = false): Promise<Job> {
  return started(await apiRequest<Job>(`${base(workspaceId)}/configs/${configId}/build`, {
    method: 'POST',
    body: JSON.stringify({ rebuild }),
  }))
}

export interface ComputeScoresInput {
  methods: string[]
  configId: string | null
  filters: TargetFilters
  topK: number
  onlyMissing: boolean
}

export async function computeSuggestionScores(projectId: string, body: ComputeScoresInput): Promise<Job> {
  return started(await apiRequest<Job>(`/mapping-projects/${projectId}/scores/compute`, {
    method: 'POST',
    body: JSON.stringify(body),
  }))
}

/** A paused scores computation: its parameters and how far it got. */
export interface PausedScores {
  params: ComputeScoresInput
  pausedAt: string
  /** Units done of `total`: a unit is one source concept through one stage (syntactic, semantic). */
  total: number
  done: number
}

/** The project's scores computation still running, if any, and the paused one. */
export function getScoresCompute(projectId: string): Promise<{ jobId: string | null; paused: PausedScores | null }> {
  return apiRequest(`/mapping-projects/${projectId}/scores/compute`)
}

/** Stop the running computation, keeping what it finished. */
export async function pauseScoresCompute(projectId: string): Promise<void> {
  await apiRequest(`/mapping-projects/${projectId}/scores/compute/pause`, { method: 'POST' })
}

export async function resumeScoresCompute(projectId: string): Promise<Job> {
  return started(await apiRequest<Job>(`/mapping-projects/${projectId}/scores/compute/resume`, { method: 'POST' }))
}

const FINISHED = new Set(['done', 'error', 'cancelled'])

/** Poll a job until it ends; `onUpdate` sees each state. */
export async function watchJob(jobId: string, onUpdate: (job: Job) => void, signal?: AbortSignal): Promise<Job> {
  for (;;) {
    const job = await getJob(jobId)
    onUpdate(job)
    if (FINISHED.has(job.status) || signal?.aborted) return job
    await new Promise((resolve) => setTimeout(resolve, 2000))
  }
}
