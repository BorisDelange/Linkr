/** The editor state of a file tree (ETL pipeline, SQL collection) that a re-read touches. */
export interface EditorFilesState<F extends { id: string; content?: string | null }> {
  files: F[]
  openFileIds: string[]
  selectedFileId: string | null
  /** fileId → the saved content an unsaved edit started from. */
  _dirtyMap: Map<string, string>
}

/**
 * Merge a tree re-read from storage after a change made elsewhere (an agent over
 * MCP) into the open editor. A file with an unsaved edit keeps the user's text,
 * and the stored version becomes what Revert goes back to; files gone from
 * storage close.
 */
export function mergeRemoteFiles<F extends { id: string; content?: string | null }>(
  state: EditorFilesState<F>,
  stored: F[],
  isDirty: (id: string) => boolean,
): EditorFilesState<F> {
  const local = new Map(state.files.map((f) => [f.id, f]))
  const ids = new Set(stored.map((f) => f.id))
  const dirty = new Map<string, string>()
  const files = stored.map((f) => {
    if (!isDirty(f.id)) return f
    dirty.set(f.id, f.content ?? '')
    return { ...f, content: local.get(f.id)?.content }
  })
  const openFileIds = state.openFileIds.filter((id) => ids.has(id))
  const selectedFileId = state.selectedFileId && ids.has(state.selectedFileId) ? state.selectedFileId : openFileIds[0] ?? null
  return { files, openFileIds, selectedFileId, _dirtyMap: dirty }
}
