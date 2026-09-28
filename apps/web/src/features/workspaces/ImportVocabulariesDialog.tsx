import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { FolderOpen, HardDrive, Loader2 } from 'lucide-react'
import { DialogShell } from '@/components/ui/dialog-shell'
import { FileDropZone } from '@/components/ui/file-drop-zone'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import { DataTable, type DataTableColumn } from '@/components/ui/data-table'
import { Progress } from '@/components/ui/progress'
import { ServerPathPickerDialog } from '@/components/ui/server-path-picker-dialog'
import { isServerMode } from '@/lib/api-client'
import { isVocabFile } from '@/lib/concept-mapping/vocab-files'
import {
  discardPreparedImport,
  prepareImport,
  runImport,
  type ExportSource,
  type ImportProgress,
  type PreparedImport,
} from '@/lib/vocabulary-library/library'
import { defaultSelection, importStatus, type InspectedVocabulary } from '@/lib/vocabulary-library/types'

interface ImportVocabulariesDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  workspaceId: string
  /** Start from this source (an older per-project vocabulary database) instead
   *  of asking for one. */
  initialSource?: ExportSource
  onImported: () => void
}

const STATUS_VARIANT = { new: 'default', other: 'secondary', same: 'outline' } as const

/**
 * Import an ATHENA export into the workspace vocabulary library: pick the export,
 * see per vocabulary whether it is new, already held at this version, or held at
 * another one, tick what to bring in.
 */
export function ImportVocabulariesDialog({ open, onOpenChange, workspaceId, initialSource, onImported }: ImportVocabulariesDialogProps) {
  const { t } = useTranslation()
  const folderInput = useRef<HTMLInputElement>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [prepared, setPrepared] = useState<PreparedImport | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [phase, setPhase] = useState<'source' | 'inspecting' | 'preview' | 'importing'>('source')
  const [upload, setUpload] = useState<{ done: number; total: number } | null>(null)
  const [progress, setProgress] = useState<ImportProgress | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Bumped on close: a prepare still running then holds a hidden import database
  // nobody else will discard.
  const inspection = useRef(0)

  useEffect(() => () => { inspection.current++ }, [])

  const inspect = async (source: ExportSource) => {
    const token = ++inspection.current
    setPhase('inspecting')
    setError(null)
    try {
      const next = await prepareImport(workspaceId, source, (done, total) => setUpload({ done, total }))
      if (token !== inspection.current) {
        void discardPreparedImport(next)
        return
      }
      setPrepared(next)
      setSelected(defaultSelection(next.inspected.vocabularies))
      setPhase('preview')
    } catch (err) {
      if (token !== inspection.current) return
      setError(err instanceof Error ? err.message : String(err))
      setPhase('source')
    } finally {
      setUpload(null)
    }
  }

  useEffect(() => {
    if (!open) {
      inspection.current++
      return
    }
    setPrepared(null)
    setSelected(new Set())
    setError(null)
    setProgress(null)
    setPhase('source')
    if (initialSource) void inspect(initialSource)
    // Runs once per opening; `inspect` is recreated every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialSource])

  const close = (next: boolean) => {
    if (next || phase === 'importing') return
    inspection.current++
    if (prepared) void discardPreparedImport(prepared)
    onOpenChange(false)
  }

  const handleImport = async () => {
    if (!prepared || selected.size === 0) return
    setPhase('importing')
    setError(null)
    try {
      await runImport(prepared, [...selected], setProgress)
      onImported()
      onOpenChange(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setPhase('preview')
    }
  }

  const toggle = (id: string) => setSelected((prev) => {
    const next = new Set(prev)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  })

  const columns = useMemo<DataTableColumn<InspectedVocabulary>[]>(() => [
    {
      id: 'pick',
      header: '',
      size: 36,
      sortable: false,
      accessor: (v) => (selected.has(v.vocabularyId) ? 1 : 0),
      cell: (v) => <Checkbox checked={selected.has(v.vocabularyId)} onCheckedChange={() => toggle(v.vocabularyId)} />,
    },
    { id: 'id', header: t('vocabulary_library.col_vocabulary'), accessor: (v) => v.vocabularyId, filter: 'text', size: 160 },
    { id: 'version', header: t('vocabulary_library.col_export_version'), accessor: (v) => v.vocabularyVersion ?? '', size: 220 },
    { id: 'library', header: t('vocabulary_library.col_library_version'), accessor: (v) => v.libraryVersion ?? '', size: 220 },
    {
      id: 'status',
      header: t('vocabulary_library.col_status'),
      accessor: (v) => importStatus(v),
      filter: 'select',
      selectOptionLabel: (s) => t(`vocabulary_library.status_${s}`),
      cell: (v) => <Badge variant={STATUS_VARIANT[importStatus(v)]}>{t(`vocabulary_library.status_${importStatus(v)}`)}</Badge>,
      size: 130,
    },
    { id: 'concepts', header: t('vocabulary_library.col_concepts'), accessor: (v) => v.conceptCount, cell: (v) => v.conceptCount.toLocaleString(), size: 110 },
  ], [selected, t])

  const vocabularies = prepared?.inspected.vocabularies ?? []

  return (
    <>
      <DialogShell
        open={open}
        onOpenChange={close}
        kind={phase === 'preview' || phase === 'importing' ? 'workbench' : 'form'}
        title={t('vocabulary_library.import_title')}
        description={
          prepared?.inspected.release
            ? t('vocabulary_library.import_release', { release: prepared.inspected.release, source: prepared.sourceLabel })
            : t('vocabulary_library.import_description')
        }
        onConfirm={phase === 'preview' || phase === 'importing' ? handleImport : undefined}
        confirmLabel={t('vocabulary_library.import_confirm', { count: selected.size })}
        confirmDisabled={selected.size === 0}
        busy={phase === 'importing'}
        footerExtra={phase === 'preview' ? (
          <div className="flex gap-3 text-xs text-muted-foreground">
            <button type="button" className="hover:text-foreground" onClick={() => setSelected(new Set(vocabularies.map((v) => v.vocabularyId)))}>
              {t('common.select_all')}
            </button>
            <button type="button" className="hover:text-foreground" onClick={() => setSelected(defaultSelection(vocabularies))}>
              {t('vocabulary_library.select_changed')}
            </button>
          </div>
        ) : undefined}
      >
        {phase === 'source' && (
          <div className="space-y-3">
            <div className={`grid gap-3 ${isServerMode() ? 'grid-cols-2' : 'grid-cols-1'}`}>
              <FileDropZone
                icon={<FolderOpen size={20} />}
                label={t('vocabulary_library.pick_folder')}
                hint={t('vocabulary_library.pick_folder_hint')}
                onClick={() => folderInput.current?.click()}
              />
              {isServerMode() && (
                <FileDropZone
                  icon={<HardDrive size={20} />}
                  label={t('vocabulary_library.pick_server_folder')}
                  hint={t('vocabulary_library.pick_server_folder_hint')}
                  onClick={() => setPickerOpen(true)}
                />
              )}
            </div>
            <input
              ref={folderInput}
              type="file"
              className="hidden"
              // @ts-expect-error — non-standard attribute, supported by every engine we target
              webkitdirectory=""
              multiple
              onChange={(e) => {
                const files = [...(e.target.files ?? [])].filter((f) => isVocabFile(f.name))
                e.target.value = ''
                if (files.length > 0) void inspect({ kind: 'files', files })
                else setError(t('vocabulary_library.no_vocabulary_files'))
              }}
            />
          </div>
        )}

        {phase === 'inspecting' && (
          <div className="space-y-2 py-6 text-center text-xs text-muted-foreground">
            <Loader2 size={14} className="mx-auto animate-spin" />
            <p>{upload ? t('vocabulary_library.uploading', { done: upload.done, total: upload.total }) : t('vocabulary_library.inspecting')}</p>
            {upload && <Progress value={(upload.done / upload.total) * 100} className="mx-auto h-1.5 max-w-xs" />}
          </div>
        )}

        {(phase === 'preview' || phase === 'importing') && (
          <div className="flex min-h-0 flex-1 flex-col gap-3">
            {phase === 'importing' && (
              <div className="space-y-1.5">
                <p className="text-xs text-muted-foreground">
                  {progress?.step ? t('vocabulary_library.importing_step', { table: progress.step }) : t('vocabulary_library.importing')}
                </p>
                <Progress value={progress && progress.total ? (progress.done / progress.total) * 100 : 5} className="h-1.5" />
              </div>
            )}
            <DataTable
              data={vocabularies}
              columns={columns}
              rowKey={(v) => v.vocabularyId}
              pageSize={100}
              initialSorting={{ columnId: 'id', desc: false }}
              viewKey="vocabulary-import-preview"
            />
          </div>
        )}

        {error && <p className="text-xs text-destructive">{error}</p>}
      </DialogShell>

      {isServerMode() && (
        <ServerPathPickerDialog
          open={pickerOpen}
          mode="folder"
          scope={{ kind: 'workspace', workspaceId }}
          onClose={() => setPickerOpen(false)}
          onPick={(path) => {
            setPickerOpen(false)
            void inspect({ kind: 'serverPath', path })
          }}
        />
      )}
    </>
  )
}
