interface EditorFile {
  id: string
  content?: string | null
  parentId?: string | null
}

/** The editor state of a file tree (ETL pipeline, SQL collection) that a re-read touches. */
export interface EditorFilesState<F extends EditorFile> {
  files: F[]
  openFileIds: string[]
  selectedFileId: string | null
  /** fileId → the saved content an unsaved edit started from. */
  _dirtyMap: Map<string, string>
  /** Files with an unsaved edit that were deleted elsewhere: kept in the editor
   *  until the user saves (re-creates) or closes them. */
  orphanedFileIds: string[]
}

/**
 * Merge a tree re-read from storage after a change made elsewhere (an agent over
 * MCP) into the open editor. A file with an unsaved edit keeps the user's text,
 * and the stored version becomes what Revert goes back to. A file gone from
 * storage closes — unless it has an unsaved edit: then it stays, orphaned, so
 * the user's text is never lost (moved to the root if its folder went too).
 */
export function mergeRemoteFiles<F extends EditorFile>(
  state: EditorFilesState<F>,
  stored: F[],
  isDirty: (id: string) => boolean,
): EditorFilesState<F> {
  const local = new Map(state.files.map((f) => [f.id, f]))
  const storedIds = new Set(stored.map((f) => f.id))
  const dirty = new Map<string, string>()
  const files = stored.map((f) => {
    if (!isDirty(f.id)) return f
    dirty.set(f.id, f.content ?? '')
    return { ...f, content: local.get(f.id)?.content }
  })
  const orphans = state.files.filter((f) => !storedIds.has(f.id) && isDirty(f.id))
  const kept = new Set([...storedIds, ...orphans.map((f) => f.id)])
  for (const f of orphans) {
    dirty.set(f.id, state._dirtyMap.get(f.id) ?? '')
    files.push(f.parentId && !kept.has(f.parentId) ? { ...f, parentId: null } : f)
  }
  const openFileIds = state.openFileIds.filter((id) => kept.has(id))
  const selectedFileId = state.selectedFileId && kept.has(state.selectedFileId) ? state.selectedFileId : openFileIds[0] ?? null
  return { files, openFileIds, selectedFileId, _dirtyMap: dirty, orphanedFileIds: orphans.map((f) => f.id) }
}

/** The state without an orphaned file the user closes or reverts: nothing in
 *  storage to fall back on, so it leaves the tree too. */
export function dropOrphan<F extends EditorFile>(state: EditorFilesState<F>, id: string): EditorFilesState<F> {
  const dirty = new Map(state._dirtyMap)
  dirty.delete(id)
  const openFileIds = state.openFileIds.filter((fid) => fid !== id)
  return {
    files: state.files.filter((f) => f.id !== id),
    openFileIds,
    selectedFileId:
      state.selectedFileId === id
        ? openFileIds[Math.min(state.openFileIds.indexOf(id), openFileIds.length - 1)] ?? null
        : state.selectedFileId,
    _dirtyMap: dirty,
    orphanedFileIds: state.orphanedFileIds.filter((fid) => fid !== id),
  }
}
