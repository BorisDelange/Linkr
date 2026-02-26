import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { FlaskConical, AlertTriangle } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { ComponentPluginProps } from '@/lib/plugins/component-registry'

// ===========================================================================
// Types
// ===========================================================================

type TestName = 'welch-t' | 'mann-whitney' | 'chi-square' | 'fisher' | 'anova' | 'kruskal-wallis'

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
  let f = 1e-30
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

  // Build contingency table
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

function selectTest(
  variableType: 'numeric' | 'categorical',
  groupCount: number,
  preference: TestPreference,
  isTwoByTwo: boolean,
  minExpectedCount: number,
): TestName {
  if (variableType === 'categorical') {
    if (isTwoByTwo && minExpectedCount < 5) return 'fisher'
    return 'chi-square'
  }
  // Numeric
  if (groupCount === 2) {
    return preference === 'nonparametric' ? 'mann-whitney' : 'welch-t'
  }
  return preference === 'nonparametric' ? 'kruskal-wallis' : 'anova'
}

function computeAllTests(
  rows: Record<string, unknown>[],
  columns: { id: string; name: string; type: string }[],
  groupColumnId: string | undefined,
  valueColumnIds: string[],
  testPreference: TestPreference,
  alpha: number,
): TestResult[] {
  if (!groupColumnId || valueColumnIds.length === 0 || rows.length === 0) return []

  const groupCol = columns.find((c) => c.id === groupColumnId)
  if (!groupCol) return []

  // Build groups
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

      const testName = selectTest('numeric', validGroupNames.length, testPreference, false, 0)

      if (testName === 'welch-t') {
        const res = welchT(groupArrays[0], groupArrays[1], validGroupNames[0], validGroupNames[1], alpha)
        if (!res) {
          results.push({
            variable: col.name,
            variableType: 'numeric',
            testName,
            testLabel: TEST_LABELS[testName],
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

      // Check if 2x2 for Fisher decision
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

      const testName = selectTest('categorical', groupCount, testPreference, isTwoByTwo, minExpected)

      if (testName === 'fisher') {
        const res = fisherExact(catGroups, groupNames)
        results.push({
          variable: col.name,
          variableType: 'categorical',
          testName,
          testLabel: TEST_LABELS[testName],
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

export function StatisticalTestsComponent({ config, columns, rows, compact }: ComponentPluginProps) {
  const { i18n } = useTranslation()
  const lang = (i18n.language === 'fr' ? 'fr' : 'en') as 'en' | 'fr'

  const groupColumnId = config.groupColumn as string | undefined
  const rawValueColumns = config.valueColumns as string[] | undefined
  const testPreference = (config.testPreference as TestPreference) ?? 'auto'
  const alpha = (config.alpha as number) ?? 0.05
  const rawVisibleColumns = config.visibleColumns as string[] | undefined
  const visibleColumns = new Set(rawVisibleColumns?.length ? rawVisibleColumns : ALL_TABLE_COLUMNS)
  const highlightSignificant = (config.highlightSignificant as boolean) ?? true

  const showCol = (col: string) => visibleColumns.has(col)

  // Default: all columns except group column
  const valueColumnIds = rawValueColumns?.length
    ? rawValueColumns
    : columns.filter((c) => c.id !== groupColumnId).map((c) => c.id)

  const results = useMemo(
    () => computeAllTests(rows, columns, groupColumnId, valueColumnIds, testPreference, alpha),
    [rows, columns, groupColumnId, valueColumnIds, testPreference, alpha],
  )

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

  // Empty states
  if (!groupColumnId) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-muted-foreground">
        <FlaskConical size={24} className="opacity-40" />
        <p className="text-xs">
          {lang === 'fr'
            ? 'Sélectionnez une colonne de groupe pour commencer.'
            : 'Select a group column to begin.'}
        </p>
      </div>
    )
  }

  if (rows.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-muted-foreground">
        <FlaskConical size={24} className="opacity-40" />
        <p className="text-xs">{lang === 'fr' ? 'Aucune donnée disponible.' : 'No data available.'}</p>
      </div>
    )
  }

  if (results.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-muted-foreground">
        <FlaskConical size={24} className="opacity-40" />
        <p className="text-xs">
          {lang === 'fr'
            ? 'Sélectionnez au moins une colonne de valeurs.'
            : 'Select at least one value column.'}
        </p>
      </div>
    )
  }

  const cellCn = compact ? 'px-2 py-0.5' : 'px-3 py-1.5'
  const textCn = compact ? 'text-[10px]' : 'text-xs'
  const thCn = cn('border-b border-r font-medium whitespace-nowrap', cellCn)

  return (
    <div className={cn('h-full overflow-auto', !compact && 'p-4')}>
      <table className={cn('w-full border-collapse', textCn)}>
        <thead className="sticky top-0 z-10">
          <tr className="bg-muted">
            <th className={cn(thCn, 'text-left sticky left-0 z-20 bg-muted')}>
              Variable
            </th>
            {/* Group descriptive columns */}
            {showCol('descriptive') &&
              allGroupNames.map((gn) => (
                <th key={gn} className={cn(thCn, 'text-right')}>
                  {gn}
                </th>
              ))}
            {showCol('test') && (
              <th className={cn(thCn, 'text-left')}>
                Test
              </th>
            )}
            {showCol('statistic') && (
              <th className={cn(thCn, 'text-right')}>
                {lang === 'fr' ? 'Statistique' : 'Statistic'}
              </th>
            )}
            {showCol('df') && (
              <th className={cn(thCn, 'text-right')}>
                df
              </th>
            )}
            {showCol('p') && (
              <th className={cn(thCn, 'text-right')}>
                p
              </th>
            )}
            {showCol('ci') && (
              <th className={cn(thCn, 'text-right')}>
                {lang === 'fr' ? 'IC 95%' : '95% CI'}
              </th>
            )}
            {showCol('effectSize') && (
              <th className={cn(thCn, 'text-right')}>
                {lang === 'fr' ? 'Taille d\'effet' : 'Effect size'}
              </th>
            )}
            <th className={cn('border-b font-medium text-left whitespace-nowrap', cellCn)} />
          </tr>
        </thead>
        <tbody>
          {results.map((r, idx) => {
            const isSignificant = r.pValue != null && r.pValue < alpha
            const rowBg = highlightSignificant && isSignificant
              ? 'bg-green-50 dark:bg-green-950/20'
              : idx % 2 === 1
                ? 'bg-muted/30'
                : ''
            return (
              <tr
                key={idx}
                className={cn('transition-colors hover:bg-accent/30', rowBg)}
              >
                {/* Variable */}
                <td
                  className={cn(
                    'sticky left-0 z-[5] border-b border-r font-medium bg-background whitespace-nowrap',
                    cellCn,
                    rowBg,
                  )}
                >
                  <span>{r.variable}</span>
                  <span className="ml-1 text-muted-foreground">
                    ({r.variableType === 'numeric' ? 'num.' : 'cat.'})
                  </span>
                </td>

                {/* Group descriptive columns — right after variable for comparison */}
                {showCol('descriptive') &&
                  allGroupNames.map((gn) => {
                    const gd = r.groupDescriptives?.find((g) => g.groupName === gn)
                    if (!gd) {
                      return (
                        <td key={gn} className={cn('border-b border-r text-right whitespace-nowrap', cellCn)}>
                          <span className="text-muted-foreground/40">{DASH}</span>
                        </td>
                      )
                    }
                    if (r.variableType === 'numeric') {
                      return (
                        <td key={gn} className={cn('border-b border-r text-right whitespace-nowrap', cellCn)}>
                          <span className="text-muted-foreground">n=</span>{gd.n}
                          {gd.mean != null && (
                            <>
                              {', '}
                              {fmt(gd.mean)} ± {fmt(gd.sd ?? 0)}
                            </>
                          )}
                        </td>
                      )
                    }
                    // Categorical: show top categories
                    return (
                      <td key={gn} className={cn('border-b border-r text-right whitespace-normal max-w-[220px]', cellCn)}>
                        <span className="text-muted-foreground">n=</span>{gd.n}
                        {gd.freqs && (
                          <span className="ml-1">
                            {gd.freqs.map((f) => `${f.category}: ${f.count} (${f.pct.toFixed(1)}%)`).join('; ')}
                          </span>
                        )}
                      </td>
                    )
                  })}

                {/* Test */}
                {showCol('test') && (
                  <td className={cn('border-b border-r whitespace-nowrap', cellCn)}>
                    {r.testLabel[lang]}
                  </td>
                )}

                {/* Statistic */}
                {showCol('statistic') && (
                  <td className={cn('border-b border-r text-right font-mono whitespace-nowrap', cellCn)}>
                    {r.statistic != null ? (
                      <>
                        <span className="text-muted-foreground">{r.statisticLabel} = </span>
                        {fmt(r.statistic)}
                      </>
                    ) : (
                      <span className="text-muted-foreground/40">{DASH}</span>
                    )}
                  </td>
                )}

                {/* df */}
                {showCol('df') && (
                  <td className={cn('border-b border-r text-right font-mono whitespace-nowrap', cellCn)}>
                    {r.df != null ? (
                      Number.isInteger(r.df) ? r.df : fmt(r.df, 1)
                    ) : (
                      <span className="text-muted-foreground/40">{DASH}</span>
                    )}
                  </td>
                )}

                {/* p-value */}
                {showCol('p') && (
                  <td
                    className={cn(
                      'border-b border-r text-right font-mono whitespace-nowrap',
                      cellCn,
                      isSignificant && 'font-bold',
                    )}
                  >
                    {r.pValue != null ? (
                      <>
                        {formatP(r.pValue)}
                        {isSignificant && (
                          <span className="text-green-600 dark:text-green-400">{sigStars(r.pValue)}</span>
                        )}
                      </>
                    ) : (
                      <span className="text-muted-foreground/40">{DASH}</span>
                    )}
                  </td>
                )}

                {/* 95% CI */}
                {showCol('ci') && (
                  <td className={cn('border-b border-r text-right font-mono whitespace-nowrap', cellCn)}>
                    {r.ci ? (
                      `[${fmt(r.ci[0])}, ${fmt(r.ci[1])}]`
                    ) : (
                      <span className="text-muted-foreground/40">{DASH}</span>
                    )}
                  </td>
                )}

                {/* Effect size */}
                {showCol('effectSize') && (
                  <td className={cn('border-b border-r text-right font-mono whitespace-nowrap', cellCn)}>
                    {r.effectSize != null ? (
                      <>
                        <span className="text-muted-foreground">{r.effectSizeLabel} = </span>
                        {fmt(r.effectSize)}
                      </>
                    ) : (
                      <span className="text-muted-foreground/40">{DASH}</span>
                    )}
                  </td>
                )}

                {/* Warning */}
                <td className={cn('border-b whitespace-nowrap', cellCn)}>
                  {r.warning && (
                    <span className="inline-flex items-center gap-1 text-amber-600 dark:text-amber-400">
                      <AlertTriangle size={compact ? 10 : 12} />
                      {r.warning}
                    </span>
                  )}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
