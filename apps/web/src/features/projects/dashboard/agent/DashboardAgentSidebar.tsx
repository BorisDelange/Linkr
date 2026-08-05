import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  AlertTriangle,
  ChevronRight,
  CornerDownLeft,
  Info,
  RotateCcw,
  Sparkles,
  Square,
  Undo2,
  X,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Textarea } from '@/components/ui/textarea'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import type { LlmEndpoint } from '@/lib/agent/agent-loop'
import {
  useDashboardAgent,
  type ExchangeRecord,
  type SessionStats,
  type TranscriptEntry,
} from './use-dashboard-agent'

interface Props {
  dashboardId: string
  projectUid: string
  endpoint: LlmEndpoint | null
  /** True when the model is reached over a public API rather than locally. */
  isRemote: boolean
  onClose: () => void
}

/** Dark tooltip, matching the app's icon-button convention. */
function IconAction({
  label,
  onClick,
  children,
}: {
  label: string
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon" className="size-6" onClick={onClick}>
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent
        side="bottom"
        className="rounded-md bg-neutral-900 px-2 py-1 text-xs text-white"
      >
        {label}
      </TooltipContent>
    </Tooltip>
  )
}

/** A tool call renders as one collapsed line; the detail is one click away. */
function ToolLine({ entry }: { entry: TranscriptEntry }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="text-xs">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-start gap-1 text-left text-muted-foreground hover:text-foreground"
      >
        <ChevronRight
          size={12}
          className={cn('mt-0.5 shrink-0 transition-transform', open && 'rotate-90')}
        />
        <span className={cn(!entry.ok && 'text-destructive')}>{entry.text}</span>
      </button>
      {open && entry.detail ? (
        <p className="ml-4 mt-1 whitespace-pre-wrap break-words font-mono text-[11px] text-muted-foreground">
          {entry.detail}
        </p>
      ) : null}
    </div>
  )
}

/**
 * Everything that goes over the wire, so nothing about the model interaction is
 * hidden — with a remote provider, "what exactly did you send?" needs an exact
 * answer, not a summary.
 */
function SessionInfoDialog({
  stats,
  contextTokens,
  endpoint,
  systemPrompt,
  exchanges,
  open,
  onOpenChange,
}: {
  stats: SessionStats
  contextTokens: number
  endpoint: LlmEndpoint | null
  systemPrompt: () => string
  exchanges: ExchangeRecord[]
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { t } = useTranslation()
  const totalTokens = stats.promptTokens + stats.completionTokens
  const seconds = stats.elapsedMs / 1000
  const rate = seconds > 0 ? stats.completionTokens / seconds : 0

  const rows: [string, string][] = [
    [t('agent.info_model'), endpoint?.model ?? '—'],
    [t('agent.info_endpoint'), endpoint?.baseUrl ?? '—'],
    [t('agent.info_started'), new Date(stats.startedAt).toLocaleString()],
    [t('agent.info_exchanges'), String(stats.exchanges)],
    [t('agent.info_prompt_tokens'), stats.promptTokens.toLocaleString()],
    [t('agent.info_completion_tokens'), stats.completionTokens.toLocaleString()],
    [t('agent.info_total_tokens'), totalTokens.toLocaleString()],
    [t('agent.info_rate'), rate > 0 ? `${rate.toFixed(1)} tok/s` : '—'],
    [t('agent.info_context'), t('agent.context_tokens', { count: contextTokens })],
  ]

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="text-sm">{t('agent.info_title')}</DialogTitle>
        </DialogHeader>
        <Tabs defaultValue="stats" className="min-h-0 flex-1">
          <TabsList className="w-fit">
            <TabsTrigger value="stats" className="text-xs">
              {t('agent.info_tab_stats')}
            </TabsTrigger>
            <TabsTrigger value="context" className="text-xs">
              {t('agent.info_tab_context')}
            </TabsTrigger>
            <TabsTrigger value="exchanges" className="text-xs">
              {t('agent.info_tab_exchanges')} ({exchanges.length})
            </TabsTrigger>
          </TabsList>

          <TabsContent value="stats" className="mt-3">
            <dl className="space-y-1.5 text-xs">
              {rows.map(([label, value]) => (
                <div key={label} className="flex items-start justify-between gap-4">
                  <dt className="text-muted-foreground">{label}</dt>
                  <dd className="truncate text-right font-medium">{value}</dd>
                </div>
              ))}
            </dl>
            {stats.exchanges === 0 ? (
              <p className="mt-3 text-[11px] text-muted-foreground">
                {t('agent.info_no_usage')}
              </p>
            ) : null}
          </TabsContent>

          <TabsContent value="context" className="mt-3">
            <p className="mb-2 text-[11px] text-muted-foreground">
              {t('agent.info_context_hint')}
            </p>
            <pre className="max-h-[50vh] overflow-auto whitespace-pre-wrap break-words rounded-md border bg-muted/40 p-2 font-mono text-[11px]">
              {systemPrompt()}
            </pre>
          </TabsContent>

          <TabsContent value="exchanges" className="mt-3">
            {exchanges.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                {t('agent.info_no_exchanges')}
              </p>
            ) : (
              <div className="max-h-[50vh] space-y-2 overflow-auto">
                {exchanges.map((exchange, index) => (
                  <details key={exchange.id} className="rounded-md border">
                    <summary className="cursor-pointer px-2 py-1.5 text-xs">
                      #{index + 1} · {new Date(exchange.at).toLocaleTimeString()} ·{' '}
                      {(exchange.durationMs / 1000).toFixed(1)}s
                      {exchange.usage
                        ? ` · ${exchange.usage.promptTokens + exchange.usage.completionTokens} tok`
                        : ''}
                    </summary>
                    <div className="space-y-2 border-t p-2">
                      <p className="text-[11px] font-medium text-muted-foreground">
                        {t('agent.info_sent')}
                      </p>
                      <pre className="max-h-52 overflow-auto whitespace-pre-wrap break-words rounded bg-muted/40 p-2 font-mono text-[10px]">
                        {JSON.stringify(exchange.request, null, 2)}
                      </pre>
                      <p className="text-[11px] font-medium text-muted-foreground">
                        {t('agent.info_received')}
                      </p>
                      <pre className="max-h-52 overflow-auto whitespace-pre-wrap break-words rounded bg-muted/40 p-2 font-mono text-[10px]">
                        {JSON.stringify(
                          {
                            content: exchange.responseText,
                            tool_calls: exchange.toolCalls,
                          },
                          null,
                          2
                        )}
                      </pre>
                    </div>
                  </details>
                ))}
              </div>
            )}
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  )
}

export function DashboardAgentSidebar({
  dashboardId,
  projectUid,
  endpoint,
  isRemote,
  onClose,
}: Props) {
  const { t } = useTranslation()
  const [draft, setDraft] = useState('')
  const [infoOpen, setInfoOpen] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)

  const {
    transcript,
    running,
    canUndo,
    contextTokens,
    systemPrompt,
    exchanges,
    stats,
    pending,
    confirmPending,
    cancelPending,
    send,
    stop,
    undo,
    reset,
  } = useDashboardAgent({ dashboardId, projectUid, endpoint })

  useEffect(() => {
    // ScrollArea doesn't forward a ref, so reach the Radix viewport from a
    // wrapper element instead of the component itself.
    const viewport = scrollRef.current?.querySelector(
      '[data-radix-scroll-area-viewport]'
    )
    if (viewport) viewport.scrollTop = viewport.scrollHeight
  }, [transcript, pending])

  const submit = () => {
    if (!draft.trim() || running) return
    send(draft)
    setDraft('')
  }

  return (
    <TooltipProvider>
      <div className="flex w-80 shrink-0 flex-col border-l bg-card">
        <div className="flex items-center gap-2 border-b px-3 py-2">
          <Sparkles size={15} className="text-primary" />
          <span className="text-sm font-medium">{t('agent.title')}</span>
          {isRemote ? (
            <Badge variant="destructive" className="gap-1 text-[10px]">
              <AlertTriangle size={10} />
              {t('agent.external_api')}
            </Badge>
          ) : null}
          <div className="ml-auto flex items-center gap-1">
            <IconAction label={t('agent.info_title')} onClick={() => setInfoOpen(true)}>
              <Info size={12} />
            </IconAction>
            <IconAction label={t('agent.reset')} onClick={reset}>
              <RotateCcw size={12} />
            </IconAction>
            <IconAction label={t('common.close')} onClick={onClose}>
              <X size={12} />
            </IconAction>
          </div>
        </div>

        <div ref={scrollRef} className="min-h-0 flex-1">
          <ScrollArea className="h-full">
            <div className="space-y-3 p-3">
              {transcript.length === 0 ? (
                <p className="text-xs text-muted-foreground">{t('agent.empty_hint')}</p>
              ) : null}
              {transcript.map((entry) => {
                if (entry.kind === 'tool') return <ToolLine key={entry.id} entry={entry} />
                if (entry.kind === 'user') {
                  return (
                    <div
                      key={entry.id}
                      className="rounded-md bg-muted px-2 py-1.5 text-xs"
                    >
                      {entry.text}
                    </div>
                  )
                }
                if (entry.kind === 'error') {
                  return (
                    <p key={entry.id} className="text-xs text-destructive">
                      {t(`agent.error.${entry.text}`, { defaultValue: entry.text })}
                    </p>
                  )
                }
                return (
                  <p key={entry.id} className="whitespace-pre-wrap text-xs">
                    {entry.text === 'reverted' ? t('agent.reverted') : entry.text}
                    {entry.streaming ? (
                      <span className="ml-0.5 inline-block animate-pulse">▋</span>
                    ) : null}
                  </p>
                )
              })}

              {running && !transcript.some((e) => e.streaming) ? (
                <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <span className="inline-flex gap-0.5">
                    <span className="animate-bounce [animation-delay:-0.3s]">.</span>
                    <span className="animate-bounce [animation-delay:-0.15s]">.</span>
                    <span className="animate-bounce">.</span>
                  </span>
                  {t('agent.thinking')}
                </p>
              ) : null}

              {pending ? (
                <div className="space-y-2 rounded-md border-2 border-destructive bg-destructive/5 p-2.5">
                  <p className="flex items-start gap-1.5 text-xs font-medium text-destructive">
                    <AlertTriangle size={13} className="mt-0.5 shrink-0" />
                    {t(`agent.confirm_${pending.tool}`, { name: pending.summary })}
                  </p>
                  <div className="flex gap-1.5">
                    <Button
                      size="sm"
                      variant="destructive"
                      className="h-7 flex-1 text-xs"
                      onClick={confirmPending}
                    >
                      {t('agent.confirm_yes')}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 flex-1 text-xs"
                      onClick={cancelPending}
                    >
                      {t('common.cancel')}
                    </Button>
                  </div>
                </div>
              ) : null}
            </div>
          </ScrollArea>
        </div>

        {canUndo && !running ? (
          <div className="border-t px-3 py-2">
            <Button
              variant="outline"
              size="sm"
              className="w-full gap-1.5"
              onClick={undo}
            >
              <Undo2 size={13} />
              {t('agent.undo')}
            </Button>
          </div>
        ) : null}

        <div className="border-t p-2">
          <div className="relative">
            <Textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  submit()
                }
              }}
              placeholder={t('agent.placeholder')}
              rows={2}
              className="resize-none pr-9 text-xs"
              disabled={running}
            />
            <Button
              size="icon"
              variant={running ? 'destructive' : 'default'}
              className="absolute bottom-1.5 right-1.5 size-6"
              onClick={running ? stop : submit}
              title={running ? t('agent.stop') : t('agent.send')}
            >
              {running ? <Square size={11} /> : <CornerDownLeft size={12} />}
            </Button>
          </div>
        </div>

        <SessionInfoDialog
          stats={stats}
          contextTokens={contextTokens}
          endpoint={endpoint}
          systemPrompt={systemPrompt}
          exchanges={exchanges}
          open={infoOpen}
          onOpenChange={setInfoOpen}
        />
      </div>
    </TooltipProvider>
  )
}
