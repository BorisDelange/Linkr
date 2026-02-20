import { useTranslation } from 'react-i18next'
import type { DataSource, DatabaseConnectionConfig } from '@/types'
import {
  Database,
  Plug,
  Unplug,
  RefreshCw,
  Pencil,
  MoreHorizontal,
  Trash2,
  Check,
  Download,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
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
  onExport?: () => void
  onRemove: () => void
}

function getSourceSummary(source: DataSource): string {
  if (source.sourceType === 'fhir') return 'FHIR Server'

  const mapping = source.schemaMapping
  const config = source.connectionConfig as DatabaseConnectionConfig
  const parts: string[] = []

  if (config.engine) parts.push(config.engine.charAt(0).toUpperCase() + config.engine.slice(1))
  if (mapping?.presetLabel) parts.push(mapping.presetLabel)

  return parts.join(' / ') || 'Database'
}

function getConnectionDetail(source: DataSource): string | null {
  if (source.sourceType === 'fhir') return null

  const config = source.connectionConfig as DatabaseConnectionConfig
  if (config.fileNames && config.fileNames.length > 0) {
    return `${config.fileNames.length} Parquet files`
  }
  if (config.fileId) return null
  if (config.host) {
    return `${config.host}${config.port ? `:${config.port}` : ''}${config.database ? `/${config.database}` : ''}`
  }
  return null
}

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return n.toLocaleString()
  return n.toString()
}

const statusColors: Record<string, string> = {
  connected: 'bg-green-500',
  disconnected: 'bg-muted-foreground',
  error: 'bg-red-500',
  configuring: 'bg-amber-500',
}

export function DatabaseCard({
  source,
  isActive,
  onClick,
  onSetActive,
  onTestConnection,
  onDisconnect,
  onReconnect,
  onEdit,
  onExport,
  onRemove,
}: DatabaseCardProps) {
  const { t } = useTranslation()

  const summary = getSourceSummary(source)
  const detail = getConnectionDetail(source)
  const config = source.connectionConfig as DatabaseConnectionConfig
  const needsReconnect = config.useFileHandles && source.status === 'disconnected'

  const cardClassName = [
    'transition-colors',
    onClick ? 'cursor-pointer hover:bg-accent/50' : '',
    isActive ? 'border-green-500/50 bg-green-50 dark:bg-green-950/20' : '',
  ].filter(Boolean).join(' ')

  return (
    <Card className={cardClassName}>
      <CardContent className="p-5">
        {/* Clickable area */}
        <div
          role={onClick ? 'button' : undefined}
          tabIndex={onClick ? 0 : undefined}
          onClick={onClick}
          onKeyDown={onClick ? (e) => { if (e.key === 'Enter' || e.key === ' ') onClick() } : undefined}
        >
          {/* Header row */}
          <div className="flex items-start justify-between">
            <div className="flex items-start gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10">
                <Database size={18} className="text-primary" />
              </div>
              <div>
                <h3 className="text-sm font-semibold">{source.name}</h3>
                <p className="mt-0.5 text-xs text-muted-foreground">{summary}</p>
              </div>
            </div>

            {/* Status badge + menu */}
            <div className="flex items-center gap-1.5">
              <span
                className={`h-2 w-2 rounded-full ${statusColors[source.status] ?? statusColors.disconnected}`}
              />
              <span className="text-xs text-muted-foreground">
                {t(`databases.status_${source.status}`)}
              </span>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon-sm" onClick={(e) => e.stopPropagation()}>
                    <MoreHorizontal size={14} />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {onEdit && (
                    <DropdownMenuItem onClick={(e) => { e.stopPropagation(); onEdit() }}>
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
                  {onExport && source.status === 'connected' && source.sourceType !== 'fhir' && (
                    <DropdownMenuItem onClick={(e) => { e.stopPropagation(); onExport() }}>
                      <Download size={14} />
                      {t('databases.export')}
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onClick={(e) => { e.stopPropagation(); onRemove() }}
                    className="text-destructive focus:text-destructive"
                  >
                    <Trash2 size={14} />
                    {t('databases.remove')}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>

          {/* Connection detail */}
          {detail && (
            <p className="mt-2 text-xs text-muted-foreground">{detail}</p>
          )}

          {/* Error message */}
          {source.status === 'error' && source.errorMessage && (
            <p className="mt-2 text-xs text-destructive line-clamp-2">{source.errorMessage}</p>
          )}

          {/* Stats */}
          {source.stats && (
            <div className="mt-3 flex items-center gap-3 text-xs text-muted-foreground">
              {source.stats.patientCount != null && (
                <span>{formatNumber(source.stats.patientCount)} patients</span>
              )}
              {source.stats.visitCount != null && (
                <span>{formatNumber(source.stats.visitCount)} visits</span>
              )}
              {source.stats.tableCount != null && (
                <span>{source.stats.tableCount} tables</span>
              )}
            </div>
          )}
        </div>

        {/* Actions */}
        {(isActive || (onSetActive && source.status === 'connected')) && (
          <div className="mt-4 flex items-center gap-2">
            {isActive ? (
              <span className="inline-flex items-center gap-1 rounded-md bg-green-100 px-2 py-1 text-xs font-medium text-green-700 dark:bg-green-900/40 dark:text-green-400">
                <Check size={12} />
                {t('databases.active_badge')}
              </span>
            ) : onSetActive && source.status === 'connected' ? (
              <Button
                variant="outline"
                size="sm"
                onClick={onSetActive}
                className="gap-1.5 text-xs"
              >
                <Check size={12} />
                {t('databases.use_database')}
              </Button>
            ) : null}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
