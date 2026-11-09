import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { queryDataSource } from '@/lib/duckdb/engine'
import { checkStatus } from '@/lib/duckdb/data-quality'
import { useDataSourceStore } from '@/stores/data-source-store'
import type { DqCustomCheck } from '@/types'

export interface TestResult {
  success: boolean
  lines: string[]
}

type TestedCheck = Pick<DqCustomCheck, 'name' | 'sql' | 'origin' | 'threshold'>

/**
 * Test one check on a database — the rule set's while it is written, a
 * profile's to see what its run will say: the count query, read the way a run
 * reads it (`checkStatus`), told in words.
 */
export function useCheckTest(dataSourceId: string) {
  const { t, i18n } = useTranslation()
  const ensureMounted = useDataSourceStore((s) => s.ensureMounted)
  const [testing, setTesting] = useState(false)
  const [result, setResult] = useState<TestResult | null>(null)

  const run = useCallback(async (check: TestedCheck) => {
    if (!dataSourceId || testing) return
    const formatPct = (n: number) => n.toLocaleString(i18n.language, { maximumFractionDigits: 2 })
    setTesting(true)
    setResult(null)
    try {
      await ensureMounted(dataSourceId)
      const rows = await queryDataSource(dataSourceId, check.sql, { pushdown: check.origin !== 'manual', origin: `Data quality · test check ${check.name}` })
      if (!rows.length) {
        setResult({ success: false, lines: [t('data_quality.test_result_no_rows'), t('data_quality.test_expected_shape')] })
        return
      }
      const row = rows[0]
      if (!('violated_rows' in row) || !('total_rows' in row)) {
        setResult({
          success: false,
          lines: [
            t('data_quality.test_result_missing_columns', { columns: Object.keys(row).join(', ') }),
            t('data_quality.test_expected_shape'),
          ],
        })
        return
      }
      const violated = Number(row.violated_rows ?? 0)
      const total = Number(row.total_rows ?? 0)
      const status = checkStatus(violated, total, check.threshold)
      const pct = total > 0 ? (violated / total) * 100 : 0
      const counts = t('data_quality.test_result_counts', {
        violated: violated.toLocaleString(i18n.language),
        total: total.toLocaleString(i18n.language),
        pct: formatPct(pct),
      })
      const rule = check.threshold === 0
        ? t('data_quality.test_rule_zero')
        : t('data_quality.test_rule_threshold', { threshold: formatPct(check.threshold) })
      if (status === 'not_applicable') {
        setResult({ success: true, lines: [t('data_quality.test_result_not_applicable'), counts] })
      } else {
        setResult({
          success: status === 'pass',
          lines: [status === 'pass' ? t('data_quality.test_result_pass') : t('data_quality.test_result_fail'), counts, rule],
        })
      }
    } catch (err) {
      setResult({
        success: false,
        lines: [t('data_quality.test_result_error', { message: err instanceof Error ? err.message : String(err) })],
      })
    } finally {
      setTesting(false)
    }
  }, [dataSourceId, testing, ensureMounted, i18n.language, t])

  const clear = useCallback(() => setResult(null), [])
  return { testing, result, run, clear }
}
