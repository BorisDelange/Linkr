import { useTranslation } from 'react-i18next'
import { Cpu, HardDrive, MemoryStick, Circle } from 'lucide-react'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { Separator } from '@/components/ui/separator'
import { cn } from '@/lib/utils'
import { useBrowserMetrics } from '@/hooks/use-browser-metrics'
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

  const memPct = metrics.memory.pct
  const storagePct = metrics.storage?.pct ?? null

  return (
    <footer className="flex h-6 shrink-0 items-center justify-between border-t bg-background px-3 text-[11px] text-muted-foreground">
      <div className="flex items-center gap-3">
        <span className="font-medium">Linkr v2.0</span>
      </div>
      <div className="flex items-center gap-3">
        {/* Metrics popover */}
        <Popover>
          <PopoverTrigger asChild>
            <button className="flex items-center gap-2 rounded px-1.5 py-0.5 hover:bg-accent/50 transition-colors">
              <MemoryStick size={11} />
              {memPct !== null ? (
                <span>{formatMB(metrics.memory.usedMB)}{metrics.memory.totalMB ? ` / ${formatMB(metrics.memory.totalMB)}` : ''}</span>
              ) : (
                <span>—</span>
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

              {/* JS Heap Memory */}
              {memPct !== null && (
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

              {/* WASM Runtimes */}
              <div className="space-y-2">
                <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                  {t('server.runtimes')}
                </p>
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
              </div>

              <Separator />

              {/* Session info */}
              <div className="space-y-1">
                <div className="flex items-center justify-between text-[10px]">
                  <span className="text-muted-foreground">{t('server.mode')}</span>
                  <span>{t('server.local_mode')}</span>
                </div>
                <div className="flex items-center justify-between text-[10px]">
                  <span className="text-muted-foreground">{t('server.session')}</span>
                  <span>{metrics.sessionUptime}</span>
                </div>
              </div>
            </div>
          </PopoverContent>
        </Popover>

        {/* Overall status indicator */}
        <span className="opacity-30">|</span>
        <div className="flex items-center gap-1.5">
          <span className={cn(
            'inline-block h-1.5 w-1.5 rounded-full',
            metrics.runtimes.pyodide === 'error' || metrics.runtimes.webR === 'error'
              ? 'bg-red-500'
              : metrics.runtimes.pyodide === 'loading' || metrics.runtimes.webR === 'loading'
                ? 'bg-yellow-500 animate-pulse'
                : metrics.runtimes.pyodide === 'executing' || metrics.runtimes.webR === 'executing'
                  ? 'bg-blue-500 animate-pulse'
                  : 'bg-emerald-500'
          )} />
          <span>{t('server.ready')}</span>
        </div>
      </div>
    </footer>
  )
}
