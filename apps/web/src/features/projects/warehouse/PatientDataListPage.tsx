import { useState, useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'
import { Plus, User, MoreHorizontal, Trash2, Pencil, TriangleAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { CardMetaFooter } from '@/components/ui/card-meta-footer'
import { TruncatedText } from '@/components/ui/truncated-text'
import { ListPageToolbar, type SortState } from '@/components/ui/list-page-toolbar'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { RequiredMark } from '@/components/ui/required-mark'
import { GatedButton } from '@/components/ui/gated-button'
import { DialogShell } from '@/components/ui/dialog-shell'
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { cardMenuTriggerClass, cn } from '@/lib/utils'
import { paths } from '@/lib/paths'
import { localized } from '@/lib/localized'
import { applySort, baseSortFields } from '@/lib/list-sort'
import { usePatientChartStore } from '@/stores/patient-chart-store'
import { useAppStore } from '@/stores/app-store'
import { useResolvedParams } from '@/hooks/use-resolved-params'
import { useMyProjectRole } from '@/hooks/use-context-role'
import { PatientBoardEditDialog } from './patient-data/PatientBoardEditDialog'
import type { PatientDashboard } from '@/types'

export function PatientDataListPage() {
  const { t } = useTranslation()
  const language = useAppStore((s) => s.language)
  const navigate = useNavigate()
  const { wsUid, projectUid: resolvedProjectUid } = useResolvedParams()
  const projectUid = resolvedProjectUid ?? ''
  const { atLeast } = useMyProjectRole(projectUid)
  const canEdit = atLeast('editor')
  const canDelete = atLeast('owner')

  const dashboards = usePatientChartStore((s) => s.dashboards)
  const loaded = usePatientChartStore((s) => s.loaded && s.activeProjectUid === projectUid)
  const loadError = usePatientChartStore((s) => s.loadError)
  const loadProjectDashboards = usePatientChartStore((s) => s.loadProjectDashboards)
  const createDashboard = usePatientChartStore((s) => s.createDashboard)
  const removeDashboard = usePatientChartStore((s) => s.removeDashboard)

  const [createOpen, setCreateOpen] = useState(false)
  const [createName, setCreateName] = useState('')
  const [createDescription, setCreateDescription] = useState('')
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null)
  const [editTarget, setEditTarget] = useState<PatientDashboard | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [sort, setSort] = useState<SortState | null>(null)

  useEffect(() => {
    if (projectUid) loadProjectDashboards(projectUid)
  }, [projectUid, loadProjectDashboards])

  const projectBoards = useMemo(
    () =>
      dashboards
        .filter((d) => d.projectUid === projectUid)
        .sort((a, b) => a.displayOrder - b.displayOrder),
    [dashboards, projectUid],
  )

  const filteredBoards = useMemo(() => {
    const words = searchQuery.toLowerCase().split(/\s+/).filter(Boolean)
    const filtered = words.length
      ? projectBoards.filter((d) => {
          const name = localized(d.name, language).toLowerCase()
          return words.every((w) => name.includes(w))
        })
      : projectBoards
    return applySort(filtered, sort, {
      name: (d) => localized(d.name, language),
      createdAt: (d) => d.createdAt,
      updatedAt: (d) => d.updatedAt,
    })
  }, [projectBoards, searchQuery, language, sort])

  // Compared in the ACTIVE language: that is the string the user typed and the
  // one the list shows them, so a clash in another translation isn't a clash here.
  const nameError = useMemo(() => {
    const trimmed = createName.trim().toLowerCase()
    if (!trimmed) return null
    const taken = projectBoards.some(
      (d) => localized(d.name, language).trim().toLowerCase() === trimmed,
    )
    return taken ? t('patient_data.board_name_exists') : null
  }, [createName, projectBoards, language, t])
  const isNameValid = createName.trim().length > 0 && !nameError

  const handleCreate = async () => {
    const name = createName.trim()
    if (!name || nameError) return
    const id = await createDashboard(projectUid, name, createDescription.trim() || undefined)
    setCreateOpen(false)
    setCreateName('')
    setCreateDescription('')
    navigate(paths.patientBoard(wsUid ?? '', projectUid, id))
  }

  const handleDelete = () => {
    if (deleteTarget) {
      removeDashboard(deleteTarget)
      setDeleteTarget(null)
    }
  }

  // An empty list after a failed load reads as "my boards are gone", so say what
  // actually happened instead.
  if (loadError) {
    return (
      <div className="mx-auto max-w-4xl px-6 py-10">
        <h1 className="text-2xl font-bold text-foreground">{t('patient_data.title')}</h1>
        <p className="mt-2 text-sm text-destructive">{t('common.load_failed')}</p>
        <p className="mt-1 text-xs text-muted-foreground">{loadError}</p>
      </div>
    )
  }

  if (!loaded) return null

  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto max-w-4xl px-6 py-10">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold text-foreground">{t('patient_data.title')}</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {t('patient_data.boards_description')}
            </p>
          </div>
          <GatedButton
            allowed={canEdit}
            notAllowedReason={t('common.insufficient_permissions')}
            size="sm"
            className="shrink-0 gap-1 text-xs"
            onClick={() => setCreateOpen(true)}
          >
            <Plus size={14} />
            {t('patient_data.create_board')}
          </GatedButton>
        </div>

        {projectBoards.length > 0 && (
          <ListPageToolbar
            searchQuery={searchQuery}
            onSearchChange={setSearchQuery}
            searchPlaceholder={t('patient_data.search_boards_placeholder')}
            sort={{ options: baseSortFields(t), value: sort, onChange: setSort }}
          />
        )}

        {projectBoards.length === 0 ? (
          <Card className="mt-6">
            <div className="flex flex-col items-center py-12">
              <User size={40} className="text-muted-foreground" />
              <p className="mt-4 text-sm font-medium text-foreground">
                {t('patient_data.no_boards_title')}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {t('patient_data.no_boards_description')}
              </p>
              <GatedButton
                allowed={canEdit}
                notAllowedReason={t('common.insufficient_permissions')}
                onClick={() => setCreateOpen(true)}
                className="mt-4 gap-2"
              >
                <Plus size={16} />
                {t('patient_data.create_board')}
              </GatedButton>
            </div>
          </Card>
        ) : filteredBoards.length === 0 ? (
          <div className="mt-6 flex flex-col items-center py-8">
            <User size={24} className="text-muted-foreground/50" />
            <p className="mt-2 text-sm text-muted-foreground">{t('patient_data.no_board_results')}</p>
          </div>
        ) : (
          <div className="mt-6 grid gap-3 sm:grid-cols-2">
            {filteredBoards.map((board) => {
              const description = board.description ? localized(board.description, language) : ''
              return (
                <Card
                  key={board.id}
                  className="flex min-h-44 cursor-pointer flex-col gap-0 py-0 transition-colors hover:bg-accent"
                  onClick={() => navigate(paths.patientBoard(wsUid ?? '', projectUid, board.id))}
                >
                  <div className="flex flex-1 flex-col px-4 pt-5">
                    <div className="flex flex-1 flex-col justify-center">
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex min-w-0 items-center gap-3">
                          <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-teal-500/10">
                            <User size={20} className="text-teal-500" />
                          </div>
                          <span className="truncate text-sm font-medium text-card-foreground">
                            {localized(board.name, language)}
                          </span>
                        </div>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon-xs"
                              className={cn('-mt-1 shrink-0 self-start', cardMenuTriggerClass)}
                              onClick={(e) => e.stopPropagation()}
                            >
                              <MoreHorizontal size={14} />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
                            <DropdownMenuItem disabled={!canEdit} onClick={() => setEditTarget(board)}>
                              <Pencil size={14} />
                              {t('common.edit')}
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              disabled={!canDelete}
                              variant="destructive"
                              onClick={() => setDeleteTarget(board.id)}
                            >
                              <Trash2 size={14} />
                              {t('common.delete')}
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                      <div className="mt-2 h-4">
                        {description && (
                          <TruncatedText text={description} className="text-xs text-muted-foreground" />
                        )}
                      </div>
                    </div>
                    <CardMetaFooter
                      createdById={board.createdById}
                      createdBy={board.createdBy}
                      createdByDetails={board.createdByDetails}
                      createdAt={board.createdAt}
                      updatedAt={board.updatedAt}
                    />
                  </div>
                </Card>
              )
            })}
          </div>
        )}
      </div>

      {/* Create dialog */}
      <DialogShell
        open={createOpen}
        onOpenChange={setCreateOpen}
        title={t('patient_data.create_board_title')}
        description={t('patient_data.create_board_description')}
        contentClassName="space-y-4 py-2"
        onConfirm={handleCreate}
        confirmLabel={t('patient_data.create_board')}
        confirmDisabled={!isNameValid}
      >
            <div className="space-y-2">
              <Label>{t('common.name')}<RequiredMark /></Label>
              <Input
                value={createName}
                onChange={(e) => setCreateName(e.target.value)}
                placeholder={t('patient_data.board_name_placeholder')}
                className={cn(nameError && 'border-destructive')}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') { e.preventDefault(); handleCreate() }
                }}
                autoFocus
              />
              {nameError && (
                <p className="flex items-center gap-1 text-[10px] text-destructive">
                  <TriangleAlert size={10} />
                  {nameError}
                </p>
              )}
            </div>
            <div className="space-y-2">
              <Label>{t('common.description')}</Label>
              <Textarea
                value={createDescription}
                onChange={(e) => setCreateDescription(e.target.value)}
                rows={3}
                className="resize-none"
              />
            </div>
      </DialogShell>

      {/* Delete confirmation */}
      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => { if (!open) setDeleteTarget(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('patient_data.delete_board_confirm_title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('patient_data.delete_board_confirm_description', {
                name: deleteTarget
                  ? localized(projectBoards.find((d) => d.id === deleteTarget)?.name ?? {}, language)
                  : '',
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete} className="bg-destructive text-white hover:bg-destructive/90">
              {t('common.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Edit dialog */}
      {editTarget && (
        <PatientBoardEditDialog
          item={editTarget}
          onOpenChange={(open) => { if (!open) setEditTarget(null) }}
        />
      )}
    </div>
  )
}
