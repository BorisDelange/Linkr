import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { DialogShell } from '@/components/ui/dialog-shell'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { formatApiError, isServerMode } from '@/lib/api-client'
import { onJobsChanged } from '@/lib/api/environments'
import { ideFilePath } from '@/lib/api/ide-files'
import {
  detectWebAppPreset,
  listWebAppPresets,
  listWebApps,
  restartWebApp,
  startWebApp,
  type WebAppPreset,
} from '@/lib/api/web-apps'
import { useFileStore } from '@/stores/file-store'

interface Target {
  fileId: string
  name: string
}

function languageOf(name: string): 'r' | 'python' {
  return name.toLowerCase().endsWith('.r') ? 'r' : 'python'
}

function defaultCommand(name: string): string {
  const quoted = /^[\w.-]+$/.test(name) ? name : `'${name.replace(/'/g, `'\\''`)}'`
  return name.toLowerCase().endsWith('.r') ? `Rscript ${quoted}` : `python ${quoted}`
}

/**
 * "Run as web app": serve the file through the API's proxy and show it in a tab.
 * A file no preset recognises asks for a command instead, with `$PORT` to listen
 * on. An app already running for the file is restarted in its own tab (RStudio's
 * "Reload App"), so the code saved since is picked up.
 */
export function useRunAsWebApp(projectUid: string | null) {
  const { t } = useTranslation()
  const [asking, setAsking] = useState<Target | null>(null)
  const [command, setCommand] = useState('')
  const [busy, setBusy] = useState(false)

  const failure = useCallback(
    (e: unknown) => t('web_apps.start_failed', { error: formatApiError(e).summary ?? String(e) }),
    [t],
  )

  const report = useCallback((name: string, e: unknown) => {
    const { addExecutionResult, setOutputVisible } = useFileStore.getState()
    addExecutionResult({
      id: `web-app-${Date.now()}`,
      fileName: name,
      language: languageOf(name),
      timestamp: Date.now(),
      duration: 0,
      success: false,
      output: failure(e),
    })
    setOutputVisible(true)
  }, [failure])

  /** A start can wait minutes on the project's environment build: say so at once,
   *  in the output, and turn the line into the outcome when the server answers. */
  const starting = useCallback(async <T,>(name: string, start: () => Promise<T>): Promise<T | undefined> => {
    const { addExecutionResult, updateExecutionResult, setOutputVisible } = useFileStore.getState()
    const id = `web-app-${Date.now()}`
    const since = Date.now()
    addExecutionResult({
      id,
      fileName: name,
      language: languageOf(name),
      timestamp: since,
      duration: 0,
      success: true,
      running: true,
      output: t('web_apps.preparing', { name }),
    })
    setOutputVisible(true)
    try {
      const result = await start()
      updateExecutionResult(id, { running: false, duration: Date.now() - since, output: t('web_apps.started', { name }) })
      return result
    } catch (e) {
      updateExecutionResult(id, { running: false, success: false, duration: Date.now() - since, output: failure(e) })
      return undefined
    }
  }, [t, failure])

  const launch = useCallback(async (target: Target, opts: { framework?: string; command?: string }) => {
    const path = ideFilePath(target.fileId)
    if (!projectUid || path === undefined) return
    const app = await starting(target.name, () => startWebApp({ projectUid, path, ...opts }))
    if (app) useFileStore.getState().openAppTab(app.appId, target.name)
  }, [projectUid, starting])

  const runAsWebApp = useCallback(async (target: Target) => {
    const store = useFileStore.getState()
    const path = ideFilePath(target.fileId)
    if (!projectUid || path === undefined) return
    try {
      // The server starts the file from disk.
      await store.saveFile(target.fileId)
      const running = (await listWebApps(projectUid)).find(
        (a) => a.path === path && (a.status === 'starting' || a.status === 'ready'),
      )
      if (running) {
        const next = await starting(target.name, () => restartWebApp(running))
        if (!next) return
        const tab = useFileStore.getState().terminalTabs.find((t) => t.appId === running.appId)
        if (tab) store.retargetAppTab(tab.id, next.appId)
        store.openAppTab(next.appId, target.name)
        return
      }
      const content = store.files.find((f) => f.id === target.fileId)?.content ?? ''
      const preset = detectWebAppPreset(target.name, content, await listWebAppPresets())
      if (preset) {
        await launch(target, { framework: preset.key })
      } else {
        setCommand(defaultCommand(target.name))
        setAsking(target)
      }
    } catch (e) {
      report(target.name, e)
    }
  }, [projectUid, launch, report, starting])

  const confirm = async () => {
    if (!asking) return
    setBusy(true)
    setAsking(null)
    try {
      await launch(asking, { command: command.trim() })
    } finally {
      setBusy(false)
    }
  }

  const dialog = (
    <DialogShell
      open={asking !== null}
      onOpenChange={(open) => { if (!open) setAsking(null) }}
      title={t('web_apps.command_title')}
      description={t('web_apps.command_description', { name: asking?.name ?? '' })}
      onConfirm={() => void confirm()}
      confirmLabel={t('web_apps.run')}
      confirmDisabled={!command.trim()}
      busy={busy}
    >
      <div className="space-y-1.5">
        <Label htmlFor="web-app-command">{t('web_apps.command_label')}</Label>
        <Input
          id="web-app-command"
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          className="font-mono"
          autoFocus
        />
        <p className="text-xs text-muted-foreground">{t('web_apps.command_hint')}</p>
      </div>
    </DialogShell>
  )

  return { runAsWebApp, dialog }
}

interface EntryFile {
  id: string | null
  name: string | null
  language: string | null | undefined
  content: string | null
}

/**
 * Whether the open file is a web app's entry point, and whether its app runs.
 * A Shiny / Streamlit / Dash… entry point means nothing run line by line in the
 * console (Streamlit warns on each call, Shiny holds the R session): its Run
 * starts the app, like RStudio's "Run App", and reads "Reload app" while it runs.
 */
export function useWebAppEntry(projectUid: string | null, file: EntryFile) {
  const [presets, setPresets] = useState<WebAppPreset[]>([])
  useEffect(() => {
    if (isServerMode()) listWebAppPresets().then(setPresets, () => {})
  }, [])
  const { id, name, language, content } = file
  const preset = useMemo(
    () => (name !== null && (language === 'python' || language === 'r')
      ? detectWebAppPreset(name, content ?? '', presets)
      : null),
    [name, language, content, presets],
  )

  // Refreshed when an app starts or stops from here, or a tab opens or closes; an
  // app that ends on its own is noticed at the next of those — the click restarts
  // it either way.
  const [runningPaths, setRunningPaths] = useState<ReadonlySet<string>>(new Set())
  const appTabIds = useFileStore((s) => s.terminalTabs.filter((tt) => tt.kind === 'app').map((tt) => tt.appId).join())
  useEffect(() => {
    if (!isServerMode() || !projectUid) return
    let live = true
    const refresh = () => {
      listWebApps(projectUid).then((apps) => {
        if (live) setRunningPaths(new Set(apps.map((a) => a.path)))
      }, () => {})
    }
    refresh()
    const off = onJobsChanged(refresh)
    return () => { live = false; off() }
  }, [projectUid, appTabIds, id])
  const path = id ? ideFilePath(id) : undefined
  return { preset, running: !!preset && path !== undefined && runningPaths.has(path) }
}
