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
import ReactMarkdown from 'react-markdown'
import {
  remarkPlugins,
  rehypePlugins,
  urlTransform,
} from '@/components/editor/MarkdownRenderer'
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

/** Elapsed time, matching the IDE's convention: seconds, then minutes. */
function formatElapsed(ms: number): string {
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  const minutes = Math.floor(seconds / 60)
  return `${minutes}m ${Math.floor(seconds % 60)}s`
}

function clockTime(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

/** Ticks while a turn runs so the user sees time passing, not a frozen panel. */
function LiveElapsed({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 100)
    return () => clearInterval(timer)
  }, [since])
  return <span className="tabular-nums">{formatElapsed(now - since)}</span>
}

/**
 * Assistant prose, rendered as markdown.
 *
 * Headings are deliberately flattened to near body size: a model writing "# Done"
 * would otherwise blow out a 320px panel. Everything stays within one or two
 * steps of the surrounding text, so structure reads as emphasis rather than as a
 * document. Sanitisation comes from the shared config — this is model output.
 */
function AssistantMarkdown({ text }: { text: string }) {
  return (
    <div
      className={cn(
        'prose prose-sm dark:prose-invert max-w-none text-xs',
        '[&>*:first-child]:!mt-0 [&>*:last-child]:!mb-0',
        '[&_h1]:text-sm [&_h2]:text-sm [&_h3]:text-xs [&_h4]:text-xs',
        '[&_h1]:font-semibold [&_h2]:font-semibold [&_h3]:font-semibold',
        '[&_h1]:mb-1 [&_h2]:mb-1 [&_h3]:mb-1 [&_h1]:mt-2 [&_h2]:mt-2 [&_h3]:mt-2',
        '[&_p]:my-1 [&_ul]:my-1 [&_ol]:my-1 [&_li]:my-0.5',
        '[&_pre]:my-1 [&_pre]:overflow-x-auto [&_pre]:p-2 [&_pre]:text-[11px]',
        '[&_code]:text-[11px] [&_table]:text-[11px] [&_table]:my-1'
      )}
    >
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={rehypePlugins}
        urlTransform={urlTransform}
      >
        {text}
      </ReactMarkdown>
    </div>
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
  const [selectedExchange, setSelectedExchange] = useState(0)
  // Latest call is the interesting one; clamp so a reset never leaves a stale index.
  const index = Math.min(selectedExchange, Math.max(exchanges.length - 1, 0))
  const current = exchanges[index]
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
      <DialogContent className="flex h-[70vh] flex-col sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="text-sm">{t('agent.info_title')}</DialogTitle>
        </DialogHeader>
        <Tabs defaultValue="stats" className="flex min-h-0 flex-1 flex-col">
          <TabsList className="mx-auto w-fit shrink-0">
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

          <TabsContent value="stats" className="mt-3 min-h-0 flex-1 overflow-auto">
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

          <TabsContent value="context" className="mt-3 flex min-h-0 flex-1 flex-col">
            <p className="mb-2 shrink-0 text-[11px] text-muted-foreground">
              {t('agent.info_context_hint')}
            </p>
            <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words rounded-md border bg-muted/40 p-2 font-mono text-[11px]">
              {systemPrompt()}
            </pre>
          </TabsContent>

          <TabsContent value="exchanges" className="mt-3 flex min-h-0 flex-1 flex-col">
            {exchanges.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                {t('agent.info_no_exchanges')}
              </p>
            ) : (
              <>
                {/* One selector plus one scroll area: a list of expandable blocks
                    nested a second scrollbar inside the dialog's own. */}
                <select
                  value={selectedExchange}
                  onChange={(e) => setSelectedExchange(Number(e.target.value))}
                  className="mb-2 h-8 shrink-0 rounded-md border bg-background px-2 text-xs"
                >
                  {exchanges.map((exchange, index) => (
                    <option key={exchange.id} value={index}>
                      #{index + 1} · {new Date(exchange.at).toLocaleTimeString()} ·{' '}
                      {(exchange.durationMs / 1000).toFixed(1)}s
                      {exchange.usage
                        ? ` · ${exchange.usage.promptTokens + exchange.usage.completionTokens} tok`
                        : ''}
                    </option>
                  ))}
                </select>
                {current ? (
                  <div className="min-h-0 flex-1 space-y-2 overflow-auto">
                    <p className="text-[11px] font-medium text-muted-foreground">
                      {t('agent.info_sent')}
                    </p>
                    <pre className="whitespace-pre-wrap break-words rounded bg-muted/40 p-2 font-mono text-[10px]">
                      {JSON.stringify(current.request, null, 2)}
                    </pre>
                    <p className="text-[11px] font-medium text-muted-foreground">
                      {t('agent.info_received')}
                    </p>
                    <pre className="whitespace-pre-wrap break-words rounded bg-muted/40 p-2 font-mono text-[10px]">
                      {JSON.stringify(
                        { content: current.responseText, tool_calls: current.toolCalls },
                        null,
                        2
                      )}
                    </pre>
                  </div>
                ) : null}
              </>
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
    turnStartedAt,
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
                    <div key={entry.id} className="rounded-md bg-muted px-2 py-1.5">
                      <p className="text-xs">{entry.text}</p>
                      <p className="mt-0.5 text-[10px] text-muted-foreground">
                        {clockTime(entry.at)}
                      </p>
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
                  <div key={entry.id}>
                    {entry.streaming ? (
                      // Render plain while streaming: half-written markdown
                      // (an unclosed ``` or table) would flicker between layouts.
                      <p className="whitespace-pre-wrap text-xs">
                        {entry.text}
                        <span className="ml-0.5 inline-block animate-pulse">▋</span>
                      </p>
                    ) : (
                      <AssistantMarkdown
                        text={entry.text === 'reverted' ? t('agent.reverted') : entry.text}
                      />
                    )}
                    {entry.durationMs != null && !entry.streaming ? (
                      <p className="mt-0.5 text-[10px] text-muted-foreground">
                        {clockTime(entry.at)} · {formatElapsed(entry.durationMs)}
                      </p>
                    ) : null}
                  </div>
                )
              })}

              {running && turnStartedAt != null ? (
                <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <span className="inline-flex gap-0.5">
                    <span className="animate-bounce [animation-delay:-0.3s]">.</span>
                    <span className="animate-bounce [animation-delay:-0.15s]">.</span>
                    <span className="animate-bounce">.</span>
                  </span>
                  {t('agent.thinking')}
                  <LiveElapsed since={turnStartedAt} />
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
