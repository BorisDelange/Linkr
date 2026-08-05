import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  AlertTriangle,
  ChevronRight,
  CornerDownLeft,
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
import { cn } from '@/lib/utils'
import type { LlmEndpoint } from '@/lib/agent/agent-loop'
import {
  useDashboardAgent,
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
        <span className={cn('font-mono', !entry.ok && 'text-destructive')}>
          {entry.text}
        </span>
      </button>
      {open && entry.detail ? (
        <p className="ml-4 mt-1 whitespace-pre-wrap break-words font-mono text-[11px] text-muted-foreground">
          {entry.detail}
        </p>
      ) : null}
    </div>
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
  const scrollRef = useRef<HTMLDivElement>(null)

  const {
    transcript,
    running,
    canUndo,
    contextTokens,
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
  }, [transcript])

  const submit = () => {
    if (!draft.trim() || running) return
    send(draft)
    setDraft('')
  }

  return (
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
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            title={t('agent.reset')}
            onClick={reset}
          >
            <RotateCcw size={13} />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            title={t('common.close')}
            onClick={onClose}
          >
            <X size={14} />
          </Button>
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
                  <div key={entry.id} className="rounded-md bg-muted px-2 py-1.5 text-xs">
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
                </p>
              )
            })}
          </div>
        </ScrollArea>
      </div>

      {canUndo && !running ? (
        <div className="border-t px-3 py-2">
          <Button variant="outline" size="sm" className="w-full gap-1.5" onClick={undo}>
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
        <p className="mt-1 text-right text-[10px] text-muted-foreground">
          {t('agent.context_tokens', { count: contextTokens })}
        </p>
      </div>
    </div>
  )
}
