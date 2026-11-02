import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { DialogShell } from '@/components/ui/dialog-shell'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { formatApiError } from '@/lib/api-client'
import { ideFilePath } from '@/lib/api/ide-files'
import {
  detectWebAppPreset,
  listWebAppPresets,
  listWebApps,
  restartWebApp,
  startWebApp,
} from '@/lib/api/web-apps'
import { useFileStore } from '@/stores/file-store'

interface Target {
  fileId: string
  name: string
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

  const report = useCallback((name: string, e: unknown) => {
    const { addExecutionResult, setOutputVisible } = useFileStore.getState()
    addExecutionResult({
      id: `web-app-${Date.now()}`,
      fileName: name,
      language: name.toLowerCase().endsWith('.r') ? 'r' : 'python',
      timestamp: Date.now(),
      duration: 0,
      success: false,
      output: t('web_apps.start_failed', { error: formatApiError(e).summary ?? String(e) }),
    })
    setOutputVisible(true)
  }, [t])

  const launch = useCallback(async (target: Target, opts: { framework?: string; command?: string }) => {
    const path = ideFilePath(target.fileId)
    if (!projectUid || path === undefined) return
    const { openAppTab } = useFileStore.getState()
    const app = await startWebApp({ projectUid, path, ...opts })
    openAppTab(app.appId, target.name)
  }, [projectUid])

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
        const next = await restartWebApp(running)
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
  }, [projectUid, launch, report])

  const confirm = async () => {
    if (!asking) return
    setBusy(true)
    try {
      await launch(asking, { command: command.trim() })
      setAsking(null)
    } catch (e) {
      report(asking.name, e)
      setAsking(null)
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
