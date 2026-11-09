/**
 * Server mode: what a data catalog's server run is given
 * (apps/api schemas/catalog_run.py) — the catalog's plan, every query with its
 * class relations in. The server fills the tokens and runs it end to end
 * (services/server_runs/catalog), page open or not: the computation (kind
 * `catalog`), or the crossings' size estimate (kind `catalog_estimate`).
 */

import type { DataCatalog } from '@/types'
import type { SchemaMapping } from '@/types/schema-mapping'
import {
  compileCatalogPlan,
  compileEstimatePlan,
  type CatalogPlan,
  type CatalogRunStep,
  type CatalogUnitInfo,
} from './catalog-compute'
import type { CatalogStepProgress } from './catalog-run'

export interface CatalogRunSpec extends CatalogPlan {
  label: string
  /** Start over; else a paused computation's stored results are resumed. */
  fresh: boolean
  mode: 'compute' | 'estimate'
  /** The estimate mode's queries, each stored under its key as it lands. */
  estimates?: { variables: CatalogPlan['crossings'][number]['variables']; key: string; sql: string }[]
}

/** A server run's state as the page reads it (`server_runs/catalog/executor.py`). */
export interface CatalogServerRunState {
  phase?: CatalogRunStep | 'saving'
  phaseStartedAt?: string
  /** Units done. */
  offset?: number
  /** Units planned, once the crossings are. */
  total?: number | null
  steps?: Partial<Record<CatalogRunStep, CatalogStepProgress>>
  current?: CatalogUnitInfo
}

/** A size estimate's state: the rankings, then one estimate per crossing. */
export interface CatalogEstimateRunState {
  phase?: 'ranking' | 'estimates'
  offset?: number
  total?: number
  /** Estimates stored. */
  next?: number
  current?: CatalogUnitInfo | { step: 'estimates'; crossing: CatalogPlan['crossings'][number]['variables'] }
}

type Prepare = (sql: string) => string | Promise<string>

async function preparedPlan(plan: CatalogPlan, prepare: Prepare): Promise<CatalogPlan> {
  const orNull = async (sql: string | null) => (sql == null ? null : prepare(sql))
  return {
    ...plan,
    sizeSql: await prepare(plan.sizeSql),
    boundsSql: await orNull(plan.boundsSql),
    conceptCounts: await Promise.all(plan.conceptCounts.map(async (q) => ({ dictKey: q.dictKey, sql: await prepare(q.sql) }))),
    totalsSql: await prepare(plan.totalsSql),
    serviceRankSql: await orNull(plan.serviceRankSql),
    conceptRankSql: await orNull(plan.conceptRankSql),
    crossings: await Promise.all(plan.crossings.map(async (c) => ({ variables: c.variables, sql: await orNull(c.sql) }))),
  }
}

export async function compileCatalogRunSpec(
  catalog: Pick<DataCatalog, 'variables' | 'crossings' | 'counts' | 'dataSourceId'>,
  mapping: SchemaMapping,
  {
    label,
    fresh,
    tables,
    prepare,
    planOptions,
  }: {
    label: string
    fresh: boolean
    tables?: readonly string[] | null
    /** The SQL as the database runs it: the class relations injected. */
    prepare: Prepare
    planOptions?: { sliceRows?: number; conceptChunk?: number }
  },
): Promise<CatalogRunSpec> {
  const plan = await preparedPlan(compileCatalogPlan(catalog, mapping, tables, planOptions), prepare)
  return { ...plan, label, fresh, mode: 'compute' }
}

/**
 * The size estimate of the catalog's crossings whose estimate is not `known`;
 * null when there is none left to make.
 */
export async function compileCatalogEstimateSpec(
  catalog: DataCatalog,
  mapping: SchemaMapping,
  { label, known, prepare }: { label: string; known: (key: string) => boolean; prepare: Prepare },
): Promise<CatalogRunSpec | null> {
  const compiled = compileEstimatePlan(catalog, mapping, known)
  if (!compiled) return null
  return {
    ...await preparedPlan(compiled.plan, prepare),
    label,
    fresh: true,
    mode: 'estimate',
    estimates: await Promise.all(compiled.estimates.map(async (e) => ({ ...e, sql: await prepare(e.sql) }))),
  }
}
