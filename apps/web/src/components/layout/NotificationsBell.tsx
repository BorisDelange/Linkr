import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'
import { Bell, Bot, ListTree, Pencil, Plus, Trash2, Undo2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { isServerMode } from '@/lib/api-client'
import { localized } from '@/lib/localized'
import { paths } from '@/lib/paths'
import { cn } from '@/lib/utils'
import { useConceptMappingStore } from '@/stores/concept-mapping-store'
import { useAppStore } from '@/stores/app-store'
import { useAuthStore } from '@/stores/auth-store'
import { useNotificationStore } from '@/stores/notification-store'
import { useUiContextPublisher } from '@/hooks/use-ui-context-publisher'
import { hasDetailDialog, type AppNotification } from '@/lib/api/notifications'
import { NotificationDetailDialog } from '@/components/layout/NotificationDetailDialog'

const ACTION_ICON = { created: Plus, updated: Pencil, deleted: Trash2 } as const

function relativeTime(iso: string, language: string): string {
  const seconds = Math.round((new Date(iso).getTime() - Date.now()) / 1000)
  const fmt = new Intl.RelativeTimeFormat(language, { numeric: 'auto' })
  const abs = Math.abs(seconds)
  if (abs < 60) return fmt.format(seconds, 'second')
  if (abs < 3600) return fmt.format(Math.round(seconds / 60), 'minute')
  if (abs < 86400) return fmt.format(Math.round(seconds / 3600), 'hour')
  return fmt.format(Math.round(seconds / 86400), 'day')
}

/**
 * Header notification centre (server mode): what external clients — an agent
 * over MCP — changed on the user's behalf. Owns the notification socket, which
 * also refreshes the affected stores live. Opening the list marks it read.
 */
export function NotificationsBell() {
  const { t, i18n } = useTranslation()
  const navigate = useNavigate()
  const loggedIn = useAuthStore((s) => !!s.user)
  const { items, unread, connect, disconnect, markAllRead, clearAll, undo } = useNotificationStore()
  const [undoing, setUndoing] = useState<string | null>(null)
  const [undoError, setUndoError] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const [detailOf, setDetailOf] = useState<AppNotification | null>(null)
  const enabled = isServerMode() && loggedIn
  useUiContextPublisher(enabled)

  useEffect(() => {
    if (!enabled) return
    connect()
    return disconnect
  }, [enabled, connect, disconnect])

  if (!enabled) return null

  const onOpenChange = (next: boolean) => {
    setOpen(next)
    if (next) void markAllRead()
  }

  const target = (n: AppNotification): string | null => {
    if (n.action === 'deleted') return null
    if (n.entityType === 'mapping_project') {
      const workspaceId = useConceptMappingStore.getState().mappingProjects.find((p) => p.id === n.entityId)?.workspaceId
        ?? n.detail?.workspaceId
      if (!workspaceId) return null
      // A mapping write opens where it can be reviewed: the Mappings tab, or the
      // editor, whose Suggestions panel shows suggestions.
      const tab = n.detail?.part === 'mappings' ? 'mappings' : n.detail?.part === 'suggestions' ? 'editor' : null
      return `${paths.warehouseConceptMappingProject(workspaceId, n.entityId)}${tab ? `?tab=${tab}` : ''}`
    }
    if (!n.projectUid) return null
    const project = useAppStore.getState()._projectsRaw.find((p) => p.uid === n.projectUid)
    if (!project?.workspaceId) return null
    if (n.entityType === 'cohort') return paths.cohort(project.workspaceId, n.projectUid, n.entityId)
    if (n.entityType === 'dashboard') return paths.dashboard(project.workspaceId, n.projectUid, n.entityId)
    if (n.entityType === 'dataset') return paths.datasets(project.workspaceId, n.projectUid)
    if (n.entityType === 'script') return paths.ide(project.workspaceId, n.projectUid)
    if (n.entityType === 'concept_list') return paths.concepts(project.workspaceId, n.projectUid)
    return null
  }

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon-sm" className="relative" aria-label={t('notifications.title')}>
          <Bell size={15} />
          {unread > 0 && (
            <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-medium leading-none text-primary-foreground">
              {unread > 99 ? '99+' : unread}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-96 p-2 text-xs">
        <div className="mb-2 flex items-center justify-between px-1.5">
          <span className="font-medium">{t('notifications.title')}</span>
          {items.length > 0 && (
            <button
              className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground"
              onClick={() => void clearAll()}
            >
              <Trash2 size={11} />
              {t('notifications.clear_all')}
            </button>
          )}
        </div>
        {items.length === 0 ? (
          <p className="px-1.5 py-4 text-center text-muted-foreground">{t('notifications.empty')}</p>
        ) : (
          <ul className="flex max-h-96 flex-col gap-0.5 overflow-y-auto">
            {items.map((n) => {
              const Icon = ACTION_ICON[n.action] ?? Pencil
              const href = target(n)
              return (
                <li key={n.id} className="group flex items-start gap-1">
                  <button
                    disabled={!href}
                    onClick={() => { if (href) { setOpen(false); navigate(href) } }}
                    className={cn(
                      'flex min-w-0 flex-1 items-start gap-2 rounded px-1.5 py-1.5 text-left',
                      href ? 'hover:bg-muted/60' : 'cursor-default',
                    )}
                  >
                    <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded bg-muted">
                      <Icon size={11} className="text-muted-foreground" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">
                        {t(`notifications.entity.${n.entityType}`, { defaultValue: n.entityType })}{' '}
                        <span className="font-medium">« {localized(n.label, i18n.language) || n.entityId} »</span>
                      </span>
                      {n.detail && (
                        <span className="block truncate text-muted-foreground">
                          {t(`notifications.part.${n.detail.part}.${n.detail.action}`, {
                            name: localized(n.detail.name, i18n.language),
                            // Mapping notifications recorded before `count` carried it in `name`.
                          count: n.detail.count ?? (Number(localized(n.detail.name, i18n.language)) || undefined),
                          })}
                        </span>
                      )}
                      <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
                        <Bot size={10} />
                        {t(`notifications.action.${n.action}`, { source: n.source.toUpperCase() })}
                        {' · '}
                        {relativeTime(n.createdAt, i18n.language)}
                        {n.undoneAt && <> · {t('notifications.undone')}</>}
                      </span>
                      {undoError === n.id && (
                        <span className="block text-[10px] text-destructive">{t('notifications.undo_failed')}</span>
                      )}
                    </span>
                    {!n.readAt && <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />}
                  </button>
                  {hasDetailDialog(n) && (
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="mt-1 h-6 w-6 shrink-0 text-muted-foreground"
                      aria-label={t('notifications.show_details')}
                      title={t('notifications.show_details')}
                      onClick={() => { setOpen(false); setDetailOf(n) }}
                    >
                      <ListTree size={12} />
                    </Button>
                  )}
                  {n.undoable && (
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={undoing !== null}
                      className="mt-1 h-6 shrink-0 gap-1 px-1.5 text-[10px] text-muted-foreground"
                      onClick={() => {
                        setUndoing(n.id)
                        setUndoError(null)
                        undo(n.id)
                          .catch(() => setUndoError(n.id))
                          .finally(() => setUndoing(null))
                      }}
                    >
                      <Undo2 size={11} />
                      {t('notifications.undo')}
                    </Button>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </PopoverContent>
      <NotificationDetailDialog
        notification={detailOf}
        onOpenChange={(next) => { if (!next) setDetailOf(null) }}
        href={detailOf ? target(detailOf) : null}
        onOpen={(href) => { setDetailOf(null); navigate(href) }}
      />
    </Popover>
  )
}
