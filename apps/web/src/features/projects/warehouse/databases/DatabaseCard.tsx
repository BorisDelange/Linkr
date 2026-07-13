import { memo } from 'react'
import { useTranslation } from 'react-i18next'
import type { DataSource, DatabaseConnectionConfig } from '@/types'
import { localized } from '@/lib/localized'
import {
  Database,
  Plug,
  Unplug,
  RefreshCw,
  Pencil,
  MoreHorizontal,
  Trash2,
  Check,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { CardMetaFooter } from '@/components/ui/card-meta-footer'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

interface DatabaseCardProps {
  source: DataSource
  isActive?: boolean
  onClick?: () => void
  onSetActive?: () => void
  onTestConnection: () => void
  onDisconnect?: () => void
  onReconnect?: () => void
  onEdit?: () => void
  onRemove: () => void
  /** When false, edit/remove actions are disabled (viewer). Default true. */
  canEdit?: boolean
  /** Extra content rendered under the stats row (e.g. the linked-projects strip). */
  belowStats?: React.ReactNode
}

function getSourceSummary(source: DataSource, lang: string): string {
  if (source.sourceType === 'fhir') return 'FHIR Server'

  const mapping = source.schemaMapping
  const config = source.connectionConfig as DatabaseConnectionConfig
  const parts: string[] = []

  if (config.engine) parts.push(config.engine.charAt(0).toUpperCase() + config.engine.slice(1))
  if (mapping?.presetLabel) parts.push(localized(mapping.presetLabel, lang))

  return parts.join(' / ') || 'Database'
}

const statusColors: Record<string, string> = {
  connected: 'bg-green-500',
  disconnected: 'bg-muted-foreground',
  error: 'bg-red-500',
  configuring: 'bg-amber-500',
}

export const DatabaseCard = memo(function DatabaseCard({
  source,
  isActive,
  onClick,
  onSetActive,
  onTestConnection,
  onDisconnect,
  onReconnect,
  onEdit,
  onRemove,
  canEdit = true,
  belowStats,
}: DatabaseCardProps) {
  const { t, i18n } = useTranslation()

  const summary = getSourceSummary(source, i18n.language)
  const config = source.connectionConfig as DatabaseConnectionConfig
  const needsReconnect = config.useFileHandles && source.status === 'disconnected'

  const cardClassName = [
    'flex min-h-44 min-w-0 flex-col gap-0 py-0 transition-colors',
    onClick ? 'cursor-pointer hover:bg-accent/50' : '',
    isActive ? 'border-green-500/50 bg-green-50 dark:bg-green-950/20' : '',
  ].filter(Boolean).join(' ')

  return (
    <Card
      className={cardClassName}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onClick={onClick}
      onKeyDown={onClick ? (e) => { if (e.key === 'Enter' || e.key === ' ') onClick() } : undefined}
    >
      <div className="flex flex-1 flex-col px-4 pt-5">
        <div className="flex flex-1 items-center gap-4">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-teal-500/10">
          <Database size={20} className="text-teal-500" />
        </div>

        <div className="min-w-0 flex-1">
          <h3 className="truncate text-sm font-medium">{source.name}</h3>
          <p className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
            <span
              className={`size-2 shrink-0 rounded-full ${statusColors[source.status] ?? statusColors.disconnected}`}
            />
            <span className="truncate">
              {t(`databases.status_${source.status}`)} &middot; {summary}
            </span>
          </p>

          {/* Error status is shown by the status dot; the full message lives in
              the detail panel. Keep the card light — just the linked-projects strip. */}
          {belowStats}

          {/* Active badge / use action */}
          {(isActive || (onSetActive && source.status === 'connected')) && (
            <div className="mt-3 flex items-center gap-2">
              {isActive ? (
                <span className="inline-flex items-center gap-1 rounded-md bg-green-100 px-2 py-1 text-xs font-medium text-green-700 dark:bg-green-900/40 dark:text-green-400">
                  <Check size={12} />
                  {t('databases.active_badge')}
                </span>
              ) : onSetActive && source.status === 'connected' ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={(e) => { e.stopPropagation(); onSetActive() }}
                  className="gap-1.5 text-xs"
                >
                  <Check size={12} />
                  {t('databases.use_database')}
                </Button>
              ) : null}
            </div>
          )}
        </div>

        {/* Actions menu (top-right) */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" className="-mr-1 -mt-1 shrink-0 self-start" onClick={(e) => e.stopPropagation()}>
              <MoreHorizontal size={14} />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {onEdit && (
              <DropdownMenuItem disabled={!canEdit} onClick={(e) => { e.stopPropagation(); onEdit() }}>
                <Pencil size={14} />
                {t('common.edit')}
              </DropdownMenuItem>
            )}
            {source.status === 'connected' && onDisconnect && (
              <DropdownMenuItem onClick={(e) => { e.stopPropagation(); onDisconnect() }}>
                <Unplug size={14} />
                {t('databases.disconnect')}
              </DropdownMenuItem>
            )}
            {source.status !== 'connected' && (
              needsReconnect && onReconnect ? (
                <DropdownMenuItem onClick={(e) => { e.stopPropagation(); onReconnect() }}>
                  <RefreshCw size={14} />
                  {t('databases.reconnect')}
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem onClick={(e) => { e.stopPropagation(); onTestConnection() }}>
                  <Plug size={14} />
                  {t('databases.connect')}
                </DropdownMenuItem>
              )
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem
              disabled={!canEdit}
              onClick={(e) => { e.stopPropagation(); onRemove() }}
              className="text-destructive focus:text-destructive"
            >
              <Trash2 size={14} className="text-destructive" />
              {t('databases.remove')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        </div>
        <CardMetaFooter
          className="mt-auto"
          createdById={source.createdById}
          createdBy={source.createdBy}
          createdByDetails={source.createdByDetails}
          createdAt={source.createdAt}
          updatedAt={source.updatedAt}
        />
      </div>
    </Card>
  )
})
