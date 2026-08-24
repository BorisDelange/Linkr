import { useCallback, useMemo, useRef, useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Activity, AlertTriangle, Table as TableIcon, TrendingUp } from 'lucide-react'
import { Allotment } from 'allotment'
import { cn } from '@/lib/utils'
import { isServerMode } from '@/lib/api-client'
import { renderOnServer } from '@/lib/api/execution'
import type { ComponentPluginProps } from '@/lib/plugins/component-registry'
import { buildKaplanMeierSpec } from './kaplan-meier-server'
import { buildCoxSpec, type CoxResult, type CoxCoefficient } from './cox-server'
import { resolvePalette } from '@/lib/plugins/shared-styles'
import { displayColumnName } from '@/lib/dataset-utils'
import { niceStep } from '@/lib/chart-ticks'
import { coefficientRelabeler } from '@/lib/stats/coefficient-labels'
import { PublicationTable, type PublicationColumn } from '@/components/ui/publication-table'
import { AnalysisLoading, usePluginName } from '@/components/ui/analysis-loading'
import { usePublishAnalysisTable } from './analysis-table-context'
import type { ExportTable, ExportTableCell } from '@/lib/table-export'
import type { TFunction } from 'i18next'

/**
 * A model warning as DATA rather than as a sentence, so the render can say it
 * in the reader's language — the compute path runs far from i18n.
 */
export type KmWarning =
  | { code: 'rows_excluded'; count: number }
  | { code: 'no_observations' }
  /** The server sends its warnings as ready-made English sentences. */
  | string

/** How the curves, the summary table and the Cox model share the panel. */
type DisplayMode = 'plot' | 'table' | 'cox' | 'both' | 'both-tabs'

/** Which pane is showing in tabs mode. */
type KmView = 'plot' | 'table' | 'cox'

/** A Cox coefficient plus a stable row id. */
interface CoxRow {
  id: string
  coef: CoxCoefficient
}

/** One term's proportional-hazards check, as a table row. */
interface CoxPhRow {
  id: string
  name: string
  statistic: number | null
  pValue: number | null
}

/** A group's summary plus its index, which fixes its colour. */
interface KmRow {
  id: string
  group: GroupSurvival
  index: number
}

// ===========================================================================
// Types
// ===========================================================================

interface SurvivalStep {
  time: number
  nRisk: number
  nEvent: number
  nCensor: number
  survival: number
  ciLow: number
  ciHigh: number
}

interface GroupSurvival {
  name: string
  steps: SurvivalStep[]
  medianSurvival: number | null
  medianCiLow: number | null
  medianCiHigh: number | null
  totalN: number
  totalEvents: number
}

interface LogRankResult {
  chiSquare: number
  df: number
  pValue: number
}

interface KMResult {
  groups: GroupSurvival[]
  logRank: LogRankResult | null
  warnings: KmWarning[]
}

const DASH = '\u2014'

// ===========================================================================
// Color palette
// ===========================================================================

// Group curve colours come from the shared palette (config: colorPalette),
// so a Kaplan-Meier figure matches the other charts in the same report.
// ===========================================================================
// Distribution CDF (chi-square only needed for log-rank)
// ===========================================================================

function gammaLn(x: number): number {
  const g = 7
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
    1.5056327351493116e-7,
  ]
  if (x < 0.5) {
    return Math.log(Math.PI / Math.sin(Math.PI * x)) - gammaLn(1 - x)
  }
  x -= 1
  let a = c[0]
  const t = x + g + 0.5
  for (let i = 1; i < g + 2; i++) a += c[i] / (x + i)
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a)
}

function regularizedGamma(a: number, x: number): number {
  if (x <= 0) return 0
  if (x < a + 1) {
    let sum = 1 / a
    let term = 1 / a
    for (let n = 1; n < 200; n++) {
      term *= x / (a + n)
      sum += term
      if (Math.abs(term) < Math.abs(sum) * 1e-14) break
    }
    return sum * Math.exp(-x + a * Math.log(x) - gammaLn(a))
  }
  let c = 1e-30
  let d = 1 / (x + 1 - a)
  let h = d
  for (let n = 1; n < 200; n++) {
    const an = -n * (n - a)
    const bn = x + 2 * n + 1 - a
    d = bn + an * d
    if (Math.abs(d) < 1e-30) d = 1e-30
    d = 1 / d
    c = bn + an / c
    if (Math.abs(c) < 1e-30) c = 1e-30
    const delta = c * d
    h *= delta
    if (Math.abs(delta - 1) < 1e-14) break
  }
  return 1 - Math.exp(-x + a * Math.log(x) - gammaLn(a)) * h
}

function chiSquareCDF(x: number, k: number): number {
  if (x <= 0) return 0
  return regularizedGamma(k / 2, x / 2)
}

function inverseNormalCDF(p: number): number {
  const a = [
    -3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.383577518672690e2,
    -3.066479806614716e1, 2.506628277459239e0,
  ]
  const b = [
    -5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1,
    -1.328068155288572e1,
  ]
  const c = [
    -7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838e0, -2.549732539343734e0,
    4.374664141464968e0, 2.938163982698783e0,
  ]
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996e0, 3.754408661907416e0]
  const pLow = 0.02425
  const pHigh = 1 - pLow
  let q: number, r: number
  if (p < pLow) {
    q = Math.sqrt(-2 * Math.log(p))
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
  }
  if (p <= pHigh) {
    q = p - 0.5
    r = q * q
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
      (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)
  }
  q = Math.sqrt(-2 * Math.log(1 - p))
  return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
    ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
}

// ===========================================================================
// Kaplan-Meier estimator
// ===========================================================================

function isNotMissing(v: unknown): boolean {
  return v != null && v !== '' && String(v).toLowerCase() !== 'null'
}

interface Observation {
  time: number
  event: boolean // true = event, false = censored
}

function computeKM(obs: Observation[], zCrit: number): { steps: SurvivalStep[]; medianSurvival: number | null; medianCiLow: number | null; medianCiHigh: number | null } {
  if (obs.length === 0) return { steps: [], medianSurvival: null, medianCiLow: null, medianCiHigh: null }

  // Sort by time, events before censored at same time
  const sorted = [...obs].sort((a, b) => a.time - b.time || (a.event ? 0 : 1) - (b.event ? 0 : 1))

  const steps: SurvivalStep[] = []
  let nRisk = sorted.length
  let survival = 1
  let varSum = 0 // Greenwood's formula cumulative sum

  // Add initial point
  steps.push({
    time: 0,
    nRisk,
    nEvent: 0,
    nCensor: 0,
    survival: 1,
    ciLow: 1,
    ciHigh: 1,
  })

  let i = 0
  while (i < sorted.length) {
    const currentTime = sorted[i].time
    let nEvent = 0
    let nCensor = 0

    // Count events at this time
    while (i < sorted.length && sorted[i].time === currentTime && sorted[i].event) {
      nEvent++
      i++
    }
    // Count censored at this time
    while (i < sorted.length && sorted[i].time === currentTime && !sorted[i].event) {
      nCensor++
      i++
    }

    if (nEvent > 0 && nRisk > 0) {
      survival *= (nRisk - nEvent) / nRisk
      // Greenwood's formula for variance
      if (nRisk > nEvent) {
        varSum += nEvent / (nRisk * (nRisk - nEvent))
      }
    }

    // Confidence interval using log(-log(S)) transformation (more stable)
    let ciLow = survival
    let ciHigh = survival
    if (survival > 0 && survival < 1 && varSum > 0) {
      const logLogS = Math.log(-Math.log(survival))
      const se = Math.sqrt(varSum) / Math.abs(Math.log(survival))
      ciLow = Math.exp(-Math.exp(logLogS + zCrit * se))
      ciHigh = Math.exp(-Math.exp(logLogS - zCrit * se))
      ciLow = Math.max(0, Math.min(1, ciLow))
      ciHigh = Math.max(0, Math.min(1, ciHigh))
    } else if (survival <= 0) {
      ciLow = 0
      ciHigh = 0
    }

    steps.push({
      time: currentTime,
      nRisk,
      nEvent,
      nCensor,
      survival: Math.max(0, survival),
      ciLow,
      ciHigh,
    })

    nRisk -= nEvent + nCensor
  }

  // Find median survival (smallest time where S <= 0.5)
  let medianSurvival: number | null = null
  let medianCiLow: number | null = null
  let medianCiHigh: number | null = null
  for (const step of steps) {
    if (step.survival <= 0.5) {
      medianSurvival = step.time
      break
    }
  }
  // CI for median: times where ciHigh <= 0.5 and ciLow <= 0.5
  if (medianSurvival !== null) {
    for (const step of steps) {
      if (step.ciHigh <= 0.5) { medianCiLow = step.time; break }
    }
    for (const step of steps) {
      if (step.ciLow <= 0.5) { medianCiHigh = step.time; break }
    }
  }

  return { steps, medianSurvival, medianCiLow, medianCiHigh }
}

// ===========================================================================
// Log-rank test
// ===========================================================================

function logRankTest(groupObs: Observation[][]): LogRankResult | null {
  if (groupObs.length < 2) return null

  // Collect all unique event times across all groups
  const allEventTimes = new Set<number>()
  for (const obs of groupObs) {
    for (const o of obs) {
      if (o.event) allEventTimes.add(o.time)
    }
  }
  const times = [...allEventTimes].sort((a, b) => a - b)
  if (times.length === 0) return null

  const K = groupObs.length

  // For each group, prepare sorted observations
  const groupSorted = groupObs.map(obs =>
    [...obs].sort((a, b) => a.time - b.time || (a.event ? 0 : 1) - (b.event ? 0 : 1))
  )

  // For each group: track index pointer for at-risk count
  const groupN = groupSorted.map(obs => obs.length)
  const groupPtr = new Array(K).fill(0)
  const groupAtRisk = [...groupN]

  // O_k - E_k for each group (first K-1 used for test)
  const OminusE = new Array(K).fill(0)
  // Variance-covariance matrix (K-1 × K-1)
  const V: number[][] = Array.from({ length: K - 1 }, () => new Array(K - 1).fill(0))

  for (const t of times) {
    // Advance pointers: remove observations with time < t
    for (let k = 0; k < K; k++) {
      while (groupPtr[k] < groupSorted[k].length && groupSorted[k][groupPtr[k]].time < t) {
        groupPtr[k]++
        groupAtRisk[k]--
      }
    }

    // Count events and at-risk at this time
    const d_k = new Array(K).fill(0) // events per group at time t
    const n_k = [...groupAtRisk]     // at-risk per group at time t

    for (let k = 0; k < K; k++) {
      let ptr = groupPtr[k]
      while (ptr < groupSorted[k].length && groupSorted[k][ptr].time === t && groupSorted[k][ptr].event) {
        d_k[k]++
        ptr++
      }
    }

    const d = d_k.reduce((s, v) => s + v, 0) // total events at time t
    const n = n_k.reduce((s, v) => s + v, 0) // total at-risk at time t

    if (n <= 0 || d <= 0) continue

    // Expected events: E_k = n_k * d / n
    for (let k = 0; k < K; k++) {
      OminusE[k] += d_k[k] - (n_k[k] * d) / n
    }

    // Variance contribution
    const factor = n > 1 ? (d * (n - d)) / (n * n * (n - 1)) : 0
    for (let j = 0; j < K - 1; j++) {
      for (let k = 0; k < K - 1; k++) {
        if (j === k) {
          V[j][k] += factor * n_k[j] * (n - n_k[j])
        } else {
          V[j][k] -= factor * n_k[j] * n_k[k]
        }
      }
    }

    // After processing events at this time, advance pointers past events and censored at this time
    for (let k = 0; k < K; k++) {
      while (groupPtr[k] < groupSorted[k].length && groupSorted[k][groupPtr[k]].time === t) {
        groupPtr[k]++
        groupAtRisk[k]--
      }
    }
  }

  // Chi-square statistic: (O-E)' V^{-1} (O-E) for K-1 groups
  // For K=2: chi² = (O1-E1)² / V[0][0]
  let chiSq: number
  const df = K - 1

  if (K === 2) {
    chiSq = V[0][0] > 0 ? (OminusE[0] * OminusE[0]) / V[0][0] : 0
  } else {
    // General case: invert V matrix
    // Use simple Gauss-Jordan for small matrices
    const n = K - 1
    const aug = V.map((row, i) => {
      const r = [...row]
      for (let j = 0; j < n; j++) r.push(i === j ? 1 : 0)
      return r
    })

    for (let col = 0; col < n; col++) {
      // Pivot
      let maxRow = col
      for (let row = col + 1; row < n; row++) {
        if (Math.abs(aug[row][col]) > Math.abs(aug[maxRow][col])) maxRow = row
      }
      [aug[col], aug[maxRow]] = [aug[maxRow], aug[col]]

      const pivot = aug[col][col]
      if (Math.abs(pivot) < 1e-15) return null // Singular

      for (let j = 0; j < 2 * n; j++) aug[col][j] /= pivot
      for (let row = 0; row < n; row++) {
        if (row === col) continue
        const factor = aug[row][col]
        for (let j = 0; j < 2 * n; j++) aug[row][j] -= factor * aug[col][j]
      }
    }

    // Extract inverse
    const Vinv = aug.map(row => row.slice(n))

    // chi² = sum_j sum_k OminusE[j] * Vinv[j][k] * OminusE[k]
    chiSq = 0
    for (let j = 0; j < n; j++) {
      for (let k = 0; k < n; k++) {
        chiSq += OminusE[j] * Vinv[j][k] * OminusE[k]
      }
    }
  }

  const pValue = 1 - chiSquareCDF(chiSq, df)

  return { chiSquare: chiSq, df, pValue }
}

// ===========================================================================
// Main computation
// ===========================================================================

function computeKMResult(
  rows: Record<string, unknown>[],
  _columns: { id: string; name: string; type: string }[],
  timeId: string,
  eventId: string,
  groupId: string | null,
  confidenceLevel: number,
): KMResult {
  const warnings: KmWarning[] = []
  const alpha = 1 - confidenceLevel / 100
  const zCrit = inverseNormalCDF(1 - alpha / 2)

  // Parse observations
  const allObs: { time: number; event: boolean; group: string }[] = []
  let nMissing = 0

  for (const row of rows) {
    const timeRaw = row[timeId]
    const eventRaw = row[eventId]
    if (!isNotMissing(timeRaw) || !isNotMissing(eventRaw)) { nMissing++; continue }

    const time = typeof timeRaw === 'number' ? timeRaw : Number(timeRaw)
    if (isNaN(time) || time < 0) { nMissing++; continue }

    // Event: 1/true/"1"/"yes"/"true" = event, anything else = censored
    const eventStr = String(eventRaw).toLowerCase().trim()
    const event = eventStr === '1' || eventStr === 'true' || eventStr === 'yes'

    const group = groupId && isNotMissing(row[groupId]) ? String(row[groupId]) : '(All)'
    allObs.push({ time, event, group })
  }

  if (nMissing > 0) {
    warnings.push({ code: 'rows_excluded', count: nMissing })
  }

  if (allObs.length === 0) {
    return { groups: [], logRank: null, warnings: [...warnings, { code: 'no_observations' }] }
  }

  // Split by group
  const groupMap = new Map<string, Observation[]>()
  for (const obs of allObs) {
    if (!groupMap.has(obs.group)) groupMap.set(obs.group, [])
    groupMap.get(obs.group)!.push({ time: obs.time, event: obs.event })
  }

  const groupNames = [...groupMap.keys()].sort()

  const groups: GroupSurvival[] = groupNames.map(name => {
    const obs = groupMap.get(name)!
    const km = computeKM(obs, zCrit)
    return {
      name,
      steps: km.steps,
      medianSurvival: km.medianSurvival,
      medianCiLow: km.medianCiLow,
      medianCiHigh: km.medianCiHigh,
      totalN: obs.length,
      totalEvents: obs.filter(o => o.event).length,
    }
  })

  // Log-rank test (only if multiple groups)
  let logRank: LogRankResult | null = null
  if (groupNames.length >= 2) {
    const groupObs = groupNames.map(name => groupMap.get(name)!)
    logRank = logRankTest(groupObs)
  }

  return { groups, logRank, warnings }
}

// ===========================================================================
// Formatting
// ===========================================================================

function fmt(val: number, decimals = 2): string {
  if (!isFinite(val)) return DASH
  if (Math.abs(val) >= 1e6) return val.toExponential(2)
  return val.toFixed(decimals)
}

function fmtP(p: number): string {
  if (!isFinite(p)) return DASH
  if (p < 0.001) return '< 0.001'
  return p.toFixed(3)
}

/**
 * A number that may be absent.
 *
 * The Cox program returns null where a value overflowed — a near-separated fit
 * sends the hazard ratio past what a float can hold — so a dash here means
 * "not representable", not "not computed".
 */
function fmtOrDash(v: number | null, decimals = 2): string {
  return v === null ? DASH : fmt(v, decimals)
}

// ===========================================================================
// SVG Survival Curve
// ===========================================================================

/**
 * The plot's viewBox width and its left margin, in viewBox units.
 *
 * Shared with the summary table below the figure, which indents by their ratio
 * so its first column lines up with the start of the curves.
 */
const PLOT_BASE_WIDTH = { compact: 400, full: 600 } as const
const PLOT_MARGIN_LEFT = { compact: 35, full: 50 } as const

interface SurvivalPlotProps {
  groups: GroupSurvival[]
  showCI: boolean
  showCensor: boolean
  showMedian: boolean
  showAtRisk: boolean
  compact?: boolean
  timeLabel: string
  /** Already-translated axis title; the plot does no i18n of its own. */
  survivalLabel: string
  /** Already-translated caption for the at-risk rows. */
  atRiskLabel: string
  colors: string[]
  showGrid: boolean
}

function SurvivalPlot({ groups, showCI, showCensor, showMedian, showAtRisk, compact, timeLabel, survivalLabel, atRiskLabel, colors, showGrid }: SurvivalPlotProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const svgRef = useRef<SVGSVGElement>(null)

  // Responsive sizing
  const margin = {
    top: compact ? 10 : 20,
    right: compact ? 10 : 20,
    // With the at-risk block: the tick row, the time label, the "At risk"
    // caption, then TWO lines per group — its name, then its counts.
    bottom: showAtRisk
      ? groups.length * (compact ? 24 : 30) + (compact ? 34 : 46)
      : compact ? 25 : 35,
    left: PLOT_MARGIN_LEFT[compact ? 'compact' : 'full'],
  }

  const baseWidth = PLOT_BASE_WIDTH[compact ? 'compact' : 'full']
  // The viewBox GROWS with the at-risk block rather than the curves shrinking
  // to make room for it: plotHeight is baseHeight minus the margins, so a
  // five-group at-risk table on a fixed height left the curves squeezed into a
  // third of the box.
  const baseHeight = (compact ? 220 : 320) + (showAtRisk ? groups.length * (compact ? 24 : 30) : 0)

  // Find max time across all groups
  let maxTime = 0
  for (const g of groups) {
    for (const s of g.steps) {
      if (s.time > maxTime) maxTime = s.time
    }
  }
  if (maxTime <= 0) maxTime = 1

  // Nice axis ticks
  const nTicks = compact ? 5 : 8
  // The shared helper, not a local copy: these ticks label the x axis AND head
  // the at-risk columns, so they must round the same way as every other chart.
  const tickInterval = niceStep(maxTime / nTicks)
  const ticks: number[] = []
  for (let t = 0; t <= maxTime + tickInterval * 0.5; t += tickInterval) {
    ticks.push(Math.round(t * 1000) / 1000)
  }
  const xMax = ticks[ticks.length - 1] || maxTime

  const plotWidth = baseWidth - margin.left - margin.right
  const plotHeight = baseHeight - margin.top - margin.bottom

  // Widest legend label in characters, so every swatch lines up at the same x
  // instead of stepping in and out with each name's length.
  const legendTextWidth =
    groups.length > 1
      ? Math.min(compact ? 12 : 18, Math.max(...groups.map(g => g.name.length))) *
        (compact ? 4.4 : 5.4)
      : 0

  const xScale = (t: number) => margin.left + (t / xMax) * plotWidth
  const yScale = (s: number) => margin.top + (1 - s) * plotHeight

  // Build step-function path
  const buildPath = (steps: SurvivalStep[]): string => {
    if (steps.length === 0) return ''
    let d = `M ${xScale(steps[0].time)} ${yScale(steps[0].survival)}`
    for (let i = 1; i < steps.length; i++) {
      // Horizontal line to current time
      d += ` L ${xScale(steps[i].time)} ${yScale(steps[i - 1].survival)}`
      // Vertical drop
      d += ` L ${xScale(steps[i].time)} ${yScale(steps[i].survival)}`
    }
    return d
  }

  // Build CI area path (step-function upper and lower)
  const buildCIPath = (steps: SurvivalStep[]): string => {
    if (steps.length < 2) return ''
    // Upper path (forward)
    let d = `M ${xScale(steps[0].time)} ${yScale(steps[0].ciHigh)}`
    for (let i = 1; i < steps.length; i++) {
      d += ` L ${xScale(steps[i].time)} ${yScale(steps[i - 1].ciHigh)}`
      d += ` L ${xScale(steps[i].time)} ${yScale(steps[i].ciHigh)}`
    }
    // Lower path (backward)
    for (let i = steps.length - 1; i >= 1; i--) {
      d += ` L ${xScale(steps[i].time)} ${yScale(steps[i].ciLow)}`
      d += ` L ${xScale(steps[i].time)} ${yScale(steps[i - 1].ciLow)}`
    }
    d += ` L ${xScale(steps[0].time)} ${yScale(steps[0].ciLow)}`
    d += ' Z'
    return d
  }

  // Censor marks: censored observations (nCensor > 0)
  const getCensorMarks = (steps: SurvivalStep[]): { x: number; y: number }[] => {
    const marks: { x: number; y: number }[] = []
    for (let i = 1; i < steps.length; i++) {
      if (steps[i].nCensor > 0) {
        marks.push({ x: xScale(steps[i].time), y: yScale(steps[i].survival) })
      }
    }
    return marks
  }

  // At-risk numbers at tick times
  const getAtRisk = (steps: SurvivalStep[], t: number): number => {
    // Return the at-risk at the start of the interval containing t.
    for (let i = steps.length - 1; i >= 0; i--) {
      if (steps[i].time <= t) return steps[i].nRisk
    }
    return steps[0]?.nRisk ?? 0
  }

  const fontSize = compact ? 9 : 11
  const smallFontSize = compact ? 8 : 10

  return (
    <div ref={containerRef}>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${baseWidth} ${baseHeight}`}
        className="w-full text-foreground"
        style={{ maxHeight: baseHeight, fontSize }}
      >
        {/* Grid lines */}
        {[0, 0.25, 0.5, 0.75, 1].map(s => (
          <line key={s} x1={margin.left} x2={margin.left + plotWidth} y1={yScale(s)} y2={yScale(s)} stroke="currentColor" strokeWidth={0.5} opacity={0.1} />
        ))}
        {ticks.map(t => (
          <line key={t} x1={xScale(t)} x2={xScale(t)} y1={margin.top} y2={margin.top + plotHeight} stroke="currentColor" strokeWidth={0.5} opacity={0.1} />
        ))}

        {/* Median dashed line at S=0.5 */}
        {showMedian && (
          <line x1={margin.left} x2={margin.left + plotWidth} y1={yScale(0.5)} y2={yScale(0.5)} stroke="currentColor" strokeWidth={0.8} strokeDasharray="4,3" opacity={0.25} />
        )}

        {/* CI bands */}
        {showCI && groups.map((g, idx) => (
          <path key={`ci-${idx}`} d={buildCIPath(g.steps)} fill={colors[idx % colors.length]} opacity={0.12} />
        ))}

        {/* Step curves */}
        {groups.map((g, idx) => (
          <path key={`curve-${idx}`} d={buildPath(g.steps)} fill="none" stroke={colors[idx % colors.length]} strokeWidth={compact ? 1.5 : 2} />
        ))}

        {/* Censor marks */}
        {showCensor && groups.map((g, idx) => {
          const marks = getCensorMarks(g.steps)
          return marks.map((m, mi) => (
            <line key={`censor-${idx}-${mi}`} x1={m.x} y1={m.y - 4} x2={m.x} y2={m.y + 4} stroke={colors[idx % colors.length]} strokeWidth={1.5} />
          ))
        })}

        {/* Median vertical drop lines */}
        {showMedian && groups.map((g, idx) => {
          if (g.medianSurvival === null) return null
          const mx = xScale(g.medianSurvival)
          return (
            <line key={`median-${idx}`} x1={mx} y1={yScale(0.5)} x2={mx} y2={margin.top + plotHeight} stroke={colors[idx % colors.length]} strokeWidth={1} strokeDasharray="3,3" opacity={0.5} />
          )
        })}

        {/* Grid: a rule at each labelled survival level, so a reader can carry
            a value across to the axis without a straightedge. */}
        {showGrid && [0.25, 0.5, 0.75].map(g => (
          <line
            key={`grid-${g}`}
            x1={margin.left}
            x2={margin.left + plotWidth}
            y1={yScale(g)}
            y2={yScale(g)}
            stroke="currentColor"
            strokeDasharray="3 3"
            opacity={0.15}
          />
        ))}

        {/* Y axis */}
        <line x1={margin.left} x2={margin.left} y1={margin.top} y2={margin.top + plotHeight} stroke="currentColor" strokeWidth={1} opacity={0.3} />
        {[0, 0.25, 0.5, 0.75, 1].map(s => (
          <text key={s} x={margin.left - 4} y={yScale(s) + 3.5} textAnchor="end" fill="currentColor" opacity={0.6} fontSize={smallFontSize}>
            {(s * 100).toFixed(0)}%
          </text>
        ))}
        <text x={margin.left - (compact ? 22 : 32)} y={margin.top + plotHeight / 2} textAnchor="middle" fill="currentColor" opacity={0.5} fontSize={smallFontSize} transform={`rotate(-90, ${margin.left - (compact ? 22 : 32)}, ${margin.top + plotHeight / 2})`}>
          {survivalLabel}
        </text>

        {/* X axis */}
        <line x1={margin.left} x2={margin.left + plotWidth} y1={margin.top + plotHeight} y2={margin.top + plotHeight} stroke="currentColor" strokeWidth={1} opacity={0.3} />
        {ticks.map(t => (
          <text key={t} x={xScale(t)} y={margin.top + plotHeight + (compact ? 12 : 15)} textAnchor="middle" fill="currentColor" opacity={0.6} fontSize={smallFontSize}>
            {Number.isInteger(t) ? t : t.toFixed(1)}
          </text>
        ))}
        {timeLabel && (
          <text x={margin.left + plotWidth / 2} y={margin.top + plotHeight + (compact ? 22 : 28)} textAnchor="middle" fill="currentColor" opacity={0.5} fontSize={smallFontSize}>
            {timeLabel}
          </text>
        )}

        {/* At-risk table */}
        {showAtRisk && groups.length > 0 && (
          <text
            x={margin.left}
            y={margin.top + plotHeight + (compact ? 32 : 40)}
            fill="currentColor"
            opacity={0.5}
            fontSize={smallFontSize}
            fontWeight={600}
          >
            {atRiskLabel}
          </text>
        )}
        {showAtRisk && groups.map((g, idx) => {
          const yBase = margin.top + plotHeight + (compact ? 52 : 66) + idx * (compact ? 24 : 30)
          return (
            <g key={`atrisk-${idx}`}>
              {/* On its OWN line above the counts, not in the left gutter: the
                  gutter ends where the first tick is centred, so a right-anchored
                  name there ran straight into the count at time 0. */}
              <text x={margin.left} y={yBase - (compact ? 8 : 10)} textAnchor="start" fill={colors[idx % colors.length]} fontSize={smallFontSize} fontWeight={600}>
                <title>{g.name}</title>
                {g.name.length > (compact ? 16 : 24) ? g.name.slice(0, compact ? 14 : 22) + '…' : g.name}
              </text>
              {ticks.map(t => (
                <text key={t} x={xScale(t)} y={yBase + 4} textAnchor="middle" fill="currentColor" opacity={0.6} fontSize={smallFontSize}>
                  {getAtRisk(g.steps, t)}
                </text>
              ))}
            </g>
          )
        })}

        {/* Legend */}
        {groups.length > 1 && groups.map((g, idx) => {
          const lx = margin.left + plotWidth - (compact ? 4 : 8)
          const ly = margin.top + (compact ? 8 : 12) + idx * (compact ? 12 : 16)
          return (
            <g key={`legend-${idx}`}>
              {/* Anchored at the RIGHT edge and running leftwards: anchored at
                  the left, a long group name ran off the plot entirely. */}
              <line
                x1={lx - legendTextWidth - (compact ? 16 : 20)}
                y1={ly}
                x2={lx - legendTextWidth - 4}
                y2={ly}
                stroke={colors[idx % colors.length]}
                strokeWidth={2}
              />
              <text x={lx} y={ly + 3.5} textAnchor="end" fill="currentColor" opacity={0.8} fontSize={smallFontSize}>
                <title>{g.name}</title>
                {g.name.length > (compact ? 12 : 18) ? `${g.name.slice(0, compact ? 10 : 16)}…` : g.name}
              </text>
            </g>
          )
        })}
      </svg>
    </div>
  )
}

// ===========================================================================
// Component
// ===========================================================================

export function KaplanMeierComponent({ config, columns, rows, compact, datasetFileId, datasetFilters }: ComponentPluginProps) {
  const { t } = useTranslation()
  const server = isServerMode()
  const pluginName = usePluginName('kaplan-meier')

  const timeId = (config.timeColumn as string) ?? ''
  const eventId = (config.eventColumn as string) ?? ''
  const groupId = (config.groupColumn as string) || null
  const confidenceLevel = (config.confidenceLevel as number) ?? 95
  const showCI = (config.showCI as boolean) ?? true
  const showAtRisk = (config.showAtRisk as boolean) ?? true
  const showMedian = (config.showMedian as boolean) ?? true
  const showCensor = (config.showCensor as boolean) ?? true
  // Falls back to the time column's own label: an unnamed time axis is the
  // common case, and "Days since admission" is already recorded on the column.
  const timeColumn = columns.find((c) => c.id === timeId)
  const timeLabel =
    (config.timeLabel as string) || (timeColumn ? displayColumnName(timeColumn) : '')
  const wrap = config.wrap === true
  const showGrid = config.showGrid !== false
  // Matches the manifest default: tabs, so all three views are reachable
  // without the reader having to discover the Display setting first.
  const displayMode = (config.displayMode as DisplayMode) ?? 'both-tabs'
  // Which pane shows in tabs mode. Local, not persisted: it is a way of looking
  // at the result, not a property of the analysis.
  const [activeView, setActiveView] = useState<KmView>('plot')
  const colors = useMemo(
    () => resolvePalette((config.colorPalette as string) ?? 'default'),
    [config.colorPalette],
  )

  const localResult = useMemo(
    () => {
      if (server || !timeId || !eventId) return null
      return computeKMResult(rows, columns, timeId, eventId, groupId, confidenceLevel)
    },
    [server, rows, columns, timeId, eventId, groupId, confidenceLevel],
  )
  // Stable string keys so the effect only re-fetches on a semantic change.
  const spec = server && datasetFileId && timeId && eventId
    ? buildKaplanMeierSpec(columns, timeId, eventId, groupId, confidenceLevel)
    : null
  const specKey = spec ? JSON.stringify(spec) : null
  const filtersKey = JSON.stringify(datasetFilters ?? null)
  const [serverResult, setServerResult] = useState<KMResult | null>(null)
  const [serverError, setServerError] = useState<string | null>(null)
  const [serverLoaded, setServerLoaded] = useState(false)
  useEffect(() => {
    if (!server || !datasetFileId || !spec) return
    let cancelled = false
    renderOnServer('kaplan-meier', spec, { datasetFileId, datasetFilters })
      .then((out) => {
        if (cancelled) return
        setServerLoaded(true)
        if (out.stderr) { setServerError(out.stderr); return }
        try {
          const parsed = out.stdout.trim() === 'null' ? null : (JSON.parse(out.stdout.trim()) as KMResult)
          setServerResult(parsed); setServerError(null)
        } catch { setServerError(out.stdout || 'Failed to parse result') }
      })
      .catch((e) => { if (!cancelled) { setServerLoaded(true); setServerError(String(e)) } })
    return () => { cancelled = true }
  }, [server, datasetFileId, specKey, filtersKey]) // eslint-disable-line react-hooks/exhaustive-deps

  const result = server ? serverResult : localResult

  // --- Cox proportional hazards --------------------------------------------
  // Server only: the fit needs lifelines, and carrying a second implementation
  // of Newton-Raphson into the browser bundle to keep in parity is a worse
  // trade than telling the reader the tab needs a backend.
  const coxPredictorIds = useMemo(
    () => (config.coxPredictors as string[] | undefined) ?? [],
    [config.coxPredictors],
  )
  const coxSpec =
    server && datasetFileId && timeId && eventId && coxPredictorIds.length > 0
      ? buildCoxSpec(columns, timeId, eventId, coxPredictorIds, confidenceLevel)
      : null
  const coxSpecKey = coxSpec ? JSON.stringify(coxSpec) : null
  // Keyed by the spec it answers, so a result can never be shown for a
  // different model: dropping the predictors makes the key null and the fit
  // below is ignored, with no effect needed to clear it.
  const [coxFetched, setCoxFetched] = useState<{ key: string; result: CoxResult } | null>(null)
  const coxResult = coxFetched && coxFetched.key === coxSpecKey ? coxFetched.result : null
  // The error is keyed too, so a failure from a previous set of predictors is
  // not still on screen after the reader changes them.
  const [coxFailed, setCoxFailed] = useState<{ key: string; message: string } | null>(null)
  const coxError = coxFailed && coxFailed.key === coxSpecKey ? coxFailed.message : null
  const setCoxError = useCallback(
    (message: string | null) =>
      setCoxFailed(message !== null && coxSpecKey ? { key: coxSpecKey, message } : null),
    [coxSpecKey],
  )
  useEffect(() => {
    if (!coxSpecKey || !datasetFileId) return
    let cancelled = false
    renderOnServer('cox', JSON.parse(coxSpecKey), { datasetFileId, datasetFilters })
      .then((out) => {
        if (cancelled) return
        if (out.stderr) { setCoxError(out.stderr); return }
        try {
          setCoxFetched({ key: coxSpecKey, result: JSON.parse(out.stdout.trim()) as CoxResult })
          setCoxError(null)
        } catch { setCoxError(out.stdout || 'Failed to parse result') }
      })
      .catch((e) => { if (!cancelled) setCoxError(String(e)) })
    return () => { cancelled = true }
  }, [coxSpecKey, datasetFileId, filtersKey]) // eslint-disable-line react-hooks/exhaustive-deps

  const summaryRows = useMemo<KmRow[]>(
    () => (result?.groups ?? []).map((g, i) => ({ id: `${g.name}:${i}`, group: g, index: i })),
    [result],
  )

  const summaryColumns = useMemo<PublicationColumn<KmRow>[]>(
    () => [
      {
        id: 'group',
        header: t('analyses.km_col_group'),
        cell: (r) => (
          <span className="flex items-center gap-1.5">
            <span
              className="inline-block size-2.5 shrink-0 rounded-sm"
              style={{ backgroundColor: colors[r.index % colors.length] }}
            />
            {/* A single ungrouped curve has no group value to name. */}
            {r.group.name || t('analyses.km_overall')}
          </span>
        ),
        align: 'left',
        width: 180,
        minWidth: 100,
      },
      { id: 'n', header: 'n', cell: (r) => r.group.totalN, align: 'right', width: 70 },
      {
        id: 'events',
        header: t('analyses.km_col_events'),
        cell: (r) => r.group.totalEvents,
        align: 'right',
        width: 96,
      },
      {
        id: 'median',
        header: t('analyses.km_col_median'),
        // "not reached" rather than a dash: the curve never crossed 50%, which
        // is a result, where a dash reads as a value that could not be computed.
        cell: (r) =>
          r.group.medianSurvival !== null ? fmt(r.group.medianSurvival) : t('analyses.km_not_reached'),
        align: 'right',
        width: 110,
      },
      {
        id: 'ci',
        header: t('analyses.reg_col_ci', { level: confidenceLevel }),
        cell: (r) =>
          r.group.medianCiLow !== null && r.group.medianCiHigh !== null
            ? `[${fmt(r.group.medianCiLow)}, ${fmt(r.group.medianCiHigh)}]`
            : DASH,
        align: 'right',
        width: 130,
      },
    ],
    [t, colors, confidenceLevel],
  )

  // The spec sends storage NAMES, so the fit comes back naming its terms `site`
  // or `site: CH Vannes`. Relabel both the coefficients and the assumption
  // check, which names the same terms.
  const relabelCox = useMemo(() => coefficientRelabeler(columns), [columns])
  const coxRows = useMemo<CoxRow[]>(
    () =>
      (coxResult?.coefficients ?? []).map((c, i) => ({
        id: `${c.name}:${i}`,
        coef: { ...c, name: relabelCox(c.name) },
      })),
    [coxResult, relabelCox],
  )
  const coxPhRows = useMemo<CoxPhRow[]>(
    () =>
      (coxResult?.proportionalHazards ?? []).map((r, i) => ({
        id: `${r.name}:${i}`,
        name: relabelCox(r.name),
        statistic: r.statistic,
        pValue: r.pValue,
      })),
    [coxResult, relabelCox],
  )

  const coxPhColumns = useMemo<PublicationColumn<CoxPhRow>[]>(
    () => [
      {
        id: 'term',
        header: t('datasets.table1_variable'),
        cell: (r) => r.name,
        align: 'left',
        width: 200,
        minWidth: 110,
      },
      {
        id: 'chi2',
        // The Schoenfeld-residual test statistic. Reported rather than only its
        // p: a term can fail on a large sample at a size that does not matter.
        header: t('analyses.cox_ph_col_stat'),
        cell: (r) => fmtOrDash(r.statistic),
        align: 'right',
        width: 96,
      },
      {
        id: 'p',
        header: t('analyses.reg_col_p'),
        cell: (r) => (r.pValue !== null ? fmtP(r.pValue) : DASH),
        align: 'right',
        width: 104,
      },
      {
        id: 'verdict',
        header: t('analyses.cox_ph_col_verdict'),
        cell: (r) => {
          const violated = r.pValue !== null && r.pValue < 0.05
          return (
            <span className={cn(violated && 'font-semibold text-yellow-700 dark:text-yellow-400')}>
              {violated ? t('analyses.cox_ph_violated') : t('analyses.cox_ph_ok')}
            </span>
          )
        },
        align: 'right',
        width: 110,
      },
    ],
    [t],
  )

  const coxColumns = useMemo<PublicationColumn<CoxRow>[]>(
    () => [
      {
        id: 'term',
        header: t('datasets.table1_variable'),
        cell: (r) => r.coef.name,
        align: 'left',
        width: 200,
        minWidth: 110,
      },
      {
        id: 'hr',
        header: t('analyses.cox_col_hr'),
        cell: (r) => fmtOrDash(r.coef.hazardRatio),
        align: 'right',
        width: 96,
      },
      {
        id: 'ci',
        header: t('analyses.reg_col_ci', { level: confidenceLevel }),
        cell: (r) =>
          r.coef.ciLow !== null && r.coef.ciHigh !== null
            ? `[${fmt(r.coef.ciLow)}, ${fmt(r.coef.ciHigh)}]`
            : DASH,
        align: 'right',
        width: 132,
      },
      { id: 'z', header: 'z', cell: (r) => fmtOrDash(r.coef.z), align: 'right', width: 72 },
      {
        id: 'p',
        header: t('analyses.reg_col_p'),
        cell: (r) => (
          <span className={cn(r.coef.pValue !== null && r.coef.pValue < 0.05 && 'font-semibold text-foreground')}>
            {r.coef.pValue !== null ? fmtP(r.coef.pValue) : DASH}
          </span>
        ),
        align: 'right',
        width: 104,
      },
    ],
    [t, confidenceLevel],
  )

  // The Cox tab owns the Export menu while it is showing: exporting the group
  // summary while the reader is looking at a model would be the wrong table.
  const showingCox = displayMode === 'cox' || (displayMode === 'both-tabs' && activeView === 'cox')
  usePublishAnalysisTable(
    showingCox
      ? coxRows.length > 0
        ? () => toCoxExportTable(coxRows, coxColumns)
        : null
      : summaryRows.length > 0
        ? () => toExportTable(summaryRows, summaryColumns, t)
        : null,
    [showingCox, coxRows, coxColumns, summaryRows, summaryColumns, t],
  )


  if (server && serverError) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-muted-foreground">
        <AlertTriangle size={24} className="opacity-40" />
        <p className="text-xs whitespace-pre-wrap">{serverError}</p>
      </div>
    )
  }

  // Empty states
  if (columns.length === 0 || (!server && rows.length === 0)) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-muted-foreground">
        <Activity size={24} className="opacity-40" />
        <p className="text-xs">{t('analyses.no_data')}</p>
      </div>
    )
  }

  if (!timeId || !eventId) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-muted-foreground">
        <Activity size={24} className="opacity-40" />
        <p className="text-xs">
          {t('analyses.km_select_columns')}
        </p>
      </div>
    )
  }

  // Server mode: hold the frame until the fit returns.
  if (server && !serverLoaded) {
    return <AnalysisLoading icon={Activity} name={pluginName} compact={compact} />
  }

  if (!result || result.groups.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-muted-foreground">
        <AlertTriangle size={24} className="opacity-40" />
        <p className="text-xs">{t('analyses.km_failed')}</p>
      </div>
    )
  }

  const plotView = (
    <SurvivalPlot
      groups={result.groups}
      showCI={showCI}
      showCensor={showCensor}
      showMedian={showMedian}
      showAtRisk={showAtRisk}
      compact={compact}
      timeLabel={timeLabel}
      survivalLabel={t('analyses.km_survival')}
      atRiskLabel={t('analyses.km_at_risk')}
      colors={colors}
      showGrid={showGrid}
    />
  )

  const tableView = (
    // Indented by the plot's own left margin so the table's first column starts
    // where the curves start, rather than out at the pane edge under the axis
    // labels. The margin is a fraction of the viewBox and the SVG scales to the
    // width, so the inset is a percentage — a pixel value would drift on resize.
    <div
      className="h-full overflow-auto"
      style={{ paddingLeft: `${(PLOT_MARGIN_LEFT[compact ? 'compact' : 'full'] / PLOT_BASE_WIDTH[compact ? 'compact' : 'full']) * 100}%` }}
    >
      <PublicationTable rows={summaryRows} columns={summaryColumns} wrap={wrap} />
      {/* Log-rank travels with the table: it is a number to read, not part of
          the figure, and a curve pane showing a p-value with no table to put
          it beside reads as a stray caption. */}
      {result.logRank && (
        <div className={cn('mt-3 text-muted-foreground', compact ? 'text-[9px]' : 'text-[11px]')}>
          <span className="font-semibold text-foreground">
            {t('analyses.km_logrank')}
          </span>
          {' '}{DASH}{' '}
          <span>χ² = {fmt(result.logRank.chiSquare)}, df = {result.logRank.df}, p = {fmtP(result.logRank.pValue)}</span>
          {result.logRank.pValue < 0.05 && (
            <span className="ml-1 font-semibold text-green-600 dark:text-green-400">
              {result.logRank.pValue < 0.001 ? '***' : result.logRank.pValue < 0.01 ? '**' : '*'}
            </span>
          )}
        </div>
      )}
    </div>
  )

  const coxView = (
    // Centred and capped: the tables are ~5 narrow columns, so a wide pane left
    // them stretched across the whole width with the numbers far from their
    // labels. `mx-auto` on a max-width keeps them a readable block.
    <div
      className={cn(
        'mx-auto h-full w-full max-w-3xl overflow-auto',
        compact ? 'text-[9px]' : 'text-[11px]',
      )}
    >
      {!server ? (
        // Stated plainly rather than hidden: the reader who picked this tab
        // needs to know the analysis exists and what it would take to run it.
        <Placeholder text={t('analyses.cox_server_only')} />
      ) : coxPredictorIds.length === 0 ? (
        <Placeholder text={t('analyses.cox_select_predictors')} />
      ) : coxError ? (
        <Placeholder text={coxError} />
      ) : !coxResult ? (
        <Placeholder text={t('common.loading')} />
      ) : coxResult.error ? (
        <Placeholder text={coxResult.error} />
      ) : (
        <>
          {/* Model summary: the fit's size and how well it separates. */}
          <div className={cn('mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-muted-foreground')}>
            <span className="font-semibold text-foreground">{t('analyses.cox_title')}</span>
            <span>n = {coxResult.nObs}</span>
            <span>{t('analyses.cox_events')} = {coxResult.nEvents}</span>
            {coxResult.concordance !== null && (
              <span title={t('analyses.cox_concordance_hint')}>
                C = {fmt(coxResult.concordance)}
              </span>
            )}
            {coxResult.aic !== null && <span>AIC = {fmt(coxResult.aic, 1)}</span>}
            {coxResult.logLikelihoodRatioTest?.pValue != null && (
              <span>
                {t('analyses.cox_lr_test')} p = {fmtP(coxResult.logLikelihoodRatioTest.pValue)}
              </span>
            )}
          </div>

          {coxResult.warnings.length > 0 && (
            <div className={cn('mb-3 rounded border border-yellow-300/50 bg-yellow-50/50 dark:bg-yellow-900/10', compact ? 'px-2 py-1' : 'px-3 py-1.5')}>
              {coxResult.warnings.map((w, i) => (
                <div key={i} className="flex items-start gap-1.5 text-yellow-700 dark:text-yellow-400">
                  <AlertTriangle size={compact ? 10 : 12} className="mt-0.5 shrink-0" />
                  <span>{w}</span>
                </div>
              ))}
            </div>
          )}

          <PublicationTable rows={coxRows} columns={coxColumns} wrap={wrap} center />

          {/* The proportional-hazards check. A hazard ratio is one number for
              the whole follow-up, which only means anything if the effect is
              in fact constant over it — so a failing term is reported next to
              the estimate it qualifies, not buried. */}
          {coxPhRows.length > 0 && (
            <div className="mt-4">
              <div className="mb-1 font-semibold text-foreground">
                {t('analyses.cox_ph_title')}
              </div>
              <div className="mb-2 text-muted-foreground">{t('analyses.cox_ph_hint')}</div>
              <PublicationTable rows={coxPhRows} columns={coxPhColumns} wrap={wrap} center />
            </div>
          )}
        </>
      )}
    </div>
  )

  return (
    <div className={cn('flex h-full flex-col overflow-hidden', compact ? 'p-2' : 'p-4')}>
      {/* Warnings */}
      {result.warnings.length > 0 && (
        <div className={cn('mb-3 shrink-0 rounded border border-yellow-300/50 bg-yellow-50/50 dark:bg-yellow-900/10', compact ? 'px-2 py-1 text-[9px]' : 'px-3 py-1.5 text-[11px]')}>
          {result.warnings.map((w, i) => (
            <div key={i} className="flex items-start gap-1.5 text-yellow-700 dark:text-yellow-400">
              <AlertTriangle size={compact ? 10 : 12} className="mt-0.5 shrink-0" />
              <span>{kmWarningText(w, t)}</span>
            </div>
          ))}
        </div>
      )}

      {/* Tabs, when the two views share the panel by switching. */}
      {displayMode === 'both-tabs' && (
        <div className="mb-3 flex shrink-0 items-center justify-center gap-1">
          {([
            ['plot', Activity, t('analyses.km_view_plot')],
            ['table', TableIcon, t('analyses.km_view_table')],
            ['cox', TrendingUp, t('analyses.cox_view')],
          ] as const).map(([view, Icon, label]) => (
            <button
              key={view}
              type="button"
              onClick={() => setActiveView(view)}
              className={cn(
                'flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium transition-colors',
                activeView === view
                  ? 'bg-muted text-foreground'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              <Icon size={12} />
              {label}
            </button>
          ))}
        </div>
      )}

      {/* The curves and the summary, laid out as the Display setting asks.
          Stacked uses Allotment so the divider is draggable, matching Sankey
          and regression. The figure leads: this is a survival analysis. */}
      <div className="min-h-0 flex-1">
        {displayMode === 'both' ? (
          <Allotment vertical>
            <Allotment.Pane minSize={80}>
              <div className="h-full overflow-auto">{plotView}</div>
            </Allotment.Pane>
            {/* Sized from the content: one row per group plus a header and the
                log-rank line, rather than a fixed share that left the table
                scrolling while the curves had room to spare. */}
            <Allotment.Pane
              minSize={80}
              preferredSize={Math.min((summaryRows.length + 1) * 26 + 40, 320)}
            >
              <div className="h-full overflow-auto border-t border-border pt-2">{tableView}</div>
            </Allotment.Pane>
          </Allotment>
        ) : displayMode === 'both-tabs' ? (
          <div className="h-full overflow-auto">
            {activeView === 'cox' ? coxView : activeView === 'table' ? tableView : plotView}
          </div>
        ) : displayMode === 'cox' ? (
          coxView
        ) : displayMode === 'table' ? (
          tableView
        ) : (
          <div className="h-full overflow-auto">{plotView}</div>
        )}
      </div>
    </div>
  )
}


/** A centred message inside the Cox pane — empty state, error, or loading. */
function Placeholder({ text }: { text: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center text-muted-foreground">
      <p className="whitespace-pre-wrap">{text}</p>
    </div>
  )
}

/** The Cox coefficients as plain text, for copy / LaTeX. */
function toCoxExportTable(rows: CoxRow[], columns: PublicationColumn<CoxRow>[]): ExportTable {
  const head: ExportTableCell[][] = [columns.map((c) => ({ text: c.header, align: c.align }))]
  const body = rows.map((r) =>
    columns.map((c) => {
      const k = r.coef
      switch (c.id) {
        case 'term':
          return { text: k.name, align: c.align }
        case 'hr':
          return { text: fmtOrDash(k.hazardRatio), align: c.align }
        case 'ci':
          return {
            text:
              k.ciLow !== null && k.ciHigh !== null
                ? `[${fmt(k.ciLow)}, ${fmt(k.ciHigh)}]`
                : DASH,
            align: c.align,
          }
        case 'z':
          return { text: fmtOrDash(k.z), align: c.align }
        case 'p':
          return { text: k.pValue !== null ? fmtP(k.pValue) : DASH, align: c.align }
        default:
          return { text: '', align: c.align }
      }
    }),
  )
  return { head, body }
}

/** The summary table as plain text, for copy / LaTeX. */
function toExportTable(
  rows: KmRow[],
  columns: PublicationColumn<KmRow>[],
  t: TFunction,
): ExportTable {
  const head: ExportTableCell[][] = [columns.map((c) => ({ text: c.header, align: c.align }))]
  const body = rows.map((r) =>
    columns.map((c) => {
      const g = r.group
      switch (c.id) {
        case 'group':
          return { text: g.name || t('analyses.km_overall'), align: c.align }
        case 'n':
          return { text: String(g.totalN), align: c.align }
        case 'events':
          return { text: String(g.totalEvents), align: c.align }
        case 'median':
          return {
            text: g.medianSurvival !== null ? fmt(g.medianSurvival) : t('analyses.km_not_reached'),
            align: c.align,
          }
        case 'ci':
          return {
            text:
              g.medianCiLow !== null && g.medianCiHigh !== null
                ? `[${fmt(g.medianCiLow)}, ${fmt(g.medianCiHigh)}]`
                : DASH,
            align: c.align,
          }
        default:
          return { text: '', align: c.align }
      }
    }),
  )
  return { head, body }
}


/**
 * A Kaplan-Meier warning, said in the reader's language.
 *
 * A plain string passes through: the server's pandas program emits finished
 * English sentences, and showing one untranslated beats dropping a warning
 * about excluded rows.
 */
function kmWarningText(w: KmWarning, t: TFunction): string {
  if (typeof w === 'string') return w
  return w.code === 'rows_excluded'
    ? t('analyses.km_rows_excluded', { count: w.count })
    : t('analyses.km_no_observations')
}
