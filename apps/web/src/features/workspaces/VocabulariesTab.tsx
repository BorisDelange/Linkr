import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, BookOpen, Download, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { DataTable, type DataTableColumn } from '@/components/ui/data-table'
import { EmptyState } from '@/components/ui/empty-state'
import { FieldInfo } from '@/components/ui/field-info'
import { SectionLabel } from '@/components/ui/section-label'
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
import { isServerMode } from '@/lib/api-client'
import { humanBytes } from '@/lib/format-helpers'
import { localized } from '@/lib/localized'
import {
  legacyVocabularyDatabases,
  loadLibraryVocabularies,
  removeVocabulary,
  type ExportSource,
} from '@/lib/vocabulary-library/library'
import { libraryReleases, type LibraryVocabulary } from '@/lib/vocabulary-library/types'
import { useAppStore } from '@/stores/app-store'
import { useConceptMappingStore } from '@/stores/concept-mapping-store'
import { useDataSourceStore } from '@/stores/data-source-store'
import type { DataSource } from '@/types'
import { ImportVocabulariesDialog } from './ImportVocabulariesDialog'

interface VocabulariesTabProps {
  workspaceId: string
  canWrite: boolean
}

/**
 * The workspace's OHDSI vocabulary library: every mapping project, concept set
 * and ETL of the workspace reads its concepts from here. One version of each
 * vocabulary at a time; an ATHENA import replaces the vocabularies ticked.
 */
export function VocabulariesTab({ workspaceId, canWrite }: VocabulariesTabProps) {
  const { t } = useTranslation()
  const language = useAppStore((s) => s.language)
  const dataSources = useDataSourceStore((s) => s.dataSources)
  const removeDataSource = useDataSourceStore((s) => s.removeDataSource)
  const mappingProjects = useConceptMappingStore((s) => s.mappingProjects)
  const [vocabularies, setVocabularies] = useState<LibraryVocabulary[] | null>(null)
  const [importOpen, setImportOpen] = useState(false)
  const [importSource, setImportSource] = useState<ExportSource | undefined>()
  const [toRemove, setToRemove] = useState<LibraryVocabulary | null>(null)
  const [legacyToDelete, setLegacyToDelete] = useState<DataSource | null>(null)
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(() => {
    loadLibraryVocabularies(workspaceId)
      .then(setVocabularies)
      .catch((err) => { setError(err instanceof Error ? err.message : String(err)); setVocabularies([]) })
  }, [workspaceId])

  // Front-only the inventory lives on the library data source: re-read it
  // whenever the store's sources change.
  useEffect(() => { reload() }, [reload, dataSources])

  const legacy = useMemo(() => legacyVocabularyDatabases(dataSources, workspaceId), [dataSources, workspaceId])
  const releases = libraryReleases(vocabularies ?? [])

  const openImport = (source?: ExportSource) => {
    setImportSource(source)
    setImportOpen(true)
  }

  const columns = useMemo<DataTableColumn<LibraryVocabulary>[]>(() => [
    {
      id: 'id',
      header: t('vocabulary_library.col_vocabulary'),
      accessor: (v) => v.vocabularyId,
      filter: 'text',
      size: 150,
      cell: (v) => <span className="font-mono">{v.vocabularyId}</span>,
    },
    { id: 'name', header: t('vocabulary_library.col_name'), accessor: (v) => v.vocabularyName ?? '', filter: 'text', size: 260 },
    { id: 'version', header: t('vocabulary_library.col_version'), accessor: (v) => v.vocabularyVersion ?? '', size: 240 },
    { id: 'release', header: t('vocabulary_library.col_release'), accessor: (v) => v.release ?? '', filter: 'select', size: 140 },
    { id: 'concepts', header: t('vocabulary_library.col_concepts'), accessor: (v) => v.conceptCount, cell: (v) => v.conceptCount.toLocaleString(), size: 110 },
    ...(isServerMode()
      ? [{ id: 'size', header: t('vocabulary_library.col_size'), accessor: (v: LibraryVocabulary) => v.sizeBytes ?? 0, cell: (v: LibraryVocabulary) => humanBytes(v.sizeBytes ?? 0), size: 90 }]
      : []),
    { id: 'imported', header: t('vocabulary_library.col_imported'), accessor: (v) => v.importedAt, cell: (v) => new Date(v.importedAt).toLocaleDateString(language), size: 110 },
    {
      id: 'actions',
      header: '',
      sortable: false,
      size: 44,
      accessor: () => '',
      cell: (v) => canWrite ? (
        <Button variant="ghost" size="icon-xs" className="text-muted-foreground hover:text-destructive" aria-label={t('vocabulary_library.remove')} onClick={() => setToRemove(v)}>
          <Trash2 size={12} />
        </Button>
      ) : null,
    },
  ], [t, language, canWrite])

  const projectsUsing = (ds: DataSource) => mappingProjects.filter((p) => p.vocabularyDataSourceId === ds.id).length

  return (
    <div className="mx-auto max-w-5xl space-y-4 pt-2">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-1.5">
          <h2 className="text-sm font-semibold">{t('vocabulary_library.title')}</h2>
          <FieldInfo text={t('vocabulary_library.description')} />
        </div>
        {canWrite && (
          <Button size="sm" onClick={() => openImport()}>
            <Download size={14} />
            {t('vocabulary_library.import')}
          </Button>
        )}
      </div>

      {releases.length > 1 && (
        <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          <span>{t('vocabulary_library.mixed_releases', { releases: releases.join(', ') })}</span>
        </div>
      )}

      {vocabularies === null ? null : vocabularies.length === 0 ? (
        <Card>
          <EmptyState icon={BookOpen} title={t('vocabulary_library.empty_title')} description={t('vocabulary_library.empty_description')} />
        </Card>
      ) : (
        <DataTable
          data={vocabularies}
          columns={columns}
          rowKey={(v) => v.vocabularyId}
          pageSize={15}
          initialSorting={{ columnId: 'id', desc: false }}
        />
      )}

      {legacy.length > 0 && (
        <div className="space-y-2 pt-2">
          <SectionLabel as="h3">{t('vocabulary_library.legacy_title')}</SectionLabel>
          <p className="text-xs text-muted-foreground">{t('vocabulary_library.legacy_description')}</p>
          {legacy.map((ds) => (
            <Card key={ds.id} className="flex flex-row items-center gap-3 px-3 py-2.5">
              <span className="min-w-0 flex-1 truncate text-sm">{localized(ds.name, language)}</span>
              <span className="shrink-0 text-xs text-muted-foreground">
                {t('vocabulary_library.legacy_used_by', { count: projectsUsing(ds) })}
              </span>
              {canWrite && (
                <>
                  <Button size="sm-tight" variant="outline" onClick={() => openImport({ kind: 'database', dataSourceId: ds.id })}>
                    {t('vocabulary_library.legacy_add')}
                  </Button>
                  {isServerMode() && (
                    <Button variant="ghost" size="icon-sm" className="text-destructive hover:text-destructive" aria-label={t('common.delete')} onClick={() => setLegacyToDelete(ds)}>
                      <Trash2 size={14} />
                    </Button>
                  )}
                </>
              )}
            </Card>
          ))}
        </div>
      )}

      {error && <p className="text-xs text-destructive">{error}</p>}

      <ImportVocabulariesDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        workspaceId={workspaceId}
        initialSource={importSource}
        onImported={reload}
      />

      <AlertDialog open={toRemove !== null} onOpenChange={(open) => { if (!open) setToRemove(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('vocabulary_library.remove_title', { vocabulary: toRemove?.vocabularyId ?? '' })}</AlertDialogTitle>
            <AlertDialogDescription>{t('vocabulary_library.remove_description')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={() => {
                const v = toRemove
                setToRemove(null)
                if (v) removeVocabulary(workspaceId, v.vocabularyId).then(reload).catch((err) => setError(String(err)))
              }}
            >
              {t('vocabulary_library.remove')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={legacyToDelete !== null} onOpenChange={(open) => { if (!open) setLegacyToDelete(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('vocabulary_library.legacy_delete_title')}</AlertDialogTitle>
            <AlertDialogDescription>{t('vocabulary_library.legacy_delete_description')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={() => {
                const ds = legacyToDelete
                setLegacyToDelete(null)
                if (ds) removeDataSource(ds.id, { deleteData: true }).catch((err) => setError(String(err)))
              }}
            >
              {t('common.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
