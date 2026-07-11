import { apiFetch, apiRequest } from '@/lib/api-client'
import { uploadFileInChunks } from '@/lib/api/upload'
import type { ParsedScoreRow } from '@/lib/concept-mapping/scores-parser'
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

export async function deleteScoresFileOnServer(projectId: string): Promise<void> {
  await apiRequest(`${PROJ}/${projectId}/scores-file`, { method: 'DELETE' })
}

/** Download the scores parquet bytes from the blob store (for export). In server
 *  mode they never live in the browser, so export fetches them here. Null when
 *  the project has no scores file. */
export async function fetchScoresFileFromServer(projectId: string): Promise<Uint8Array | null> {
  const res = await apiFetch(`/api/v1${PROJ}/${projectId}/scores-file`)
  if (!res.ok) return null
  return new Uint8Array(await res.arrayBuffer())
}
