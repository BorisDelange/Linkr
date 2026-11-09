import type { EtlRunLog } from '@/types'

/** What a server-owned pipeline run is given (apps/api schemas/etl_run.py). */
export interface EtlRunStep {
  fileId: string
  name: string
  /** The script as it runs, role prefixes resolved; null for one left out. */
  sql: string | null
}

export interface EtlRunSpec {
  label: string
  pipelineId: string
  /** The databases attached beside the target, read-only, by role. */
  roles: Record<string, string>
  steps: EtlRunStep[]
  /** The `mapping.<name>` exports the scripts read, as CSV text. */
  mappingData: Record<string, string>
}

/** Where a pipeline run is (services/server_runs/etl.py), as its checkpoint says. */
export interface EtlRunState {
  pipelineId?: string
  startedAt?: string
  /** The scripts of the run, in order, and the first one not done yet. */
  fileIds?: string[]
  next?: number
  scripts?: EtlRunLog[]
  /** The statement in flight, and how much of its data it has read. */
  current?: { fileId: string; index: number; total: number; sql: string; reading?: number }
}

/** What the ETL store asks of a server run it mirrors. */
export interface EtlServerDriver {
  pause: () => void
  cancel: () => void
}
