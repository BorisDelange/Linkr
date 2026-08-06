import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, Loader2, Play, Square, Trash2, X } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Label } from '@/components/ui/label'
import { BenchMultiSelect } from './BenchMultiSelect'
import { cn } from '@/lib/utils'
import { getPlugin } from '@/lib/plugins/registry'
import { PLOT_BUILDER_ID } from '@/lib/agent/dashboard-tools'
import { resolveAgentEndpoint } from '@/lib/agent/settings'
import { fetchAvailableModels } from '@/lib/agent/settings'
import { runBench, type BenchReport, type CaseResult } from '@/lib/agent/bench/runner'
import {
  BENCH_SURFACES,
  selectCases,
  type BenchSurface,
} from '@/lib/agent/bench/cases'
import { clearReports, loadReports, removeReport, saveReport } from '@/lib/agent/bench/storage'

type Mode = 'quick' | 'full'

/**
 * Runs the copilot's test battery against the configured model, from inside the
 * app.
 *
 * The point is not to re-test the code — the CLI bench does that — but to answer
 * "what does this model do on THIS machine": the same model is equally capable
 * on a laptop and a hospital server, and wildly different in speed. Quality and
 * throughput both come out of the same run.
 */
export function AgentBenchTab() {
  const { t } = useTranslation()
  const [mode, setMode] = useState<Mode>('quick')
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const [reports, setReports] = useState<BenchReport[]>(() => loadReports())
  const [surfaces, setSurfaces] = useState<BenchSurface[]>(['dashboard'])
  const [available, setAvailable] = useState<string[]>([])
  const [models, setModels] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  // Offer the endpoint's models, defaulting to the configured one.
  useEffect(() => {
    const { endpoint } = resolveAgentEndpoint()
    if (!endpoint) return
    setModels([endpoint.model])
    fetchAvailableModels(endpoint.baseUrl, endpoint.apiKey)
      .then(setAvailable)
      .catch(() => setAvailable([endpoint.model]))
  }, [])

  const caseCount = selectCases(surfaces, mode).length

  const start = useCallback(
    async () => {
      const { endpoint } = resolveAgentEndpoint()
      if (!endpoint) {
        setError('no_provider')
        return
      }
      const plugin = getPlugin(PLOT_BUILDER_ID)
      if (!plugin) {
        setError('no_plugin')
        return
      }

      setError(null)
      setRunning(true)
      const controller = new AbortController()
      abortRef.current = controller

      try {
        for (const model of models) {
          setProgress({ done: 0, total: caseCount })
          const report = await runBench({
            endpoint: { ...endpoint, model },
            manifest: plugin.manifest,
            mode,
            surfaces,
            signal: controller.signal,
            onProgress: (_result, index, total) =>
              setProgress({ done: index + 1, total }),
          })
          setReports(saveReport(report))
        }
      } catch (caught) {
        if ((caught as Error)?.name !== 'AbortError') {
          setError((caught as Error).message)
        }
      } finally {
        abortRef.current = null
        setRunning(false)
        setProgress(null)
      }
    },
    [caseCount, models, mode, surfaces]
  )


  const stop = () => abortRef.current?.abort()

  return (
    <Card className="mt-4">
      <CardContent className="px-5 pb-5 pt-5">
        <h3 className="text-sm font-semibold">{t('agent.bench_title')}</h3>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {t('agent.bench_description')}
        </p>

        <div className="mt-4 flex flex-wrap items-end gap-2">
          <div className="space-y-1">
            <Label className="text-[11px] text-muted-foreground">
              {t('agent.bench_models')}
            </Label>
            <BenchMultiSelect
              values={available}
              selected={models}
              onChange={setModels}
              placeholder={t('agent.bench_models_placeholder')}
              disabled={running}
              className="w-56"
            />
          </div>

          <div className="space-y-1">
            <Label className="text-[11px] text-muted-foreground">
              {t('agent.bench_surfaces')}
            </Label>
            <BenchMultiSelect
              values={BENCH_SURFACES}
              selected={surfaces}
              onChange={(next) => setSurfaces(next as BenchSurface[])}
              placeholder={t('agent.bench_surfaces_placeholder')}
              disabled={running}
              className="w-44"
            />
          </div>

          <div className="space-y-1">
            <Label className="text-[11px] text-muted-foreground">
              {t('agent.bench_depth')}
            </Label>
            <div className="flex h-8 rounded-md border p-0.5">
              {(['quick', 'full'] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setMode(value)}
                  disabled={running}
                  className={cn(
                    'rounded px-2.5 text-xs transition-colors',
                    mode === value
                      ? 'bg-primary text-primary-foreground'
                      : 'text-muted-foreground hover:text-foreground'
                  )}
                >
                  {t(`agent.bench_mode_${value}`, {
                    count: selectCases(surfaces, value).length,
                  })}
                </button>
              ))}
            </div>
          </div>

          {running ? (
            <Button size="sm" className="h-8" variant="destructive" onClick={stop}>
              <Square size={13} />
              {t('agent.stop')}
            </Button>
          ) : (
            <Button
              size="sm"
              className="h-8"
              onClick={() => start()}
              disabled={!models.length || !surfaces.length}
            >
              <Play size={13} />
              {t('agent.bench_run')}
            </Button>
          )}

          {progress ? (
            <span className="flex h-8 items-center gap-1.5 text-xs text-muted-foreground">
              <Loader2 size={13} className="animate-spin" />
              {progress.done}/{progress.total}
            </span>
          ) : null}
        </div>

        <p className="mt-1.5 text-[11px] text-muted-foreground">
          {t(`agent.bench_depth_hint_${mode}`)}
        </p>

        {error ? (
          <p className="mt-3 text-xs text-destructive">
            {t(`agent.bench_error_${error}`, { defaultValue: error })}
          </p>
        ) : null}

        {reports.length > 1 ? (
          <>
            <ComparisonTable reports={reports} />
            <div className="mt-2 flex justify-end">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setReports(clearReports())}
                disabled={running}
              >
                <Trash2 size={13} />
                {t('agent.bench_clear_all')}
              </Button>
            </div>
          </>
        ) : null}
        {reports.map((report) => (
          <ReportBlock
            key={report.model}
            report={report}
            expanded={reports.length === 1}
            onRemove={() => setReports(removeReport(report.model))}
          />
        ))}

        {!reports.length && !running ? (
          <p className="mt-4 text-xs text-muted-foreground">{t('agent.bench_empty')}</p>
        ) : null}
      </CardContent>
    </Card>
  )
}

function ComparisonTable({ reports }: { reports: BenchReport[] }) {
  const { t } = useTranslation()
  const ranked = [...reports].sort(
    (a, b) => b.passed / b.total - a.passed / a.total || b.tokensPerSecond - a.tokensPerSecond
  )
  return (
    <div className="mt-4 overflow-x-auto">
      <table className="w-full text-xs">
        <thead className="text-muted-foreground">
          <tr className="border-b">
            <th className="py-1 text-left font-medium">{t('agent.info_model')}</th>
            <th className="py-1 text-right font-medium">{t('agent.bench_score')}</th>
            <th className="py-1 text-right font-medium">{t('agent.bench_speed')}</th>
            <th className="py-1 text-right font-medium">{t('agent.bench_per_case')}</th>
            <th className="py-1 text-right font-medium">{t('agent.info_total_tokens')}</th>
          </tr>
        </thead>
        <tbody>
          {ranked.map((report) => (
            <tr key={report.model} className="border-b last:border-0">
              <td className="py-1 font-medium">{report.model}</td>
              <td className="py-1 text-right tabular-nums">
                {report.passed}/{report.total}
              </td>
              <td className="py-1 text-right tabular-nums">
                {report.tokensPerSecond.toFixed(1)} tok/s
              </td>
              <td className="py-1 text-right tabular-nums">
                {(report.totalMs / report.total / 1000).toFixed(1)}s
              </td>
              <td className="py-1 text-right tabular-nums">
                {(report.promptTokens + report.completionTokens).toLocaleString()}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function ReportBlock({
  report,
  expanded,
  onRemove,
}: {
  report: BenchReport
  expanded: boolean
  onRemove: () => void
}) {
  const { t } = useTranslation()
  const pct = Math.round((report.passed / report.total) * 100)
  return (
    <div className="mt-4">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="text-sm font-semibold">{report.model}</span>
        <Badge variant={pct === 100 ? 'default' : pct >= 50 ? 'secondary' : 'destructive'}>
          {report.passed}/{report.total}
        </Badge>
        <span className="text-xs text-muted-foreground">
          {report.tokensPerSecond.toFixed(1)} tok/s ·{' '}
          {(report.totalMs / report.total / 1000).toFixed(1)}s{t('agent.bench_per_case_suffix')} ·{' '}
          {(report.promptTokens + report.completionTokens).toLocaleString()}{' '}
          {t('agent.bench_tokens')} · {new Date(report.startedAt).toLocaleString()}
        </span>
        <Button
          size="icon"
          variant="ghost"
          className="ml-auto size-6"
          onClick={onRemove}
          title={t('agent.bench_remove')}
        >
          <Trash2 size={12} />
        </Button>
      </div>

      {expanded ? (
        <ul className="mt-2 space-y-1">
          {report.cases.map((result) => (
            <CaseRow key={result.id} result={result} />
          ))}
        </ul>
      ) : null}
    </div>
  )
}

function CaseRow({ result }: { result: CaseResult }) {
  return (
    <li className="flex items-start gap-2 text-xs">
      {result.ok ? (
        <Check size={13} className="mt-0.5 shrink-0 text-emerald-600" />
      ) : (
        <X size={13} className="mt-0.5 shrink-0 text-destructive" />
      )}
      <div className="min-w-0 flex-1">
        <span className="font-mono">{result.id}</span>
        <span className="ml-1.5 text-muted-foreground">
          {(result.ms / 1000).toFixed(1)}s · {result.lang}
        </span>
        {result.detail ? (
          <p className="text-[11px] text-destructive">{result.detail}</p>
        ) : null}
        {!result.ok && result.calls.length ? (
          <p className="font-mono text-[10px] text-muted-foreground">
            {result.calls.join(' → ')}
          </p>
        ) : null}
      </div>
    </li>
  )
}
