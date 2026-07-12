import { useState, useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'
import { useResolvedParams } from '@/hooks/use-resolved-params'
import type { Dashboard } from '@/types'
import { paths } from '@/lib/paths'
import { Plus, LayoutGrid, MoreHorizontal, Trash2, Pencil } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { TruncatedText } from '@/components/ui/truncated-text'
import { ListPageToolbar } from '@/components/ui/list-page-toolbar'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { RequiredMark } from '@/components/ui/required-mark'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
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

  const { dashboards, loaded, loadProjectDashboards, createDashboard, deleteDashboard } = useDashboardStore()
  const { loadProjectDatasets } = useDatasetStore()

  const [createOpen, setCreateOpen] = useState(false)
  const [createName, setCreateName] = useState('')
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null)
  const [editTarget, setEditTarget] = useState<Dashboard | null>(null)
  const [searchQuery, setSearchQuery] = useState('')

  useEffect(() => {
    loadProjectDashboards(projectUid)
    loadProjectDatasets(projectUid)
  }, [projectUid, loadProjectDashboards, loadProjectDatasets])

  const projectDashboards = dashboards
    .filter((d) => d.projectUid === projectUid)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))

  const filteredDashboards = useMemo(() => {
    const words = searchQuery.toLowerCase().split(/\s+/).filter(Boolean)
    if (!words.length) return projectDashboards
    return projectDashboards.filter((d) => {
      const name = localized(d.name, language).toLowerCase()
      return words.every((w) => name.includes(w))
    })
  }, [projectDashboards, searchQuery, language])


  const handleCreate = async () => {
    const name = createName.trim()
    if (!name) return
    const id = await createDashboard(projectUid, setLocalized({}, language, name))
    setCreateOpen(false)
    setCreateName('')
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
                  className="cursor-pointer transition-colors hover:bg-accent/50"
                  onClick={() => navigate(paths.dashboard(wsUid ?? '', projectUid, dash.id))}
                >
                  <div className="p-4">
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex items-center gap-2.5 min-w-0">
                        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10">
                          <LayoutGrid size={16} className="text-primary" />
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
                            className="shrink-0"
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
                          <DropdownMenuSeparator />
                          <DropdownMenuItem disabled={!canDelete} variant="destructive" onClick={() => setDeleteTarget(dash.id)}>
                            <Trash2 size={14} />
                            {t('common.delete')}
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                    {description && (
                      <TruncatedText
                        text={description}
                        className="mt-2 text-xs text-muted-foreground"
                      />
                    )}
                  </div>
                </Card>
              )
            })}
          </div>
        )}
      </div>

      {/* Create dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('dashboard.create_dialog_title')}</DialogTitle>
            <DialogDescription>{t('dashboard.create_dialog_description')}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div className="space-y-1">
              <Label className="text-xs">{t('dashboard.field_name')}<RequiredMark /></Label>
              <Input
                value={createName}
                onChange={(e) => setCreateName(e.target.value)}
                placeholder={t('dashboard.field_name_placeholder')}
                className="h-8 text-sm"
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleCreate() } }}
                autoFocus
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setCreateOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button size="sm" onClick={handleCreate} disabled={!createName.trim()}>
              {t('dashboard.create_dashboard')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
