import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, Loader2, Play, Square, Trash2, X } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Label } from '@/components/ui/label'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { BenchMultiSelect } from './BenchMultiSelect'
import { cn } from '@/lib/utils'
import { getPlugin } from '@/lib/plugins/registry'
import { PLOT_BUILDER_ID } from '@/lib/agent/dashboard-tools'
import { fetchAvailableModels, resolveEndpointForSurface } from '@/lib/agent/settings'
import { runBench, type BenchReport, type CaseResult } from '@/lib/agent/bench/runner'
import {
  BENCH_SURFACES,
  selectCases,
  type BenchLang,
  type BenchSurface,
} from '@/lib/agent/bench/cases'
import {
  clearReports,
  loadReports,
  removeReport,
  saveReport,
  type StoredBenchReport,
} from '@/lib/agent/bench/storage'

type Mode = 'quick' | 'full'

interface AgentBenchTabProps {
  workspaceId: string
  /** Owner-only: running a bench writes a workspace-wide report. */
  canWrite: boolean
}

/**
 * Runs the copilot's test battery against the configured model, from inside the
 * app.
 *
 * The point is not to re-test the code — the CLI bench does that — but to answer
 * "what does this model do on THIS machine": the same model is equally capable
 * on a laptop and a hospital server, and wildly different in speed. Quality and
 * throughput both come out of the same run.
 */
export function AgentBenchTab({ workspaceId, canWrite }: AgentBenchTabProps) {
  const { t, i18n } = useTranslation()
  // Test in the language the user actually types in.
  const lang: BenchLang = i18n.language?.startsWith('fr') ? 'fr' : 'en'
  const [mode, setMode] = useState<Mode>('quick')
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const [reports, setReports] = useState<StoredBenchReport[]>([])
  const [surfaces, setSurfaces] = useState<BenchSurface[]>(['dashboard'])
  const [available, setAvailable] = useState<string[]>([])
  const [models, setModels] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [selectedModel, setSelectedModel] = useState<string>('')
  const abortRef = useRef<AbortController | null>(null)

  // Follow the newest report unless the user picked another, and never leave the
  // selector pointing at a model whose report was just deleted.
  const current =
    reports.find((report) => report.model === selectedModel) ?? reports[0] ?? null

  // Reports are workspace-wide in server mode, so an admin's evaluation shows up
  // for everyone rather than only in the browser that ran it.
  useEffect(() => {
    let cancelled = false
    loadReports(workspaceId).then((loaded) => {
      if (!cancelled) setReports(loaded)
    })
    return () => {
      cancelled = true
    }
  }, [workspaceId])

  // Offer the endpoint's models, defaulting to the configured one.
  useEffect(() => {
    let cancelled = false
    resolveEndpointForSurface(workspaceId, 'dashboard').then(({ endpoint }) => {
      if (cancelled || !endpoint) return
      setModels([endpoint.model])
      fetchAvailableModels(endpoint.baseUrl, endpoint.apiKey)
        .then((list) => {
          if (!cancelled) setAvailable(list)
        })
        .catch(() => {
          if (!cancelled) setAvailable([endpoint.model])
        })
    })
    return () => {
      cancelled = true
    }
  }, [workspaceId])

  const caseCount = selectCases(surfaces, mode).length

  const start = useCallback(
    async () => {
      const { endpoint } = await resolveEndpointForSurface(workspaceId, 'dashboard')
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
            lang,
            signal: controller.signal,
            onProgress: (_result, index, total) =>
              setProgress({ done: index + 1, total }),
          })
          setReports(await saveReport(report, workspaceId))
          setSelectedModel(report.model)
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
    [caseCount, lang, models, mode, surfaces, workspaceId]
  )


  const stop = () => abortRef.current?.abort()

  const handleRemove = useCallback(async () => {
    if (!current) return
    setReports(await removeReport(current.model, workspaceId))
  }, [current, workspaceId])

  const handleClearAll = useCallback(async () => {
    setReports(await clearReports(workspaceId))
  }, [workspaceId])

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
            <Button size="sm" className="ml-auto h-8" variant="destructive" onClick={stop}>
              <Square size={13} />
              {t('agent.stop')}
            </Button>
          ) : (
            <Button
              size="sm"
              className="ml-auto h-8"
              onClick={() => start()}
              disabled={!models.length || !surfaces.length || !canWrite}
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
          {t(`agent.bench_depth_hint_${mode}`)}{' '}
          {t('agent.bench_lang_note', { lang: lang.toUpperCase() })}
        </p>

        {error ? (
          <p className="mt-3 text-xs text-destructive">
            {t(`agent.bench_error_${error}`, { defaultValue: error })}
          </p>
        ) : null}

        {reports.length ? (
          <div className="mt-4">
            <Tabs defaultValue="detail">
              <TabsList className="mx-auto w-fit">
                <TabsTrigger value="detail" className="text-xs">
                  {t('agent.bench_view_detail')}
                </TabsTrigger>
                <TabsTrigger value="matrix" className="text-xs">
                  {t('agent.bench_view_matrix')}
                </TabsTrigger>
              </TabsList>

              {/* Controls live inside each tab: picking a run only means
                  something in Detail, where one run is shown at a time. */}
              <TabsContent value="detail" className="mt-3">
                <div className="flex flex-wrap items-center gap-2">
                  <select
                    value={current?.model ?? ''}
                    onChange={(e) => setSelectedModel(e.target.value)}
                    className="h-8 min-w-48 rounded-md border bg-background px-2 text-xs"
                  >
                    {reports.map((report) => (
                      <option key={report.model} value={report.model}>
                        {report.model} — {report.passed}/{report.total} ·{' '}
                        {report.tokensPerSecond.toFixed(1)} tok/s
                      </option>
                    ))}
                  </select>

                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-8"
                    disabled={running || !current || !canWrite}
                    onClick={handleRemove}
                  >
                    <Trash2 size={13} />
                    {t('agent.bench_remove')}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-8"
                    disabled={running || !canWrite}
                    onClick={handleClearAll}
                  >
                    <Trash2 size={13} />
                    {t('agent.bench_clear_all')}
                  </Button>
                </div>

                {current ? <ReportDetail report={current} /> : null}
              </TabsContent>

              <TabsContent value="matrix" className="mt-3">
                <div className="flex justify-end">
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-8"
                    disabled={running || !canWrite}
                    onClick={handleClearAll}
                  >
                    <Trash2 size={13} />
                    {t('agent.bench_clear_all')}
                  </Button>
                </div>
                <MatrixTable reports={reports} />
              </TabsContent>
            </Tabs>
          </div>
        ) : null}

        {!reports.length && !running ? (
          <p className="mt-4 text-xs text-muted-foreground">{t('agent.bench_empty')}</p>
        ) : null}
      </CardContent>
    </Card>
  )
}

/** One model's run: headline figures, then a row per case. */
function ReportDetail({ report }: { report: BenchReport }) {
  const { t } = useTranslation()
  const pct = Math.round((report.passed / report.total) * 100)
  return (
    <div className="mt-3">
      <div className="flex flex-wrap items-baseline gap-2">
        <Badge variant={pct === 100 ? 'default' : pct >= 50 ? 'secondary' : 'destructive'}>
          {report.passed}/{report.total}
        </Badge>
        <span className="text-xs text-muted-foreground">
          {report.tokensPerSecond.toFixed(1)} tok/s ·{' '}
          {(report.totalMs / report.total / 1000).toFixed(1)}s
          {t('agent.bench_per_case_suffix')} ·{' '}
          {(report.promptTokens + report.completionTokens).toLocaleString()}{' '}
          {t('agent.bench_tokens')} · {new Date(report.startedAt).toLocaleString()}
        </span>
      </div>

      <table className="mt-2 w-full text-xs">
        <tbody>
          {report.cases.map((result) => (
            <CaseRow key={result.id} result={result} />
          ))}
        </tbody>
      </table>
    </div>
  )
}

/**
 * Every model side by side, one row per case. This is the view that answers
 * "which model should we run here" — a per-model score hides WHICH cases a model
 * fails, and that is what decides whether it is usable.
 */
function MatrixTable({ reports }: { reports: BenchReport[] }) {
  const { t } = useTranslation()
  const ranked = [...reports].sort(
    (a, b) => b.passed / b.total - a.passed / a.total || b.tokensPerSecond - a.tokensPerSecond
  )
  // Union of case ids, so a model benched on a different depth still lines up.
  const rows: { id: string; label: string }[] = []
  for (const report of ranked) {
    for (const result of report.cases) {
      if (!rows.some((row) => row.id === result.id)) {
        rows.push({ id: result.id, label: result.label })
      }
    }
  }

  return (
    <div className="mt-3 overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b text-muted-foreground">
            <th className="py-1 pr-2 text-left font-medium">{t('agent.bench_case')}</th>
            {ranked.map((report) => (
              <th key={report.model} className="px-2 py-1 text-center font-medium">
                {report.model}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id} className="border-b last:border-0">
              <td className="py-1 pr-2">{row.label}</td>
              {ranked.map((report) => {
                const result = report.cases.find((item) => item.id === row.id)
                return (
                  <td key={report.model} className="px-2 py-1 text-center">
                    {!result ? (
                      <span className="text-muted-foreground">—</span>
                    ) : result.ok ? (
                      <Check size={13} className="mx-auto text-emerald-600" />
                    ) : (
                      <X size={13} className="mx-auto text-destructive" />
                    )}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="border-t font-medium">
            <td className="py-1 pr-2">{t('agent.bench_score')}</td>
            {ranked.map((report) => (
              <td key={report.model} className="px-2 py-1 text-center tabular-nums">
                {report.passed}/{report.total}
              </td>
            ))}
          </tr>
          <tr className="text-muted-foreground">
            <td className="py-1 pr-2">{t('agent.bench_speed')}</td>
            {ranked.map((report) => (
              <td key={report.model} className="px-2 py-1 text-center tabular-nums">
                {report.tokensPerSecond.toFixed(1)}
              </td>
            ))}
          </tr>
        </tfoot>
      </table>
    </div>
  )
}

function CaseRow({ result }: { result: CaseResult }) {
  return (
    <tr className="border-b last:border-0 align-top">
      <td className="py-1 pr-2 w-4">
        {result.ok ? (
          <Check size={13} className="text-emerald-600" />
        ) : (
          <X size={13} className="text-destructive" />
        )}
      </td>
      <td className="py-1 pr-2">
        {result.label}
        {result.detail ? (
          <p className="text-[11px] text-destructive">{result.detail}</p>
        ) : null}
        {!result.ok && result.calls.length ? (
          <p className="font-mono text-[10px] text-muted-foreground">
            {result.calls.join(' → ')}
          </p>
        ) : null}
      </td>
      <td className="w-12 py-1 pr-2 text-right">
        <Badge variant="secondary" className="text-[10px] uppercase">
          {result.lang}
        </Badge>
      </td>
      <td className="w-16 py-1 text-right tabular-nums text-muted-foreground">
        {(result.ms / 1000).toFixed(1)}s
      </td>
    </tr>
  )
}
