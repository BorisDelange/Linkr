/**
 * Bench results, kept per model so a run survives a reload.
 *
 * Local to the browser on purpose: what a bench measures is this machine's
 * speed against this endpoint, which is exactly the thing that does NOT
 * transfer between installs. Sharing them would invite comparing numbers from
 * different hardware.
 *
 * One entry per model: re-running replaces it, since an older run on the same
 * model and machine is of no use once a newer one exists.
 */
import type { BenchReport } from './runner'

const STORAGE_KEY = 'linkr.agent.bench.reports'

export function loadReports(): BenchReport[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) ? (parsed as BenchReport[]) : []
  } catch {
    return []
  }
}

function persist(reports: BenchReport[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(reports))
  } catch {
    // Storage full or unavailable: the run still displayed, which is the point.
  }
}

/** Store a report, replacing any previous one for the same model. */
export function saveReport(report: BenchReport): BenchReport[] {
  const reports = [...loadReports().filter((r) => r.model !== report.model), report]
  reports.sort((a, b) => b.startedAt - a.startedAt)
  persist(reports)
  return reports
}

export function removeReport(model: string): BenchReport[] {
  const reports = loadReports().filter((r) => r.model !== model)
  persist(reports)
  return reports
}

export function clearReports(): BenchReport[] {
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch {
    // Nothing to do: the caller resets its own state regardless.
  }
  return []
}
