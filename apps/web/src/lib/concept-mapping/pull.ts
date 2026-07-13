/**
 * Pull orchestration for a mapping project: fetch the server preview (BASE +
 * REMOTE managed files), read LOCAL from the DB, and run the pure 3-way merge
 * (merge.ts) to produce the change plan the resolution UI renders.
 *
 * This is the glue (I/O + parsing); all the "what changed / is it a conflict"
 * logic lives in merge.ts so it stays unit-testable without a server.
 */
import type { ConceptMapping, MappingProject } from '@/types'
import { getStorage } from '@/lib/storage'
import { gitPullPreview, type GitPullSide } from '@/lib/api/git'
import {
  mergeMappings,
  mergeMetadata,
  listDiffStat,
  type MappingProjectMerge,
} from './merge'

/** Parse a managed JSON file from a preview side; [] / {} on absence or bad JSON. */
function parseJson<T>(side: GitPullSide, name: string, fallback: T): T {
  const raw = side.files[name]
  if (!raw) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

function statList(side: GitPullSide, name: string): { count: number; present: boolean } {
  const s = side.stats[name]
  if (!s?.present) return { count: 0, present: false }
  return { count: s.rowCount ?? 0, present: true }
}

/**
 * Build the full merge plan for a mapping project. `projectId` is the LOCAL
 * entity; `branch` optionally overrides the linked branch.
 */
export async function prepareMappingProjectPull(projectId: string, branch?: string): Promise<MappingProjectMerge> {
  const storage = getStorage()
  const [preview, localMappings, localProject] = await Promise.all([
    gitPullPreview('mapping-projects', projectId, branch),
    storage.conceptMappings.getByProject(projectId),
    storage.mappingProjects.getById(projectId),
  ])

  const baseMappings = parseJson<ConceptMapping[]>(preview.base, 'mappings.json', [])
  const remoteMappings = parseJson<ConceptMapping[]>(preview.remote, 'mappings.json', [])
  const baseProject = parseJson<Partial<MappingProject>>(preview.base, 'project.json', {})
  const remoteProject = parseJson<Partial<MappingProject>>(preview.remote, 'project.json', {})

  const mappings = mergeMappings(baseMappings, remoteMappings, localMappings)
  const metadata = mergeMetadata(baseProject, remoteProject, localProject ?? {})

  // Source concepts: whole-list block choice — compare REMOTE stat to the local
  // count (we can't cheaply diff the CSV here; the UI fetches a preview on demand).
  const remoteCsv = statList(preview.remote, 'source-concepts.csv')
  const localCsvCount = localProject?.fileSourceData?.totalRowCount ?? 0
  const sourceConcepts = listDiffStat(localCsvCount, remoteCsv.count, remoteCsv.present && remoteCsv.count !== localCsvCount)

  // Scores: remote-wins block. "changed" = the remote has scores at all (we take
  // them wholesale); count is informational.
  const remoteScores = preview.remote.stats['similarity-scores.parquet']
  const localScores = await getLocalScoreCount(projectId)
  const scores = listDiffStat(localScores, remoteScores?.rowCount ?? 0, !!remoteScores?.present)

  return { mappings, metadata, sourceConcepts, scores }
}

/** Best-effort local scores count — the store may not expose it, so 0 is fine
 *  (the count is informational; the merge choice is "take remote"). */
async function getLocalScoreCount(_projectId: string): Promise<number> {
  return 0
}
