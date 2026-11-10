import type { JobStep } from '@/lib/api/environments'
import type { ServerRun } from '@/lib/api/server-runs'

/** Where a concept run is (apps/api services/server_runs/concepts), as its checkpoint says. */
export interface ConceptRunState {
  stage?: 'counts' | 'ranking' | 'batches' | 'done'
  /** Within the counts: the step counting, or the list being assembled. */
  phase?: 'records' | 'patients' | 'assembling' | 'ranking'
  counts?: Partial<Record<'records' | 'patients', { done: number; total: number }>>
  /** Bumped at each assembly of the concept list: reload it. */
  assembled?: number
  done?: number
  total?: number
  doneWeight?: number
  totalWeight?: number
  current?: { conceptCode: string; conceptName: string }
  failedCount?: number
  failed?: { conceptId: number; error: string }[]
  /** A run of several steps: each, as its job lists them. */
  steps?: JobStep[]
}

export type ConceptRun = ServerRun<ConceptRunState>

/** How far through its work a run is (0 to 1): its concepts weighed by their
 *  records once ranked, its counting units before. */
export function runShare(run: ConceptRun): number {
  const s = run.state
  if (s.stage === 'counts') {
    const done = (s.counts?.records?.done ?? 0) + (s.counts?.patients?.done ?? 0)
    const total = (s.counts?.records?.total ?? 0) + (s.counts?.patients?.total ?? 0)
    return total > 0 ? done / total : 0
  }
  if (s.totalWeight) return (s.doneWeight ?? 0) / s.totalWeight
  return s.total ? (s.done ?? 0) / s.total : 0
}
