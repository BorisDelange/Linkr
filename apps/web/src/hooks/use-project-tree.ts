import { useMemo } from 'react'
import { useFileStore, type FileNode } from '@/stores/file-store'

// --- Types ---

// The IDE is a pure file explorer over the working dir: it shows only real,
// editable script files. VirtualFileNode / DatasetBridgeNode are retained for
// FileTreeItem's type narrowing (project-overview nodes and the dataset preview
// bridge used to live here) but the tree no longer emits them — every
// virtual/bridge check in FileTreeItem/FilesPage resolves false at runtime.
export interface VirtualFileNode {
  id: string
  name: string
  type: 'file' | 'folder'
  parentId: string | null
  content: string
  language: string
  virtual: true
  readOnly: true
  showInIde?: true
}

export interface DatasetBridgeNode {
  id: string
  name: string
  type: 'file' | 'folder'
  parentId: string | null
  content: string
  language: string
  virtual?: false
  readOnly?: false
  datasetBridge: true
  datasetFileId: string
}

export type TreeNode =
  | (FileNode & { virtual?: false; readOnly?: false })
  | VirtualFileNode

/** ID of the scripts container node in front-only mode (files persisted under it
 * in IndexedDB). Server mode returns files already rooted at null. */
function scriptsRootId(files: FileNode[]): string | null {
  return files.find((f) => f.type === 'folder' && f.name === 'scripts' && f.parentId === null)?.id ?? null
}

export function useProjectTree(projectUid: string | null): { nodes: TreeNode[] } {
  const files = useFileStore((s) => s.files)

  const nodes = useMemo<TreeNode[]>(() => {
    // Pure working-dir explorer (RStudio/VS Code model): only editable script
    // files, no virtual project-overview nodes (datasets, README, pipeline,
    // cohorts, dashboards — reachable via their own pages). The working dir IS the
    // root, so files under the front-only 'scripts' container are re-rooted to
    // null; server mode already returns them rooted (matching the terminal's cwd).
    if (!projectUid) return files
    const rootId = scriptsRootId(files)
    if (rootId == null) return files
    return files
      .filter((f) => f.id !== rootId)
      .map((f) => (f.parentId === rootId ? { ...f, parentId: null } : f))
  }, [files, projectUid])

  return { nodes }
}
