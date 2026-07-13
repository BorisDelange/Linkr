import { useMemo } from 'react'
import { useFileStore, type FileNode } from '@/stores/file-store'
import { useAppStore } from '@/stores/app-store'
import { useDataSourceStore } from '@/stores/data-source-store'
import { useCohortStore } from '@/stores/cohort-store'
import { usePipelineStore } from '@/stores/pipeline-store'
import { useDashboardStore } from '@/stores/dashboard-store'
import { useDatasetStore } from '@/stores/dataset-store'
import { useSharedFsStore } from '@/stores/shared-fs-store'
import { localized } from '@/lib/localized'
import type { DatabaseConnectionConfig } from '@/types'

// --- Types ---

export interface VirtualFileNode {
  id: string
  name: string
  type: 'file' | 'folder'
  parentId: string | null
  content: string
  language: string
  virtual: true
  readOnly: true
  // Virtual nodes are export-only and hidden from the IDE tree, EXCEPT the
  // datasets/ subtree, flagged showInIde so it shows read-only (mirroring the
  // Datasets page / the on-disk datasets/ folder).
  showInIde?: true
}

// Retained for FileTreeItem's type narrowing. The tree no longer emits bridge
// nodes (datasets/ is now a read-only virtual view), so `datasetBridge` is never
// set at runtime — every isBridge check resolves false — but the shape keeps the
// existing item component compiling without edits.
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

// --- Helpers ---

function vFile(
  id: string,
  name: string,
  parentId: string | null,
  content: string,
  language = 'json',
): VirtualFileNode {
  return { id, name, type: 'file', parentId, content, language, virtual: true, readOnly: true }
}

function vFolder(id: string, name: string, parentId: string | null): VirtualFileNode {
  return { id, name, type: 'folder', parentId, content: '', language: '', virtual: true, readOnly: true }
}

/** Virtual nodes that ARE shown in the IDE tree (read-only) — the datasets/ subtree. */
function ideFolder(id: string, name: string, parentId: string | null): VirtualFileNode {
  return { id, name, type: 'folder', parentId, content: '', language: '', virtual: true, readOnly: true, showInIde: true }
}

function ideFile(id: string, name: string, parentId: string | null, content: string, language = 'json'): VirtualFileNode {
  return { id, name, type: 'file', parentId, content, language, virtual: true, readOnly: true, showInIde: true }
}

/** Slugify a name for use in file paths. */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'untitled'
}

/** Redact password fields in connection config. */
function redactConfig(config: unknown): unknown {
  if (!config || typeof config !== 'object') return config
  const out: Record<string, unknown> = { ...(config as Record<string, unknown>) }
  const dbConfig = out as unknown as DatabaseConnectionConfig
  if (dbConfig.password) out.password = '***'
  return out
}

// --- Hook ---

export function useProjectTree(projectUid: string | null): { nodes: TreeNode[] } {
  const files = useFileStore((s) => s.files)
  const projectsRaw = useAppStore((s) => s._projectsRaw)
  const dataSources = useDataSourceStore((s) => s.dataSources)
  const cohorts = useCohortStore((s) => s.cohorts)
  const pipelines = usePipelineStore((s) => s.pipelines)
  const dashboards = useDashboardStore((s) => s.dashboards)
  const dashboardTabs = useDashboardStore((s) => s.tabs)
  const dashboardWidgets = useDashboardStore((s) => s.widgets)
  const datasetFiles = useDatasetStore((s) => s.files)
  const datasetAnalyses = useDatasetStore((s) => s.analyses)
  const sharedFsFileNames = useSharedFsStore((s) => s.fileNames)

  const nodes = useMemo<TreeNode[]>(() => {
    if (!projectUid) return files

    const virtual: VirtualFileNode[] = []

    // --- project.json ---
    const project = projectsRaw.find((p) => p.uid === projectUid)
    if (project) {
      const { uid, name, description, status, badges, createdAt, updatedAt } = project
      virtual.push(
        vFile('virtual:project.json', 'project.json', null,
          JSON.stringify({ uid, name, description, status, badges, createdAt, updatedAt }, null, 2)),
      )
    }

    // --- README.md ---
    if (project) {
      virtual.push(
        vFile('virtual:README.md', 'README.md', null, localized(project.readme, 'en') || '', 'markdown'),
      )
    }

    // --- tasks.json ---
    if (project) {
      const { todos, notes } = project
      virtual.push(
        vFile('virtual:tasks.json', 'tasks.json', null,
          JSON.stringify({ todos: todos ?? [], notes: notes ?? '' }, null, 2)),
      )
    }

    // --- .gitignore ---
    virtual.push(
      vFile('virtual:.gitignore', '.gitignore', null, 'datasets/**/*.csv\ndatasets/**/*.parquet\n.cache/\n', 'plaintext'),
    )

    // --- databases/ ---
    const linkedIds = project?.linkedDataSourceIds ?? []
    const projectSources = dataSources.filter((ds) => linkedIds.includes(ds.id))
    if (projectSources.length > 0) {
      const dbFolderId = 'virtual:databases'
      virtual.push(vFolder(dbFolderId, 'databases', null))
      for (const ds of projectSources) {
        const slug = slugify(ds.name)
        const { id, name, description, sourceType, schemaMapping, status, stats, createdAt, updatedAt } = ds
        const connectionConfig = redactConfig(ds.connectionConfig)
        virtual.push(
          vFile(`virtual:databases/${ds.id}`, `${slug}.json`, dbFolderId,
            JSON.stringify({ id, name, description, sourceType, connectionConfig, schemaMapping, status, stats, createdAt, updatedAt }, null, 2)),
        )
      }
    }

    // --- cohorts/ ---
    const projectCohorts = cohorts.filter((c) => c.projectUid === projectUid)
    if (projectCohorts.length > 0) {
      const cohortFolderId = 'virtual:cohorts'
      virtual.push(vFolder(cohortFolderId, 'cohorts', null))
      for (const c of projectCohorts) {
        const slug = slugify(c.name)
        const { id, name, description, level, criteriaTree, customSql, resultCount, attrition, schemaVersion, createdAt, updatedAt } = c
        virtual.push(
          vFile(`virtual:cohorts/${c.id}`, `${slug}.json`, cohortFolderId,
            JSON.stringify({ id, name, description, level, criteriaTree, customSql, resultCount, attrition, schemaVersion, createdAt, updatedAt }, null, 2)),
        )
      }
    }

    // --- pipeline/ ---
    const projectPipelines = pipelines.filter((p) => p.projectUid === projectUid)
    if (projectPipelines.length > 0) {
      const pipelineFolderId = 'virtual:pipeline'
      virtual.push(vFolder(pipelineFolderId, 'pipeline', null))
      const pipeline = projectPipelines[0]
      const { id, name, nodes: pNodes, edges, createdAt, updatedAt } = pipeline
      virtual.push(
        vFile('virtual:pipeline/pipeline.json', 'pipeline.json', pipelineFolderId,
          JSON.stringify({ id, name, nodes: pNodes, edges, createdAt, updatedAt }, null, 2)),
      )
    }

    // --- dashboards/ ---
    const projectDashboards = dashboards.filter((d) => d.projectUid === projectUid)
    if (projectDashboards.length > 0) {
      const dashFolderId = 'virtual:dashboards'
      virtual.push(vFolder(dashFolderId, 'dashboards', null))
      for (const dash of projectDashboards) {
        const slug = slugify(localized(dash.name, 'en'))
        const tabs = dashboardTabs.filter((t) => t.dashboardId === dash.id)
        const tabsWithWidgets = tabs.map((tab) => ({
          ...tab,
          widgets: dashboardWidgets.filter((w) => w.tabId === tab.id),
        }))
        virtual.push(
          vFile(`virtual:dashboards/${dash.id}`, `${slug}.json`, dashFolderId,
            JSON.stringify({ id: dash.id, name: dash.name, tabs: tabsWithWidgets, createdAt: dash.createdAt, updatedAt: dash.updatedAt }, null, 2)),
        )
      }
    }

    // --- datasets/ (read-only view: mirrors the on-disk datasets/ folder; the
    // Datasets page stays the place to import/edit — the source is immutable) ---
    const datasetsFolderId = 'virtual:datasets'
    virtual.push(ideFolder(datasetsFolderId, 'datasets', null))

    if (datasetFiles.length > 0) {
      for (const df of datasetFiles) {
        const parentId = df.parentId
          ? `virtual:datasets/node/${df.parentId}`
          : datasetsFolderId
        if (df.type === 'folder') {
          virtual.push(ideFolder(`virtual:datasets/node/${df.id}`, df.name, parentId))
        } else {
          const meta = {
            columns: df.columns ?? [],
            rowCount: df.rowCount ?? 0,
            createdAt: df.createdAt,
            updatedAt: df.updatedAt,
          }
          virtual.push(
            ideFile(`virtual:datasets/node/${df.id}`, df.name, parentId, JSON.stringify(meta, null, 2)),
          )
        }
      }

      // --- analyses (nested inside the dataset's folder) ---
      if (datasetAnalyses.length > 0) {
        const byDataset = new Map<string, typeof datasetAnalyses>()
        for (const a of datasetAnalyses) {
          const list = byDataset.get(a.datasetFileId) ?? []
          list.push(a)
          byDataset.set(a.datasetFileId, list)
        }

        for (const [datasetFileId, fileAnalyses] of byDataset) {
          const dataset = datasetFiles.find((f) => f.id === datasetFileId)
          const folderName = dataset
            ? dataset.name.replace(/\.[^.]+$/, '')
            : datasetFileId
          const subFolderId = `virtual:datasets/analyses/${datasetFileId}`
          virtual.push(ideFolder(subFolderId, folderName, datasetsFolderId))

          for (const a of fileAnalyses) {
            const { id, name, type, config, createdAt, updatedAt } = a
            virtual.push(
              ideFile(`virtual:datasets/analysis/${a.id}`, `${slugify(name)}.json`, subFolderId,
                JSON.stringify({ id, name, type, config, createdAt, updatedAt }, null, 2)),
            )
          }
        }
      }
    }

    // --- datasets/ — files produced by script execution (shared-fs) ---
    for (const fullPath of sharedFsFileNames) {
      const fileName = fullPath.substring(fullPath.lastIndexOf('/') + 1)
      // Avoid duplicates with dataset store files
      const alreadyExists = datasetFiles.some((df) => df.name === fileName)
      if (!alreadyExists) {
        virtual.push(
          ideFile(`virtual:shared-fs/${fullPath}`, fileName, datasetsFolderId, '', 'plaintext'),
        )
      }
    }

    return [...virtual, ...files]
  }, [files, projectUid, projectsRaw, dataSources, cohorts, pipelines, dashboardTabs, dashboardWidgets, datasetFiles, datasetAnalyses, sharedFsFileNames])

  return { nodes }
}
