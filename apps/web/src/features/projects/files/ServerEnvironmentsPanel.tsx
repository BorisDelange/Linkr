import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Plus, Loader2, Trash2, Hammer, ExternalLink } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useAppStore } from '@/stores/app-store'
import { useMyProjectRole } from '@/hooks/use-context-role'
import {
  listEnvironments,
  listEnvPackages,
  addEnvPackages,
  removeEnvPackage,
  buildEnvironment,
  type ProjectEnvironment,
  type EnvPackage,
} from '@/lib/api/environments'

/**
 * Server-mode environment manager for the active project. Python packages are
 * declarative: add/remove edits the manifest and re-locks; a separate, explicit
 * Build materialises the venv (never automatic). R lands in a later step and is
 * shown read-only here.
 */
export function ServerEnvironmentsPanel() {
  const { t } = useTranslation()
  const projectUid = useAppStore((s) => s.activeProjectUid)
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
      setEnv(envs.find((e) => e.language === 'python') ?? null)
      setPackages(await listEnvPackages(projectUid, 'python'))
    } finally {
      setLoading(false)
    }
  }, [projectUid])

  useEffect(() => {
    void load()
  }, [load])

  const run = async (fn: () => Promise<ProjectEnvironment>) => {
    if (!projectUid) return
    setBusy(true)
    setError(null)
    try {
      setEnv(await fn())
      setPackages(await listEnvPackages(projectUid, 'python'))
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
    await run(() => addEnvPackages(projectUid!, 'python', [name]))
  }

  if (!projectUid) {
    return (
      <p className="py-8 text-center text-xs text-muted-foreground">
        {t('environments.open_project_first')}
      </p>
    )
  }

  const statusVariant =
    env?.status === 'ready' ? 'secondary' : env?.status === 'error' ? 'destructive' : 'outline'
  const needsBuild = env?.status === 'draft' || env?.status === 'error'

  return (
    <div className="mt-2 flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm font-medium">
          Python
          {env && (
            <Badge variant={statusVariant} className="text-[10px]">
              {t(`environments.status.${env.status}`)}
            </Badge>
          )}
        </div>
        <Button
          size="sm"
          variant={needsBuild ? 'default' : 'outline'}
          disabled={!canWrite || busy || env?.status === 'building'}
          onClick={() => run(() => buildEnvironment(projectUid, 'python'))}
        >
          {env?.status === 'building' ? (
            <Loader2 size={13} className="mr-1 animate-spin" />
          ) : (
            <Hammer size={13} className="mr-1" />
          )}
          {t('environments.build')}
        </Button>
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
          <p className="py-6 text-center text-xs text-muted-foreground">
            {t('environments.no_packages')}
          </p>
        ) : (
          <ul className="flex flex-col gap-1">
            {packages.map((pkg) => (
              <li
                key={pkg.name}
                className="flex items-center justify-between rounded px-2 py-1 text-xs hover:bg-muted/50"
              >
                <span className="flex items-center gap-1.5">
                  <a
                    href={`https://pypi.org/project/${encodeURIComponent(pkg.name)}`}
                    target="_blank"
                    rel="noreferrer"
                    className="font-medium hover:underline"
                  >
                    {pkg.name}
                  </a>
                  {pkg.spec && <span className="text-muted-foreground">{pkg.spec}</span>}
                  <ExternalLink size={10} className="text-muted-foreground/50" />
                </span>
                {canWrite && (
                  <button
                    className="text-muted-foreground hover:text-destructive disabled:opacity-40"
                    disabled={busy}
                    onClick={() => run(() => removeEnvPackage(projectUid, 'python', pkg.name))}
                    aria-label={t('environments.remove')}
                  >
                    <Trash2 size={13} />
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </ScrollArea>

      <p className="text-[11px] text-muted-foreground">{t('environments.build_hint')}</p>
    </div>
  )
}
