import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2, Save, Sparkles } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
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
  const [saving, setSaving] = useState(false)

  const onSave = async () => {
    setSaving(true)
    try {
      await updateWorkspace(workspace.id, {
        defaultEnvPackages: { python: toList(python), r: toList(r) },
      })
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
      <div className="flex justify-end">
        <Button onClick={() => void onSave()} disabled={saving}>
          {saving ? <Loader2 size={14} className="mr-1.5 animate-spin" /> : <Save size={14} className="mr-1.5" />}
          {t('common.save')}
        </Button>
      </div>
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
