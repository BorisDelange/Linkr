import { memo } from 'react'
import { useTranslation } from 'react-i18next'
import type { DataSource, DatabaseConnectionConfig } from '@/types'
import { localized } from '@/lib/localized'
import { cn } from '@/lib/utils'
import { ENTITY_COLORS } from '@/lib/entity-colors'
import {
  Database,
  Plug,
  Unplug,
  RefreshCw,
  Check,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { CardMetaFooter } from '@/components/ui/card-meta-footer'
import { TruncatedText } from '@/components/ui/truncated-text'
import { selectedCardClass } from '@/components/ui/use-card-selection'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { EntityActionsMenu } from '@/components/ui/entity-actions-menu'
import { useDatabaseActions } from './use-database-actions'

interface DatabaseCardProps {
  source: DataSource
  isActive?: boolean
  onClick?: () => void
  onSetActive?: () => void
  onTestConnection: () => void
  onDisconnect?: () => void
  onReconnect?: () => void
  /** The destructive action, run AFTER the menu's own confirmation — the card
   *  must not raise a second dialog of its own. */
  onRemove: () => void
  /** Wording for that action and its confirmation, when the default ("delete this
   *  database") is wrong: a project's card unlinks, and the workspace's card
   *  warns about the projects it is about to unlink. */
  removeLabelKey?: string
  removeConfirmTitleKey?: string
  removeConfirmDescriptionKey?: string
  /** Opens the licence in the docs dialog, from the footer chip. */
  onOpenLicense?: () => void
  /** Sends the menu's Readme/License items to the detail page's own tabs. */
  onOpenDocs?: (tab: 'readme' | 'license') => void
  /** Sends the menu's Versioning item to the detail page's own tab. */
  onOpenVersioning?: () => void
  /** When false, edit/remove actions are disabled (viewer). Default true. */
  canEdit?: boolean
  /** Extra content rendered under the stats row (e.g. the linked-projects strip). */
  belowStats?: React.ReactNode
  /** Part of a multi-selection — greys the card out. */
  selected?: boolean
  /** Returns true when the click was consumed as a selection gesture, so the card skips navigation. */
  onSelectClick?: (e: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean }) => boolean
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
  onRemove,
  removeLabelKey,
  removeConfirmTitleKey,
  removeConfirmDescriptionKey,
  onOpenLicense,
  onOpenDocs,
  onOpenVersioning,
  canEdit = true,
  belowStats,
  selected = false,
  onSelectClick,
}: DatabaseCardProps) {
  const { t, i18n } = useTranslation()
  const actions = useDatabaseActions()

  const summary = getSourceSummary(source, i18n.language)
  const config = source.connectionConfig as DatabaseConnectionConfig
  const needsReconnect = config.useFileHandles && source.status === 'disconnected'

  const cardClassName = cn(
    'flex min-h-44 min-w-0 flex-col gap-0 py-0 transition-colors',
    onClick && 'cursor-pointer hover:bg-accent',
    isActive && 'border-green-500/50 bg-green-50 dark:bg-green-950/20',
    selected && selectedCardClass,
  )

  const handleCardClick = (e: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean }) => {
    if (onSelectClick?.(e)) return
    onClick?.()
  }

  return (
    <Card
      className={cardClassName}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onClick={onClick || onSelectClick ? handleCardClick : undefined}
      onKeyDown={onClick ? (e) => { if (e.key === 'Enter' || e.key === ' ') onClick() } : undefined}
    >
      <div className="flex flex-1 flex-col px-4 pt-5">
        <div className="flex flex-1 items-center gap-4">
        <div className={cn('flex size-10 shrink-0 items-center justify-center rounded-lg', ENTITY_COLORS.database.bg)}>
          <Database size={20} className={ENTITY_COLORS.database.icon} />
        </div>

        <div className="min-w-0 flex-1">
          <TruncatedText text={localized(source.name, i18n.language)} readOnly className="min-w-0 flex-1 text-sm font-medium" />
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

        {/* Same menu the header badge shows, so the two cannot drift: edit,
            export, versioning, readme, licence, delete — plus the connection
            actions, which are the only database-specific ones. */}
        <EntityActionsMenu
          item={source}
          {...actions}
          canEdit={canEdit}
          canDelete={canEdit}
          onDelete={async () => onRemove()}
          deleteLabelKey={removeLabelKey}
          deleteConfirmTitleKey={removeConfirmTitleKey ?? actions.deleteConfirmTitleKey}
          deleteConfirmDescriptionKey={removeConfirmDescriptionKey ?? actions.deleteConfirmDescriptionKey}
          onOpenDocs={onOpenDocs ? (_item, tab) => onOpenDocs(tab) : undefined}
          onVersioningOverride={onOpenVersioning ? () => onOpenVersioning() : undefined}
          extraItems={
            <>
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
            </>
          }
        />
        </div>
        <CardMetaFooter
          className="mt-auto"
          createdById={source.createdById}
          createdBy={source.createdBy}
          createdByDetails={source.createdByDetails}
          createdAt={source.createdAt}
          updatedAt={source.updatedAt}
          license={source.license}
          onOpenLicense={onOpenLicense}
        />
      </div>
    </Card>
  )
})
