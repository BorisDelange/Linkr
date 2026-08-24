import { useMemo, useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { TrendingUp, AlertTriangle } from 'lucide-react'
import { cn } from '@/lib/utils'
import { isServerMode } from '@/lib/api-client'
import { renderOnServer } from '@/lib/api/execution'
import type { ComponentPluginProps } from '@/lib/plugins/component-registry'
import { buildRegressionSpec } from './regression-server'
import { niceTicks } from '@/lib/chart-ticks'
import { displayColumnName } from '@/lib/dataset-utils'
import { orderSelection, type VariableOrder } from '@/lib/analysis-default-columns'
import { PublicationTable, type PublicationColumn } from '@/components/ui/publication-table'
import { usePublishAnalysisTable } from './analysis-table-context'
import type { ExportTable, ExportTableCell } from '@/lib/table-export'
import type { DatasetColumn } from '@/types'

/**
 * A model warning as DATA rather than as a sentence.
 *
 * The compute path runs far from i18n and is shared with the server result, so
 * it records what happened and the render says it in the reader's language.
 */
export type RegressionWarning =
  | { code: 'single_category'; name: string }
  | { code: 'too_many_categories'; name: string; count: number }
  | { code: 'outcome_not_binary'; count: number }
  | { code: 'rows_excluded'; count: number }

/** Placeholder for the intercept row, swapped for a localized name at render. */
const INTERCEPT = '__intercept__'

/**
 * Is this coefficient the intercept?
 *
 * Two spellings, because the two compute paths name it differently: the client
 * emits the sentinel above, while the server's pandas program emits the
 * statsmodels literal. Both must be recognised or server mode prints the raw
 * "(Intercept)" and the forest plot draws it as though it were a predictor.
 */
function isIntercept(name: string): boolean {
  return name === INTERCEPT || name === '(Intercept)'
}

/**
 * Forest-plot marker colours.
 *
 * Theme tokens rather than raw hex: the previous #16a34a / #6b7280 stayed put
 * in dark mode while everything drawn with currentColor around them inverted.
 */
const SIG_COLOR = 'var(--color-primary)'
const NON_SIG_COLOR = 'var(--color-muted-foreground)'

// ===========================================================================
// Types
// ===========================================================================

interface CoefficientResult {
  name: string
  estimate: number
  se: number
  ciLow: number
  ciHigh: number
  statistic: number
  pValue: number
  or?: number
  orCiLow?: number
  orCiHigh?: number
}

interface RegressionResult {
  type: 'linear' | 'logistic'
  coefficients: CoefficientResult[]
  nObs: number
  nComplete: number
  rSquared?: number
  adjRSquared?: number
  fStatistic?: number
  fPValue?: number
  aic?: number
  logLikelihood?: number
  warnings: string[]
}

const DASH = '\u2014'

// ===========================================================================
// Math helpers (reuse CDF functions from statistical-tests)
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

function logBeta(a: number, b: number): number {
  return gammaLn(a) + gammaLn(b) - gammaLn(a + b)
}

function regularizedBeta(a: number, b: number, x: number): number {
  if (x <= 0) return 0
  if (x >= 1) return 1
  if (x > (a + 1) / (a + b + 2)) {
    return 1 - regularizedBeta(b, a, 1 - x)
  }
  const lnPrefix = a * Math.log(x) + b * Math.log(1 - x) - logBeta(a, b) - Math.log(a)
  const maxIter = 200
  const eps = 1e-14
  let h = 1
  let denom = 1
  let prev = 1
  for (let m = 1; m <= maxIter; m++) {
    const m2 = 2 * m
    let numerator = (m * (b - m) * x) / ((a + m2 - 1) * (a + m2))
    denom = 1 + numerator / denom
    if (Math.abs(denom) < 1e-30) denom = 1e-30
    denom = 1 / denom
    prev = 1 + numerator / prev
    if (Math.abs(prev) < 1e-30) prev = 1e-30
    h *= denom * prev

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

function tCDF(t: number, df: number): number {
  const x = df / (df + t * t)
  const p = 0.5 * regularizedBeta(df / 2, 0.5, x)
  return t >= 0 ? 1 - p : p
}

function tTestPValue(t: number, df: number): number {
  return 2 * Math.min(tCDF(t, df), 1 - tCDF(t, df))
}

function normalCDF(z: number): number {
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

function fCDF(f: number, d1: number, d2: number): number {
  if (f <= 0) return 0
  const x = (d1 * f) / (d1 * f + d2)
  return regularizedBeta(d1 / 2, d2 / 2, x)
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
// Matrix operations (for OLS and IRLS)
// ===========================================================================

type Matrix = number[][]
type Vector = number[]

function matCreate(rows: number, cols: number): Matrix {
  return Array.from({ length: rows }, () => new Array(cols).fill(0))
}

function matTranspose(A: Matrix): Matrix {
  const rows = A.length, cols = A[0].length
  const T = matCreate(cols, rows)
  for (let i = 0; i < rows; i++)
    for (let j = 0; j < cols; j++) T[j][i] = A[i][j]
  return T
}

function matMul(A: Matrix, B: Matrix): Matrix {
  const m = A.length, n = B[0].length, p = B.length
  const C = matCreate(m, n)
  for (let i = 0; i < m; i++)
    for (let j = 0; j < n; j++) {
      let s = 0
      for (let k = 0; k < p; k++) s += A[i][k] * B[k][j]
      C[i][j] = s
    }
  return C
}

function matVecMul(A: Matrix, v: Vector): Vector {
  const m = A.length, n = A[0].length
  const result = new Array(m).fill(0)
  for (let i = 0; i < m; i++)
    for (let j = 0; j < n; j++) result[i] += A[i][j] * v[j]
  return result
}

function vecDot(a: Vector, b: Vector): number {
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i] * b[i]
  return s
}

/** Solve A*x = b using Cholesky decomposition (A must be symmetric positive-definite). */
function choleskySolve(A: Matrix, b: Vector): Vector | null {
  const n = A.length
  const L = matCreate(n, n)

  // Cholesky decomposition A = L * L^T
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let s = 0
      for (let k = 0; k < j; k++) s += L[i][k] * L[j][k]
      if (i === j) {
        const diag = A[i][i] - s
        if (diag <= 0) return null // Not positive-definite
        L[i][j] = Math.sqrt(diag)
      } else {
        L[i][j] = (A[i][j] - s) / L[j][j]
      }
    }
  }

  // Forward substitution: L * y = b
  const y = new Array(n).fill(0)
  for (let i = 0; i < n; i++) {
    let s = 0
    for (let k = 0; k < i; k++) s += L[i][k] * y[k]
    y[i] = (b[i] - s) / L[i][i]
  }

  // Back substitution: L^T * x = y
  const x = new Array(n).fill(0)
  for (let i = n - 1; i >= 0; i--) {
    let s = 0
    for (let k = i + 1; k < n; k++) s += L[k][i] * x[k]
    x[i] = (y[i] - s) / L[i][i]
  }

  return x
}

/** Invert a symmetric positive-definite matrix using Cholesky. */
function choleskyInverse(A: Matrix): Matrix | null {
  const n = A.length
  const inv = matCreate(n, n)
  for (let j = 0; j < n; j++) {
    const ej = new Array(n).fill(0)
    ej[j] = 1
    const col = choleskySolve(A, ej)
    if (!col) return null
    for (let i = 0; i < n; i++) inv[i][j] = col[i]
  }
  return inv
}

// ===========================================================================
// Data preparation
// ===========================================================================

function isNotMissing(v: unknown): boolean {
  return v != null && v !== '' && String(v).toLowerCase() !== 'null'
}

function isBinaryColumn(values: unknown[]): boolean {
  const unique = new Set<string>()
  for (const v of values) {
    if (!isNotMissing(v)) continue
    unique.add(String(v))
    if (unique.size > 2) return false
  }
  return unique.size === 2
}

interface PreparedData {
  X: Matrix  // n × p (with intercept column at index 0)
  y: Vector  // n × 1
  nObs: number
  nComplete: number
  predictorNames: string[]  // length p (includes "(Intercept)")
  warnings: string[]
  binaryOutcomeMap?: Map<string, number>
}

function prepareData(
  rows: Record<string, unknown>[],
  columns: DatasetColumn[],
  outcomeId: string,
  predictorIds: string[],
  isLogistic: boolean,
): PreparedData | null {
  const colMap = new Map(columns.map(c => [c.id, c]))
  const outcomeCol = colMap.get(outcomeId)
  if (!outcomeCol) return null

  const predictorCols = predictorIds
    .filter(id => id !== outcomeId)
    .map(id => colMap.get(id))
    .filter((c): c is DatasetColumn => c != null)

  if (predictorCols.length === 0) return null

  const warnings: RegressionWarning[] = []

  // Detect categorical predictors → dummy encoding
  // For each predictor: if type !== 'number', treat as categorical
  interface PredictorSpec {
    colId: string
    colName: string
    isNumeric: boolean
    categories?: string[] // for categorical: sorted unique values (first = reference)
  }

  const predictorSpecs: PredictorSpec[] = []
  for (const col of predictorCols) {
    if (col.type === 'number') {
      predictorSpecs.push({ colId: col.id, colName: displayColumnName(col), isNumeric: true })
    } else {
      // Collect unique categories
      const cats = new Set<string>()
      for (const row of rows) {
        const v = row[col.id]
        if (isNotMissing(v)) cats.add(String(v))
      }
      const sorted = [...cats].sort()
      if (sorted.length < 2) {
        warnings.push({ code: 'single_category', name: displayColumnName(col) })
        continue
      }
      if (sorted.length > 20) {
        warnings.push({ code: 'too_many_categories', name: displayColumnName(col), count: sorted.length })
        continue
      }
      predictorSpecs.push({ colId: col.id, colName: displayColumnName(col), isNumeric: false, categories: sorted })
    }
  }

  if (predictorSpecs.length === 0) return null

  const predictorNames: string[] = [INTERCEPT]
  for (const spec of predictorSpecs) {
    if (spec.isNumeric) {
      predictorNames.push(spec.colName)
    } else {
      // Reference = first category (omitted), dummies for rest
      for (let i = 1; i < spec.categories!.length; i++) {
        predictorNames.push(`${spec.colName}: ${spec.categories![i]}`)
      }
    }
  }

  // Binary outcome mapping for logistic
  let binaryOutcomeMap: Map<string, number> | undefined
  if (isLogistic) {
    const unique = new Set<string>()
    for (const row of rows) {
      const v = row[outcomeId]
      if (isNotMissing(v)) unique.add(String(v))
    }
    const sorted = [...unique].sort()
    if (sorted.length !== 2) {
      warnings.push({ code: 'outcome_not_binary', count: sorted.length })
      return { X: [], y: [], nObs: rows.length, nComplete: 0, predictorNames, warnings }
    }
    binaryOutcomeMap = new Map()
    // Try numeric 0/1 first
    const numVals = sorted.map(Number)
    if (sorted.length === 2 && !isNaN(numVals[0]) && !isNaN(numVals[1]) &&
      ((numVals[0] === 0 && numVals[1] === 1) || (numVals[0] === 1 && numVals[1] === 0))) {
      binaryOutcomeMap.set(sorted[0], numVals[0])
      binaryOutcomeMap.set(sorted[1], numVals[1])
    } else {
      binaryOutcomeMap.set(sorted[0], 0)
      binaryOutcomeMap.set(sorted[1], 1)
    }
  }

  const p = predictorNames.length
  const Xrows: number[][] = []
  const yVec: number[] = []
  let nMissing = 0

  for (const row of rows) {
    const yRaw = row[outcomeId]
    if (!isNotMissing(yRaw)) { nMissing++; continue }

    let yVal: number
    if (isLogistic) {
      const mapped = binaryOutcomeMap!.get(String(yRaw))
      if (mapped === undefined) { nMissing++; continue }
      yVal = mapped
    } else {
      yVal = typeof yRaw === 'number' ? yRaw : Number(yRaw)
      if (isNaN(yVal)) { nMissing++; continue }
    }

    const xRow: number[] = [1] // intercept
    let skip = false
    for (const spec of predictorSpecs) {
      const v = row[spec.colId]
      if (!isNotMissing(v)) { skip = true; break }
      if (spec.isNumeric) {
        const n = typeof v === 'number' ? v : Number(v)
        if (isNaN(n)) { skip = true; break }
        xRow.push(n)
      } else {
        const s = String(v)
        if (!spec.categories!.includes(s)) { skip = true; break }
        // Dummies: reference = categories[0], so categories[1..] get 0/1
        for (let i = 1; i < spec.categories!.length; i++) {
          xRow.push(s === spec.categories![i] ? 1 : 0)
        }
      }
    }
    if (skip) { nMissing++; continue }
    if (xRow.length !== p) { nMissing++; continue }

    Xrows.push(xRow)
    yVec.push(yVal)
  }

  if (nMissing > 0) {
    warnings.push({ code: 'rows_excluded', count: nMissing })
  }

  return {
    X: Xrows,
    y: yVec,
    nObs: rows.length,
    nComplete: Xrows.length,
    predictorNames,
    warnings,
    binaryOutcomeMap,
  }
}

// ===========================================================================
// OLS linear regression
// ===========================================================================

function fitLinear(
  X: Matrix, y: Vector, predictorNames: string[], alpha: number,
): { coefficients: CoefficientResult[]; rSquared: number; adjRSquared: number; fStatistic: number; fPValue: number } | null {
  const n = X.length
  const p = X[0].length
  if (n <= p) return null

  // X^T X
  const Xt = matTranspose(X)
  const XtX = matMul(Xt, X)

  // X^T y
  const Xty = matVecMul(Xt, y)

  // Solve (X^T X) beta = X^T y
  const beta = choleskySolve(XtX, Xty)
  if (!beta) return null

  // Residuals
  const yHat = matVecMul(X, beta)
  const residuals = y.map((yi, i) => yi - yHat[i])

  // RSS and TSS
  const yMean = y.reduce((s, v) => s + v, 0) / n
  const tss = y.reduce((s, v) => s + (v - yMean) ** 2, 0)
  const rss = residuals.reduce((s, v) => s + v * v, 0)

  const rSquared = tss > 0 ? 1 - rss / tss : 0
  const adjRSquared = tss > 0 ? 1 - ((1 - rSquared) * (n - 1)) / (n - p) : 0

  // MSE
  const mse = rss / (n - p)
  if (mse <= 0) return null

  // Covariance matrix: MSE * (X^T X)^-1
  const XtXinv = choleskyInverse(XtX)
  if (!XtXinv) return null

  // z critical value
  const zCrit = inverseNormalCDF(1 - alpha / 2)

  const coefficients: CoefficientResult[] = predictorNames.map((name, j) => {
    const se = Math.sqrt(mse * XtXinv[j][j])
    const t = se > 0 ? beta[j] / se : 0
    const df = n - p
    const pVal = se > 0 ? tTestPValue(t, df) : 1
    return {
      name,
      estimate: beta[j],
      se,
      ciLow: beta[j] - zCrit * se,
      ciHigh: beta[j] + zCrit * se,
      statistic: t,
      pValue: pVal,
    }
  })

  // F-test for overall model significance
  const dfModel = p - 1
  const dfResid = n - p
  const msr = dfModel > 0 ? (tss - rss) / dfModel : 0
  const fStat = mse > 0 ? msr / mse : 0
  const fPVal = dfModel > 0 && dfResid > 0 ? 1 - fCDF(fStat, dfModel, dfResid) : 1

  return { coefficients, rSquared, adjRSquared, fStatistic: fStat, fPValue: fPVal }
}

// ===========================================================================
// Logistic regression (IRLS)
// ===========================================================================

function sigmoid(z: number): number {
  if (z > 500) return 1
  if (z < -500) return 0
  return 1 / (1 + Math.exp(-z))
}

function fitLogistic(
  X: Matrix, y: Vector, predictorNames: string[], alpha: number,
): { coefficients: CoefficientResult[]; logLikelihood: number; aic: number } | null {
  const n = X.length
  const p = X[0].length
  if (n <= p) return null

  // IRLS (Iteratively Reweighted Least Squares)
  let beta = new Array(p).fill(0)
  const maxIter = 50
  const tol = 1e-8

  for (let iter = 0; iter < maxIter; iter++) {
    // Compute probabilities
    const mu = X.map(row => sigmoid(vecDot(row, beta)))

    // Weight matrix W = diag(mu * (1 - mu))
    const w = mu.map(m => {
      const val = m * (1 - m)
      return val < 1e-10 ? 1e-10 : val // prevent numerical issues
    })

    // Working response: z = X*beta + (y - mu) / w
    // But for IRLS we solve: X^T W X * delta = X^T (y - mu)
    // Then beta_new = beta + delta

    // X^T W X
    const XtWX = matCreate(p, p)
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < p; j++) {
        for (let k = 0; k <= j; k++) {
          XtWX[j][k] += X[i][j] * w[i] * X[i][k]
        }
      }
    }
    // Symmetrize
    for (let j = 0; j < p; j++)
      for (let k = j + 1; k < p; k++) XtWX[j][k] = XtWX[k][j]

    // X^T (y - mu)
    const gradient = new Array(p).fill(0)
    for (let i = 0; i < n; i++) {
      const diff = y[i] - mu[i]
      for (let j = 0; j < p; j++) gradient[j] += X[i][j] * diff
    }

    const delta = choleskySolve(XtWX, gradient)
    if (!delta) return null

    const newBeta = beta.map((b, j) => b + delta[j])

    const change = delta.reduce((s, d) => s + d * d, 0)
    beta = newBeta
    if (change < tol) break
  }

  // Final probabilities and log-likelihood
  const mu = X.map(row => sigmoid(vecDot(row, beta)))
  let logLik = 0
  for (let i = 0; i < n; i++) {
    const p_i = Math.max(1e-15, Math.min(1 - 1e-15, mu[i]))
    logLik += y[i] * Math.log(p_i) + (1 - y[i]) * Math.log(1 - p_i)
  }

  // Covariance matrix (X^T W X)^{-1}
  const w = mu.map(m => {
    const val = m * (1 - m)
    return val < 1e-10 ? 1e-10 : val
  })
  const XtWX = matCreate(p, p)
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < p; j++) {
      for (let k = 0; k <= j; k++) {
        XtWX[j][k] += X[i][j] * w[i] * X[i][k]
      }
    }
  }
  for (let j = 0; j < p; j++)
    for (let k = j + 1; k < p; k++) XtWX[j][k] = XtWX[k][j]

  const covMatrix = choleskyInverse(XtWX)
  if (!covMatrix) return null

  const zCrit = inverseNormalCDF(1 - alpha / 2)

  const coefficients: CoefficientResult[] = predictorNames.map((name, j) => {
    const se = Math.sqrt(covMatrix[j][j])
    const z = se > 0 ? beta[j] / se : 0
    const pVal = se > 0 ? 2 * (1 - normalCDF(Math.abs(z))) : 1
    const orVal = Math.exp(beta[j])
    return {
      name,
      estimate: beta[j],
      se,
      ciLow: beta[j] - zCrit * se,
      ciHigh: beta[j] + zCrit * se,
      statistic: z,
      pValue: pVal,
      or: orVal,
      orCiLow: Math.exp(beta[j] - zCrit * se),
      orCiHigh: Math.exp(beta[j] + zCrit * se),
    }
  })

  const aic = -2 * logLik + 2 * p

  return { coefficients, logLikelihood: logLik, aic }
}

// ===========================================================================
// Main regression function
// ===========================================================================

function runRegression(
  rows: Record<string, unknown>[],
  columns: DatasetColumn[],
  outcomeId: string,
  predictorIds: string[],
  regressionType: 'auto' | 'linear' | 'logistic',
  confidenceLevel: number,
): RegressionResult | null {
  const colMap = new Map(columns.map(c => [c.id, c]))
  const outcomeCol = colMap.get(outcomeId)
  if (!outcomeCol) return null

  // Auto-detect: if outcome is binary → logistic, else linear
  let isLogistic: boolean
  if (regressionType === 'auto') {
    if (outcomeCol.type === 'number') {
      // Check if numeric column is actually binary (0/1)
      const vals = rows.map(r => r[outcomeId]).filter(isNotMissing)
      isLogistic = isBinaryColumn(vals)
    } else {
      isLogistic = true
    }
  } else {
    isLogistic = regressionType === 'logistic'
  }

  const alpha = 1 - confidenceLevel / 100

  const data = prepareData(rows, columns, outcomeId, predictorIds, isLogistic)
  if (!data) return null

  if (data.nComplete < data.predictorNames.length + 1) {
    return {
      type: isLogistic ? 'logistic' : 'linear',
      coefficients: [],
      nObs: data.nObs,
      nComplete: data.nComplete,
      warnings: [...data.warnings, `Not enough observations (${data.nComplete}) for ${data.predictorNames.length} parameters`],
    }
  }

  if (isLogistic) {
    const result = fitLogistic(data.X, data.y, data.predictorNames, alpha)
    if (!result) {
      return {
        type: 'logistic',
        coefficients: [],
        nObs: data.nObs,
        nComplete: data.nComplete,
        warnings: [...data.warnings, 'Logistic regression failed to converge'],
      }
    }
    return {
      type: 'logistic',
      coefficients: result.coefficients,
      nObs: data.nObs,
      nComplete: data.nComplete,
      logLikelihood: result.logLikelihood,
      aic: result.aic,
      warnings: data.warnings,
    }
  } else {
    const result = fitLinear(data.X, data.y, data.predictorNames, alpha)
    if (!result) {
      return {
        type: 'linear',
        coefficients: [],
        nObs: data.nObs,
        nComplete: data.nComplete,
        warnings: [...data.warnings, 'Linear regression failed (singular matrix)'],
      }
    }
    return {
      type: 'linear',
      coefficients: result.coefficients,
      nObs: data.nObs,
      nComplete: data.nComplete,
      rSquared: result.rSquared,
      adjRSquared: result.adjRSquared,
      fStatistic: result.fStatistic,
      fPValue: result.fPValue,
      warnings: data.warnings,
    }
  }
}

// ===========================================================================
// Formatting helpers
// ===========================================================================

function fmt(val: number, decimals = 3): string {
  if (!isFinite(val)) return DASH
  if (Math.abs(val) >= 1e6) return val.toExponential(2)
  if (Math.abs(val) < 0.001 && val !== 0) return val.toExponential(2)
  return val.toFixed(decimals)
}

function fmtP(p: number): string {
  if (!isFinite(p)) return DASH
  if (p < 0.001) return '< 0.001'
  return p.toFixed(3)
}

function pStars(p: number): string {
  if (p < 0.001) return '***'
  if (p < 0.01) return '**'
  if (p < 0.05) return '*'
  return ''
}

// ===========================================================================
// Forest Plot (SVG)
// ===========================================================================

interface ForestPlotProps {
  coefficients: CoefficientResult[]
  isLogistic: boolean
  compact?: boolean
  alpha: number
}

function ForestPlot({ coefficients, isLogistic, compact, alpha }: ForestPlotProps) {
  // Exclude intercept from forest plot
  const { t } = useTranslation()
  const items = coefficients.filter(c => !isIntercept(c.name))
  if (items.length === 0) return null

  const rowHeight = compact ? 22 : 28
  const labelWidth = compact ? 120 : 180
  const plotWidth = compact ? 200 : 300
  const valueWidth = compact ? 100 : 120
  const totalWidth = labelWidth + plotWidth + valueWidth
  const marginTop = compact ? 20 : 28
  // Room below the rows for the axis rule, its tick labels and the caption —
  // the old 10px held the caption alone.
  const axisHeight = compact ? 16 : 20
  const captionHeight = compact ? 10 : 12
  const axisY = marginTop + items.length * rowHeight + 4
  const totalHeight = axisY + axisHeight + captionHeight

  // Use OR for logistic, estimate for linear
  const values = items.map(c => isLogistic ? (c.or ?? Math.exp(c.estimate)) : c.estimate)
  const ciLows = items.map(c => isLogistic ? (c.orCiLow ?? Math.exp(c.ciLow)) : c.ciLow)
  const ciHighs = items.map(c => isLogistic ? (c.orCiHigh ?? Math.exp(c.ciHigh)) : c.ciHigh)

  const refValue = isLogistic ? 1 : 0

  // Compute scale: include all CIs + reference line
  const allVals = [...values, ...ciLows, ...ciHighs, refValue]
  let minVal = Math.min(...allVals.filter(isFinite))
  let maxVal = Math.max(...allVals.filter(isFinite))
  const range = maxVal - minVal || 1
  minVal -= range * 0.1
  maxVal += range * 0.1

  // Round ticks over the padded range, from the same helper every other chart
  // uses. A forest plot without an axis asks the reader to judge distance from
  // a line with nothing to measure against.
  const scale = niceTicks([minVal, maxVal])
  if (scale) {
    minVal = scale.domain[0]
    maxVal = scale.domain[1]
  }
  const ticks = scale?.ticks ?? []

  const xScale = (v: number) => {
    const clamped = Math.max(minVal, Math.min(maxVal, v))
    return labelWidth + ((clamped - minVal) / (maxVal - minVal)) * plotWidth
  }

  const refX = xScale(refValue)

  return (
    <svg width={totalWidth} height={totalHeight} className="text-foreground" style={{ fontSize: compact ? 9 : 11 }}>
      {/* Header */}
      <text x={labelWidth + plotWidth / 2} y={compact ? 12 : 16} textAnchor="middle" fill="currentColor" fontWeight={600} fontSize={compact ? 10 : 12}>
        {isLogistic ? t('analyses.reg_forest_or') : t('analyses.reg_forest_estimate')}
      </text>

      {/* Reference line */}
      <line x1={refX} y1={marginTop} x2={refX} y2={marginTop + items.length * rowHeight} stroke="currentColor" strokeWidth={1} strokeDasharray="4,3" opacity={0.4} />

      {items.map((coef, i) => {
        const cy = marginTop + i * rowHeight + rowHeight / 2
        const val = values[i]
        const lo = ciLows[i]
        const hi = ciHighs[i]
        const x = xScale(val)
        const xLo = xScale(lo)
        const xHi = xScale(hi)
        const isSig = coef.pValue < alpha

        return (
          <g key={i}>
            {/* Alternating row bg */}
            {i % 2 === 1 && (
              <rect x={0} y={cy - rowHeight / 2} width={totalWidth} height={rowHeight} fill="currentColor" opacity={0.04} />
            )}
            {/* Label */}
            <text x={labelWidth - 6} y={cy + 4} textAnchor="end" fill="currentColor" opacity={0.85} fontSize={compact ? 9 : 11}>
              <title>{coef.name}</title>
              {coef.name.length > (compact ? 18 : 25) ? coef.name.slice(0, compact ? 16 : 23) + '…' : coef.name}
            </text>
            {/* CI line */}
            <line x1={xLo} y1={cy} x2={xHi} y2={cy} stroke={isSig ? SIG_COLOR : NON_SIG_COLOR} strokeWidth={1.5} />
            {/* CI caps */}
            <line x1={xLo} y1={cy - 3} x2={xLo} y2={cy + 3} stroke={isSig ? SIG_COLOR : NON_SIG_COLOR} strokeWidth={1.5} />
            <line x1={xHi} y1={cy - 3} x2={xHi} y2={cy + 3} stroke={isSig ? SIG_COLOR : NON_SIG_COLOR} strokeWidth={1.5} />
            {/* Point estimate */}
            <rect x={x - 3.5} y={cy - 3.5} width={7} height={7} fill={isSig ? SIG_COLOR : NON_SIG_COLOR} transform={`rotate(45, ${x}, ${cy})`} />
            {/* Value text */}
            <text x={labelWidth + plotWidth + 6} y={cy + 4} fill="currentColor" opacity={0.8} fontSize={compact ? 8 : 10}>
              {fmt(val, 2)} [{fmt(lo, 2)}, {fmt(hi, 2)}]
            </text>
          </g>
        )
      })}

      {/* X axis: a rule, round ticks and their values. */}
      <g>
        <line
          x1={labelWidth}
          y1={axisY}
          x2={labelWidth + plotWidth}
          y2={axisY}
          stroke="currentColor"
          opacity={0.25}
        />
        {ticks.map((tv) => (
          <g key={tv}>
            <line x1={xScale(tv)} y1={axisY} x2={xScale(tv)} y2={axisY + 3} stroke="currentColor" opacity={0.25} />
            <text
              x={xScale(tv)}
              y={axisY + (compact ? 11 : 13)}
              textAnchor="middle"
              fill="currentColor"
              opacity={0.6}
              fontSize={compact ? 8 : 9}
            >
              {fmt(tv, 2)}
            </text>
          </g>
        ))}
      </g>

      {/* What a position on that axis means. */}
      <text x={labelWidth + plotWidth / 2} y={totalHeight - 1} textAnchor="middle" fill="currentColor" opacity={0.5} fontSize={compact ? 8 : 9}>
        {isLogistic ? t('analyses.reg_forest_axis_or') : t('analyses.reg_forest_axis_linear')}
      </text>
    </svg>
  )
}

// ===========================================================================
// Component
// ===========================================================================

export function RegressionComponent({ config, columns, rows, compact, datasetFileId, datasetFilters }: ComponentPluginProps) {
  const { t } = useTranslation()
  const server = isServerMode()

  const outcomeId = (config.outcomeColumn as string) ?? ''
  const variableOrder = (config.variableOrder as VariableOrder) ?? 'dataset'
  const rawPredictorIds = useMemo(
    () => (config.predictorColumns as string[]) ?? [],
    [config.predictorColumns],
  )
  const predictorIds = useMemo(
    () => orderSelection(rawPredictorIds, columns, variableOrder, displayColumnName),
    [rawPredictorIds, columns, variableOrder],
  )
  const regressionType = (config.regressionType as 'auto' | 'linear' | 'logistic') ?? 'auto'
  const confidenceLevel = (config.confidenceLevel as number) ?? 95
  const showForestPlot = (config.showForestPlot as boolean) ?? true
  const visibleColumns = (config.visibleColumns as string[]) ?? []
  const highlightSignificant = (config.highlightSignificant as boolean) ?? true
  const wrap = config.wrap === true
  const alpha = 1 - confidenceLevel / 100

  // Default visible: all
  const allColIds = ['estimate', 'se', 'ci', 'statistic', 'p']
  const visCols = visibleColumns.length > 0 ? visibleColumns : allColIds

  const localResult = useMemo(
    () => {
      if (server || !outcomeId || predictorIds.length === 0) return null
      return runRegression(rows, columns, outcomeId, predictorIds, regressionType, confidenceLevel)
    },
    [server, rows, columns, outcomeId, predictorIds, regressionType, confidenceLevel],
  )
  // Stable string keys so the effect only re-fetches on a semantic change.
  const spec = server && datasetFileId && outcomeId && predictorIds.length > 0
    ? buildRegressionSpec(columns, outcomeId, predictorIds, regressionType, confidenceLevel)
    : null
  const specKey = spec ? JSON.stringify(spec) : null
  const filtersKey = JSON.stringify(datasetFilters ?? null)
  const [serverResult, setServerResult] = useState<RegressionResult | null>(null)
  const [serverError, setServerError] = useState<string | null>(null)
  const [serverLoaded, setServerLoaded] = useState(false)
  useEffect(() => {
    if (!server || !datasetFileId || !spec) return
    let cancelled = false
    renderOnServer('regression', spec, { datasetFileId, datasetFilters })
      .then((out) => {
        if (cancelled) return
        setServerLoaded(true)
        if (out.stderr) { setServerError(out.stderr); return }
        try {
          const parsed = out.stdout.trim() === 'null' ? null : (JSON.parse(out.stdout.trim()) as RegressionResult)
          setServerResult(parsed); setServerError(null)
        } catch { setServerError(out.stdout || 'Failed to parse result') }
      })
      .catch((e) => { if (!cancelled) { setServerLoaded(true); setServerError(String(e)) } })
    return () => { cancelled = true }
  }, [server, datasetFileId, specKey, filtersKey]) // eslint-disable-line react-hooks/exhaustive-deps

  const result = server ? serverResult : localResult
  const isLogistic = result?.type === 'logistic'

  /** One table row per coefficient, the intercept named in the reader's language. */
  const coefRows = useMemo<CoefRow[]>(
    () =>
      (result?.coefficients ?? []).map((coef, i) => ({
        id: `${coef.name}:${i}`,
        coef,
        label: isIntercept(coef.name) ? t('analyses.reg_intercept') : coef.name,
      })),
    [result, t],
  )

  const tableColumns = useMemo<PublicationColumn<CoefRow>[]>(() => {
    const cols: PublicationColumn<CoefRow>[] = [
      {
        id: '__variable__',
        header: t('datasets.table1_variable'),
        cell: (r) => r.label,
        align: 'left',
        width: 220,
        minWidth: 110,
      },
    ]
    const headers: Record<string, string> = {
      estimate: isLogistic ? t('analyses.reg_col_or') : t('analyses.reg_col_estimate'),
      se: t('analyses.reg_col_se'),
      ci: t('analyses.reg_col_ci', { level: confidenceLevel }),
      statistic: isLogistic ? 'z' : 't',
      p: t('analyses.reg_col_p'),
    }
    // Sized to the content, not to a uniform default: a t statistic is three
    // characters where a confidence interval is a dozen.
    const widths: Record<string, number> = { estimate: 96, se: 96, ci: 132, statistic: 72, p: 104 }
    for (const col of visCols) {
      cols.push({
        id: col,
        header: headers[col] ?? col,
        cell: (r) => coefficientCell(col, r.coef, isLogistic, highlightSignificant, alpha),
        align: 'right',
        width: widths[col] ?? 100,
      })
    }
    return cols
  }, [t, visCols, isLogistic, confidenceLevel, highlightSignificant, alpha])

  // Publish for the shell's Export menu (copy / LaTeX), like the other tables.
  usePublishAnalysisTable(
    coefRows.length > 0 ? () => toExportTable(coefRows, tableColumns, isLogistic) : null,
    [coefRows, tableColumns, isLogistic],
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
        <TrendingUp size={24} className="opacity-40" />
        <p className="text-xs">
          {t('analyses.no_data')}
        </p>
      </div>
    )
  }

  if (!outcomeId) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-muted-foreground">
        <TrendingUp size={24} className="opacity-40" />
        <p className="text-xs">
          {t('analyses.reg_select_outcome')}
        </p>
      </div>
    )
  }

  if (predictorIds.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-muted-foreground">
        <TrendingUp size={24} className="opacity-40" />
        <p className="text-xs">
          {t('analyses.reg_select_predictors')}
        </p>
      </div>
    )
  }

  // Server mode: hold the frame until the fit returns (null before load = still computing).
  if (server && !serverLoaded) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-muted-foreground">
        <TrendingUp size={24} className="opacity-40" />
      </div>
    )
  }

  if (!result) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-muted-foreground">
        <AlertTriangle size={24} className="opacity-40" />
        <p className="text-xs">
          {t('analyses.reg_failed')}
        </p>
      </div>
    )
  }

  return (
    <div className={cn('h-full overflow-auto', compact ? 'p-2' : 'p-4')}>
      {/* Model summary */}
      <div className={cn('mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-muted-foreground', compact ? 'text-[9px]' : 'text-[11px]')}>
        <span className="font-semibold text-foreground">
          {isLogistic ? t('analyses.reg_logistic') : t('analyses.reg_linear')}
        </span>
        <span>n = {result.nComplete}</span>
        {result.rSquared != null && <span>R² = {fmt(result.rSquared)}</span>}
        {result.adjRSquared != null && <span>{t('analyses.reg_adj_r2')} = {fmt(result.adjRSquared)}</span>}
        {result.fStatistic != null && result.fPValue != null && (
          <span>F = {fmt(result.fStatistic)}, p = {fmtP(result.fPValue)}</span>
        )}
        {result.aic != null && <span>AIC = {fmt(result.aic, 1)}</span>}
        {result.logLikelihood != null && <span>Log-lik = {fmt(result.logLikelihood, 1)}</span>}
      </div>

      {/* Warnings */}
      {result.warnings.length > 0 && (
        <div className={cn('mb-3 rounded border border-yellow-300/50 bg-yellow-50/50 dark:bg-yellow-900/10', compact ? 'px-2 py-1 text-[9px]' : 'px-3 py-1.5 text-[11px]')}>
          {result.warnings.map((w, i) => (
            <div key={i} className="flex items-start gap-1.5 text-yellow-700 dark:text-yellow-400">
              <AlertTriangle size={compact ? 10 : 12} className="mt-0.5 shrink-0" />
              <span>{warningText(w, t)}</span>
            </div>
          ))}
        </div>
      )}

      {/* Coefficients table — PublicationTable, so it matches the descriptive
          table and statistical tests: resizable columns, no vertical rules, no
          striping, and long names truncated with the full value on hover. */}
      {result.coefficients.length > 0 && (
        <PublicationTable
          rows={coefRows}
          columns={tableColumns}
          wrap={wrap}
          emptyMessage={t('common.no_results')}
        />
      )}

      {/* Forest plot */}
      {showForestPlot && result.coefficients.length > 1 && (
        <div className={cn('mt-4', compact && 'mt-2')}>
          <ForestPlot
            coefficients={result.coefficients}
            isLogistic={isLogistic}
            compact={compact}
            alpha={alpha}
          />
        </div>
      )}
    </div>
  )
}


/** A coefficient plus the name the table prints for it. */
interface CoefRow {
  id: string
  coef: CoefficientResult
  label: string
}

/** One cell of the coefficients table. */
function coefficientCell(
  columnId: string,
  coef: CoefficientResult,
  isLogistic: boolean,
  highlight: boolean,
  alpha: number,
) {
  switch (columnId) {
    case 'estimate':
      return isLogistic ? fmt(coef.or ?? Math.exp(coef.estimate)) : fmt(coef.estimate)
    case 'se':
      return fmt(coef.se)
    case 'ci':
      return isLogistic
        ? `[${fmt(coef.orCiLow ?? Math.exp(coef.ciLow))}, ${fmt(coef.orCiHigh ?? Math.exp(coef.ciHigh))}]`
        : `[${fmt(coef.ciLow)}, ${fmt(coef.ciHigh)}]`
    case 'statistic':
      return fmt(coef.statistic)
    case 'p': {
      const significant = coef.pValue < alpha
      return (
        <span className={cn(highlight && significant && 'font-semibold')}>
          {fmtP(coef.pValue)}
          {significant && <span className="text-green-600 dark:text-green-400">{pStars(coef.pValue)}</span>}
        </span>
      )
    }
    default:
      return DASH
  }
}

/**
 * The rendered table as plain text, for copy / LaTeX.
 *
 * Rebuilt from the coefficients rather than scraped from the DOM: the p cell
 * renders as JSX so it can carry a marker, and a manuscript wants the value.
 */
function toExportTable(
  rows: CoefRow[],
  columns: PublicationColumn<CoefRow>[],
  isLogistic: boolean,
): ExportTable {
  const head: ExportTableCell[][] = [columns.map((c) => ({ text: c.header, align: c.align }))]
  const body = rows.map((r) =>
    columns.map((c) => ({
      text: c.id === '__variable__' ? r.label : exportCellText(c.id, r.coef, isLogistic),
      align: c.align,
    })),
  )
  return { head, body }
}

function exportCellText(columnId: string, coef: CoefficientResult, isLogistic: boolean): string {
  switch (columnId) {
    case 'estimate':
      return isLogistic ? fmt(coef.or ?? Math.exp(coef.estimate)) : fmt(coef.estimate)
    case 'se':
      return fmt(coef.se)
    case 'ci':
      return isLogistic
        ? `[${fmt(coef.orCiLow ?? Math.exp(coef.ciLow))}, ${fmt(coef.orCiHigh ?? Math.exp(coef.ciHigh))}]`
        : `[${fmt(coef.ciLow)}, ${fmt(coef.ciHigh)}]`
    case 'statistic':
      return fmt(coef.statistic)
    case 'p':
      return `${fmtP(coef.pValue)}${pStars(coef.pValue)}`
    default:
      return DASH
  }
}

/** A model warning, said in the reader's language. */
function warningText(w: RegressionWarning, t: TFunction): string {
  switch (w.code) {
    case 'single_category':
      return t('analyses.reg_skipped_single', { name: w.name })
    case 'too_many_categories':
      return t('analyses.reg_skipped_many', { name: w.name, count: w.count })
    case 'outcome_not_binary':
      return t('analyses.reg_outcome_not_binary', { count: w.count })
    case 'rows_excluded':
      return t('analyses.reg_rows_excluded', { count: w.count })
  }
}
