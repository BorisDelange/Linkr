import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate, useParams } from 'react-router'
import { Plus, LayoutGrid, MoreHorizontal, Trash2, Pencil, Database } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
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
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useDashboardStore } from '@/stores/dashboard-store'
import { useDatasetStore } from '@/stores/dataset-store'

export function LabDashboardsPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { wsUid, uid } = useParams()
  const projectUid = uid ?? ''

  const { dashboards, tabs, widgets, loaded, loadProjectDashboards, createDashboard, deleteDashboard, updateDashboard } = useDashboardStore()
  const { files: datasetFiles } = useDatasetStore()

  const [createOpen, setCreateOpen] = useState(false)
  const [createName, setCreateName] = useState('')
  const [createDatasetId, setCreateDatasetId] = useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null)
  const [renameTarget, setRenameTarget] = useState<{ id: string; name: string } | null>(null)

  useEffect(() => {
    loadProjectDashboards(projectUid)
  }, [projectUid, loadProjectDashboards])

  const projectDashboards = dashboards
    .filter((d) => d.projectUid === projectUid)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))

  const getWidgetCount = (dashboardId: string) => {
    const dashTabs = tabs.filter((t) => t.dashboardId === dashboardId)
    const tabIds = new Set(dashTabs.map((t) => t.id))
    return widgets.filter((w) => tabIds.has(w.tabId)).length
  }

  const getDatasetName = (datasetFileId: string | null) => {
    if (!datasetFileId) return null
    const file = datasetFiles.find((f) => f.id === datasetFileId)
    return file?.name ?? null
  }

  const projectDatasetFiles = datasetFiles.filter(
    (f) => f.projectUid === projectUid && f.type === 'file' && f.columns && f.columns.length > 0
  )

  const handleCreate = async () => {
    const name = createName.trim()
    if (!name) return
    const id = await createDashboard(projectUid, name, createDatasetId)
    setCreateOpen(false)
    setCreateName('')
    setCreateDatasetId(null)
    navigate(`/workspaces/${wsUid}/projects/${projectUid}/lab/dashboards/${id}`)
  }

  const handleDelete = () => {
    if (deleteTarget) {
      deleteDashboard(deleteTarget)
      setDeleteTarget(null)
    }
  }

  const handleRename = () => {
    if (renameTarget && renameTarget.name.trim()) {
      updateDashboard(renameTarget.id, { name: renameTarget.name.trim() })
      setRenameTarget(null)
    }
  }

  if (!loaded) return null

  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto max-w-4xl px-6 py-10">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-foreground">
              {t('dashboard.dashboards_title')}
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {t('dashboard.dashboards_description')}
            </p>
          </div>
          <Button onClick={() => setCreateOpen(true)}>
            <Plus size={16} />
            {t('dashboard.create_dashboard')}
          </Button>
        </div>

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
              <Button onClick={() => setCreateOpen(true)} className="mt-4 gap-2">
                <Plus size={16} />
                {t('dashboard.create_dashboard')}
              </Button>
            </div>
          </Card>
        ) : (
          <div className="mt-6 grid gap-3 sm:grid-cols-2">
            {projectDashboards.map((dash) => {
              const widgetCount = getWidgetCount(dash.id)
              const datasetName = getDatasetName(dash.datasetFileId)
              return (
                <Card
                  key={dash.id}
                  className="cursor-pointer transition-colors hover:bg-accent"
                  onClick={() => navigate(`/workspaces/${wsUid}/projects/${projectUid}/lab/dashboards/${dash.id}`)}
                >
                  <div className="p-4">
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex items-center gap-2.5 min-w-0">
                        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10">
                          <LayoutGrid size={16} className="text-primary" />
                        </div>
                        <span className="truncate text-sm font-medium text-card-foreground">
                          {dash.name}
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
                          <DropdownMenuItem onClick={() => setRenameTarget({ id: dash.id, name: dash.name })}>
                            <Pencil size={14} />
                            {t('dashboard.rename_title')}
                          </DropdownMenuItem>
                          <DropdownMenuItem variant="destructive" onClick={() => setDeleteTarget(dash.id)}>
                            <Trash2 size={14} />
                            {t('common.delete')}
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                    <div className="mt-2 flex items-center gap-3 text-xs text-muted-foreground">
                      <span>{t('dashboard.card_widgets', { count: widgetCount })}</span>
                      <span>{datasetName ?? t('dashboard.card_no_dataset')}</span>
                    </div>
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
              <Label className="text-xs">{t('dashboard.field_name')}</Label>
              <Input
                value={createName}
                onChange={(e) => setCreateName(e.target.value)}
                placeholder={t('dashboard.field_name_placeholder')}
                className="h-8 text-sm"
                onKeyDown={(e) => { if (e.key === 'Enter') handleCreate() }}
                autoFocus
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">{t('dashboard.field_dataset')}</Label>
              <Select
                value={createDatasetId ?? '__none__'}
                onValueChange={(v) => setCreateDatasetId(v === '__none__' ? null : v)}
              >
                <SelectTrigger className="h-8 text-sm">
                  <SelectValue placeholder={t('dashboard.field_dataset_placeholder')} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">{t('dashboard.field_dataset_none')}</SelectItem>
                  {projectDatasetFiles.map((f) => (
                    <SelectItem key={f.id} value={f.id}>
                      <div className="flex items-center gap-2">
                        <Database size={12} className="text-muted-foreground" />
                        {f.name}
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-[11px] text-muted-foreground">{t('dashboard.field_dataset_hint')}</p>
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
      <Dialog open={!!renameTarget} onOpenChange={(open) => { if (!open) setRenameTarget(null) }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('dashboard.rename_title')}</DialogTitle>
          </DialogHeader>
          <div className="py-2">
            <Input
              value={renameTarget?.name ?? ''}
              onChange={(e) => setRenameTarget((prev) => prev ? { ...prev, name: e.target.value } : null)}
              className="h-8 text-sm"
              onKeyDown={(e) => { if (e.key === 'Enter') handleRename() }}
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setRenameTarget(null)}>
              {t('common.cancel')}
            </Button>
            <Button size="sm" onClick={handleRename} disabled={!renameTarget?.name.trim()}>
              {t('common.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
