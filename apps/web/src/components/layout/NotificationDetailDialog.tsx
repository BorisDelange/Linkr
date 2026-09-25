import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { DataTable, type DataTableColumn } from '@/components/ui/data-table'
import { DialogShell } from '@/components/ui/dialog-shell'
import { localized } from '@/lib/localized'
import type { AppNotification, MappingNotificationItem } from '@/lib/api/notifications'

interface Props {
  notification: AppNotification | null
  onOpenChange: (open: boolean) => void
  /** Where the notification leads (the project's tab), shown as the dialog's action. */
  href: string | null
  onOpen: (href: string) => void
}

type Row = MappingNotificationItem & { key: string }

/** The concepts an agent suggested or mapped, one row each. Which parts get
 *  a dialog is `hasDetailDialog` (lib/api/notifications). */
export function NotificationDetailDialog({ notification, onOpenChange, href, onOpen }: Props) {
  const { t, i18n } = useTranslation()
  const detail = notification?.detail
  const isMappings = detail?.part === 'mappings'

  const rows: Row[] = useMemo(
    () => (detail?.items ?? []).map((item, i) => ({ ...item, key: String(i) })),
    [detail],
  )

  const columns: DataTableColumn<Row>[] = useMemo(() => [
    {
      id: 'source', header: t('notifications.detail.source'), filter: 'text', size: 200,
      accessor: (r) => r.sourceName || r.sourceCode,
    },
    {
      id: 'source_code', header: t('notifications.detail.source_code'), filter: 'text', size: 130,
      accessor: (r) => (r.sourceVocabularyId ? `${r.sourceVocabularyId}/${r.sourceCode}` : r.sourceCode),
    },
    {
      id: 'target', header: t('notifications.detail.target'), filter: 'text', size: 240,
      accessor: (r) => (r.conceptId ? r.conceptName || String(r.conceptId) : t('notifications.mapping_ignored')),
    },
    {
      id: 'concept_id', header: t('notifications.detail.concept_id'), filter: 'number', size: 100,
      accessor: (r) => r.conceptId || null,
    },
    {
      id: 'equivalence', header: t('notifications.detail.equivalence'), filter: 'select', size: 120,
      accessor: (r) => r.equivalence?.replace('skos:', '') ?? '',
    },
    {
      id: 'score', header: t('notifications.detail.score'), filter: 'number', size: 80, center: true,
      accessor: (r) => (r.score == null ? null : Math.round(r.score * 100) / 100),
    },
    ...(isMappings ? [{
      id: 'status', header: t('notifications.detail.status'), filter: 'select' as const, size: 110,
      accessor: (r: Row) => (r.status ? t(`concept_mapping.status_${r.status}`, { defaultValue: r.status }) : ''),
    }] : []),
    {
      id: 'comment', header: t('notifications.detail.comment'), filter: 'text', size: 360,
      accessor: (r) => r.comment ?? '',
    },
  ], [t, isMappings])

  if (!notification || !detail) return null
  const title = t(`notifications.part.${detail.part}.${detail.action}`, {
    name: localized(detail.name, i18n.language),
    count: detail.count,
  })

  return (
    <DialogShell
      open={!!notification}
      onOpenChange={onOpenChange}
      kind="workbench"
      title={title}
      description={`${t(`notifications.entity.${notification.entityType}`, { defaultValue: notification.entityType })} « ${localized(notification.label, i18n.language)} » · ${t(`notifications.action.${notification.action}`, { source: notification.source.toUpperCase() })}`}
      footerExtra={href ? (
        <Button variant="outline" size="sm" onClick={() => onOpen(href)}>
          {t('notifications.detail.open_tab', { tab: t(isMappings ? 'concept_mapping.tab_mappings' : 'concept_mapping.tab_editor') })}
        </Button>
      ) : undefined}
    >
      <DataTable
        data={rows}
        columns={columns}
        rowKey={(r) => r.key}
        pageSize={100}
        viewKey="notification-detail"
        cellTooltips="all"
        emptyMessage={t('common.no_results')}
      />
      {(detail.more ?? 0) > 0 && (
        <p className="mt-2 text-xs text-muted-foreground">{t('notifications.more_items', { count: detail.more })}</p>
      )}
    </DialogShell>
  )
}
