import { useCallback, useMemo, useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { FlaskConical, AlertTriangle, Check, ChevronDown } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import { isServerMode } from '@/lib/api-client'
import {
  defaultAnalysisColumns,
  orderSelection,
  type VariableOrder,
} from '@/lib/analysis-default-columns'
import { displayColumnName } from '@/lib/dataset-utils'
import { PublicationTable, type PublicationColumn } from '@/components/ui/publication-table'
import { AnalysisLoading, usePluginName } from '@/components/ui/analysis-loading'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { groupsLookNormal } from '@/lib/stats/normality'
import { applicableTests, overrideApplies, type TestName } from '@/lib/stats/applicable-tests'
import { renderOnServer } from '@/lib/api/execution'
import type { ComponentPluginProps } from '@/lib/plugins/component-registry'
import { buildStatisticalTestsSpec } from './statistical-tests-server'
import { usePublishAnalysisTable } from './analysis-table-context'
import type { ExportTable, ExportTableCell } from '@/lib/table-export'

// ===========================================================================
// Types
// ===========================================================================



interface TestResult {
  variable: string
  variableType: 'numeric' | 'categorical'
  testName: TestName
  testLabel: { en: string; fr: string }
  statistic: number | null
  statisticLabel: string
  df: number | null
  pValue: number | null
  ci: [number, number] | null
  effectSize: number | null
  effectSizeLabel: string
  groupDescriptives: GroupDescriptive[] | null
  warning: string | null
  /**
   * Why THIS test, in one sentence, for the hover on the test name.
   *
   * Optional because the server computes results too and may not send it; the
   * cell then shows the name alone rather than an empty tooltip.
   */
  rationale?: { en: string; fr: string }
}

/** A result plus the label the table prints for it. */
interface StatRow {
  id: string
  result: TestResult
  label: string
  /** The dataset column this row tests, which keys its per-variable override. */
  columnId: string | undefined
}

interface GroupDescriptive {
  groupName: string
  n: number
  mean?: number
  sd?: number
  median?: number
  freqs?: { category: string; count: number; pct: number }[]
}

// ===========================================================================
// Test labels
// ===========================================================================

const TEST_LABELS: Record<TestName, { en: string; fr: string }> = {
  'welch-t': { en: "Welch's t-test", fr: 'Test t de Welch' },
  'mann-whitney': { en: 'Mann-Whitney U', fr: 'Mann-Whitney U' },
  'chi-square': { en: 'Chi-squared', fr: 'Chi-deux' },
  fisher: { en: "Fisher's exact", fr: 'Test exact de Fisher' },
  anova: { en: 'One-way ANOVA', fr: 'ANOVA à un facteur' },
  'kruskal-wallis': { en: 'Kruskal-Wallis', fr: 'Kruskal-Wallis' },
}

const STAT_LABELS: Record<TestName, string> = {
  'welch-t': 't',
  'mann-whitney': 'U',
  'chi-square': 'χ²',
  fisher: '',
  anova: 'F',
  'kruskal-wallis': 'H',
}

const EFFECT_SIZE_LABELS: Record<TestName, string> = {
  'welch-t': "Cohen's d",
  'mann-whitney': 'r',
  'chi-square': "Cramér's V",
  fisher: "Cramér's V",
  anova: 'η²',
  'kruskal-wallis': 'η²_H',
}

const DASH = '\u2014'

// ===========================================================================
// Math helpers
// ===========================================================================

function mean(arr: number[]): number {
  let s = 0
  for (let i = 0; i < arr.length; i++) s += arr[i]
  return s / arr.length
}

function variance(arr: number[], ddof = 1): number {
  const m = mean(arr)
  let s = 0
  for (let i = 0; i < arr.length; i++) s += (arr[i] - m) ** 2
  return s / (arr.length - ddof)
}

function medianVal(arr: number[]): number {
  const sorted = [...arr].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

function sdVal(arr: number[]): number {
  return Math.sqrt(variance(arr, 1))
}

/** Assign average ranks; return ranks array + tie group sizes. */
function rankData(values: number[]): { ranks: number[]; tieGroups: number[] } {
  const indexed = values.map((v, i) => ({ v, i }))
  indexed.sort((a, b) => a.v - b.v)
  const ranks = new Array<number>(values.length)
  const tieGroups: number[] = []
  let i = 0
  while (i < indexed.length) {
    let j = i
    while (j < indexed.length && indexed[j].v === indexed[i].v) j++
    const avgRank = (i + 1 + j) / 2 // 1-based
    const tieSize = j - i
    if (tieSize > 1) tieGroups.push(tieSize)
    for (let k = i; k < j; k++) ranks[indexed[k].i] = avgRank
    i = j
  }
  return { ranks, tieGroups }
}

function extractNumbers(values: unknown[]): number[] {
  const nums: number[] = []
  for (const v of values) {
    if (v == null || v === '' || String(v).toLowerCase() === 'null') continue
    const n = typeof v === 'number' ? v : Number(v)
    if (!isNaN(n)) nums.push(n)
  }
  return nums
}

function isNotMissing(v: unknown): boolean {
  return v != null && v !== '' && String(v).toLowerCase() !== 'null'
}

// ===========================================================================
// Distribution CDFs (pure JS implementations)
// ===========================================================================

/** Lanczos approximation of ln(Gamma(x)). */
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

function logBeta(a: number, b: number): number {
  return gammaLn(a) + gammaLn(b) - gammaLn(a + b)
}

/**
 * Regularized incomplete beta function I_x(a, b)
 * using continued fraction (Lentz's method).
 */
function regularizedBeta(a: number, b: number, x: number): number {
  if (x <= 0) return 0
  if (x >= 1) return 1

  // Use symmetry for better convergence
  if (x > (a + 1) / (a + b + 2)) {
    return 1 - regularizedBeta(b, a, 1 - x)
  }

  const lnPrefix = a * Math.log(x) + b * Math.log(1 - x) - logBeta(a, b) - Math.log(a)

  // Continued fraction expansion
  const maxIter = 200
  const eps = 1e-14
  let h = 1
  let denom = 1
  let prev = 1

  for (let m = 1; m <= maxIter; m++) {
    // Even step: d_{2m}
    const m2 = 2 * m
    let numerator = (m * (b - m) * x) / ((a + m2 - 1) * (a + m2))
    denom = 1 + numerator / denom
    if (Math.abs(denom) < 1e-30) denom = 1e-30
    denom = 1 / denom
    prev = 1 + numerator / prev
    if (Math.abs(prev) < 1e-30) prev = 1e-30
    h *= denom * prev

    // Odd step: d_{2m+1}
    numerator = -((a + m) * (a + b + m) * x) / ((a + m2) * (a + m2 + 1))
    denom = 1 + numerator / denom
    if (Math.abs(denom) < 1e-30) denom = 1e-30
    denom = 1 / denom
    prev = 1 + numerator / prev
    if (Math.abs(prev) < 1e-30) prev = 1e-30
    const delta = denom * prev
    h *= delta

    if (Math.abs(delta - 1) < eps) break
  }

  return Math.exp(lnPrefix) * h
}

/** Lower regularized incomplete gamma function P(a, x). */
function regularizedGamma(a: number, x: number): number {
  if (x <= 0) return 0
  if (x < a + 1) {
    // Series expansion
    let sum = 1 / a
    let term = 1 / a
    for (let n = 1; n < 200; n++) {
      term *= x / (a + n)
      sum += term
      if (Math.abs(term) < Math.abs(sum) * 1e-14) break
    }
    return sum * Math.exp(-x + a * Math.log(x) - gammaLn(a))
  }
  // Continued fraction for upper gamma
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

/** CDF of the standard normal distribution. */
function normalCDF(z: number): number {
  // Abramowitz & Stegun approximation 26.2.17
  if (z < -8) return 0
  if (z > 8) return 1
  const a1 = 0.254829592
  const a2 = -0.284496736
  const a3 = 1.421413741
  const a4 = -1.453152027
  const a5 = 1.061405429
  const p = 0.3275911
  const sign = z < 0 ? -1 : 1
  const x = Math.abs(z) / Math.sqrt(2)
  const t = 1 / (1 + p * x)
  const y = 1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-x * x)
  return 0.5 * (1 + sign * y)
}

/** CDF of Student's t distribution (two-tailed p-value helper). */
function tCDF(t: number, df: number): number {
  const x = df / (df + t * t)
  const p = 0.5 * regularizedBeta(df / 2, 0.5, x)
  return t >= 0 ? 1 - p : p
}

/** Two-tailed p-value from t distribution. */
function tTestPValue(t: number, df: number): number {
  return 2 * Math.min(tCDF(t, df), 1 - tCDF(t, df))
}

/** CDF of the chi-square distribution. */
function chiSquareCDF(x: number, k: number): number {
  if (x <= 0) return 0
  return regularizedGamma(k / 2, x / 2)
}

/** CDF of the F distribution. */
function fCDF(f: number, d1: number, d2: number): number {
  if (f <= 0) return 0
  const x = (d1 * f) / (d1 * f + d2)
  return regularizedBeta(d1 / 2, d2 / 2, x)
}

/** Inverse of the standard normal CDF (Beasley-Springer-Moro algorithm). */
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
    return (
      (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    )
  } else if (p <= pHigh) {
    q = p - 0.5
    r = q * q
    return (
      ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) /
      (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)
    )
  } else {
    q = Math.sqrt(-2 * Math.log(1 - p))
    return (
      -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    )
  }
}

/** Inverse t-CDF via Newton-Raphson. */
function inverseTCDF(p: number, df: number): number {
  if (df >= 300) return inverseNormalCDF(p)
  // Newton-Raphson starting from normal approx
  let x = inverseNormalCDF(p)
  for (let i = 0; i < 10; i++) {
    const cdf = tCDF(x, df)
    // t PDF
    const logPdf =
      gammaLn((df + 1) / 2) -
      0.5 * Math.log(df * Math.PI) -
      gammaLn(df / 2) -
      ((df + 1) / 2) * Math.log(1 + (x * x) / df)
    const pdf = Math.exp(logPdf)
    if (pdf < 1e-30) break
    const dx = (cdf - p) / pdf
    x -= dx
    if (Math.abs(dx) < 1e-10) break
  }
  return x
}

// ===========================================================================
// Statistical test functions
// ===========================================================================

interface WelchResult {
  t: number
  df: number
  pValue: number
  ci: [number, number]
  cohenD: number
  descriptives: [GroupDescriptive, GroupDescriptive]
}

function welchT(
  g1: number[],
  g2: number[],
  g1Name: string,
  g2Name: string,
  alpha: number,
): WelchResult | null {
  if (g1.length < 2 || g2.length < 2) return null
  const n1 = g1.length
  const n2 = g2.length
  const m1 = mean(g1)
  const m2 = mean(g2)
  const v1 = variance(g1)
  const v2 = variance(g2)

  if (v1 === 0 && v2 === 0) return null

  const se = Math.sqrt(v1 / n1 + v2 / n2)
  const t = (m1 - m2) / se
  const df = (v1 / n1 + v2 / n2) ** 2 / ((v1 / n1) ** 2 / (n1 - 1) + (v2 / n2) ** 2 / (n2 - 1))
  const pValue = tTestPValue(t, df)

  const tCrit = inverseTCDF(1 - alpha / 2, df)
  const diff = m1 - m2
  const ci: [number, number] = [diff - tCrit * se, diff + tCrit * se]

  const pooledSD = Math.sqrt(((n1 - 1) * v1 + (n2 - 1) * v2) / (n1 + n2 - 2))
  const cohenD = pooledSD > 0 ? Math.abs(diff) / pooledSD : 0

  return {
    t,
    df,
    pValue,
    ci,
    cohenD,
    descriptives: [
      { groupName: g1Name, n: n1, mean: m1, sd: sdVal(g1), median: medianVal(g1) },
      { groupName: g2Name, n: n2, mean: m2, sd: sdVal(g2), median: medianVal(g2) },
    ],
  }
}

interface MannWhitneyResult {
  U: number
  pValue: number
  r: number
  descriptives: [GroupDescriptive, GroupDescriptive]
}

function mannWhitney(
  g1: number[],
  g2: number[],
  g1Name: string,
  g2Name: string,
): MannWhitneyResult | null {
  if (g1.length < 1 || g2.length < 1) return null
  const n1 = g1.length
  const n2 = g2.length
  const combined = [...g1, ...g2]
  const { ranks, tieGroups } = rankData(combined)

  let R1 = 0
  for (let i = 0; i < n1; i++) R1 += ranks[i]

  const U1 = R1 - (n1 * (n1 + 1)) / 2
  const U2 = n1 * n2 - U1
  const U = Math.min(U1, U2)

  const N = n1 + n2
  const muU = (n1 * n2) / 2
  let tieCorrection = 0
  for (const t of tieGroups) tieCorrection += t ** 3 - t
  const sigmaU = Math.sqrt((n1 * n2 * (N + 1)) / 12 - (n1 * n2 * tieCorrection) / (12 * N * (N - 1)))

  const z = sigmaU > 0 ? (U - muU) / sigmaU : 0
  const pValue = 2 * (1 - normalCDF(Math.abs(z)))
  const r = sigmaU > 0 ? Math.abs(z) / Math.sqrt(N) : 0

  return {
    U,
    pValue,
    r,
    descriptives: [
      { groupName: g1Name, n: n1, mean: mean(g1), sd: sdVal(g1), median: medianVal(g1) },
      { groupName: g2Name, n: n2, mean: mean(g2), sd: sdVal(g2), median: medianVal(g2) },
    ],
  }
}

interface ChiSquareResult {
  chi2: number
  df: number
  pValue: number
  cramersV: number
  descriptives: GroupDescriptive[]
  warning: string | null
}

function chiSquareTest(
  groups: Map<string, string[]>,
  groupNames: string[],
): ChiSquareResult | null {
  // Collect all categories
  const categorySet = new Set<string>()
  for (const values of groups.values()) {
    for (const v of values) categorySet.add(v)
  }
  const categories = [...categorySet].sort()
  if (categories.length < 2 || groupNames.length < 2) return null

  const nRows = categories.length
  const nCols = groupNames.length

  const observed: number[][] = Array.from({ length: nRows }, () => new Array(nCols).fill(0))
  for (let j = 0; j < nCols; j++) {
    const vals = groups.get(groupNames[j])!
    for (const v of vals) {
      const i = categories.indexOf(v)
      if (i >= 0) observed[i][j]++
    }
  }

  const rowTotals = observed.map((row) => row.reduce((s, v) => s + v, 0))
  const colTotals = new Array(nCols).fill(0) as number[]
  for (let j = 0; j < nCols; j++) {
    for (let i = 0; i < nRows; i++) colTotals[j] += observed[i][j]
  }
  const N = rowTotals.reduce((s, v) => s + v, 0)
  if (N === 0) return null

  let chi2 = 0
  let lowExpectedCount = 0
  for (let i = 0; i < nRows; i++) {
    for (let j = 0; j < nCols; j++) {
      const expected = (rowTotals[i] * colTotals[j]) / N
      if (expected < 5) lowExpectedCount++
      if (expected > 0) {
        chi2 += (observed[i][j] - expected) ** 2 / expected
      }
    }
  }

  const df = (nRows - 1) * (nCols - 1)
  const pValue = 1 - chiSquareCDF(chi2, df)
  const cramersV = Math.sqrt(chi2 / (N * (Math.min(nRows, nCols) - 1)))

  let warning: string | null = null
  if (lowExpectedCount > 0) {
    warning = `${lowExpectedCount} cell(s) have expected count < 5`
  }

  // Descriptives per group
  const descriptives: GroupDescriptive[] = groupNames.map((gn, j) => {
    const freqs = categories.map((cat, i) => ({
      category: cat,
      count: observed[i][j],
      pct: colTotals[j] > 0 ? (observed[i][j] / colTotals[j]) * 100 : 0,
    }))
    return { groupName: gn, n: colTotals[j], freqs }
  })

  return { chi2, df, pValue, cramersV, warning, descriptives }
}

interface FisherResult {
  pValue: number
  cramersV: number
  descriptives: GroupDescriptive[]
}

function fisherExact(
  groups: Map<string, string[]>,
  groupNames: string[],
): FisherResult | null {
  if (groupNames.length !== 2) return null

  const categorySet = new Set<string>()
  for (const values of groups.values()) {
    for (const v of values) categorySet.add(v)
  }
  const categories = [...categorySet].sort()
  if (categories.length !== 2) return null

  // 2x2 table: rows = categories, cols = groups
  const g0 = groups.get(groupNames[0])!
  const g1 = groups.get(groupNames[1])!
  const a = g0.filter((v) => v === categories[0]).length
  const b = g1.filter((v) => v === categories[0]).length
  const c = g0.filter((v) => v === categories[1]).length
  const d = g1.filter((v) => v === categories[1]).length
  const N = a + b + c + d
  if (N === 0) return null

  // Log-hypergeometric probability
  const logHyper = (x: number): number => {
    const ab = a + b
    const cd = c + d
    const ac = a + c
    const bd = b + d
    return (
      gammaLn(ab + 1) +
      gammaLn(cd + 1) +
      gammaLn(ac + 1) +
      gammaLn(bd + 1) -
      gammaLn(N + 1) -
      gammaLn(x + 1) -
      gammaLn(ab - x + 1) -
      gammaLn(ac - x + 1) -
      gammaLn(x + d - a + 1)
    )
  }

  // Rebuild: iterate over all possible values of the (0,0) cell
  const r0 = a + b // row 0 total
  const c0 = a + c // col 0 total
  const minA = Math.max(0, r0 + c0 - N)
  const maxA = Math.min(r0, c0)

  const logPObserved = logHyper(a)
  let pValue = 0
  for (let x = minA; x <= maxA; x++) {
    const logPx = logHyper(x)
    if (logPx <= logPObserved + 1e-10) {
      pValue += Math.exp(logPx)
    }
  }
  pValue = Math.min(pValue, 1)

  // Cramér's V from chi-square equivalent
  const expected00 = (r0 * c0) / N
  const expected01 = (r0 * (N - c0)) / N
  const expected10 = ((N - r0) * c0) / N
  const expected11 = ((N - r0) * (N - c0)) / N
  const chi2 =
    (expected00 > 0 ? (a - expected00) ** 2 / expected00 : 0) +
    (expected01 > 0 ? (b - expected01) ** 2 / expected01 : 0) +
    (expected10 > 0 ? (c - expected10) ** 2 / expected10 : 0) +
    (expected11 > 0 ? (d - expected11) ** 2 / expected11 : 0)
  const cramersV = Math.sqrt(chi2 / N)

  const descriptives: GroupDescriptive[] = [
    {
      groupName: groupNames[0],
      n: a + c,
      freqs: [
        { category: categories[0], count: a, pct: a + c > 0 ? (a / (a + c)) * 100 : 0 },
        { category: categories[1], count: c, pct: a + c > 0 ? (c / (a + c)) * 100 : 0 },
      ],
    },
    {
      groupName: groupNames[1],
      n: b + d,
      freqs: [
        { category: categories[0], count: b, pct: b + d > 0 ? (b / (b + d)) * 100 : 0 },
        { category: categories[1], count: d, pct: b + d > 0 ? (d / (b + d)) * 100 : 0 },
      ],
    },
  ]

  return { pValue, cramersV, descriptives }
}

interface AnovaResult {
  F: number
  dfBetween: number
  dfWithin: number
  pValue: number
  etaSquared: number
  descriptives: GroupDescriptive[]
}

function anovaTest(
  groupArrays: number[][],
  groupNames: string[],
): AnovaResult | null {
  const k = groupArrays.length
  if (k < 2) return null
  const allValues: number[] = []
  for (const g of groupArrays) {
    if (g.length < 1) return null
    allValues.push(...g)
  }
  const N = allValues.length
  if (N <= k) return null

  const grandMean = mean(allValues)
  let SSB = 0
  let SSW = 0
  const descriptives: GroupDescriptive[] = []

  for (let i = 0; i < k; i++) {
    const g = groupArrays[i]
    const gMean = mean(g)
    SSB += g.length * (gMean - grandMean) ** 2
    for (const v of g) SSW += (v - gMean) ** 2
    descriptives.push({
      groupName: groupNames[i],
      n: g.length,
      mean: gMean,
      sd: g.length > 1 ? sdVal(g) : 0,
      median: medianVal(g),
    })
  }

  const dfB = k - 1
  const dfW = N - k
  const MSB = SSB / dfB
  const MSW = SSW / dfW
  if (MSW === 0) return null
  const F = MSB / MSW
  const pValue = 1 - fCDF(F, dfB, dfW)
  const etaSquared = SSB / (SSB + SSW)

  return { F, dfBetween: dfB, dfWithin: dfW, pValue, etaSquared, descriptives }
}

interface KruskalResult {
  H: number
  df: number
  pValue: number
  etaSquaredH: number
  descriptives: GroupDescriptive[]
}

function kruskalWallisTest(
  groupArrays: number[][],
  groupNames: string[],
): KruskalResult | null {
  const k = groupArrays.length
  if (k < 2) return null

  const combined: number[] = []
  const groupIndices: number[] = []
  for (let i = 0; i < k; i++) {
    if (groupArrays[i].length < 1) return null
    for (const v of groupArrays[i]) {
      combined.push(v)
      groupIndices.push(i)
    }
  }
  const N = combined.length
  if (N <= k) return null

  const { ranks, tieGroups } = rankData(combined)

  // Mean rank per group
  const groupRankSums = new Array(k).fill(0) as number[]
  const groupN = new Array(k).fill(0) as number[]
  for (let i = 0; i < N; i++) {
    groupRankSums[groupIndices[i]] += ranks[i]
    groupN[groupIndices[i]]++
  }

  let H = 0
  for (let i = 0; i < k; i++) {
    const meanRank = groupRankSums[i] / groupN[i]
    H += groupN[i] * (meanRank - (N + 1) / 2) ** 2
  }
  H *= 12 / (N * (N + 1))

  // Tie correction
  let tieCorr = 0
  for (const t of tieGroups) tieCorr += t ** 3 - t
  if (tieCorr > 0) H /= 1 - tieCorr / (N ** 3 - N)

  const df = k - 1
  const pValue = 1 - chiSquareCDF(H, df)
  const etaSquaredH = (H - k + 1) / (N - k)

  const descriptives: GroupDescriptive[] = groupNames.map((gn, i) => ({
    groupName: gn,
    n: groupArrays[i].length,
    mean: mean(groupArrays[i]),
    sd: groupArrays[i].length > 1 ? sdVal(groupArrays[i]) : 0,
    median: medianVal(groupArrays[i]),
  }))

  return { H, df, pValue, etaSquaredH, descriptives }
}

// ===========================================================================
// Test selection & orchestration
// ===========================================================================

type TestPreference = 'auto' | 'parametric' | 'nonparametric'

/**
 * Which test, and WHY — the rationale travels with the choice so the table can
 * show it on hover.
 *
 * `auto` is the only mode that inspects the data: each group is checked for
 * normality (Shapiro-Wilk), and any group failing sends the whole comparison to
 * the rank-based test. Failing safe toward the non-parametric side is
 * deliberate: it costs a little power when the data really were normal, whereas
 * a t-test on a skewed variable can report a difference that is not there.
 *
 * `parametric` / `nonparametric` skip the check entirely — a protocol that
 * fixed the analysis in advance should not have the tool quietly overrule it.
 */
function selectTest(
  variableType: 'numeric' | 'categorical',
  groupCount: number,
  preference: TestPreference,
  isTwoByTwo: boolean,
  minExpectedCount: number,
  groupValues: number[][] = [],
  /** This variable's own pinned test, which outranks everything below. */
  override?: TestName,
): { testName: TestName; rationale: { en: string; fr: string } } {
  // A test pinned on the row wins outright — over the data AND over the global
  // preference. Whether it SUITS the variable is checked by the caller, which
  // has the group count; an override that cannot apply is dropped there rather
  // than silently producing a test the data cannot support.
  if (override) {
    return {
      testName: override,
      rationale: {
        en: 'Chosen for this variable in the results table; neither the data nor the global setting was consulted.',
        fr: 'Choisi pour cette variable dans le tableau des résultats ; ni les données ni le réglage global n’ont été consultés.',
      },
    }
  }
  if (variableType === 'categorical') {
    if (isTwoByTwo && minExpectedCount < 5) {
      return {
        testName: 'fisher',
        rationale: {
          en: `2×2 table with an expected count below 5 (smallest ${minExpectedCount.toFixed(1)}), where chi-squared's approximation is unreliable — Fisher's exact test instead.`,
          fr: `Tableau 2×2 avec un effectif attendu sous 5 (le plus petit ${minExpectedCount.toFixed(1)}), où l'approximation du chi² n'est pas fiable — test exact de Fisher à la place.`,
        },
      }
    }
    return {
      testName: 'chi-square',
      rationale: {
        en: 'Categorical variable compared across groups, with expected counts large enough for the chi-squared approximation.',
        fr: 'Variable qualitative comparée entre groupes, avec des effectifs attendus suffisants pour l’approximation du chi².',
      },
    }
  }

  const pair = groupCount === 2
  if (preference === 'nonparametric') {
    return {
      testName: pair ? 'mann-whitney' : 'kruskal-wallis',
      rationale: {
        en: 'Non-parametric test forced in the settings; the data were not checked for normality.',
        fr: 'Test non paramétrique forcé dans les paramètres ; la normalité des données n’a pas été vérifiée.',
      },
    }
  }
  if (preference === 'parametric') {
    return {
      testName: pair ? 'welch-t' : 'anova',
      rationale: {
        en: 'Parametric test forced in the settings; the data were not checked for normality.',
        fr: 'Test paramétrique forcé dans les paramètres ; la normalité des données n’a pas été vérifiée.',
      },
    }
  }

  const verdict = groupsLookNormal(groupValues)
  if (verdict.normal) {
    const why = verdict.reason === 'not-tested-large'
      ? {
          en: 'Groups too large to test for normality usefully (Shapiro-Wilk rejects trivial departures at this size); the parametric test is robust here.',
          fr: 'Groupes trop grands pour tester utilement la normalité (Shapiro-Wilk rejette des écarts négligeables à cette taille) ; le test paramétrique est robuste ici.',
        }
      : {
          en: `Each group is consistent with a normal distribution (Shapiro-Wilk, smallest p = ${verdict.pValue!.toFixed(3)}).`,
          fr: `Chaque groupe est compatible avec une distribution normale (Shapiro-Wilk, plus petit p = ${verdict.pValue!.toFixed(3)}).`,
        }
    return { testName: pair ? 'welch-t' : 'anova', rationale: why }
  }
  const why = verdict.reason === 'not-tested-small'
    ? {
        en: 'Too few observations per group to check normality, so the test that does not assume it was used.',
        fr: 'Trop peu d’observations par groupe pour vérifier la normalité ; le test qui ne la suppose pas a été retenu.',
      }
    : {
        en: `At least one group departs from normality (Shapiro-Wilk, smallest p = ${verdict.pValue!.toFixed(3)}), so a rank-based test was used.`,
        fr: `Au moins un groupe s’écarte de la normalité (Shapiro-Wilk, plus petit p = ${verdict.pValue!.toFixed(3)}) ; un test sur les rangs a été utilisé.`,
      }
  return { testName: pair ? 'mann-whitney' : 'kruskal-wallis', rationale: why }
}

function computeAllTests(
  rows: Record<string, unknown>[],
  columns: { id: string; name: string; type: string }[],
  groupColumnId: string | undefined,
  valueColumnIds: string[],
  testPreference: TestPreference,
  alpha: number,
  /** Per-variable pinned tests, keyed by COLUMN ID. */
  testOverrides: Record<string, TestName> = {},
): TestResult[] {
  if (!groupColumnId || valueColumnIds.length === 0 || rows.length === 0) return []

  const groupCol = columns.find((c) => c.id === groupColumnId)
  if (!groupCol) return []

  const groupMap = new Map<string, Record<string, unknown>[]>()
  for (const row of rows) {
    const gv = row[groupColumnId]
    if (!isNotMissing(gv)) continue
    const key = String(gv)
    if (!groupMap.has(key)) groupMap.set(key, [])
    groupMap.get(key)!.push(row)
  }
  const groupNames = [...groupMap.keys()].sort()
  const groupCount = groupNames.length

  if (groupCount < 2) {
    return valueColumnIds
      .filter((id) => id !== groupColumnId)
      .map((colId) => {
        const col = columns.find((c) => c.id === colId)
        return {
          variable: col?.name ?? colId,
          variableType: col?.type === 'number' ? 'numeric' : 'categorical',
          testName: 'welch-t' as TestName,
          testLabel: TEST_LABELS['welch-t'],
          statistic: null,
          statisticLabel: '',
          df: null,
          pValue: null,
          ci: null,
          effectSize: null,
          effectSizeLabel: '',
          groupDescriptives: null,
          warning: groupCount === 0 ? 'No groups found' : 'Only 1 group',
        }
      })
  }

  const results: TestResult[] = []

  for (const colId of valueColumnIds) {
    if (colId === groupColumnId) continue
    const col = columns.find((c) => c.id === colId)
    if (!col) continue
    // Skip date columns
    if (col.type === 'date') continue

    const isNumeric = col.type === 'number'

    if (isNumeric) {
      // Extract numeric arrays per group
      const groupArrays: number[][] = []
      const validGroupNames: string[] = []
      for (const gn of groupNames) {
        const nums = extractNumbers(groupMap.get(gn)!.map((r) => r[colId]))
        if (nums.length > 0) {
          groupArrays.push(nums)
          validGroupNames.push(gn)
        }
      }

      if (validGroupNames.length < 2) {
        results.push({
          variable: col.name,
          variableType: 'numeric',
          testName: 'welch-t',
          testLabel: TEST_LABELS['welch-t'],
          statistic: null,
          statisticLabel: '',
          df: null,
          pValue: null,
          ci: null,
          effectSize: null,
          effectSizeLabel: '',
          groupDescriptives: null,
          warning: 'Insufficient data in groups',
        })
        continue
      }

      const pinned = testOverrides[col.id]
      const { testName, rationale } = selectTest(
        'numeric', validGroupNames.length, testPreference, false, 0, groupArrays,
        overrideApplies(pinned, 'numeric', validGroupNames.length) ? pinned : undefined,
      )

      if (testName === 'welch-t') {
        const res = welchT(groupArrays[0], groupArrays[1], validGroupNames[0], validGroupNames[1], alpha)
        if (!res) {
          results.push({
            variable: col.name,
            variableType: 'numeric',
            testName,
            testLabel: TEST_LABELS[testName],
          rationale,
            statistic: null,
            statisticLabel: STAT_LABELS[testName],
            df: null,
            pValue: null,
            ci: null,
            effectSize: null,
            effectSizeLabel: EFFECT_SIZE_LABELS[testName],
            groupDescriptives: null,
            warning: 'Zero variance or n < 2',
          })
        } else {
          results.push({
            variable: col.name,
            variableType: 'numeric',
            testName,
            testLabel: TEST_LABELS[testName],
          rationale,
            statistic: res.t,
            statisticLabel: STAT_LABELS[testName],
            df: res.df,
            pValue: res.pValue,
            ci: res.ci,
            effectSize: res.cohenD,
            effectSizeLabel: EFFECT_SIZE_LABELS[testName],
            groupDescriptives: res.descriptives,
            warning: null,
          })
        }
      } else if (testName === 'mann-whitney') {
        const res = mannWhitney(groupArrays[0], groupArrays[1], validGroupNames[0], validGroupNames[1])
        results.push({
          variable: col.name,
          variableType: 'numeric',
          testName,
          testLabel: TEST_LABELS[testName],
          rationale,
          statistic: res?.U ?? null,
          statisticLabel: STAT_LABELS[testName],
          df: null,
          pValue: res?.pValue ?? null,
          ci: null,
          effectSize: res?.r ?? null,
          effectSizeLabel: EFFECT_SIZE_LABELS[testName],
          groupDescriptives: res?.descriptives ?? null,
          warning: res ? null : 'Insufficient data',
        })
      } else if (testName === 'anova') {
        const res = anovaTest(groupArrays, validGroupNames)
        results.push({
          variable: col.name,
          variableType: 'numeric',
          testName,
          testLabel: TEST_LABELS[testName],
          rationale,
          statistic: res?.F ?? null,
          statisticLabel: STAT_LABELS[testName],
          df: res ? res.dfBetween : null,
          pValue: res?.pValue ?? null,
          ci: null,
          effectSize: res?.etaSquared ?? null,
          effectSizeLabel: EFFECT_SIZE_LABELS[testName],
          groupDescriptives: res?.descriptives ?? null,
          warning: res ? null : 'Zero within-group variance or n ≤ k',
        })
      } else {
        // kruskal-wallis
        const res = kruskalWallisTest(groupArrays, validGroupNames)
        results.push({
          variable: col.name,
          variableType: 'numeric',
          testName,
          testLabel: TEST_LABELS[testName],
          rationale,
          statistic: res?.H ?? null,
          statisticLabel: STAT_LABELS[testName],
          df: res?.df ?? null,
          pValue: res?.pValue ?? null,
          ci: null,
          effectSize: res?.etaSquaredH ?? null,
          effectSizeLabel: EFFECT_SIZE_LABELS[testName],
          groupDescriptives: res?.descriptives ?? null,
          warning: res ? null : 'Insufficient data',
        })
      }
    } else {
      // Categorical variable
      const catGroups = new Map<string, string[]>()
      for (const gn of groupNames) {
        const vals = groupMap
          .get(gn)!
          .map((r) => r[colId])
          .filter(isNotMissing)
          .map(String)
        catGroups.set(gn, vals)
      }

      const allCategories = new Set<string>()
      for (const vals of catGroups.values()) {
        for (const v of vals) allCategories.add(v)
      }
      const isTwoByTwo = allCategories.size === 2 && groupNames.length === 2

      // Compute min expected count for Fisher decision
      let minExpected = Infinity
      if (isTwoByTwo) {
        const cats = [...allCategories]
        const table = groupNames.map((gn) => {
          const vals = catGroups.get(gn)!
          return cats.map((cat) => vals.filter((v) => v === cat).length)
        })
        const N = table.flat().reduce((s, v) => s + v, 0)
        const rowTotals = cats.map((_, i) => table.reduce((s, col) => s + col[i], 0))
        const colTotals = table.map((col) => col.reduce((s, v) => s + v, 0))
        if (N > 0) {
          for (let i = 0; i < 2; i++) {
            for (let j = 0; j < 2; j++) {
              const exp = (rowTotals[i] * colTotals[j]) / N
              if (exp < minExpected) minExpected = exp
            }
          }
        }
      }

      const pinnedCat = testOverrides[col.id]
      const { testName, rationale } = selectTest(
        'categorical', groupCount, testPreference, isTwoByTwo, minExpected, [],
        overrideApplies(pinnedCat, 'categorical', groupCount) ? pinnedCat : undefined,
      )

      if (testName === 'fisher') {
        const res = fisherExact(catGroups, groupNames)
        results.push({
          variable: col.name,
          variableType: 'categorical',
          testName,
          testLabel: TEST_LABELS[testName],
          rationale,
          statistic: null,
          statisticLabel: STAT_LABELS[testName],
          df: null,
          pValue: res?.pValue ?? null,
          ci: null,
          effectSize: res?.cramersV ?? null,
          effectSizeLabel: EFFECT_SIZE_LABELS[testName],
          groupDescriptives: res?.descriptives ?? null,
          warning: res ? null : 'Cannot compute',
        })
      } else {
        const res = chiSquareTest(catGroups, groupNames)
        results.push({
          variable: col.name,
          variableType: 'categorical',
          testName,
          testLabel: TEST_LABELS[testName],
          rationale,
          statistic: res?.chi2 ?? null,
          statisticLabel: STAT_LABELS[testName],
          df: res?.df ?? null,
          pValue: res?.pValue ?? null,
          ci: null,
          effectSize: res?.cramersV ?? null,
          effectSizeLabel: EFFECT_SIZE_LABELS[testName],
          groupDescriptives: res?.descriptives ?? null,
          warning: res?.warning ?? (res ? null : 'Cannot compute'),
        })
      }
    }
  }

  return results
}

// ===========================================================================
// Formatting
// ===========================================================================

function formatP(p: number): string {
  if (p < 0.001) return '< 0.001'
  return p.toFixed(3)
}

function sigStars(p: number): string {
  if (p < 0.001) return ' ***'
  if (p < 0.01) return ' **'
  if (p < 0.05) return ' *'
  return ''
}

function fmt(val: number, decimals = 2): string {
  if (Math.abs(val) >= 1e6) return val.toExponential(2)
  return val.toFixed(decimals)
}

// ===========================================================================
// Component
// ===========================================================================

const ALL_TABLE_COLUMNS = ['test', 'statistic', 'df', 'p', 'ci', 'effectSize', 'descriptive'] as const

export function StatisticalTestsComponent({ config, columns, rows, compact, datasetFileId, datasetFilters, onConfigChange }: ComponentPluginProps) {
  const { t, i18n } = useTranslation()
  const lang = (i18n.language === 'fr' ? 'fr' : 'en') as 'en' | 'fr'
  const server = isServerMode()
  const pluginName = usePluginName('statistical-tests')

  const groupColumnId = config.groupColumn as string | undefined
  const rawValueColumns = config.valueColumns as string[] | undefined
  const testPreference = (config.testPreference as TestPreference) ?? 'auto'
  const alpha = (config.alpha as number) ?? 0.05
  const rawVisibleColumns = config.visibleColumns as string[] | undefined
  const visibleColumns = new Set(rawVisibleColumns?.length ? rawVisibleColumns : ALL_TABLE_COLUMNS)
  const highlightSignificant = (config.highlightSignificant as boolean) ?? true
  const wrap = config.wrap === true
  const variableOrder = (config.variableOrder as VariableOrder) ?? 'dataset'

  const showCol = (col: string) => visibleColumns.has(col)

  // Default: every column worth testing, minus the grouping one. Identifiers
  // and dates are left unticked — see lib/analysis-default-columns.
  const testable = columns.filter((c) => c.id !== groupColumnId)
  const valueColumnIds = orderSelection(
    rawValueColumns?.length ? rawValueColumns : defaultAnalysisColumns(testable).map((c) => c.id),
    testable,
    variableOrder,
    displayColumnName,
  )

  // Per-variable pinned tests, keyed by column id. Config like any other, so it
  // rides the analysis draft and is saved with it.
  const testOverrides = useMemo(
    () => (config.testOverrides as Record<string, TestName> | undefined) ?? {},
    [config.testOverrides],
  )
  const setOverride = useCallback(
    (columnId: string, test: TestName | null) => {
      if (!onConfigChange) return
      const next = { ...testOverrides }
      // Removing the pin returns the row to Auto rather than storing a
      // "no preference" value the compute path would have to special-case.
      if (test === null) delete next[columnId]
      else next[columnId] = test
      onConfigChange({ testOverrides: next })
    },
    [onConfigChange, testOverrides],
  )

  const localResults = useMemo(
    () => (server ? null : computeAllTests(rows, columns, groupColumnId, valueColumnIds, testPreference, alpha, testOverrides)),
    [server, rows, columns, groupColumnId, valueColumnIds, testPreference, alpha, testOverrides],
  )
  // Stable string keys so the effect only re-fetches on a semantic change.
  const [serverResults, setServerResults] = useState<TestResult[] | null>(null)
  // How many groups the last result compared, which gates whether a pinned test
  // still applies. Read from the RESULT rather than the data: in server mode
  // `rows` is empty. A count one render stale is harmless here — it only decides
  // whether an override survives — where making the spec depend on its own
  // output would not be.
  const serverGroupCount = useMemo(
    () => serverResults?.find((r) => r.groupDescriptives)?.groupDescriptives?.length ?? 0,
    [serverResults],
  )

  const spec = server && datasetFileId && groupColumnId
    ? buildStatisticalTestsSpec(
        columns, groupColumnId, valueColumnIds, testPreference, alpha,
        testOverrides, serverGroupCount,
      )
    : null
  const specKey = spec ? JSON.stringify(spec) : null
  const filtersKey = JSON.stringify(datasetFilters ?? null)
  const [serverError, setServerError] = useState<string | null>(null)
  useEffect(() => {
    if (!server || !datasetFileId || !spec) return
    let cancelled = false
    renderOnServer('statistical-tests', spec, { datasetFileId, datasetFilters })
      .then((out) => {
        if (cancelled) return
        if (out.stderr) { setServerError(out.stderr); return }
        try { setServerResults(JSON.parse(out.stdout.trim()) as TestResult[]); setServerError(null) }
        catch { setServerError(out.stdout || 'Failed to parse result') }
      })
      .catch((e) => { if (!cancelled) setServerError(String(e)) })
    return () => { cancelled = true }
  }, [server, datasetFileId, specKey, filtersKey]) // eslint-disable-line react-hooks/exhaustive-deps

  const results = useMemo(() => (server ? serverResults : localResults) ?? [], [server, serverResults, localResults])

  // Results identify a variable by its column NAME (both ends agree on that);
  // the table prints the LABEL, so map back through the column list here.
  const statRows = useMemo<StatRow[]>(() => {
    const byName = new Map(columns.map((c) => [c.name, c]))
    return results.map((result, i) => ({
      id: `${result.variable}:${i}`,
      result,
      label: (() => {
        const col = byName.get(result.variable)
        return col ? displayColumnName(col) : result.variable
      })(),
      columnId: byName.get(result.variable)?.id,
    }))
  }, [results, columns])

  const groupColumn = groupColumnId ? columns.find((c) => c.id === groupColumnId) : undefined
  const groupLabel = groupColumn ? displayColumnName(groupColumn) : ''


  // Collect group names for descriptive columns (always computed)
  const allGroupNames = useMemo(() => {
    if (!groupColumnId) return []
    const names = new Set<string>()
    for (const r of results) {
      if (r.groupDescriptives) {
        for (const g of r.groupDescriptives) names.add(g.groupName)
      }
    }
    return [...names].sort()
  }, [results, groupColumnId])

  // One PublicationColumn per visible statistic, so the table gets booktabs
  // styling, resizable columns and ellipsis-with-tooltip for free — the same
  // component the descriptive table uses, so the two read as one family.
  //
  // Memoized because PublicationTable captures the column objects when a
  // resize drag begins, and a drag re-renders on every mouse move. Rebuilding
  // the array on each render swapped those objects mid-drag, so the column
  // stopped following the cursor.
  const tableColumns = useMemo<PublicationColumn<StatRow>[]>(() => {
    const cols: PublicationColumn<StatRow>[] = []
    cols.push({
      id: '__variable__',
      header: t('datasets.table1_variable'),
      cell: (r) => (
        <span>
          {r.label}
          <span className="ml-1 text-muted-foreground">
            ({r.result.variableType === 'numeric' ? 'num.' : 'cat.'})
          </span>
        </span>
      ),
      align: 'left',
      width: 200,
      minWidth: 110,
    })
    if (showCol('descriptive')) {
      for (const gn of allGroupNames) {
        cols.push({
          id: `g:${gn}`,
          header: gn,
          // Grouped under the grouping variable's own label, the way a journal
          // puts "Arm" over the columns that belong to it.
          group: groupLabel,
          cell: (r) => descriptiveCell(r.result, gn),
          align: 'right',
          width: 130,
        })
      }
    }
    if (showCol('test')) {
      cols.push({
        id: 'test',
        header: t('datasets.stats_col_test'),
        cell: (r) => (
          <TestCell
            result={r.result}
            lang={lang}
            groupCount={allGroupNames.length}
            pinned={r.columnId ? testOverrides[r.columnId] : undefined}
            onPick={
              onConfigChange && r.columnId
                ? (test) => setOverride(r.columnId!, test)
                : undefined
            }
          />
        ),
        align: 'left',
        // Room for the longest label ("Kruskal-Wallis") plus the chevron that
        // shows the cell is a control; at 140 the two crowded each other.
        width: 170,
      })
    }
    if (showCol('statistic')) {
      cols.push({
        id: 'statistic',
        header: t('datasets.stats_col_statistic'),
        cell: (r) =>
          r.result.statistic != null ? (
            <span className="font-mono">
              <span className="text-muted-foreground">{r.result.statisticLabel} = </span>
              {fmt(r.result.statistic)}
            </span>
          ) : (
            <span className="text-muted-foreground/40">{DASH}</span>
          ),
        align: 'right',
        width: 100,
      })
    }
    if (showCol('df')) {
      cols.push({
        id: 'df',
        header: 'df',
        cell: (r) =>
          r.result.df != null ? (
            <span className="font-mono">
              {Number.isInteger(r.result.df) ? r.result.df : fmt(r.result.df, 1)}
            </span>
          ) : (
            <span className="text-muted-foreground/40">{DASH}</span>
          ),
        align: 'right',
        width: 56,
      })
    }
    if (showCol('p')) {
      cols.push({
        id: 'p',
        header: 'p',
        cell: (r) => <PValueCell result={r.result} alpha={alpha} highlight={highlightSignificant} />,
        align: 'right',
        width: 86,
      })
    }
    if (showCol('ci')) {
      cols.push({
        id: 'ci',
        header: t('datasets.stats_col_ci'),
        cell: (r) =>
          r.result.ci ? (
            <span className="font-mono">{`[${fmt(r.result.ci[0])}, ${fmt(r.result.ci[1])}]`}</span>
          ) : (
            <span className="text-muted-foreground/40">{DASH}</span>
          ),
        align: 'right',
        width: 118,
      })
    }
    if (showCol('effectSize')) {
      cols.push({
        id: 'effectSize',
        header: t('datasets.stats_col_effect'),
        cell: (r) =>
          r.result.effectSize != null ? (
            <span className="font-mono">
              <span className="text-muted-foreground">{r.result.effectSizeLabel} = </span>
              {fmt(r.result.effectSize)}
            </span>
          ) : (
            <span className="text-muted-foreground/40">{DASH}</span>
          ),
        align: 'right',
        width: 112,
      })
    }
    return cols
    // eslint-disable-next-line react-hooks/exhaustive-deps -- showCol reads visibleColumns, tracked via rawVisibleColumns
  }, [t, lang, alpha, highlightSignificant, allGroupNames, groupLabel, rawVisibleColumns])

  // Publish the table for the shell's Export menu (copy / LaTeX). Built from the
  // same columns the table renders, so what you copy is what you see — including
  // which statistics are currently shown.
  usePublishAnalysisTable(
    statRows.length > 0 ? () => toExportTable(statRows, tableColumns, lang, alpha) : null,
    [statRows, tableColumns, lang, alpha],
  )

  // Empty states
  if (!groupColumnId) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-muted-foreground">
        <FlaskConical size={24} className="opacity-40" />
        <p className="text-xs">{t('datasets.stats_select_group')}</p>
      </div>
    )
  }

  if (server && serverError) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-muted-foreground">
        <FlaskConical size={24} className="opacity-40" />
        <p className="text-xs whitespace-pre-wrap">{serverError}</p>
      </div>
    )
  }

  if (!server && rows.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-muted-foreground">
        <FlaskConical size={24} className="opacity-40" />
        <p className="text-xs">{lang === 'fr' ? 'Aucune donnée disponible.' : 'No data available.'}</p>
      </div>
    )
  }

  // Server mode: hold the frame until results arrive (empty array is a real "no columns" state).
  if (server && serverResults === null) {
    return <AnalysisLoading icon={FlaskConical} name={pluginName} compact={compact} />
  }

  if (statRows.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-muted-foreground">
        <FlaskConical size={24} className="opacity-40" />
        <p className="text-xs">{t('datasets.stats_select_values')}</p>
      </div>
    )
  }



  return (
    <div className={cn('flex h-full flex-col', !compact && 'p-4')}>
      <div className="min-h-0 flex-1">
        <PublicationTable
          rows={statRows}
          columns={tableColumns}
          wrap={wrap}
          className="h-full"
          emptyMessage={t('common.no_results')}
        />
      </div>
      {/* The legend a statistical table is expected to carry. Until now this
          one printed * ** *** and left the reader to assume the thresholds. */}
      <div
        className={cn(
          'shrink-0 pt-2 text-muted-foreground',
          compact ? 'text-[8px]' : 'text-[10px]',
        )}
      >
        <p>* p &lt; 0.05 &nbsp; ** p &lt; 0.01 &nbsp; *** p &lt; 0.001</p>
      </div>
    </div>
  )
}

/** The group descriptive cell: n, plus mean ± SD or the category breakdown. */
function descriptiveCell(result: TestResult, groupName: string) {
  const gd = result.groupDescriptives?.find((g) => g.groupName === groupName)
  if (!gd) return <span className="text-muted-foreground/40">{DASH}</span>
  if (result.variableType === 'numeric') {
    return (
      <span>
        <span className="text-muted-foreground">n=</span>
        {gd.n}
        {gd.mean != null && ` , ${fmt(gd.mean)} ± ${fmt(gd.sd ?? 0)}`}
      </span>
    )
  }
  return (
    <span>
      <span className="text-muted-foreground">n=</span>
      {gd.n}
      {gd.freqs && (
        <span className="ml-1">
          {gd.freqs.map((f) => `${f.category}: ${f.count} (${f.pct.toFixed(1)}%)`).join('; ')}
        </span>
      )}
    </span>
  )
}

/**
 * The test name, with WHY it was chosen behind a hover.
 *
 * The reason belongs next to the result rather than in the docs: "Mann-Whitney"
 * alone does not tell a reader whether the tool judged the data non-normal or
 * whether someone forced it, and those support very different conclusions.
 */
function TestCell({
  result,
  lang,
  groupCount,
  pinned,
  onPick,
}: {
  result: TestResult
  lang: 'en' | 'fr'
  groupCount: number
  /** The test pinned on this variable, if any. */
  pinned?: TestName
  /** Absent where the config is read-only (a dashboard widget): then this is just text. */
  onPick?: (test: TestName | null) => void
}) {
  const { t } = useTranslation()
  const label = result.testLabel[lang]

  // A pinned test carries no mark in the table. It reads in medium weight, and
  // the hover says it was chosen rather than derived — enough for the person
  // who set it, without a symbol competing with the significance stars.
  const name = <span className={cn(pinned && 'font-medium')}>{label}</span>

  // Read-only (a dashboard widget): the name, with WHY behind a hover.
  if (!onPick) {
    if (!result.rationale) return name
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="cursor-help underline decoration-dotted underline-offset-2">{name}</span>
          </TooltipTrigger>
          <TooltipContent className="max-w-xs">
            <p className="text-xs">{result.rationale[lang]}</p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    )
  }

  const choices = applicableTests(result.variableType, groupCount)
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {/* The chevron is the affordance. A dotted underline and cursor-help —
            which is all this cell used to carry — reads as "there is an
            explanation here", not "you can change this", so the per-variable
            choice went unnoticed. The rationale moves into the menu, where it
            no longer competes with the click. */}
        <button
          type="button"
          className="group -mx-1 flex w-full items-center gap-1 rounded px-1 text-left hover:bg-accent"
          title={pinned ? t('datasets.stats_test_pinned') : t('datasets.stats_pick_test')}
        >
          <span className="min-w-0 truncate">{name}</span>
          <ChevronDown
            size={11}
            className="shrink-0 text-muted-foreground opacity-40 transition-opacity group-hover:opacity-100"
          />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-w-xs text-xs">
        {/* WHY the current test was chosen. It used to be a hover on the cell,
            which hid the fact that the cell was a control; here it explains the
            choice at the moment the reader is about to change it. */}
        {result.rationale && (
          <>
            <p className="px-2 py-1.5 text-[10px] leading-snug text-muted-foreground">
              {result.rationale[lang]}
            </p>
            <DropdownMenuSeparator />
          </>
        )}
        <DropdownMenuItem onClick={() => onPick(null)}>
          {t('datasets.stats_test_auto')}
          {!pinned && <Check size={12} className="ml-auto" />}
        </DropdownMenuItem>
        {choices.map((test) => (
          <DropdownMenuItem key={test} onClick={() => onPick(test)}>
            {TEST_LABELS[test][lang]}
            {pinned === test && <Check size={12} className="ml-auto" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * The p-value, its significance marker, and any warning about its reliability.
 *
 * A fragile p is SHOWN and flagged, never hidden: suppressing it would leave
 * the reader thinking the comparison was not run, and quietly deciding for them
 * which results they may see is worse than telling them what is shaky.
 */
function PValueCell({
  result,
  alpha,
  highlight,
}: {
  result: TestResult
  alpha: number
  highlight: boolean
}) {
  if (result.pValue == null) return <span className="text-muted-foreground/40">{DASH}</span>
  const significant = result.pValue < alpha
  return (
    <span className={cn('font-mono', highlight && significant && 'font-bold')}>
      {formatP(result.pValue)}
      {highlight && significant && (
        <span className="text-green-600 dark:text-green-400">{sigStars(result.pValue)}</span>
      )}
      {result.warning && (
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="ml-1 inline-flex cursor-help align-middle text-amber-600 dark:text-amber-400">
                <AlertTriangle size={11} />
              </span>
            </TooltipTrigger>
            <TooltipContent className="max-w-xs">
              <p className="text-xs">{result.warning}</p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      )}
    </span>
  )
}


/**
 * The rendered table as plain text, for copy / LaTeX.
 *
 * Rebuilt from the results rather than scraped from the DOM: a cell renders as
 * JSX (a tooltip trigger, a coloured marker), and a manuscript wants the value.
 * The significance stars are kept — they carry meaning a reader expects — while
 * the warning icon becomes nothing, since its text is already in the tooltip.
 */
function toExportTable(
  rows: StatRow[],
  columns: PublicationColumn<StatRow>[],
  lang: 'en' | 'fr',
  alpha: number,
): ExportTable {
  const head: ExportTableCell[][] = []
  // A group header row, only when some column declares one.
  if (columns.some((c) => c.group)) {
    const groupRow: ExportTableCell[] = []
    for (const col of columns) {
      const last = groupRow[groupRow.length - 1]
      if (last && last.text === (col.group ?? '')) last.colSpan = (last.colSpan ?? 1) + 1
      else groupRow.push({ text: col.group ?? '', colSpan: 1, align: 'center' })
    }
    head.push(groupRow)
  }
  head.push(columns.map((c) => ({ text: c.header, align: c.align })))

  const body = rows.map((r) =>
    columns.map((c) => ({ text: exportCellText(c.id, r, lang, alpha), align: c.align })),
  )
  return { head, body }
}

function exportCellText(
  columnId: string,
  row: StatRow,
  lang: 'en' | 'fr',
  alpha: number,
): string {
  const r = row.result
  if (columnId === '__variable__') return row.label
  if (columnId.startsWith('g:')) return descriptiveText(r, columnId.slice(2))
  switch (columnId) {
    case 'test':
      return r.testLabel[lang]
    case 'statistic':
      return r.statistic != null ? `${r.statisticLabel} = ${fmt(r.statistic)}` : DASH
    case 'df':
      return r.df != null ? (Number.isInteger(r.df) ? String(r.df) : fmt(r.df, 1)) : DASH
    case 'p':
      if (r.pValue == null) return DASH
      return `${formatP(r.pValue)}${r.pValue < alpha ? sigStars(r.pValue) : ''}`
    case 'ci':
      return r.ci ? `[${fmt(r.ci[0])}, ${fmt(r.ci[1])}]` : DASH
    case 'effectSize':
      return r.effectSize != null ? `${r.effectSizeLabel} = ${fmt(r.effectSize)}` : DASH
    default:
      return ''
  }
}

function descriptiveText(result: TestResult, groupName: string): string {
  const gd = result.groupDescriptives?.find((g) => g.groupName === groupName)
  if (!gd) return DASH
  if (result.variableType === 'numeric') {
    return gd.mean != null ? `n=${gd.n}, ${fmt(gd.mean)} ± ${fmt(gd.sd ?? 0)}` : `n=${gd.n}`
  }
  const freqs = gd.freqs?.map((f) => `${f.category}: ${f.count} (${f.pct.toFixed(1)}%)`).join('; ')
  return freqs ? `n=${gd.n} ${freqs}` : `n=${gd.n}`
}
