import { useState, useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'
import { useResolvedParams } from '@/hooks/use-resolved-params'
import type { Dashboard } from '@/types'
import { paths } from '@/lib/paths'
import { Plus, LayoutGrid, MoreHorizontal, Trash2, Pencil, TriangleAlert, Copy } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cardMenuTriggerClass, cn } from '@/lib/utils'
import { Card } from '@/components/ui/card'
import { CardMetaFooter } from '@/components/ui/card-meta-footer'
import { TruncatedText } from '@/components/ui/truncated-text'
import { ListPageToolbar, type SortState } from '@/components/ui/list-page-toolbar'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { RequiredMark } from '@/components/ui/required-mark'
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
import { useDashboardStore } from '@/stores/dashboard-store'
import { useDatasetStore } from '@/stores/dataset-store'
import { useAppStore } from '@/stores/app-store'
import { useMyProjectRole } from '@/hooks/use-context-role'
import { GatedButton } from '@/components/ui/gated-button'
import { localized, setLocalized } from '@/lib/localized'
import { applySort, baseSortFields } from '@/lib/list-sort'
import { DashboardEditDialog } from './DashboardEditDialog'

export function LabDashboardsPage() {
  const { t } = useTranslation()
  const language = useAppStore((s) => s.language)
  const navigate = useNavigate()
  const { wsUid, projectUid: resolvedProjectUid } = useResolvedParams()
  const projectUid = resolvedProjectUid ?? ''
  const { atLeast } = useMyProjectRole(projectUid)
  const canEdit = atLeast('editor')
  const canDelete = atLeast('owner')

  const { dashboards, loaded, loadProjectDashboards, createDashboard, duplicateDashboard, deleteDashboard } = useDashboardStore()
  const { loadProjectDatasets } = useDatasetStore()

  const [createOpen, setCreateOpen] = useState(false)
  const [createName, setCreateName] = useState('')
  const [createDescription, setCreateDescription] = useState('')
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null)
  const [editTarget, setEditTarget] = useState<Dashboard | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [sort, setSort] = useState<SortState | null>(null)

  useEffect(() => {
    loadProjectDashboards(projectUid)
    loadProjectDatasets(projectUid)
  }, [projectUid, loadProjectDashboards, loadProjectDatasets])

  const projectDashboards = dashboards
    .filter((d) => d.projectUid === projectUid)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))

  const filteredDashboards = useMemo(() => {
    const words = searchQuery.toLowerCase().split(/\s+/).filter(Boolean)
    const filtered = words.length
      ? projectDashboards.filter((d) => {
          const name = localized(d.name, language).toLowerCase()
          return words.every((w) => name.includes(w))
        })
      : projectDashboards
    return applySort(filtered, sort, {
      name: (d) => localized(d.name, language),
      createdAt: (d) => d.createdAt,
      updatedAt: (d) => d.updatedAt,
    })
  }, [projectDashboards, searchQuery, language, sort])


  // Compared in the ACTIVE language: that is what the user typed and what the
  // list shows, so a clash in another translation isn't a clash here.
  const nameError = useMemo(() => {
    const trimmed = createName.trim().toLowerCase()
    if (!trimmed) return null
    const taken = projectDashboards.some(
      (d) => localized(d.name, language).trim().toLowerCase() === trimmed,
    )
    return taken ? t('dashboard.dashboard_name_exists') : null
  }, [createName, projectDashboards, language, t])
  const isNameValid = createName.trim().length > 0 && !nameError

  const handleCreate = async () => {
    const name = createName.trim()
    if (!name || nameError) return
    const description = createDescription.trim()
    const id = await createDashboard(
      projectUid,
      setLocalized({}, language, name),
      description ? setLocalized({}, language, description) : undefined,
    )
    setCreateOpen(false)
    setCreateName('')
    setCreateDescription('')
    navigate(paths.dashboard(wsUid ?? '', projectUid, id))
  }

  const handleDelete = () => {
    if (deleteTarget) {
      deleteDashboard(deleteTarget)
      setDeleteTarget(null)
    }
  }

  if (!loaded) return null

  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto max-w-4xl px-6 py-10">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold text-foreground">
              {t('dashboard.dashboards_title')}
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {t('dashboard.dashboards_description')}
            </p>
          </div>
          <GatedButton allowed={canEdit} notAllowedReason={t('common.insufficient_permissions')} size="sm" className="shrink-0 gap-1 text-xs" onClick={() => setCreateOpen(true)}>
            <Plus size={14} />
            {t('dashboard.create_dashboard')}
          </GatedButton>
        </div>

        {projectDashboards.length > 0 && (
          <ListPageToolbar
            searchQuery={searchQuery}
            onSearchChange={setSearchQuery}
            searchPlaceholder={t('dashboard.search_placeholder')}
            sort={{ options: baseSortFields(t), value: sort, onChange: setSort }}
          />
        )}

        {projectDashboards.length === 0 ? (
          <Card className="mt-6">
            <div className="flex flex-col items-center py-12">
              <LayoutGrid size={40} className="text-muted-foreground" />
              <p className="mt-4 text-sm font-medium text-foreground">
                {t('dashboard.no_dashboards_title')}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {t('dashboard.no_dashboards_description')}
              </p>
              <GatedButton allowed={canEdit} notAllowedReason={t('common.insufficient_permissions')} onClick={() => setCreateOpen(true)} className="mt-4 gap-2">
                <Plus size={16} />
                {t('dashboard.create_dashboard')}
              </GatedButton>
            </div>
          </Card>
        ) : filteredDashboards.length === 0 ? (
          <div className="mt-6 flex flex-col items-center py-8">
            <LayoutGrid size={24} className="text-muted-foreground/50" />
            <p className="mt-2 text-sm text-muted-foreground">{t('dashboard.no_results')}</p>
          </div>
        ) : (
          <div className="mt-6 grid gap-3 sm:grid-cols-2">
            {filteredDashboards.map((dash) => {
              const description = dash.description ? localized(dash.description, language) : ''
              return (
                <Card
                  key={dash.id}
                  className="flex min-h-44 cursor-pointer flex-col gap-0 py-0 transition-colors hover:bg-accent"
                  onClick={() => navigate(paths.dashboard(wsUid ?? '', projectUid, dash.id))}
                >
                  <div className="flex flex-1 flex-col px-4 pt-5">
                   <div className="flex flex-1 flex-col justify-center">
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-3 min-w-0">
                        <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-rose-500/10">
                          <LayoutGrid size={20} className="text-rose-500" />
                        </div>
                        <span className="truncate text-sm font-medium text-card-foreground">
                          {localized(dash.name, language)}
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
                          <DropdownMenuItem disabled={!canEdit} onClick={() => setEditTarget(dash)}>
                            <Pencil size={14} />
                            {t('common.edit')}
                          </DropdownMenuItem>
                          <DropdownMenuItem disabled={!canEdit} onClick={() => { void duplicateDashboard(dash.id) }}>
                            <Copy size={14} />
                            {t('common.duplicate')}
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem disabled={!canDelete} variant="destructive" onClick={() => setDeleteTarget(dash.id)}>
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
                      createdById={dash.createdById}
                      createdBy={dash.createdBy}
                      createdByDetails={dash.createdByDetails}
                      createdAt={dash.createdAt}
                      updatedAt={dash.updatedAt}
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
        title={t('dashboard.create_dialog_title')}
        description={t('dashboard.create_dialog_description')}
        contentClassName="space-y-4 py-2"
        onConfirm={handleCreate}
        confirmLabel={t('dashboard.create_dashboard')}
        confirmDisabled={!isNameValid}
      >
            <div className="space-y-2">
              <Label>{t('dashboard.field_name')}<RequiredMark /></Label>
              <Input
                value={createName}
                onChange={(e) => setCreateName(e.target.value)}
                placeholder={t('dashboard.field_name_placeholder')}
                className={cn(nameError && 'border-destructive')}
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
            <AlertDialogTitle>{t('dashboard.delete_confirm_title')}</AlertDialogTitle>
            <AlertDialogDescription>{t('dashboard.delete_confirm_description')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete} className="bg-destructive text-white hover:bg-destructive/90">
              {t('common.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Rename dialog */}
      {editTarget && (
        <DashboardEditDialog
          item={editTarget}
          onOpenChange={(open) => { if (!open) setEditTarget(null) }}
        />
      )}
    </div>
  )
}
