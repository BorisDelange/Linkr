import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CalendarClock } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { FieldLabel } from '@/features/projects/lab/datasets/analyses/config-panel-field-label'
import { MultiSelectField } from '@/features/projects/lab/datasets/analyses/config-panel-input-fields'
import { localized } from '@/lib/localized'
import { useDashboardStore } from '@/stores/dashboard-store'
import type { DashboardEvent } from '@/types'
import type { PluginConfigField } from '@/types/plugin'
import { formatEventDate } from '@/lib/dashboard-events'
import { DashboardEventsDialog } from './DashboardEventsDialog'
import { useTabDashboardEvents } from './use-dashboard-events'

/**
 * A `dashboard-events` config field: which of the dashboard's events this
 * widget marks, plus the dialog that edits the dashboard's events. The widget
 * stores only the ids; the events themselves live on the dashboard, shared.
 */
export function DashboardEventsField({
  tabId,
  fieldKey,
  field,
  config,
  onConfigChange,
}: {
  tabId: string
  fieldKey: string
  field: PluginConfigField
  config: Record<string, unknown>
  onConfigChange: (changes: Record<string, unknown>) => void
}) {
  const { t, i18n } = useTranslation()
  const lang = i18n.language as 'en' | 'fr'
  const dashboardId = useDashboardStore((s) => s.tabs.find((tab) => tab.id === tabId)?.dashboardId)
  const updateDashboard = useDashboardStore((s) => s.updateDashboard)
  const events = useTabDashboardEvents(tabId)
  const [dialogOpen, setDialogOpen] = useState(false)

  const selectField = useMemo<PluginConfigField>(() => ({
    ...field,
    type: 'select',
    multi: true,
    options: events.map((e) => ({
      value: e.id,
      label: {
        en: `${localized(e.label, 'en')} · ${formatEventDate(e.date, 'en')}`,
        fr: `${localized(e.label, 'fr')} · ${formatEventDate(e.date, 'fr')}`,
      },
    })),
  }), [field, events])

  const selected = Array.isArray(config[fieldKey]) ? (config[fieldKey] as string[]) : []

  const save = (next: DashboardEvent[]) => {
    if (!dashboardId) return
    updateDashboard(dashboardId, { events: next })
    // An event added from this chart is one the user wants on it.
    const before = new Set(events.map((e) => e.id))
    const added = next.filter((e) => !before.has(e.id)).map((e) => e.id)
    if (added.length > 0) onConfigChange({ [fieldKey]: [...selected, ...added] })
  }

  return (
    <div className="space-y-1.5">
      {events.length > 0 ? (
        <MultiSelectField
          fieldKey={fieldKey}
          field={selectField}
          value={config[fieldKey]}
          columns={[]}
          lang={lang}
          config={config}
          onConfigChange={onConfigChange}
        />
      ) : (
        <div className="space-y-1.5">
          <FieldLabel field={field} config={config} lang={lang} />
          <p className="text-xs text-muted-foreground">{t('dashboard.events_none_yet')}</p>
        </div>
      )}
      <Button variant="outline" size="sm-tight" onClick={() => setDialogOpen(true)} disabled={!dashboardId}>
        <CalendarClock />
        {t('dashboard.events_manage')}
      </Button>
      {dialogOpen && <DashboardEventsDialog events={events} onSave={save} onOpenChange={setDialogOpen} />}
    </div>
  )
}
