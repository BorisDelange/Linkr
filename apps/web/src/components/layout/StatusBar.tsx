import { useTranslation } from 'react-i18next'
import { Cpu, HardDrive, MemoryStick, Circle, Box, GitBranch, Trash2, Server } from 'lucide-react'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { Separator } from '@/components/ui/separator'
import { cn } from '@/lib/utils'
import { useBrowserMetrics } from '@/hooks/use-browser-metrics'
import { useServerKernels } from '@/hooks/use-server-kernels'
import { isServerMode } from '@/lib/api-client'
import { restartServerKernel } from '@/lib/api/execution'
import { useProjectRouteUid } from '@/hooks/use-project-route'
import { useSessionStore } from '@/stores/session-store'
import { useEnvironmentsUiStore } from '@/stores/environments-ui-store'
import { APP_VERSION } from '@/lib/version'
import { EnvironmentsDialog } from '@/features/projects/files/EnvironmentsDialog'
import { JobsIndicator } from '@/components/layout/JobsIndicator'
import type { RuntimeStatus } from '@/lib/runtimes/types'

function usageColor(pct: number) {
  if (pct < 50) return 'bg-green-500'
  if (pct < 80) return 'bg-yellow-500'
  return 'bg-red-500'
}

function UsageBar({ pct, className }: { pct: number; className?: string }) {
  return (
    <div className={cn('h-1.5 w-16 rounded-full bg-muted overflow-hidden', className)}>
      <div
        className={cn('h-full rounded-full transition-all', usageColor(pct))}
        style={{ width: `${pct}%` }}
      />
    </div>
  )
}

function runtimeStatusColor(status: RuntimeStatus): string {
  switch (status) {
    case 'ready': return 'bg-emerald-500'
    case 'loading': return 'bg-yellow-500 animate-pulse'
    case 'executing': return 'bg-blue-500 animate-pulse'
    case 'error': return 'bg-red-500'
    default: return 'bg-muted-foreground/30'
  }
}

function runtimeStatusLabel(status: RuntimeStatus, t: (k: string) => string): string {
  switch (status) {
    case 'ready': return t('server.runtime_ready')
    case 'loading': return t('server.runtime_loading')
    case 'executing': return t('server.runtime_executing')
    case 'error': return t('server.runtime_error')
    default: return t('server.runtime_idle')
  }
}

function formatMB(mb: number): string {
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`
  return `${mb} MB`
}

export function StatusBar() {
  const { t } = useTranslation()
  const metrics = useBrowserMetrics()
  // Modal open state lives in a store so the "install in environment" affordances
  // (script output button, terminal toast) can open it and queue an install.
  const environmentsOpen = useEnvironmentsUiStore((s) => s.open)
  const setEnvironmentsOpen = useEnvironmentsUiStore((s) => s.setOpen)
  const server = isServerMode()
  // Only treat a project as active on an actual project route — the app-store's
  // activeProjectUid lingers after you leave a project into a workspace view, which
  // would otherwise keep the last project's kernels/env showing in the footer.
  const activeProjectUid = useProjectRouteUid()
  const { kernels, refresh } = useServerKernels(activeProjectUid)
  // Map a kernel's envId (its session id) → the session's display name, so each
  // kernel line names its session (Ready/Executing is PER kernel, not global).
  // Subscribe to the raw slice (a stable reference) — NOT getSessionsForProject,
  // which returns a fresh array each call and would loop the selector.
  const sessionsByScope = useSessionStore((s) => s.sessions)
  const sessionName = (language: 'python' | 'r', envId: string) => {
    if (envId === 'default') return t('sessions.default')
    const named = activeProjectUid ? sessionsByScope[`${activeProjectUid}:${language}`] : undefined
    return named?.find((sn) => sn.id === envId)?.name ?? envId
  }

  // "Close session": shut down the live kernel (it disappears from the list).
  // The next run in that session lazily recreates it with a fresh namespace — so
  // this doubles as the "restart with clean variables" path. The backend endpoint
  // is still /execute/restart (it does a shutdown; no relaunch).
  const handleCloseSession = async (language: 'python' | 'r', envId: string) => {
    if (!activeProjectUid) return
    await restartServerKernel(language, activeProjectUid, envId)
    refresh()
  }

  // Browser JS-heap / WASM metrics only make sense in front-only mode; in server
  // mode compute runs server-side, so we surface kernels instead.
  const memPct = server ? null : metrics.memory.pct
  const storagePct = server ? null : (metrics.storage?.pct ?? null)

  return (
    <footer className="flex h-6 shrink-0 items-center justify-between border-t bg-background px-3 text-[11px] text-muted-foreground">
      <div className="flex items-center gap-2">
        <span className="font-medium">Linkr v{APP_VERSION}</span>
        <span className="opacity-30">|</span>
        <a
          href="https://framagit.org/interhop/linkr/linkr"
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-1 rounded px-1 py-0.5 hover:bg-accent/50 transition-colors"
        >
          <GitBranch size={11} />
          <span>{t('footer.source')}</span>
        </a>
      </div>
      <div className="flex items-center gap-3">
        <JobsIndicator />
        {/* Environments + kernels are per-project (server mode). Off a project
            there's nothing project-scoped to show, so hide them entirely (not just
            disable). In front-only mode the metric shows browser runtimes, so it
            always renders. */}
        {(!server || activeProjectUid) && (
          <>
            <button
              onClick={() => setEnvironmentsOpen(true)}
              className="flex items-center gap-1.5 rounded px-1.5 py-0.5 transition-colors hover:bg-accent/50"
            >
              <Box size={11} />
              <span>{t('environments.title')}</span>
            </button>
            <EnvironmentsDialog open={environmentsOpen} onOpenChange={setEnvironmentsOpen} />
            <span className="opacity-30">|</span>
          </>
        )}
        {/* Metrics popover. In server mode the metrics ARE the project's kernels,
            so it's hidden off a project (nothing project-scoped to show). Browser
            metrics (front-only) always show. */}
        {(!server || activeProjectUid) && (
        <Popover>
          <PopoverTrigger asChild>
            <button
              className="flex items-center gap-2 rounded px-1.5 py-0.5 transition-colors hover:bg-accent/50"
            >
              {server ? (
                <>
                  <Server size={11} />
                  <span>{t('server.kernel_count', { count: kernels.length })}</span>
                </>
              ) : memPct !== null ? (
                <>
                  <MemoryStick size={11} />
                  <span>{formatMB(metrics.memory.usedMB)}{metrics.memory.totalMB ? ` / ${formatMB(metrics.memory.totalMB)}` : ''}</span>
                </>
              ) : (
                <>
                  <MemoryStick size={11} />
                  <span className="opacity-60">{t('server.memory_unavailable_short')}</span>
                </>
              )}
              {storagePct !== null && (
                <>
                  <span className="opacity-30">|</span>
                  <HardDrive size={11} />
                  <span>{formatMB(metrics.storage!.usedMB)}</span>
                </>
              )}
            </button>
          </PopoverTrigger>
          <PopoverContent align="end" side="top" className="w-72 p-0">
            <div className="p-3 space-y-3">
              <p className="text-xs font-medium">{t('server.title')}</p>
              <Separator />

              {/* Browser metrics — only meaningful in front-only (WASM) mode. */}
              {!server && (<>
              {/* JS Heap Memory */}
              {memPct !== null ? (
                <>
                  <div className="flex items-center justify-between text-xs">
                    <div className="flex items-center gap-1.5">
                      <MemoryStick size={12} className="text-muted-foreground" />
                      <span>{t('server.memory')}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <UsageBar pct={memPct} />
                      <span className="w-8 text-right font-medium">{memPct}%</span>
                    </div>
                  </div>
                  <div className="pl-5 text-[10px] text-muted-foreground">
                    {formatMB(metrics.memory.usedMB)} / {formatMB(metrics.memory.totalMB!)}
                  </div>
                </>
              ) : (
                <>
                  <div className="flex items-center justify-between text-xs">
                    <div className="flex items-center gap-1.5">
                      <MemoryStick size={12} className="text-muted-foreground" />
                      <span>{t('server.memory')}</span>
                    </div>
                    <span className="text-[10px] text-muted-foreground italic">
                      {t('server.memory_unavailable')}
                    </span>
                  </div>
                  <div className="pl-5 text-[10px] text-muted-foreground">
                    {t('server.memory_unavailable_hint')}
                  </div>
                </>
              )}

              {/* Storage */}
              {metrics.storage && (
                <>
                  <div className="flex items-center justify-between text-xs">
                    <div className="flex items-center gap-1.5">
                      <HardDrive size={12} className="text-muted-foreground" />
                      <span>{t('server.storage')}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <UsageBar pct={metrics.storage.pct} />
                      <span className="w-8 text-right font-medium">{metrics.storage.pct}%</span>
                    </div>
                  </div>
                  <div className="pl-5 text-[10px] text-muted-foreground">
                    {formatMB(metrics.storage.usedMB)} / {formatMB(metrics.storage.quotaMB)}
                  </div>
                </>
              )}

              {/* CPU cores */}
              {metrics.cpuCores > 0 && (
                <div className="flex items-center justify-between text-xs">
                  <div className="flex items-center gap-1.5">
                    <Cpu size={12} className="text-muted-foreground" />
                    <span>CPU</span>
                  </div>
                  <span className="font-medium">
                    {metrics.cpuCores} {t('server.cores')}
                  </span>
                </div>
              )}

              <Separator />
              </>)}

              {/* Runtimes — server kernels in server mode, browser WASM otherwise */}
              <div className="space-y-2">
                <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                  {server ? t('server.kernels') : t('server.runtimes')}
                </p>
                {server ? (
                  kernels.length === 0 ? (
                    <p className="text-[10px] text-muted-foreground italic">{t('server.no_kernels')}</p>
                  ) : (
                    kernels.map((k) => (
                      <div key={`${k.language}-${k.envId}`} className="space-y-0.5">
                        <div className="flex items-center justify-between text-xs">
                          <span>{k.language === 'python' ? 'Python' : 'R'} · {sessionName(k.language, k.envId)}</span>
                          <div className="flex items-center gap-1.5">
                            <Circle size={6} className={cn('fill-current', k.busy ? 'text-blue-500' : k.alive ? 'text-emerald-500' : 'text-muted-foreground/30')} />
                            <span className="text-muted-foreground">
                              {k.busy ? t('server.runtime_executing') : t('server.runtime_ready')}
                            </span>
                            <button
                              onClick={() => handleCloseSession(k.language, k.envId)}
                              className="group/kill rounded p-0.5 text-muted-foreground transition-colors hover:bg-accent"
                              title={t('server.close_session')}
                            >
                              <Trash2 size={11} className="group-hover/kill:text-destructive" />
                            </button>
                          </div>
                        </div>
                        {(k.rssKb != null || k.pid != null) && (
                          <div className="flex items-center gap-2 pl-0 text-[10px] text-muted-foreground/70 tabular-nums">
                            {k.rssKb != null && <span>{t('server.kernel_memory', { mb: Math.round(k.rssKb / 1024) })}</span>}
                            {k.pid != null && <span>PID {k.pid}</span>}
                          </div>
                        )}
                      </div>
                    ))
                  )
                ) : (
                  <>
                    <div className="flex items-center justify-between text-xs">
                      <span>Python (Pyodide)</span>
                      <div className="flex items-center gap-1.5">
                        <Circle size={6} className={cn('fill-current', runtimeStatusColor(metrics.runtimes.pyodide).replace('bg-', 'text-').replace(' animate-pulse', ''))} />
                        <span className="text-muted-foreground">{runtimeStatusLabel(metrics.runtimes.pyodide, t)}</span>
                      </div>
                    </div>
                    <div className="flex items-center justify-between text-xs">
                      <span>R (webR)</span>
                      <div className="flex items-center gap-1.5">
                        <Circle size={6} className={cn('fill-current', runtimeStatusColor(metrics.runtimes.webR).replace('bg-', 'text-').replace(' animate-pulse', ''))} />
                        <span className="text-muted-foreground">{runtimeStatusLabel(metrics.runtimes.webR, t)}</span>
                      </div>
                    </div>
                  </>
                )}
              </div>

              <Separator />

              {/* Session info */}
              <div className="space-y-1">
                <div className="flex items-center justify-between text-[10px]">
                  <span className="text-muted-foreground">{t('server.mode')}</span>
                  <span>{server ? t('server.server_mode') : t('server.local_mode')}</span>
                </div>
                <div className="flex items-center justify-between text-[10px]">
                  <span className="text-muted-foreground">{t('server.session')}</span>
                  <span>{metrics.sessionUptime}</span>
                </div>
              </div>
            </div>
          </PopoverContent>
        </Popover>
        )}

        {/* Overall status indicator. It summarises whether ANY runtime is busy
            (not a specific kernel). In server mode it reflects the project's
            kernels, so it's hidden off a project — there is nothing to be ready for. */}
        {(!server || activeProjectUid) && (
          <>
            <span className="opacity-30">|</span>
            <div className="flex items-center gap-1.5">
              <span className={cn(
                'inline-block h-1.5 w-1.5 rounded-full',
                server
                  ? (kernels.some((k) => k.busy) ? 'bg-blue-500 animate-pulse' : 'bg-emerald-500')
                  : metrics.runtimes.pyodide === 'error' || metrics.runtimes.webR === 'error'
                    ? 'bg-red-500'
                    : metrics.runtimes.pyodide === 'loading' || metrics.runtimes.webR === 'loading'
                      ? 'bg-yellow-500 animate-pulse'
                      : metrics.runtimes.pyodide === 'executing' || metrics.runtimes.webR === 'executing'
                        ? 'bg-blue-500 animate-pulse'
                        : 'bg-emerald-500'
              )} />
              <span>{server && kernels.some((k) => k.busy) ? t('server.runtime_executing') : t('server.ready')}</span>
            </div>
          </>
        )}
      </div>
    </footer>
  )
}
