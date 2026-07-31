import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2, Save } from 'lucide-react'
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
          placeholder={BUILTIN.python.join('\n')}
          hint={t('workspace_env.python_hint')}
        />
        <LangCard
          title="R"
          value={r}
          onChange={setR}
          placeholder={BUILTIN.r.join('\n')}
          hint={t('workspace_env.r_hint')}
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
}: {
  title: string
  value: string
  onChange: (v: string) => void
  placeholder: string
  hint: string
}) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">{title}</CardTitle>
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
