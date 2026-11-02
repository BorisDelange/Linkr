import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ExternalLink, Loader2, RefreshCw, RotateCcw, ScrollText, Square, Play, Globe } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { NoticeBanner } from '@/components/ui/notice-banner'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { ApiError, formatApiError } from '@/lib/api-client'
import { stripAnsi } from '@/lib/ansi'
import { cn } from '@/lib/utils'
import { useFileStore } from '@/stores/file-store'
import {
  getWebApp,
  restartWebApp,
  stopWebApp,
  webAppFrameUrl,
  webSocketsGetThrough,
  type WebApp,
  type WebAppStatus,
} from '@/lib/api/web-apps'

const DOT: Record<WebAppStatus, string> = {
  starting: 'bg-warning animate-pulse',
  ready: 'bg-emerald-500',
  failed: 'bg-destructive',
  stopped: 'bg-muted-foreground/50',
}

/**
 * A web app started from the IDE, in its own tab: the app in an iframe under a
 * thin toolbar, and its output in a drawer. Closing the tab leaves the app
 * running — the jobs panel lists it and stops it.
 */
export function WebAppPanel({ tabId, appId, active }: { tabId: string; appId: string; active: boolean }) {
  const { t } = useTranslation()
  const [app, setApp] = useState<WebApp | null>(null)
  const [gone, setGone] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showLog, setShowLog] = useState(false)
  const [frameKey, setFrameKey] = useState(0)
  const [busy, setBusy] = useState(false)
  const [wsBlocked, setWsBlocked] = useState(false)
  const retarget = useFileStore((s) => s.retargetAppTab)
  const logEnd = useRef<HTMLDivElement>(null)

  const status: WebAppStatus = gone ? 'stopped' : app?.status ?? 'starting'
  const ended = status === 'failed' || status === 'stopped'

  useEffect(() => {
    setApp(null)
    setGone(false)
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = async () => {
      try {
        const next = await getWebApp(appId)
        if (cancelled) return
        setApp(next)
        if (next.status === 'failed') setShowLog(true)
        if (next.status === 'failed' || next.status === 'stopped') return
        // Fast while it boots; then only to notice that it crashed.
        timer = setTimeout(poll, next.status === 'starting' ? 1000 : 3000)
      } catch (e) {
        if (cancelled) return
        // The server restarted since: the app is gone with it.
        if (e instanceof ApiError && e.status === 404) setGone(true)
        else timer = setTimeout(poll, 5000)
      }
    }
    void poll()
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [appId])

  const ready = app?.status === 'ready' ? app : null
  useEffect(() => {
    if (!ready) return
    let cancelled = false
    void webSocketsGetThrough(ready).then((ok) => { if (!cancelled) setWsBlocked(!ok) })
    return () => { cancelled = true }
  }, [ready?.appId]) // eslint-disable-line react-hooks/exhaustive-deps -- once per app

  useEffect(() => {
    if (showLog) logEnd.current?.scrollIntoView({ block: 'end' })
  }, [showLog, app?.log?.length])

  const restart = useCallback(async () => {
    if (!app) return
    setBusy(true)
    setError(null)
    try {
      const next = await restartWebApp(gone ? { ...app, status: 'stopped' } : app)
      retarget(tabId, next.appId)
    } catch (e) {
      setError(formatApiError(e).summary ?? String(e))
    } finally {
      setBusy(false)
    }
  }, [app, gone, retarget, tabId])

  const stop = useCallback(async () => {
    setBusy(true)
    try {
      await stopWebApp(appId)
      setApp((a) => (a ? { ...a, status: 'stopped' } : a))
    } catch (e) {
      setError(formatApiError(e).summary ?? String(e))
    } finally {
      setBusy(false)
    }
  }, [appId])

  const frameUrl = app ? webAppFrameUrl(app.url) : null

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b px-2 text-xs">
        <span className={cn('size-2 shrink-0 rounded-full', DOT[status])} />
        <span className="truncate font-medium">{app?.label ?? '…'}</span>
        <span className="shrink-0 text-muted-foreground">{t(`web_apps.status.${status}`)}</span>
        {error && <span role="alert" className="truncate text-destructive">{error}</span>}
        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          <ToolbarButton label={t('web_apps.reload')} disabled={status !== 'ready'} onClick={() => setFrameKey((k) => k + 1)}>
            <RefreshCw size={13} />
          </ToolbarButton>
          <ToolbarButton label={t('web_apps.open_window')} disabled={status !== 'ready' || !frameUrl} onClick={() => frameUrl && window.open(frameUrl, '_blank', 'noopener')}>
            <ExternalLink size={13} />
          </ToolbarButton>
          <ToolbarButton label={t('web_apps.logs')} pressed={showLog} onClick={() => setShowLog((v) => !v)}>
            <ScrollText size={13} />
          </ToolbarButton>
          <ToolbarButton label={t(ended ? 'web_apps.start_again' : 'web_apps.restart')} disabled={!app || busy} onClick={() => void restart()}>
            {busy ? <Loader2 size={13} className="animate-spin" /> : ended ? <Play size={13} /> : <RotateCcw size={13} />}
          </ToolbarButton>
          <ToolbarButton label={t('web_apps.stop')} disabled={ended || busy} onClick={() => void stop()}>
            <Square size={13} />
          </ToolbarButton>
        </div>
      </div>

      {wsBlocked && status === 'ready' && (
        <NoticeBanner tone="warning" title={t('web_apps.ws_blocked')} description={t('web_apps.ws_blocked_hint')} />
      )}

      <div className="relative min-h-0 flex-1">
        {status === 'ready' && frameUrl ? (
          // No sandbox: an app needs its own storage, cookies and WebSocket. It is
          // reachable only by the user who started it (see routes/apps.py).
          <iframe
            key={frameKey}
            src={frameUrl}
            title={app?.label}
            className="size-full border-0 bg-white"
            allow="clipboard-read; clipboard-write; fullscreen"
            // A hidden tab keeps its app mounted; only the active one takes focus.
            tabIndex={active ? 0 : -1}
          />
        ) : (
          <div className="flex size-full flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
            {status === 'starting' ? (
              <>
                <Loader2 size={20} className="animate-spin" />
                <span>{t('web_apps.starting', { name: app?.label ?? '' })}</span>
                <span className="text-xs">{t('web_apps.starting_hint')}</span>
              </>
            ) : (
              <>
                <Globe size={28} className="text-muted-foreground/50" />
                <span>{gone ? t('web_apps.gone') : status === 'failed' ? (app?.error ?? t('web_apps.status.failed')) : t('web_apps.stopped')}</span>
                {app && (
                  <Button size="xs" className="mt-1 gap-1" disabled={busy} onClick={() => void restart()}>
                    <Play size={12} />
                    {t('web_apps.start_again')}
                  </Button>
                )}
              </>
            )}
          </div>
        )}
      </div>

      {showLog && (
        <div className="h-48 shrink-0 overflow-auto border-t bg-muted/30 px-3 py-2">
          {app?.command && (
            <p className="mb-1 font-mono text-[10px] text-muted-foreground">$ {app.command}</p>
          )}
          <pre className="font-mono text-xs whitespace-pre-wrap">
            {stripAnsi((app?.log ?? []).join('\n')) || t('web_apps.no_output')}
          </pre>
          <div ref={logEnd} />
        </div>
      )}
    </div>
  )
}

function ToolbarButton({
  label,
  onClick,
  disabled,
  pressed,
  children,
}: {
  label: string
  onClick: () => void
  disabled?: boolean
  pressed?: boolean
  children: React.ReactNode
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant={pressed ? 'secondary' : 'ghost'}
          size="icon-xs"
          aria-label={label}
          aria-pressed={pressed}
          disabled={disabled}
          onClick={onClick}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}
