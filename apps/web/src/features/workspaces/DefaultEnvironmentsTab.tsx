import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2, Save, Sparkles, Check } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useWorkspaceStore } from '@/stores/workspace-store'
import type { Workspace } from '@/types'

/** Built-in defaults shown as placeholders when the workspace hasn't set its own.
 *  Kept in sync with the backend DEFAULT_PACKAGES (environments.py). */
const BUILTIN = {
  python: ['pandas', 'numpy', 'matplotlib', 'plotly', 'scikit-learn', 'duckdb'],
  r: ['dplyr', 'ggplot2', 'tidyr', 'readr', 'data.table'],
}

// Placeholders show the two forms side by side: a bare name (latest) and a
// version-pinned one — so users see how to choose a version.
const PLACEHOLDER = {
  python: 'pandas\nnumpy==1.26.4\nplotly>=5.20\nscikit-learn',
  r: 'dplyr\nggplot2==3.5.1\ntidyr\ndata.table',
}

const toText = (list?: string[]) => (list ?? []).join('\n')
const toList = (text: string) =>
  text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)

/**
 * Workspace Settings → Default environments. Edits the package lists (one per
 * line) a new project in this workspace starts from. Empty = built-in defaults.
 */
export function DefaultEnvironmentsTab({ workspace }: { workspace: Workspace }) {
  const { t } = useTranslation()
  const updateWorkspace = useWorkspaceStore((s) => s.updateWorkspace)
  const [python, setPython] = useState(toText(workspace.defaultEnvPackages?.python))
  const [r, setR] = useState(toText(workspace.defaultEnvPackages?.r))
  const opts = workspace.defaultEnvOptions
  const [pyIndexUrl, setPyIndexUrl] = useState(opts?.python?.indexUrl ?? '')
  const [pyTrustedHost, setPyTrustedHost] = useState(opts?.python?.trustedHost ?? '')
  const [rRepos, setRRepos] = useState(opts?.r?.repos ?? '')
  const [rMethod, setRMethod] = useState(opts?.r?.method ?? '')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => () => { if (savedTimer.current) clearTimeout(savedTimer.current) }, [])

  const onSave = async () => {
    setSaving(true)
    try {
      // Only keep options with a value, so the stored blob stays clean.
      const trim = (v: string) => v.trim()
      const pruned = <T extends Record<string, string>>(o: T) =>
        Object.fromEntries(Object.entries(o).filter(([, v]) => v)) as Partial<T>
      await updateWorkspace(workspace.id, {
        defaultEnvPackages: { python: toList(python), r: toList(r) },
        defaultEnvOptions: {
          python: pruned({ indexUrl: trim(pyIndexUrl), trustedHost: trim(pyTrustedHost) }),
          r: pruned({ repos: trim(rRepos), method: trim(rMethod) }),
        },
      })
      // Briefly flip the button to a "Saved ✓" confirmation, then back to "Save".
      setSaved(true)
      if (savedTimer.current) clearTimeout(savedTimer.current)
      savedTimer.current = setTimeout(() => setSaved(false), 2000)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="mx-auto max-w-2xl space-y-4 py-2">
      <p className="text-sm text-muted-foreground">{t('workspace_env.description')}</p>
      <div className="grid gap-4 sm:grid-cols-2">
        <LangCard
          title="Python"
          value={python}
          onChange={setPython}
          placeholder={PLACEHOLDER.python}
          hint={t('workspace_env.python_hint')}
          onLoadDefaults={() => setPython(BUILTIN.python.join('\n'))}
          loadLabel={t('workspace_env.load_defaults')}
        />
        <LangCard
          title="R"
          value={r}
          onChange={setR}
          placeholder={PLACEHOLDER.r}
          hint={t('workspace_env.r_hint')}
          onLoadDefaults={() => setR(BUILTIN.r.join('\n'))}
          loadLabel={t('workspace_env.load_defaults')}
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">{t('workspace_env.python_options')}</CardTitle>
            <CardDescription className="text-xs">{t('workspace_env.options_hint')}</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            <OptField label={t('environments.opt_index_url')} value={pyIndexUrl} onChange={setPyIndexUrl} placeholder="https://pypi.org/simple" />
            <OptField label={t('environments.opt_trusted_host')} value={pyTrustedHost} onChange={setPyTrustedHost} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">{t('workspace_env.r_options')}</CardTitle>
            <CardDescription className="text-xs">{t('workspace_env.options_hint')}</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            <OptField label={t('environments.opt_repos')} value={rRepos} onChange={setRRepos} placeholder="https://packagemanager.posit.co/cran/latest" />
            <OptField label={t('environments.opt_method')} value={rMethod} onChange={setRMethod} placeholder="auto" />
          </CardContent>
        </Card>
      </div>

      <div className="flex justify-end">
        <Button onClick={() => void onSave()} disabled={saving} variant={saved ? 'outline' : 'default'}>
          {saving ? (
            <Loader2 size={14} className="mr-1.5 animate-spin" />
          ) : saved ? (
            <Check size={14} className="mr-1.5 text-emerald-500" />
          ) : (
            <Save size={14} className="mr-1.5" />
          )}
          {saved ? t('common.saved') : t('common.save')}
        </Button>
      </div>
    </div>
  )
}

function OptField({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
}) {
  return (
    <div className="flex flex-col gap-1">
      <Label className="text-[11px] text-muted-foreground">{label}</Label>
      <Input
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="h-8 text-xs"
      />
    </div>
  )
}

function LangCard({
  title,
  value,
  onChange,
  placeholder,
  hint,
  onLoadDefaults,
  loadLabel,
}: {
  title: string
  value: string
  onChange: (v: string) => void
  placeholder: string
  hint: string
  onLoadDefaults: () => void
  loadLabel: string
}) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-sm">{title}</CardTitle>
          <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={onLoadDefaults}>
            <Sparkles size={12} className="mr-1" />
            {loadLabel}
          </Button>
        </div>
        <CardDescription className="text-xs">{hint}</CardDescription>
      </CardHeader>
      <CardContent>
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          spellCheck={false}
          className="h-48 w-full resize-y rounded-md border bg-background p-2 font-mono text-xs focus:outline-none focus:ring-1 focus:ring-ring"
        />
      </CardContent>
    </Card>
  )
}
