import { useMemo, useRef, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Activity, AlertTriangle } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { ComponentPluginProps } from '@/lib/plugins/component-registry'

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
  warnings: string[]
}

const DASH = '\u2014'

// ===========================================================================
// Color palette
// ===========================================================================

const COLORS = [
  '#4e79a7', '#e15759', '#59a14f', '#f28e2b', '#76b7b2',
  '#edc949', '#af7aa1', '#ff9da7', '#9c755f', '#bab0ab',
]

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
  columns: { id: string; name: string; type: string }[],
  timeId: string,
  eventId: string,
  groupId: string | null,
  confidenceLevel: number,
): KMResult {
  const warnings: string[] = []
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
    warnings.push(`${nMissing} row(s) excluded (missing/invalid values)`)
  }

  if (allObs.length === 0) {
    return { groups: [], logRank: null, warnings: [...warnings, 'No valid observations'] }
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

// ===========================================================================
// SVG Survival Curve
// ===========================================================================

interface SurvivalPlotProps {
  groups: GroupSurvival[]
  showCI: boolean
  showCensor: boolean
  showMedian: boolean
  showAtRisk: boolean
  compact?: boolean
  timeLabel: string
  lang: 'en' | 'fr'
}

function SurvivalPlot({ groups, showCI, showCensor, showMedian, showAtRisk, compact, timeLabel, lang }: SurvivalPlotProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const svgRef = useRef<SVGSVGElement>(null)

  // Responsive sizing
  const margin = {
    top: compact ? 10 : 20,
    right: compact ? 10 : 20,
    bottom: (showAtRisk ? groups.length * (compact ? 14 : 18) + (compact ? 20 : 30) : (compact ? 25 : 35)),
    left: compact ? 35 : 50,
  }

  const baseWidth = compact ? 400 : 600
  const baseHeight = compact ? 220 : 320

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
  const tickInterval = niceInterval(maxTime, nTicks)
  const ticks: number[] = []
  for (let t = 0; t <= maxTime + tickInterval * 0.5; t += tickInterval) {
    ticks.push(Math.round(t * 1000) / 1000)
  }
  const xMax = ticks[ticks.length - 1] || maxTime

  const plotWidth = baseWidth - margin.left - margin.right
  const plotHeight = baseHeight - margin.top - margin.bottom

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
    let nRisk = 0
    for (const step of steps) {
      if (step.time <= t) nRisk = step.nRisk - step.nEvent - step.nCensor
      else break
    }
    // Return the at-risk at the start of that interval
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
          <path key={`ci-${idx}`} d={buildCIPath(g.steps)} fill={COLORS[idx % COLORS.length]} opacity={0.12} />
        ))}

        {/* Step curves */}
        {groups.map((g, idx) => (
          <path key={`curve-${idx}`} d={buildPath(g.steps)} fill="none" stroke={COLORS[idx % COLORS.length]} strokeWidth={compact ? 1.5 : 2} />
        ))}

        {/* Censor marks */}
        {showCensor && groups.map((g, idx) => {
          const marks = getCensorMarks(g.steps)
          return marks.map((m, mi) => (
            <line key={`censor-${idx}-${mi}`} x1={m.x} y1={m.y - 4} x2={m.x} y2={m.y + 4} stroke={COLORS[idx % COLORS.length]} strokeWidth={1.5} />
          ))
        })}

        {/* Median vertical drop lines */}
        {showMedian && groups.map((g, idx) => {
          if (g.medianSurvival === null) return null
          const mx = xScale(g.medianSurvival)
          return (
            <line key={`median-${idx}`} x1={mx} y1={yScale(0.5)} x2={mx} y2={margin.top + plotHeight} stroke={COLORS[idx % COLORS.length]} strokeWidth={1} strokeDasharray="3,3" opacity={0.5} />
          )
        })}

        {/* Y axis */}
        <line x1={margin.left} x2={margin.left} y1={margin.top} y2={margin.top + plotHeight} stroke="currentColor" strokeWidth={1} opacity={0.3} />
        {[0, 0.25, 0.5, 0.75, 1].map(s => (
          <text key={s} x={margin.left - 4} y={yScale(s) + 3.5} textAnchor="end" fill="currentColor" opacity={0.6} fontSize={smallFontSize}>
            {(s * 100).toFixed(0)}%
          </text>
        ))}
        <text x={margin.left - (compact ? 22 : 32)} y={margin.top + plotHeight / 2} textAnchor="middle" fill="currentColor" opacity={0.5} fontSize={smallFontSize} transform={`rotate(-90, ${margin.left - (compact ? 22 : 32)}, ${margin.top + plotHeight / 2})`}>
          {lang === 'fr' ? 'Survie' : 'Survival'}
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
        {showAtRisk && groups.map((g, idx) => {
          const yBase = margin.top + plotHeight + (compact ? 28 : 35) + idx * (compact ? 14 : 18)
          return (
            <g key={`atrisk-${idx}`}>
              <text x={margin.left - 4} y={yBase + 4} textAnchor="end" fill={COLORS[idx % COLORS.length]} fontSize={smallFontSize} fontWeight={600}>
                {g.name.length > (compact ? 8 : 12) ? g.name.slice(0, compact ? 6 : 10) + '…' : g.name}
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
          const lx = margin.left + plotWidth - (compact ? 8 : 12)
          const ly = margin.top + (compact ? 8 : 12) + idx * (compact ? 12 : 16)
          return (
            <g key={`legend-${idx}`}>
              <line x1={lx - (compact ? 16 : 20)} y1={ly} x2={lx - 4} y2={ly} stroke={COLORS[idx % COLORS.length]} strokeWidth={2} />
              <text x={lx} y={ly + 3.5} fill="currentColor" opacity={0.8} fontSize={smallFontSize}>
                {g.name}
              </text>
            </g>
          )
        })}
      </svg>
    </div>
  )
}

/** Compute a nice tick interval for an axis. */
function niceInterval(maxVal: number, targetTicks: number): number {
  const rough = maxVal / targetTicks
  const mag = Math.pow(10, Math.floor(Math.log10(rough)))
  const residual = rough / mag
  let nice: number
  if (residual <= 1.5) nice = 1
  else if (residual <= 3) nice = 2
  else if (residual <= 7) nice = 5
  else nice = 10
  return nice * mag
}

// ===========================================================================
// Component
// ===========================================================================

export function KaplanMeierComponent({ config, columns, rows, compact }: ComponentPluginProps) {
  const { i18n } = useTranslation()
  const lang = (i18n.language === 'fr' ? 'fr' : 'en') as 'en' | 'fr'

  const timeId = (config.timeColumn as string) ?? ''
  const eventId = (config.eventColumn as string) ?? ''
  const groupId = (config.groupColumn as string) || null
  const confidenceLevel = (config.confidenceLevel as number) ?? 95
  const showCI = (config.showCI as boolean) ?? true
  const showAtRisk = (config.showAtRisk as boolean) ?? true
  const showMedian = (config.showMedian as boolean) ?? true
  const showCensor = (config.showCensor as boolean) ?? true
  const timeLabel = (config.timeLabel as string) ?? ''

  const result = useMemo(
    () => {
      if (!timeId || !eventId) return null
      return computeKMResult(rows, columns, timeId, eventId, groupId, confidenceLevel)
    },
    [rows, columns, timeId, eventId, groupId, confidenceLevel],
  )

  // Empty states
  if (columns.length === 0 || rows.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-muted-foreground">
        <Activity size={24} className="opacity-40" />
        <p className="text-xs">{lang === 'fr' ? 'Aucune donnée disponible.' : 'No data available.'}</p>
      </div>
    )
  }

  if (!timeId || !eventId) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-muted-foreground">
        <Activity size={24} className="opacity-40" />
        <p className="text-xs">
          {lang === 'fr'
            ? 'Sélectionnez les variables de temps et d\u2019événement.'
            : 'Select the time and event variables.'}
        </p>
      </div>
    )
  }

  if (!result || result.groups.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-muted-foreground">
        <AlertTriangle size={24} className="opacity-40" />
        <p className="text-xs">{lang === 'fr' ? 'Impossible de calculer les courbes.' : 'Unable to compute survival curves.'}</p>
      </div>
    )
  }

  return (
    <div className={cn('h-full overflow-auto', compact ? 'p-2' : 'p-4')}>
      {/* Warnings */}
      {result.warnings.length > 0 && (
        <div className={cn('mb-3 rounded border border-yellow-300/50 bg-yellow-50/50 dark:bg-yellow-900/10', compact ? 'px-2 py-1 text-[9px]' : 'px-3 py-1.5 text-[11px]')}>
          {result.warnings.map((w, i) => (
            <div key={i} className="flex items-start gap-1.5 text-yellow-700 dark:text-yellow-400">
              <AlertTriangle size={compact ? 10 : 12} className="mt-0.5 shrink-0" />
              <span>{w}</span>
            </div>
          ))}
        </div>
      )}

      {/* Survival plot */}
      <SurvivalPlot
        groups={result.groups}
        showCI={showCI}
        showCensor={showCensor}
        showMedian={showMedian}
        showAtRisk={showAtRisk}
        compact={compact}
        timeLabel={timeLabel}
        lang={lang}
      />

      {/* Summary table */}
      <div className={cn('mt-3', compact && 'mt-2')}>
        <table className={cn('w-full border-collapse', compact ? 'text-[10px]' : 'text-xs')}>
          <thead>
            <tr className="bg-muted">
              <th className={cn('border-b border-r font-medium text-left', compact ? 'px-2 py-0.5' : 'px-3 py-1.5')}>
                {lang === 'fr' ? 'Groupe' : 'Group'}
              </th>
              <th className={cn('border-b border-r font-medium text-left', compact ? 'px-2 py-0.5' : 'px-3 py-1.5')}>n</th>
              <th className={cn('border-b border-r font-medium text-left', compact ? 'px-2 py-0.5' : 'px-3 py-1.5')}>
                {lang === 'fr' ? 'Événements' : 'Events'}
              </th>
              <th className={cn('border-b border-r font-medium text-left', compact ? 'px-2 py-0.5' : 'px-3 py-1.5')}>
                {lang === 'fr' ? 'Médiane' : 'Median'}
              </th>
              <th className={cn('border-b font-medium text-left', compact ? 'px-2 py-0.5' : 'px-3 py-1.5')}>
                {`${confidenceLevel}% CI`}
              </th>
            </tr>
          </thead>
          <tbody>
            {result.groups.map((g, idx) => (
              <tr key={idx} className={cn('transition-colors hover:bg-accent/30', idx % 2 === 1 && 'bg-muted/30')}>
                <td className={cn('border-b border-r font-medium', compact ? 'px-2 py-0.5' : 'px-3 py-1.5')}>
                  <span className="inline-block w-2.5 h-2.5 rounded-sm mr-1.5" style={{ backgroundColor: COLORS[idx % COLORS.length] }} />
                  {g.name}
                </td>
                <td className={cn('border-b border-r', compact ? 'px-2 py-0.5' : 'px-3 py-1.5')}>{g.totalN}</td>
                <td className={cn('border-b border-r', compact ? 'px-2 py-0.5' : 'px-3 py-1.5')}>{g.totalEvents}</td>
                <td className={cn('border-b border-r', compact ? 'px-2 py-0.5' : 'px-3 py-1.5')}>
                  {g.medianSurvival !== null ? fmt(g.medianSurvival) : DASH}
                </td>
                <td className={cn('border-b', compact ? 'px-2 py-0.5' : 'px-3 py-1.5')}>
                  {g.medianCiLow !== null && g.medianCiHigh !== null
                    ? `[${fmt(g.medianCiLow)}, ${fmt(g.medianCiHigh)}]`
                    : DASH}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Log-rank test */}
      {result.logRank && (
        <div className={cn('mt-3 text-muted-foreground', compact ? 'text-[9px]' : 'text-[11px]')}>
          <span className="font-semibold text-foreground">
            {lang === 'fr' ? 'Test du log-rank' : 'Log-rank test'}
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
}
