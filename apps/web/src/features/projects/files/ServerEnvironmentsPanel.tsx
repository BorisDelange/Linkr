import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Plus, Loader2, Trash2, Hammer, ExternalLink, Info, ArrowUpCircle, Sparkles } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { useProjectRouteUid } from '@/hooks/use-project-route'
import { useMyProjectRole } from '@/hooks/use-context-role'
import {
  listEnvironments,
  listEnvPackages,
  addEnvPackages,
  removeEnvPackage,
  buildEnvironment,
  installPreset,
  upgradeEnvPackages,
  listJobs,
  type ProjectEnvironment,
  type EnvPackage,
} from '@/lib/api/environments'

/**
 * Server-mode environment manager for the active project (per language). Packages
 * are declarative: add/remove/upgrade edits the lockfile; Build materialises the
 * venv/library. Build is normally automatic on first run — the button is only for
 * an explicit rebuild and is shown only when the env needs one.
 */
export function ServerEnvironmentsPanel({ language }: { language: 'python' | 'r' }) {
  const { t } = useTranslation()
  const projectUid = useProjectRouteUid()
  const canWrite = useMyProjectRole().can('ide:write')

  const [env, setEnv] = useState<ProjectEnvironment | null>(null)
  const [packages, setPackages] = useState<EnvPackage[]>([])
  const [loading, setLoading] = useState(false)
  const [newPkg, setNewPkg] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!projectUid) return
    setLoading(true)
    try {
      const envs = await listEnvironments(projectUid)
      setEnv(envs.find((e) => e.language === language) ?? null)
      setPackages(await listEnvPackages(projectUid, language))
    } finally {
      setLoading(false)
    }
  }, [projectUid, language])

  useEffect(() => {
    void load()
  }, [load])

  const run = async (fn: () => Promise<ProjectEnvironment>) => {
    if (!projectUid) return
    setBusy(true)
    setError(null)
    try {
      setEnv(await fn())
      setPackages(await listEnvPackages(projectUid, language))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const onAdd = async () => {
    const name = newPkg.trim()
    if (!name) return
    setNewPkg('')
    await run(() => addEnvPackages(projectUid!, language, [name]))
  }

  // A build runs as a background job → poll until it settles, then reload the env
  // so its status flips draft/building → ready/error in the UI.
  const onBuild = async () => {
    if (!projectUid) return
    setBusy(true)
    setError(null)
    try {
      await buildEnvironment(projectUid, language)
      setEnv((e) => (e ? { ...e, status: 'building' } : e))
      const poll = async (): Promise<void> => {
        const active = await listJobs(projectUid)
        const build = active.find((j) => j.kind === 'build')
        if (build && (build.status === 'queued' || build.status === 'running')) {
          await new Promise((r) => setTimeout(r, 1500))
          return poll()
        }
        if (build && build.status === 'error') setError(build.logTail || 'Build failed')
      }
      await poll()
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const onPreset = () => run(() => installPreset(projectUid!, language))
  const onUpgradeAll = () => run(() => upgradeEnvPackages(projectUid!, language))
  const onUpgrade = (pkg: string) => run(() => upgradeEnvPackages(projectUid!, language, pkg))

  if (!projectUid) {
    return (
      <p className="py-8 text-center text-xs text-muted-foreground">
        {t('environments.open_project_first')}
      </p>
    )
  }

  const statusVariant =
    env?.status === 'ready' ? 'secondary' : env?.status === 'error' ? 'destructive' : 'outline'
  const needsBuild = env?.status === 'draft' || env?.status === 'error' || env?.status === 'building'
  const label = language === 'python' ? 'Python' : 'R'
  const packageUrl = (name: string) =>
    language === 'python'
      ? `https://pypi.org/project/${encodeURIComponent(name)}`
      : `https://packagemanager.posit.co/client/#/repos/cran/packages/${encodeURIComponent(name)}`

  return (
    <TooltipProvider delayDuration={200}>
      <div className="mt-2 flex flex-col gap-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 text-sm font-medium">
            {label}
            {env && env.status !== 'ready' && (
              <Badge variant={statusVariant} className="text-[10px]">
                {t(`environments.status.${env.status}`)}
              </Badge>
            )}
            <Tooltip>
              <TooltipTrigger asChild>
                <button className="text-muted-foreground/60 hover:text-muted-foreground" aria-label={t('environments.version_help_label')}>
                  <Info size={13} />
                </button>
              </TooltipTrigger>
              <TooltipContent side="right" className="max-w-xs text-xs">
                {t(`environments.version_help_${language}`)}
              </TooltipContent>
            </Tooltip>
          </div>
          <div className="flex items-center gap-1">
            {canWrite && packages.length > 0 && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button size="sm" variant="ghost" className="h-7 px-2" disabled={busy} onClick={() => void onUpgradeAll()}>
                    <ArrowUpCircle size={13} className="mr-1" />
                    {t('environments.update_all')}
                  </Button>
                </TooltipTrigger>
                <TooltipContent className="text-xs">{t('environments.update_all_hint')}</TooltipContent>
              </Tooltip>
            )}
            {/* Build normally runs automatically on first execution; the button is
                only offered for an explicit (re)build when the env isn't ready. */}
            {canWrite && needsBuild && (
              <Button
                size="sm"
                className="h-7 px-2"
                disabled={busy || env?.status === 'building'}
                onClick={() => void onBuild()}
              >
                {env?.status === 'building' ? (
                  <Loader2 size={13} className="mr-1 animate-spin" />
                ) : (
                  <Hammer size={13} className="mr-1" />
                )}
                {t('environments.build')}
              </Button>
            )}
          </div>
        </div>

        {canWrite && (
          <div className="flex gap-2">
            <Input
              value={newPkg}
              onChange={(e) => setNewPkg(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void onAdd()
              }}
              placeholder={t('environments.add_placeholder')}
              disabled={busy}
              className="h-8 text-xs"
            />
            <Button size="sm" onClick={() => void onAdd()} disabled={busy || !newPkg.trim()}>
              <Plus size={14} />
            </Button>
          </div>
        )}

        {error && <p className="text-xs text-destructive">{error}</p>}

        <ScrollArea className="max-h-64">
          {loading ? (
            <div className="flex justify-center py-6">
              <Loader2 size={16} className="animate-spin text-muted-foreground" />
            </div>
          ) : packages.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-6 text-center">
              <p className="text-xs text-muted-foreground">{t('environments.no_packages')}</p>
              {canWrite && (
                <Button size="sm" variant="outline" className="h-7" disabled={busy} onClick={() => void onPreset()}>
                  <Sparkles size={13} className="mr-1" />
                  {t('environments.install_preset')}
                </Button>
              )}
            </div>
          ) : (
            <ul className="flex flex-col gap-1">
              {packages.map((pkg) => (
                <li key={pkg.name} className="group flex items-center justify-between rounded text-xs hover:bg-muted/50">
                  {/* Whole row (name + version + external-link icon) is one link. */}
                  <a
                    href={packageUrl(pkg.name)}
                    target="_blank"
                    rel="noreferrer"
                    className="flex flex-1 items-center gap-1.5 px-2 py-1 hover:underline"
                  >
                    <span className="font-medium">{pkg.name}</span>
                    {pkg.spec && <span className="text-muted-foreground">{pkg.spec}</span>}
                    <ExternalLink size={10} className="text-muted-foreground/50" />
                  </a>
                  {canWrite && (
                    <div className="flex items-center gap-0.5 pr-1.5 opacity-0 transition-opacity group-hover:opacity-100">
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <button
                            className="text-muted-foreground hover:text-foreground disabled:opacity-40"
                            disabled={busy}
                            onClick={() => void onUpgrade(pkg.name)}
                            aria-label={t('environments.update')}
                          >
                            <ArrowUpCircle size={13} />
                          </button>
                        </TooltipTrigger>
                        <TooltipContent className="text-xs">{t('environments.update')}</TooltipContent>
                      </Tooltip>
                      <button
                        className="text-muted-foreground hover:text-destructive disabled:opacity-40"
                        disabled={busy}
                        onClick={() => run(() => removeEnvPackage(projectUid, language, pkg.name))}
                        aria-label={t('environments.remove')}
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </ScrollArea>

        <p className="text-[11px] text-muted-foreground">{t('environments.build_hint')}</p>
      </div>
    </TooltipProvider>
  )
}
