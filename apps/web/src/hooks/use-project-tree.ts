import { useMemo } from 'react'
import { useFileStore, type FileNode } from '@/stores/file-store'
import { useAppStore } from '@/stores/app-store'
import { useDataSourceStore } from '@/stores/data-source-store'
import { useCohortStore } from '@/stores/cohort-store'
import { usePipelineStore } from '@/stores/pipeline-store'
import { useDashboardStore } from '@/stores/dashboard-store'
import { useDatasetStore } from '@/stores/dataset-store'
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
  const dashboardTabs = useDashboardStore((s) => s.tabs)
  const dashboardWidgets = useDashboardStore((s) => s.widgets)
  const datasetFiles = useDatasetStore((s) => s.files)
  const datasetAnalyses = useDatasetStore((s) => s.analyses)

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
        vFile('virtual:README.md', 'README.md', null, project.readme ?? '', 'markdown'),
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
      vFile('virtual:.gitignore', '.gitignore', null, 'data/\n.cache/\n', 'plaintext'),
    )

    // --- data/ (gitignored — databases + datasets) ---
    const dataFolderId = 'virtual:data'
    virtual.push(vFolder(dataFolderId, 'data', null))

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
        const { id, name, description, level, criteria, resultCount, createdAt, updatedAt } = c
        virtual.push(
          vFile(`virtual:cohorts/${c.id}`, `${slug}.json`, cohortFolderId,
            JSON.stringify({ id, name, description, level, criteria, resultCount, createdAt, updatedAt }, null, 2)),
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
    const projectTabs = dashboardTabs.filter((t) => t.projectUid === projectUid)
    if (projectTabs.length > 0) {
      const dashFolderId = 'virtual:dashboards'
      virtual.push(vFolder(dashFolderId, 'dashboards', null))
      for (const tab of projectTabs) {
        const slug = slugify(tab.name)
        const tabWidgets = dashboardWidgets.filter((w) => w.tabId === tab.id)
        virtual.push(
          vFile(`virtual:dashboards/${tab.id}`, `${slug}.json`, dashFolderId,
            JSON.stringify({ id: tab.id, name: tab.name, displayOrder: tab.displayOrder, widgets: tabWidgets }, null, 2)),
        )
      }
    }

    // --- data/databases/ (virtual mirror of imported database files) ---
    virtual.push(vFolder('virtual:data/databases', 'databases', dataFolderId))

    // --- data/datasets/ (virtual read-only mirror of dataset file tree) ---
    const datasetsFolderId = 'virtual:data/datasets'
    virtual.push(vFolder(datasetsFolderId, 'datasets', dataFolderId))

    if (datasetFiles.length > 0) {
      // Build virtual nodes preserving the tree structure
      for (const df of datasetFiles) {
        const parentId = df.parentId
          ? `virtual:data/datasets/${df.parentId}`
          : datasetsFolderId
        if (df.type === 'folder') {
          virtual.push(vFolder(`virtual:data/datasets/${df.id}`, df.name, parentId))
        } else {
          // Show column metadata as content
          const meta = {
            columns: df.columns ?? [],
            rowCount: df.rowCount ?? 0,
            createdAt: df.createdAt,
            updatedAt: df.updatedAt,
          }
          virtual.push(
            vFile(`virtual:data/datasets/${df.id}`, df.name, parentId,
              JSON.stringify(meta, null, 2)),
          )
        }
      }
    }

    // --- datasets_analyses/ (virtual read-only mirror of analysis configs) ---
    if (datasetAnalyses.length > 0) {
      const analysesFolderId = 'virtual:datasets_analyses'
      virtual.push(vFolder(analysesFolderId, 'datasets_analyses', null))

      // Group analyses by dataset, create one subfolder per dataset
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
        const subFolderId = `virtual:datasets_analyses/${datasetFileId}`
        virtual.push(vFolder(subFolderId, folderName, analysesFolderId))

        for (const a of fileAnalyses) {
          const { id, name, type, config, createdAt, updatedAt } = a
          virtual.push(
            vFile(`virtual:datasets_analyses/${a.id}`, `${slugify(name)}.json`, subFolderId,
              JSON.stringify({ id, name, type, config, createdAt, updatedAt }, null, 2)),
          )
        }
      }
    }

    return [...virtual, ...files]
  }, [files, projectUid, projectsRaw, dataSources, cohorts, pipelines, dashboardTabs, dashboardWidgets, datasetFiles, datasetAnalyses])

  return { nodes }
}
