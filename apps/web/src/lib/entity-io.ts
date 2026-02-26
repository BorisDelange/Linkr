/**
 * Shared utilities for entity export/import (ZIP and JSON).
 */
import JSZip from 'jszip'
import type { Storage } from '@/lib/storage'

// ---------------------------------------------------------------------------
// Download helpers
// ---------------------------------------------------------------------------

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

export function downloadJson(data: unknown, filename: string): void {
  const json = JSON.stringify(data, null, 2)
  const blob = new Blob([json], { type: 'application/json' })
  downloadBlob(blob, filename)
}

// ---------------------------------------------------------------------------
// Slugify & timestamp
// ---------------------------------------------------------------------------

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'export'
}

/** Returns a timestamp string like `2025-12-01_13-23-43`. */
export function timestamp(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`
}

// ---------------------------------------------------------------------------
// Export ZIP
// ---------------------------------------------------------------------------

export interface ZipEntry {
  filename: string
  data: unknown
}

/**
 * Create and download a ZIP with a main JSON file + optional child JSON files.
 */
export async function exportEntityZip(
  entries: ZipEntry[],
  zipName: string,
): Promise<void> {
  const zip = new JSZip()
  for (const entry of entries) {
    zip.file(entry.filename, JSON.stringify(entry.data, null, 2))
  }
  const blob = await zip.generateAsync({ type: 'blob' })
  downloadBlob(blob, zipName)
}

// ---------------------------------------------------------------------------
// Import ZIP
// ---------------------------------------------------------------------------

/**
 * Parse a ZIP file and return all JSON files as parsed objects.
 */
export async function parseImportZip(
  file: File,
): Promise<Record<string, unknown>> {
  const zip = await JSZip.loadAsync(file)
  const result: Record<string, unknown> = {}
  for (const [path, entry] of Object.entries(zip.files)) {
    if (entry.dir) continue
    const content = await entry.async('string')
    try {
      result[path] = JSON.parse(content)
    } catch {
      result[path] = content
    }
  }
  return result
}

// ---------------------------------------------------------------------------
// Project ZIP (build without downloading — reusable)
// ---------------------------------------------------------------------------

function addJson(zip: JSZip, filename: string, data: unknown[]) {
  if (data.length > 0) zip.file(filename, JSON.stringify(data, null, 2))
}

/**
 * Build a ZIP blob containing all project data from storage.
 * Returns the blob + a resolved project name string.
 */
export async function buildProjectZip(
  projectUid: string,
  storage: Storage,
): Promise<{ blob: Blob; projectName: string } | null> {
  const project = await storage.projects.getById(projectUid)
  if (!project) return null

  const zip = new JSZip()
  zip.file('project.json', JSON.stringify(project, null, 2))

  // IDE files
  addJson(zip, 'ide-files.json', await storage.ideFiles.getByProject(projectUid))

  // Pipelines
  addJson(zip, 'pipelines.json', await storage.pipelines.getByProject(projectUid))

  // Cohorts
  addJson(zip, 'cohorts.json', await storage.cohorts.getByProject(projectUid))

  // Connections
  addJson(zip, 'connections.json', await storage.connections.getByProject(projectUid))

  // Dashboards + tabs + widgets
  const dashboards = await storage.dashboards.getByProject(projectUid)
  if (dashboards.length > 0) {
    const tabs: unknown[] = []
    const widgets: unknown[] = []
    for (const d of dashboards) {
      const dTabs = await storage.dashboardTabs.getByDashboard(d.id)
      tabs.push(...dTabs)
      for (const tab of dTabs) {
        widgets.push(...(await storage.dashboardWidgets.getByTab(tab.id)))
      }
    }
    zip.file('dashboards.json', JSON.stringify(dashboards, null, 2))
    addJson(zip, 'dashboard-tabs.json', tabs)
    addJson(zip, 'dashboard-widgets.json', widgets)
  }

  // Dataset files + analyses
  const datasetFiles = await storage.datasetFiles.getByProject(projectUid)
  if (datasetFiles.length > 0) {
    zip.file('dataset-files.json', JSON.stringify(datasetFiles, null, 2))
    const analyses: unknown[] = []
    for (const df of datasetFiles) {
      if (df.type === 'file') {
        analyses.push(...(await storage.datasetAnalyses.getByDataset(df.id)))
      }
    }
    addJson(zip, 'dataset-analyses.json', analyses)
  }

  // Readme attachments (binary)
  const attachments = await storage.readmeAttachments.getByProject(projectUid)
  if (attachments.length > 0) {
    const meta = attachments.map(({ data: _, ...rest }) => rest)
    zip.file('readme-attachments.json', JSON.stringify(meta, null, 2))
    for (const att of attachments) {
      zip.file(`attachments/${att.id}-${att.fileName}`, att.data)
    }
  }

  const projectName = typeof project.name === 'string'
    ? project.name
    : (project.name.en || Object.values(project.name)[0] || 'project')

  const blob = await zip.generateAsync({ type: 'blob' })
  return { blob, projectName }
}
