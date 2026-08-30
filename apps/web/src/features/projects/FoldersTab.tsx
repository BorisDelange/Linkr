import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { FolderCog, FolderInput, Loader2 } from 'lucide-react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { FormField } from '@/components/ui/form-field'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useAppStore } from '@/stores/app-store'
import { useResolvedDirs } from '@/hooks/use-resolved-dirs'
import { fsValidateDir, fsRebindCopy, type FsConflictStrategy, type FsValidation } from '@/lib/api/fs-browser'
import { formatApiError } from '@/lib/api-client'
import { ServerFolderPickerDialog } from './files/ServerFolderPickerDialog'

interface Props {
  projectUid: string
  /** From useMyProjectRole: can('project-settings:write'). */
  canEdit: boolean
}

type Which = 'idePath' | 'scriptsPath' | 'datasetsPath'

const ROW_LABEL: Record<Which, { label: string; desc: string; def: string }> = {
  idePath: { label: 'project_folders.ide_folder', desc: 'project_folders.ide_folder_desc', def: 'project_folders.default_ide' },
  scriptsPath: { label: 'project_folders.scripts_folder', desc: 'project_folders.scripts_folder_desc', def: 'project_folders.default_scripts' },
  datasetsPath: { label: 'project_folders.datasets_folder', desc: 'project_folders.datasets_folder_desc', def: 'project_folders.default_datasets' },
}

/** Pending rebind awaiting the optional "copy old folder → new folder" step. */
interface PendingRebind {
  which: Which
  oldPath: string
  newPath: string
}

function validationMessage(t: (k: string) => string, v: FsValidation): string {
  switch (v.reason) {
    case 'not_found': return t('project_folders.err_not_found')
    case 'not_a_dir': return t('project_folders.err_not_a_dir')
    case 'not_writable': return t('project_folders.err_not_writable')
    case 'outside_roots': return t('project_folders.err_outside_roots')
    default: return t('project_folders.err_invalid')
  }
}

export function FoldersTab({ projectUid, canEdit }: Props) {
  const { t } = useTranslation()
  const _projectRaw = useAppStore((s) => s._projectsRaw.find((p) => p.uid === projectUid))
  const updateProjectPaths = useAppStore((s) => s.updateProjectPaths)
  const resolved = useResolvedDirs(projectUid, `${_projectRaw?.idePath ?? ''}|${_projectRaw?.scriptsPath ?? ''}|${_projectRaw?.datasetsPath ?? ''}`)
  const defaultFor = (w: Which) =>
    resolved?.defaults[w === 'idePath' ? 'ide' : w === 'scriptsPath' ? 'scripts' : 'datasets']

  const idePath = _projectRaw?.idePath
  const scriptsPath = _projectRaw?.scriptsPath
  const datasetsPath = _projectRaw?.datasetsPath
  const currentOf = (w: Which) => (w === 'idePath' ? idePath : w === 'scriptsPath' ? scriptsPath : datasetsPath)

  const [pickerFor, setPickerFor] = useState<Which | null>(null)
  const [saving, setSaving] = useState<Which | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState<PendingRebind | null>(null)
  const [conflict, setConflict] = useState<FsConflictStrategy>('keep_both')
  const [copying, setCopying] = useState(false)

  const applyBinding = async (which: Which, newPath: string) => {
    setSaving(which)
    setError(null)
    try {
      const v = await fsValidateDir(projectUid, newPath)
      if (!v.ok) {
        setError(validationMessage(t, v))
        return
      }
      const oldPath = currentOf(which)
      await updateProjectPaths(projectUid, { [which]: v.path })
      // Offer to carry the previous folder's files over (only when re-pointing
      // an already-set binding to a different folder).
      if (oldPath && oldPath !== v.path) {
        setPending({ which, oldPath, newPath: v.path as string })
      }
    } catch (e) {
      const fe = formatApiError(e)
      setError(fe.summary ?? fe.detail ?? String(e))
    } finally {
      setSaving(null)
    }
  }

  const runCopy = async () => {
    if (!pending) return
    setCopying(true)
    setError(null)
    try {
      await fsRebindCopy(projectUid, pending.oldPath, pending.newPath, conflict)
      setPending(null)
    } catch (e) {
      const fe = formatApiError(e)
      setError(fe.summary ?? fe.detail ?? String(e))
    } finally {
      setCopying(false)
    }
  }

  const row = (which: Which) => {
    const meta = ROW_LABEL[which]
    const current = currentOf(which)
    const defaultHint = t(meta.def)
    return (
    <FormField label={t(meta.label)} hint={t(meta.desc)}>
      {() => (
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1 truncate rounded-md border bg-muted/40 px-3 py-2 text-xs font-mono" title={current || defaultHint}>
          {current || <span className="text-muted-foreground">{defaultHint}</span>}
        </div>
        {canEdit && (
          <Button
            variant="outline"
            size="sm"
            disabled={saving === which}
            onClick={() => setPickerFor(which)}
          >
            {saving === which ? <Loader2 size={14} className="animate-spin" /> : <FolderCog size={14} />}
            {t('project_folders.change')}
          </Button>
        )}
      </div>
      )}
    </FormField>
    )
  }

  return (
    <div className="mx-auto max-w-2xl space-y-4 pt-2">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm">
            <FolderInput size={15} />
            {t('project_folders.title')}
          </CardTitle>
          <CardDescription>{t('project_folders.description')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          {row('idePath')}
          {row('scriptsPath')}
          {row('datasetsPath')}
          {error && <p className="text-xs text-destructive">{error}</p>}
        </CardContent>
      </Card>

      {pickerFor && (
        <ServerFolderPickerDialog
          projectUid={projectUid}
          open
          initialPath={currentOf(pickerFor)}
          defaultPath={defaultFor(pickerFor)}
          onClose={() => setPickerFor(null)}
          onPick={(path) => {
            const which = pickerFor
            setPickerFor(null)
            void applyBinding(which, path)
          }}
        />
      )}

      {/* Optional copy after a rebind */}
      <Dialog open={pending != null} onOpenChange={(o) => !o && setPending(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('project_folders.copy_title')}</DialogTitle>
            <DialogDescription>{t('project_folders.copy_description')}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3 text-xs">
            <div className="min-w-0 rounded-md border bg-muted/40 px-3 py-2 font-mono">
              <div className="text-muted-foreground">{t('project_folders.copy_from')}</div>
              <div className="break-all">{pending?.oldPath}</div>
              <div className="mt-1 text-muted-foreground">{t('project_folders.copy_to')}</div>
              <div className="break-all">{pending?.newPath}</div>
            </div>
            <FormField label={t('project_folders.on_conflict')}>
              {() => (
                <Select value={conflict} onValueChange={(v) => setConflict(v as FsConflictStrategy)}>
                  <SelectTrigger className="h-8 text-xs [&>span]:truncate"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="keep_both">{t('project_folders.conflict_keep_both')}</SelectItem>
                    <SelectItem value="ignore">{t('project_folders.conflict_ignore')}</SelectItem>
                    <SelectItem value="overwrite">{t('project_folders.conflict_overwrite')}</SelectItem>
                  </SelectContent>
                </Select>
              )}
            </FormField>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPending(null)} disabled={copying}>
              {t('project_folders.copy_skip')}
            </Button>
            <Button onClick={runCopy} disabled={copying}>
              {copying ? <Loader2 size={14} className="animate-spin" /> : <FolderInput size={14} />}
              {t('project_folders.copy_do')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
