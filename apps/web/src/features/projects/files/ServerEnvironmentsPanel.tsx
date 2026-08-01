import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Plus, Loader2, Trash2, Hammer, ExternalLink, Info, RefreshCw, Sparkles, CheckCircle2, PackageCheck } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { useProjectRouteUid } from '@/hooks/use-project-route'
import { useMyProjectRole } from '@/hooks/use-context-role'
import { summarizeInstallError, fullInstallError } from '@/lib/install-error'
import { useEnvironmentsUiStore, type PendingEnvInstall } from '@/stores/environments-ui-store'
import { cn } from '@/lib/utils'
import {
  listEnvironments,
  listEnvPackages,
  addEnvPackages,
  removeEnvPackage,
  buildEnvironment,
  installPreset,
  upgradeEnvPackages,
  getEnvDrift,
  captureEnvDrift,
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
export function ServerEnvironmentsPanel({
  language,
  reloadKey,
  pending,
}: {
  language: 'python' | 'r'
  /** Toggled by the dialog's `open` — reloads the package list each time the
   *  dialog is (re)opened, so a package added elsewhere shows up. */
  reloadKey?: unknown
  /** A queued one-click install (from a script/terminal affordance). When it
   *  targets this panel's language, its packages are added declaratively. */
  pending?: PendingEnvInstall | null
}) {
  const { t } = useTranslation()
  const projectUid = useProjectRouteUid()
  const canWrite = useMyProjectRole().can('ide:write')
  const clearPending = useEnvironmentsUiStore((s) => s.clearPending)

  const [env, setEnv] = useState<ProjectEnvironment | null>(null)
  const [packages, setPackages] = useState<EnvPackage[]>([])
  const [loading, setLoading] = useState(false)
  const [newPkg, setNewPkg] = useState('')
  const [busy, setBusy] = useState(false)
  const [adding, setAdding] = useState(false)
  // Packages whose per-row action (update / remove) is in flight — drives a spinner
  // on that row's button that stays visible even when the pointer leaves the row.
  // A sentinel '*' means "update all" (every row spins).
  const [pendingPkgs, setPendingPkgs] = useState<Set<string>>(new Set())
  const [removeTarget, setRemoveTarget] = useState<string | null>(null)
  const [drift, setDrift] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)

  const isPkgPending = (name: string) => pendingPkgs.has(name) || pendingPkgs.has('*')

  const load = useCallback(async () => {
    if (!projectUid) return
    setLoading(true)
    try {
      const envs = await listEnvironments(projectUid)
      setEnv(envs.find((e) => e.language === language) ?? null)
      setPackages(await listEnvPackages(projectUid, language))
      // Packages installed imperatively (script/terminal) that the lockfile doesn't
      // record — offer to capture them. Best-effort: a failure just hides the banner.
      setDrift(await getEnvDrift(projectUid, language).catch(() => []))
    } finally {
      setLoading(false)
    }
  }, [projectUid, language])

  const onCapture = () => run(() => captureEnvDrift(projectUid!, language))

  useEffect(() => {
    void load()
  }, [load, reloadKey])

  // `mark` is the package name(s) whose row should spin while the op runs ('*' =
  // all rows). Omit it for ops that aren't tied to a specific row (add, preset).
  const run = async (fn: () => Promise<ProjectEnvironment>, mark?: string) => {
    if (!projectUid) return
    setBusy(true)
    setError(null)
    if (mark) setPendingPkgs((s) => new Set(s).add(mark))
    try {
      setEnv(await fn())
      setPackages(await listEnvPackages(projectUid, language))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
      if (mark) {
        setPendingPkgs((s) => {
          const next = new Set(s)
          next.delete(mark)
          return next
        })
      }
    }
  }

  const addPackages = useCallback(async (names: string[]) => {
    if (!projectUid || names.length === 0) return
    setAdding(true)
    setBusy(true)
    setError(null)
    try {
      setEnv(await addEnvPackages(projectUid, language, names))
      setPackages(await listEnvPackages(projectUid, language))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setAdding(false)
      setBusy(false)
    }
  }, [projectUid, language])

  const onAdd = async () => {
    const name = newPkg.trim()
    if (!name) return
    setNewPkg('')
    await addPackages([name])
  }

  // Consume a queued one-click install targeting this language: add the packages
  // declaratively, then clear it so it doesn't fire again on re-render. Keyed on
  // the request nonce so repeat requests for the same package still run.
  const consumedNonce = useRef<number | null>(null)
  useEffect(() => {
    if (!pending || pending.language !== language) return
    if (consumedNonce.current === pending.nonce) return
    consumedNonce.current = pending.nonce
    void addPackages(pending.packages).finally(() => clearPending())
  }, [pending, language, addPackages, clearPending])

  // A build runs as a background job → poll until it settles, then reload the env
  // so its status flips draft/building → ready/error in the UI.
  const onBuild = async () => {
    if (!projectUid) return
    setBusy(true)
    setError(null)
    try {
      await buildEnvironment(projectUid, language)
      setEnv((e) => (e ? { ...e, status: 'building' } : e))
      // Bound the poll so a stuck server job can't pin the UI in "building"
      // forever: at 1.5s/iteration this caps just past the server build timeout.
      const MAX_POLLS = 1400
      const poll = async (n = 0): Promise<void> => {
        const active = await listJobs(projectUid)
        const build = active.find((j) => j.kind === 'build')
        if (build && (build.status === 'queued' || build.status === 'running')) {
          if (n >= MAX_POLLS) {
            setError(t('environments.build_taking_too_long'))
            return
          }
          await new Promise((r) => setTimeout(r, 1500))
          return poll(n + 1)
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
  const onUpgradeAll = () => run(() => upgradeEnvPackages(projectUid!, language), '*')
  const onUpgrade = (pkg: string) => run(() => upgradeEnvPackages(projectUid!, language, pkg), pkg)
  const onRemove = (pkg: string) => run(() => removeEnvPackage(projectUid!, language, pkg), pkg)

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
  // Which build-help copy to show: building / needs-a-build / up-to-date.
  const buildState =
    env?.status === 'building' ? 'building' : needsBuild ? 'draft' : 'ready'
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
            {env?.status === 'ready' && packages.length > 0 && (
              <Badge variant="secondary" className="gap-1 text-[10px] text-emerald-600 dark:text-emerald-400">
                <CheckCircle2 size={10} />
                {t('environments.status_up_to_date')}
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
                    {pendingPkgs.has('*') ? (
                      <Loader2 size={13} className="mr-1 animate-spin" />
                    ) : (
                      <RefreshCw size={13} className="mr-1" />
                    )}
                    {t('environments.update_all')}
                  </Button>
                </TooltipTrigger>
                <TooltipContent className="text-xs">{t('environments.update_all_hint')}</TooltipContent>
              </Tooltip>
            )}
            {/* Build is always shown so its role is discoverable. It's only
                actionable when the declared lockfile is ahead of the built
                venv/library (draft/error) — up-to-date (ready) it's disabled. The
                tooltip explains why. */}
            {canWrite && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span>
                    <Button
                      size="sm"
                      variant={needsBuild ? 'default' : 'outline'}
                      className="h-7 px-2"
                      disabled={busy || !needsBuild || env?.status === 'building'}
                      onClick={() => void onBuild()}
                    >
                      {env?.status === 'building' ? (
                        <Loader2 size={13} className="mr-1 animate-spin" />
                      ) : (
                        <Hammer size={13} className="mr-1" />
                      )}
                      {t('environments.build')}
                    </Button>
                  </span>
                </TooltipTrigger>
                <TooltipContent side="bottom" className="max-w-xs text-xs">
                  {t(`environments.build_help_${buildState}`)}
                </TooltipContent>
              </Tooltip>
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
              {adding ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
            </Button>
          </div>
        )}

        {canWrite && drift.length > 0 && (
          <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 px-2.5 py-2 text-xs">
            <PackageCheck size={14} className="mt-0.5 shrink-0 text-amber-500" />
            <div className="min-w-0 flex-1">
              <p className="text-muted-foreground">
                {t('environments.drift_hint', { count: drift.length })}
              </p>
              <p className="mt-0.5 truncate font-medium" title={drift.join(', ')}>{drift.join(', ')}</p>
            </div>
            <Button size="xs" variant="outline" className="shrink-0" disabled={busy} onClick={() => void onCapture()}>
              {t('environments.capture')}
            </Button>
          </div>
        )}

        {error && (
          <div className="flex items-start gap-1.5 text-xs text-destructive">
            <span className="min-w-0 flex-1 break-words">{summarizeInstallError(error)}</span>
            {/* Popover (not Tooltip): the full error can be long and must be
                scrollable with the trackpad — a hover tooltip closes on wheel. */}
            <Popover>
              <PopoverTrigger asChild>
                <button className="mt-0.5 shrink-0 text-destructive/70 hover:text-destructive" aria-label={t('environments.error_details')}>
                  <Info size={13} />
                </button>
              </PopoverTrigger>
              <PopoverContent side="left" align="start" className="max-h-80 w-[28rem] max-w-[90vw] overflow-auto whitespace-pre-wrap break-words p-3 font-mono text-[11px] leading-relaxed">
                {fullInstallError(error)}
              </PopoverContent>
            </Popover>
          </div>
        )}

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
              {packages.map((pkg) => {
                const pending = isPkgPending(pkg.name)
                return (
                <li key={pkg.name} className="group flex items-center justify-between rounded text-xs hover:bg-muted/50">
                  {/* Whole row (name + version + external-link icon) is one link. */}
                  <a
                    href={packageUrl(pkg.name)}
                    target="_blank"
                    rel="noreferrer"
                    className="flex flex-1 items-center gap-1.5 px-2 py-1"
                  >
                    <span className="font-medium">{pkg.name}</span>
                    {pkg.spec && <span className="text-muted-foreground">{pkg.spec}</span>}
                    <ExternalLink size={10} className="text-muted-foreground/50" />
                  </a>
                  {canWrite && (
                    // While this row's op is in flight the actions stay visible even
                    // if the pointer leaves the row (a spinner replaces the update icon).
                    <div className={cn(
                      'flex items-center gap-0.5 pr-1.5 transition-opacity',
                      pending ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
                    )}>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <button
                            className="text-muted-foreground hover:text-foreground disabled:opacity-40"
                            disabled={busy}
                            onClick={() => void onUpgrade(pkg.name)}
                            aria-label={t('environments.update')}
                          >
                            {pending ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
                          </button>
                        </TooltipTrigger>
                        <TooltipContent className="text-xs">{t('environments.update')}</TooltipContent>
                      </Tooltip>
                      <button
                        className="text-muted-foreground hover:text-destructive disabled:opacity-40"
                        disabled={busy}
                        onClick={() => setRemoveTarget(pkg.name)}
                        aria-label={t('environments.remove')}
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  )}
                </li>
                )
              })}
            </ul>
          )}
        </ScrollArea>

        <p className="text-[11px] text-muted-foreground">{t('environments.build_hint')}</p>
      </div>

      <AlertDialog open={!!removeTarget} onOpenChange={(open) => { if (!open) setRemoveTarget(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('environments.remove_confirm_title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('environments.remove_confirm_body')}{' '}
              <span className="font-semibold text-foreground">{removeTarget}</span>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const pkg = removeTarget
                setRemoveTarget(null)
                if (pkg) void onRemove(pkg)
              }}
              className="bg-destructive text-white hover:bg-destructive/90"
            >
              {t('environments.remove')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </TooltipProvider>
  )
}
