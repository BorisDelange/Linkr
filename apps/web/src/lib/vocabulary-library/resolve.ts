/**
 * Which vocabulary database a workspace's features read: the workspace library
 * once it holds vocabularies, else (until the older databases are added to it)
 * the vocabulary database a mapping project imported for itself.
 */
interface DataSourceLike {
  id: string
  workspaceId?: string | null
  isVocabularyReference?: boolean
  connectionConfig?: unknown
}

function libraryConfig(ds: DataSourceLike): { vocabularyLibrary?: boolean; vocabularies?: unknown[] } {
  return (ds.connectionConfig ?? {}) as { vocabularyLibrary?: boolean; vocabularies?: unknown[] }
}

export function findLibrary<T extends DataSourceLike>(dataSources: readonly T[], workspaceId: string | null | undefined): T | undefined {
  return dataSources.find((d) => d.workspaceId === workspaceId && d.isVocabularyReference && libraryConfig(d).vocabularyLibrary)
}

export function vocabularyDataSourceIdFor(
  project: { workspaceId?: string | null; vocabularyDataSourceId?: string | null } | undefined,
  dataSources: readonly DataSourceLike[],
): string | undefined {
  if (!project) return undefined
  const library = findLibrary(dataSources, project.workspaceId)
  if (library && (libraryConfig(library).vocabularies?.length ?? 0) > 0) return library.id
  const own = project.vocabularyDataSourceId
  return own && dataSources.some((d) => d.id === own) ? own : undefined
}
