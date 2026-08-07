/**
 * Bench results, kept per model so a run survives a reload.
 *
 * Server-backed when there is a server: an admin benches a model once and
 * everyone choosing one sees the verdict, instead of it living in whichever
 * browser happened to run it. A client-only (WASM) deployment keeps the results
 * in localStorage.
 *
 * A report is a statement about a *deployment*, not just a model: the pass/fail
 * per case transfers anywhere, the speed does not. Hence one entry per model,
 * replaced on re-run — an older run on the same machine is of no use once a
 * newer one exists.
 */
import { isServerMode } from '@/lib/api-client'
import {
  deleteReport as apiDeleteReport,
  listReports as apiListReports,
  saveReport as apiSaveReport,
  type ServerBenchReport,
} from '@/lib/api/llm'
import type { BenchLang, BenchSurface } from './cases'
import type { BenchReport, CaseResult } from './runner'

const STORAGE_KEY = 'linkr.agent.bench.reports'

/** Server rows carry an id (needed to delete one); local ones never do. */
export type StoredBenchReport = BenchReport & { id?: string }

function fromServer(row: ServerBenchReport): StoredBenchReport {
  return {
    id: row.id,
    model: row.model,
    startedAt: Date.parse(row.ranAt),
    mode: row.mode as BenchReport['mode'],
    surfaces: row.surfaces as BenchSurface[],
    lang: row.lang as BenchLang,
    passed: row.passed,
    total: row.total,
    totalMs: row.totalMs,
    promptTokens: row.promptTokens,
    completionTokens: row.completionTokens,
    tokensPerSecond: row.tokensPerSecond,
    cases: row.cases as CaseResult[],
  }
}

// --- localStorage (WASM mode) ---------------------------------------------

function loadLocal(): StoredBenchReport[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) ? (parsed as StoredBenchReport[]) : []
  } catch {
    return []
  }
}

function persistLocal(reports: StoredBenchReport[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(reports))
  } catch {
    // Storage full or unavailable: the run still displayed, which is the point.
  }
}

// --- Public API (async: the server backing needs it) -----------------------

export async function loadReports(workspaceId?: string): Promise<StoredBenchReport[]> {
  if (!isServerMode() || !workspaceId) return loadLocal()
  try {
    return (await apiListReports(workspaceId)).map(fromServer)
  } catch {
    return []
  }
}

/** Store a report, replacing any previous one for the same model. */
export async function saveReport(
  report: BenchReport,
  workspaceId?: string
): Promise<StoredBenchReport[]> {
  if (isServerMode() && workspaceId) {
    // The server does the replace-by-model itself, so just post and re-read.
    await apiSaveReport({
      workspaceId,
      model: report.model,
      mode: report.mode,
      lang: report.lang,
      surfaces: report.surfaces,
      passed: report.passed,
      total: report.total,
      totalMs: report.totalMs,
      promptTokens: report.promptTokens,
      completionTokens: report.completionTokens,
      tokensPerSecond: report.tokensPerSecond,
      cases: report.cases.map((c) => ({ ...c, detail: c.detail })),
    })
    return loadReports(workspaceId)
  }

  const reports = [...loadLocal().filter((r) => r.model !== report.model), report]
  reports.sort((a, b) => b.startedAt - a.startedAt)
  persistLocal(reports)
  return reports
}

export async function removeReport(
  model: string,
  workspaceId?: string
): Promise<StoredBenchReport[]> {
  if (isServerMode() && workspaceId) {
    const existing = await loadReports(workspaceId)
    const target = existing.find((r) => r.model === model)
    if (target?.id) await apiDeleteReport(target.id)
    return loadReports(workspaceId)
  }

  const reports = loadLocal().filter((r) => r.model !== model)
  persistLocal(reports)
  return reports
}

export async function clearReports(workspaceId?: string): Promise<StoredBenchReport[]> {
  if (isServerMode() && workspaceId) {
    // No bulk endpoint: reports are few (one per model) and deleting them is a
    // deliberate admin action, so N calls is fine and keeps the API surface small.
    const existing = await loadReports(workspaceId)
    await Promise.all(existing.filter((r) => r.id).map((r) => apiDeleteReport(r.id as string)))
    return loadReports(workspaceId)
  }

  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch {
    // Nothing to do: the caller resets its own state regardless.
  }
  return []
}
