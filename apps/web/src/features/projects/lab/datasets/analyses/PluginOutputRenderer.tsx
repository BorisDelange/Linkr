import { useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertCircle, AlertTriangle, Info, Play, Download, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { OutputTable } from '@/features/projects/files/OutputTable'

import { installPythonPackage } from '@/lib/runtimes/pyodide-engine'
import { installRPackage } from '@/lib/runtimes/webr-engine'
import type { RuntimeOutput } from '@/lib/runtimes/types'
import { sanitizeHtml } from '@/lib/sanitize'

/** Extract missing package names from error messages. */
function detectMissingPackages(stderr: string): { name: string; lang: 'python' | 'r' }[] {
  const packages: { name: string; lang: 'python' | 'r' }[] = []
  const seen = new Set<string>()

  // R: "there is no package called 'dplyr'"
  for (const match of stderr.matchAll(/there is no package called ['\u2018](\w+)['\u2019]/g)) {
    const key = `r:${match[1]}`
    if (!seen.has(key)) { seen.add(key); packages.push({ name: match[1], lang: 'r' }) }
  }

  // Python: "ModuleNotFoundError: No module named 'xxx'"
  for (const match of stderr.matchAll(/No module named ['\u2018](\w+)['\u2019]/g)) {
    const key = `py:${match[1]}`
    if (!seen.has(key)) { seen.add(key); packages.push({ name: match[1], lang: 'python' }) }
  }

  return packages
}

/**
 * Patterns that indicate R informational warnings (not real errors).
 * Each line matching any of these is classified as a warning, not an error.
 */
const R_WARNING_PATTERNS = [
  /^Attaching package/,
  /^The following object/,
  /^Loading required package/,
  /^\s+filter, lag$/,
  /^\s+intersect, setdiff, setequal, union$/,
  /are masked from/,
  /is masked from/,
  /^Warning message/,
  /^In .+ :\s*$/,
  /^── /,
  // ggplot2 / tidyverse informational messages
  /^`stat_/,
  /^`geom_/,
  /Pick better value/,
  /^Scale for /,
  /^Coordinate system already present/,
  /removed \d+ rows? containing/,
  /^Don't know how to automatically pick/,
]

/** Split stderr into real errors and informational warnings. */
function splitStderr(stderr: string): { errors: string; warnings: string } {
  if (!stderr) return { errors: '', warnings: '' }

  const lines = stderr.split('\n')
  const errorLines: string[] = []
  const warningLines: string[] = []

  // Track contiguous warning blocks (e.g. "Attaching package..." followed by "The following objects...")
  let inWarningBlock = false

  for (const line of lines) {
    const isWarningLine = R_WARNING_PATTERNS.some(p => p.test(line))

    if (isWarningLine) {
      inWarningBlock = true
      warningLines.push(line)
    } else if (inWarningBlock && line.trim() === '') {
      // Blank line after warning block — keep it with warnings
      warningLines.push(line)
      inWarningBlock = false
    } else {
      inWarningBlock = false
      errorLines.push(line)
    }
  }

  return {
    errors: errorLines.join('\n').trim(),
    warnings: warningLines.join('\n').trim(),
  }
}

interface PluginOutputRendererProps {
  result: RuntimeOutput | null
  isExecuting: boolean
  statusMessage?: string | null
  installedDeps?: string[]
  onRerun?: () => void
  /** Compact mode for dashboard widgets — less padding, no borders on table. */
  compact?: boolean
}

export function PluginOutputRenderer({ result, isExecuting, statusMessage, installedDeps, onRerun, compact }: PluginOutputRendererProps) {
  const { t } = useTranslation()
  const [expandedPanel, setExpandedPanel] = useState<'info' | 'warnings' | null>(null)

  if (isExecuting) {
    return (
      <div className="flex h-full flex-col items-center justify-center text-center p-6">
        <div className="size-5 animate-spin rounded-full border-2 border-primary border-t-transparent" />
        <p className="mt-3 text-xs text-muted-foreground">
          {statusMessage ?? t('datasets.analysis_running')}
        </p>
      </div>
    )
  }

  if (!result) {
    return (
      <div className="flex h-full flex-col items-center justify-center text-center p-6">
        <Play size={24} className="text-muted-foreground/50" />
        <p className="mt-3 text-xs text-muted-foreground">{t('datasets.analysis_no_result')}</p>
      </div>
    )
  }

  const { errors, warnings } = splitStderr(result.stderr)
  const hasError = errors.length > 0
  const hasWarnings = warnings.length > 0
  const hasInfo = (installedDeps?.length ?? 0) > 0
  const hasFigures = result.figures.length > 0
  const hasTable = result.table !== null
  const hasStdout = result.stdout.length > 0
  const missingPackages = hasError ? detectMissingPackages(errors) : []

  // In compact mode, render table directly without ScrollArea wrapper for better space usage
  if (compact && hasTable && result.table && !hasError && !hasFigures) {
    return <OutputTable headers={result.table.headers} rows={result.table.rows} compact />
  }

  // In compact mode with figures, use flex layout so plot fills available space
  // Allow warnings (non-blocking) — only real errors prevent full-size mode
  const compactFigureOnly = compact && hasFigures && !hasTable

  return (
    <div className={compactFigureOnly ? 'h-full flex flex-col' : 'h-full overflow-auto'}>
      <div className={compact ? (compactFigureOnly ? 'flex-1 min-h-0 flex flex-col p-1.5 gap-1.5' : 'p-1.5 space-y-1.5') : 'p-3 space-y-3'}>
        {/* Errors (real) — collapsible */}
        {hasError && (
          <details className="rounded-md border border-destructive/50 bg-destructive/5 overflow-hidden" open>
            <summary className="flex items-center gap-2 px-3 py-2 cursor-pointer text-xs text-destructive font-medium select-none hover:bg-destructive/10 transition-colors">
              <AlertCircle size={14} className="shrink-0" />
              {t('datasets.analysis_error', 'Error')}
            </summary>
            <div className="px-3 pb-3 space-y-2">
              <pre className="text-xs text-destructive whitespace-pre-wrap break-words font-mono">
                {errors}
              </pre>
              {missingPackages.length > 0 && (
                <MissingPackageInstaller packages={missingPackages} onInstalled={onRerun} />
              )}
            </div>
          </details>
        )}

        {/* Info & Warnings pills row */}
        {(hasInfo || hasWarnings) && (
          <div className="space-y-2">
            <div className="flex items-center gap-1.5">
              {hasInfo && (
                <button
                  type="button"
                  onClick={() => setExpandedPanel(expandedPanel === 'info' ? null : 'info')}
                  className="inline-flex items-center gap-1 rounded-full border border-blue-200/50 bg-blue-50/50 dark:border-blue-900/30 dark:bg-blue-950/20 px-2 py-0.5 text-[11px] text-blue-600 dark:text-blue-400 hover:bg-blue-100/50 dark:hover:bg-blue-950/40 transition-colors"
                >
                  <Info size={10} className="shrink-0" />
                  {t('datasets.analysis_info')}
                </button>
              )}
              {hasWarnings && (
                <button
                  type="button"
                  onClick={() => setExpandedPanel(expandedPanel === 'warnings' ? null : 'warnings')}
                  className="inline-flex items-center gap-1 rounded-full border border-amber-200/50 bg-amber-50/50 dark:border-amber-900/30 dark:bg-amber-950/20 px-2 py-0.5 text-[11px] text-amber-600 dark:text-amber-400 hover:bg-amber-100/50 dark:hover:bg-amber-950/40 transition-colors"
                >
                  <AlertTriangle size={10} className="shrink-0" />
                  {t('datasets.analysis_warnings')}
                </button>
              )}
            </div>
            {expandedPanel === 'info' && hasInfo && (
              <div className="rounded-md border border-blue-200/50 bg-blue-50/50 dark:border-blue-900/30 dark:bg-blue-950/20 px-3 py-2">
                <p className="text-xs text-blue-700 dark:text-blue-300">
                  {t('datasets.analysis_deps_installed', { packages: installedDeps!.join(', ') })}
                </p>
              </div>
            )}
            {expandedPanel === 'warnings' && hasWarnings && (
              <pre className="rounded-md border border-amber-200/50 bg-amber-50/50 dark:border-amber-900/30 dark:bg-amber-950/20 p-2 text-xs font-mono whitespace-pre-wrap break-words text-amber-800 dark:text-amber-300">
                {warnings}
              </pre>
            )}
          </div>
        )}

        {/* Figures (SVG/PNG) — fill widget when compact */}
        {hasFigures && result.figures.map((fig) => (
          <div
            key={fig.id}
            className={compact
              ? 'flex-1 min-h-0 overflow-hidden flex items-center justify-center'
              : 'rounded-md border bg-background overflow-hidden'
            }
          >
            {fig.type === 'svg' ? (
              <div
                className={compact
                  ? 'w-full h-full [&>svg]:w-full [&>svg]:h-full [&>svg]:object-contain'
                  : 'w-full [&>svg]:w-full [&>svg]:h-auto'
                }
                dangerouslySetInnerHTML={{ __html: sanitizeHtml(fig.data) }}
              />
            ) : (
              <img
                src={fig.data}
                alt={fig.label}
                className={compact ? 'max-w-full max-h-full object-contain' : 'w-full'}
              />
            )}
          </div>
        ))}

        {/* Table */}
        {hasTable && result.table && (
          <div className={compact ? 'overflow-hidden' : 'rounded-md border overflow-hidden'}>
            <OutputTable headers={result.table.headers} rows={result.table.rows} compact={compact} />
          </div>
        )}

        {/* Text output (only if no table and no figures) */}
        {hasStdout && !hasTable && !hasFigures && (
          <pre className="rounded-md border bg-muted/30 p-3 text-xs font-mono whitespace-pre-wrap break-words">
            {result.stdout}
          </pre>
        )}

        {/* Stdout alongside table/figures */}
        {hasStdout && (hasTable || hasFigures) && (
          <details className="text-xs">
            <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
              {t('datasets.analysis_console_output')}
            </summary>
            <pre className="mt-1 rounded-md border bg-muted/30 p-2 font-mono whitespace-pre-wrap break-words">
              {result.stdout}
            </pre>
          </details>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Inline installer for missing packages
// ---------------------------------------------------------------------------

function MissingPackageInstaller({
  packages,
  onInstalled,
}: {
  packages: { name: string; lang: 'python' | 'r' }[]
  onInstalled?: () => void
}) {
  const { t } = useTranslation()
  const [installing, setInstalling] = useState<string | null>(null)
  const [installed, setInstalled] = useState<Set<string>>(new Set())
  const [error, setError] = useState<string | null>(null)

  const handleInstall = useCallback(async (pkg: { name: string; lang: 'python' | 'r' }) => {
    const key = `${pkg.lang}:${pkg.name}`
    setInstalling(key)
    setError(null)
    try {
      if (pkg.lang === 'python') {
        await installPythonPackage(pkg.name)
      } else {
        await installRPackage(pkg.name)
      }
      setInstalled(prev => new Set(prev).add(key))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setInstalling(null)
    }
  }, [])

  const allInstalled = packages.every(p => installed.has(`${p.lang}:${p.name}`))

  return (
    <div className="space-y-2 pt-1">
      <div className="flex flex-wrap items-center gap-1.5">
        {packages.map(pkg => {
          const key = `${pkg.lang}:${pkg.name}`
          const isDone = installed.has(key)
          const isLoading = installing === key
          return (
            <Button
              key={key}
              size="sm"
              variant="outline"
              className="h-6 gap-1 text-[11px]"
              disabled={isDone || isLoading || installing !== null}
              onClick={() => handleInstall(pkg)}
            >
              {isLoading ? (
                <Loader2 size={10} className="animate-spin" />
              ) : (
                <Download size={10} />
              )}
              {isDone
                ? t('environments.installed_pkg', { name: pkg.name })
                : t('environments.install_pkg', { name: pkg.name })}
            </Button>
          )
        })}
      </div>
      {error && (
        <p className="text-[10px] text-destructive">{error}</p>
      )}
      {allInstalled && onInstalled && (
        <Button
          size="sm"
          className="h-6 gap-1 text-[11px]"
          onClick={onInstalled}
        >
          <Play size={10} />
          {t('datasets.analysis_rerun')}
        </Button>
      )}
    </div>
  )
}
