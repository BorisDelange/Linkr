import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'
import { ShieldCheck, Plus, Trash2, Pencil, Database, MoreHorizontal } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
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
import { cn } from '@/lib/utils'
import { useDqStore } from '@/stores/dq-store'
import { useWorkspaceStore } from '@/stores/workspace-store'
import { useDataSourceStore } from '@/stores/data-source-store'
import { CreateDqRuleSetDialog } from './CreateDqRuleSetDialog'
import type { DqRuleSet, DqRuleSetStatus } from '@/types'

const STATUS_BADGE: Record<DqRuleSetStatus, { variant: 'default' | 'secondary' | 'destructive' | 'outline'; label: string }> = {
  draft: { variant: 'secondary', label: 'data_quality.rs_status_draft' },
  ready: { variant: 'outline', label: 'data_quality.rs_status_ready' },
  running: { variant: 'default', label: 'data_quality.rs_status_running' },
  success: { variant: 'default', label: 'data_quality.rs_status_success' },
  error: { variant: 'destructive', label: 'data_quality.rs_status_error' },
}

export function DqRuleSetListPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { activeWorkspaceId } = useWorkspaceStore()
  const { dqRuleSetsLoaded, loadDqRuleSets, getWorkspaceRuleSets, deleteRuleSet } = useDqStore()
  const dataSources = useDataSourceStore((s) => s.dataSources)

  const [dialogOpen, setDialogOpen] = useState(false)
  const [toDelete, setToDelete] = useState<DqRuleSet | null>(null)
  const [toEdit, setToEdit] = useState<DqRuleSet | null>(null)

  useEffect(() => {
    if (!dqRuleSetsLoaded) loadDqRuleSets()
  }, [dqRuleSetsLoaded, loadDqRuleSets])

  const ruleSets = activeWorkspaceId ? getWorkspaceRuleSets(activeWorkspaceId) : []

  const getSourceName = (sourceId: string) =>
    dataSources.find((ds) => ds.id === sourceId)?.name ?? '—'

  const handleCreated = (ruleSetId: string) => {
    navigate(ruleSetId)
  }

  const handleDelete = async () => {
    if (toDelete) {
      await deleteRuleSet(toDelete.id)
      setToDelete(null)
    }
  }

  const scoreColor = (score?: number) => {
    if (score == null) return ''
    if (score >= 95) return 'text-emerald-600 dark:text-emerald-400'
    if (score >= 80) return 'text-amber-600 dark:text-amber-400'
    return 'text-red-600 dark:text-red-400'
  }

  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto max-w-3xl px-6 py-10">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-foreground">{t('data_quality.rs_title')}</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {t('data_quality.rs_description')}
            </p>
          </div>
          <Button onClick={() => setDialogOpen(true)}>
            <Plus size={16} />
            {t('data_quality.new_rule_set')}
          </Button>
        </div>

        {ruleSets.length === 0 ? (
          <Card className="mt-6">
            <div className="flex flex-col items-center py-12">
              <ShieldCheck size={40} className="text-muted-foreground" />
              <p className="mt-4 text-sm font-medium text-foreground">
                {t('data_quality.no_rule_sets')}
              </p>
              <p className="mt-1 max-w-sm text-center text-xs text-muted-foreground">
                {t('data_quality.no_rule_sets_description')}
              </p>
            </div>
          </Card>
        ) : (
          <div className="mt-6 grid gap-3">
            {ruleSets.map((rs) => {
              const statusInfo = STATUS_BADGE[rs.status]
              return (
                <Card
                  key={rs.id}
                  className="cursor-pointer transition-colors hover:bg-accent/50"
                  onClick={() => navigate(rs.id)}
                >
                  <div className="flex items-start gap-4 p-4">
                    <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-teal-500/10">
                      <ShieldCheck size={20} className="text-teal-500" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm font-medium">
                          {rs.name}
                        </span>
                        <Badge variant={statusInfo.variant} className="text-[10px]">
                          {t(statusInfo.label)}
                        </Badge>
                        {rs.lastScore != null && (
                          <span className={cn('text-xs font-mono font-medium', scoreColor(rs.lastScore))}>
                            {rs.lastScore}%
                          </span>
                        )}
                      </div>
                      <div className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
                        <Database size={12} />
                        <span>{getSourceName(rs.dataSourceId)}</span>
                      </div>
                      {rs.lastRunAt && (
                        <p className="mt-0.5 text-[10px] text-muted-foreground">
                          {t('data_quality.last_run')}: {new Date(rs.lastRunAt).toLocaleString()}
                          {rs.lastRunDurationMs != null && ` (${(rs.lastRunDurationMs / 1000).toFixed(1)}s)`}
                        </p>
                      )}
                    </div>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <MoreHorizontal size={14} />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={(e) => { e.stopPropagation(); setToEdit(rs) }}>
                          <Pencil size={14} />
                          {t('common.edit')}
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onClick={(e) => { e.stopPropagation(); setToDelete(rs) }}
                          className="text-destructive focus:text-destructive"
                        >
                          <Trash2 size={14} />
                          {t('common.delete')}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </Card>
              )
            })}
          </div>
        )}
      </div>

      <CreateDqRuleSetDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onCreated={handleCreated}
      />

      <CreateDqRuleSetDialog
        open={!!toEdit}
        onOpenChange={(open) => { if (!open) setToEdit(null) }}
        editingRuleSet={toEdit}
      />

      <AlertDialog open={!!toDelete} onOpenChange={(open) => { if (!open) setToDelete(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('data_quality.delete_rs_title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('data_quality.delete_rs_description', { name: toDelete?.name ?? '' })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete}>{t('common.delete')}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
