import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'
import { Bell, Bot, Pencil, Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { isServerMode } from '@/lib/api-client'
import { localized } from '@/lib/localized'
import { paths } from '@/lib/paths'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/stores/app-store'
import { useAuthStore } from '@/stores/auth-store'
import { useNotificationStore } from '@/stores/notification-store'
import type { AppNotification } from '@/lib/api/notifications'

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
  const { items, unread, connect, disconnect, markAllRead, clearAll } = useNotificationStore()
  const [open, setOpen] = useState(false)
  const enabled = isServerMode() && loggedIn

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
    if (n.action === 'deleted' || !n.projectUid) return null
    const project = useAppStore.getState()._projectsRaw.find((p) => p.uid === n.projectUid)
    if (!project?.workspaceId) return null
    if (n.entityType === 'cohort') return paths.cohort(project.workspaceId, n.projectUid, n.entityId)
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
                <li key={n.id}>
                  <button
                    disabled={!href}
                    onClick={() => { if (href) { setOpen(false); navigate(href) } }}
                    className={cn(
                      'flex w-full items-start gap-2 rounded px-1.5 py-1.5 text-left',
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
                      <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
                        <Bot size={10} />
                        {t(`notifications.action.${n.action}`, { source: n.source.toUpperCase() })}
                        {' · '}
                        {relativeTime(n.createdAt, i18n.language)}
                      </span>
                    </span>
                    {!n.readAt && <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />}
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </PopoverContent>
    </Popover>
  )
}
