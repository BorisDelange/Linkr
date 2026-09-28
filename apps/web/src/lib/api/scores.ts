import { ApiError, apiFetch, apiRequest } from '@/lib/api-client'
import { uploadFileInChunks } from '@/lib/api/upload'
import type { ParsedScoreRow } from '@/lib/concept-mapping/scores-parser'
import type { ScoreMethodStat } from '@/lib/concept-mapping/scores-csv'
import type { ScoresIndex, SuggestionCategory } from '@/types'
import { SUGGESTION_CATEGORIES } from '@/types'

const PROJ = '/mapping-projects'

/** Server sends the index with Sets serialised as string[] (JSON has no Set);
 *  rehydrate to the ScoresIndex shape the store/UI expect. */
interface ScoresIndexWire {
  projectId: string
  rowCount: number
  methods: string[]
  sourceKeys: string[]
  categorySourceKeys: Record<string, string[]>
}

function toScoresIndex(wire: ScoresIndexWire): ScoresIndex {
  const categorySourceKeys = {} as Record<SuggestionCategory, Set<string>>
  for (const cat of SUGGESTION_CATEGORIES) {
    categorySourceKeys[cat] = new Set(wire.categorySourceKeys[cat] ?? [])
  }
  return {
    projectId: wire.projectId,
    rowCount: wire.rowCount,
    methods: wire.methods,
    sourceKeys: new Set(wire.sourceKeys),
    categorySourceKeys,
    importedAt: new Date().toISOString(),
  }
}

/** Upload a scores parquet, attach it to the project, and get back the built
 *  index. The bytes go to the content-addressed blob store; only the sha and the
 *  index travel — the parquet never lives in the browser in server mode. */
export async function persistScoresFileOnServer(
  projectId: string,
  file: File,
): Promise<ScoresIndex | null> {
  const { sha } = await uploadFileInChunks(file, file.name)
  const wire = await apiRequest<ScoresIndexWire>(`${PROJ}/${projectId}/scores-file`, {
    method: 'POST',
    body: JSON.stringify({ sha, fileName: file.name }),
  })
  return toScoresIndex(wire)
}

/** Rebuild the query index from the already-attached parquet (no upload). Null
 *  when the project has no scores file. */
export async function fetchScoresIndexFromServer(projectId: string): Promise<ScoresIndex | null> {
  const wire = await apiRequest<ScoresIndexWire | null>(`${PROJ}/${projectId}/scores-index`)
  return wire ? toScoresIndex(wire) : null
}

/** Byte size of the attached scores parquet, for the export dialog. 0 when the
 *  project has no scores file — without downloading the (large) parquet. */
export async function fetchScoresFileSizeFromServer(projectId: string): Promise<number> {
  const wire = await apiRequest<(ScoresIndexWire & { fileSize?: number }) | null>(
    `${PROJ}/${projectId}/scores-index`,
  )
  return wire?.fileSize ?? 0
}

/** Score rows for one (vocabulary, code). Only matching rows descend. */
export function queryScoresForSourceOnServer(
  projectId: string,
  vocabId: string,
  code: string,
): Promise<ParsedScoreRow[]> {
  return apiRequest<ParsedScoreRow[]>(`${PROJ}/${projectId}/scores/query`, {
    method: 'POST',
    body: JSON.stringify({ vocabularyId: vocabId, conceptCode: code }),
  })
}

/** Drop every row of `methods` (e.g. one agent's `ai/<model>` suggestions) from
 *  the project's scores file. Null index when nothing remains. */
export async function removeScoreMethodsOnServer(
  projectId: string,
  methods: string[],
): Promise<{ index: ScoresIndex | null; removed: number }> {
  const res = await apiRequest<{ index: ScoresIndexWire | null; removed: number }>(`${PROJ}/${projectId}/scores/remove`, {
    method: 'POST',
    body: JSON.stringify({ methods }),
  })
  return { index: res.index ? toScoresIndex(res.index) : null, removed: res.removed }
}

export async function deleteScoresFileOnServer(projectId: string): Promise<void> {
  await apiRequest(`${PROJ}/${projectId}/scores-file`, { method: 'DELETE' })
}

/** Download the scores parquet bytes from the blob store (for export), only the
 *  rows of `methods` when given. In server mode they never live in the browser,
 *  so export fetches them here. Null when there is nothing to send. */
export async function fetchScoresFileFromServer(projectId: string, methods?: string[]): Promise<Uint8Array | null> {
  const query = methods ? `?${methods.map((m) => `methods=${encodeURIComponent(m)}`).join('&')}` : ''
  return bytesOrNullOn404(await apiFetch(`/api/v1${PROJ}/${projectId}/scores-file${query}`))
}

/** One method's versioned CSV. Null when the method has no rows. */
export async function fetchScoreMethodCsvFromServer(projectId: string, method: string): Promise<Uint8Array | null> {
  return bytesOrNullOn404(await apiFetch(`/api/v1${PROJ}/${projectId}/scores/method-csv?method=${encodeURIComponent(method)}`))
}

// Only a 404 means "nothing to send": any other failure must reach the caller,
// or a git tree built from it would read the missing CSV as a deletion.
async function bytesOrNullOn404(res: Response): Promise<Uint8Array | null> {
  if (res.status === 404) return null
  if (!res.ok) throw new ApiError(res.status, await res.text())
  return new Uint8Array(await res.arrayBuffer())
}

/** Per method: row count and CSV size. [] when the project has no scores file. */
export function fetchScoreMethodStatsFromServer(projectId: string): Promise<ScoreMethodStat[]> {
  return apiRequest<ScoreMethodStat[]>(`${PROJ}/${projectId}/scores/methods`)
}

/** Replace each method's rows with those of its CSV (an import bringing
 *  similarity-scores/<method>.csv). Null index when nothing remains. */
export async function importScoreCsvsOnServer(
  projectId: string,
  csvs: { method: string; bytes: Uint8Array }[],
): Promise<ScoresIndex | null> {
  const files: { method: string; sha: string }[] = []
  for (const { method, bytes } of csvs) {
    const file = new File([bytes as BlobPart], `${method.replace(/\//g, '_')}.csv`, { type: 'text/csv' })
    const { sha } = await uploadFileInChunks(file, file.name)
    files.push({ method, sha })
  }
  const wire = await apiRequest<ScoresIndexWire | null>(`${PROJ}/${projectId}/scores/import-csv`, {
    method: 'POST',
    body: JSON.stringify({ files }),
  })
  return wire ? toScoresIndex(wire) : null
}

/** Take the versioned methods a pull brings: `methods` are replaced by their CSV
 *  at the remote head (read server-side), `removed` are dropped. */
export async function pullScoreMethodsOnServer(
  projectId: string,
  branch: string,
  methods: string[],
  removed: string[],
): Promise<ScoresIndex | null> {
  const wire = await apiRequest<ScoresIndexWire | null>(`/git/mapping-projects/${projectId}/pull-scores`, {
    method: 'POST',
    body: JSON.stringify({ branch, methods, removed }),
  })
  return wire ? toScoresIndex(wire) : null
}
