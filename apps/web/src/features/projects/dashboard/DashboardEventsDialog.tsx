import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CalendarClock, Plus, Trash2 } from 'lucide-react'
import { DialogShell } from '@/components/ui/dialog-shell'
import { FieldInfo } from '@/components/ui/field-info'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import { DateTimeField } from '@/components/ui/date-time-field'
import { ColorPickerPopover } from '@/components/ui/color-picker-popover'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
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
import { useSaveForm } from '@/hooks/use-save-form'
import { cleanLocalized, localized, localizedRaw, seedLocalizedForEditing, setLocalized } from '@/lib/localized'
import type { DashboardEvent } from '@/types'
import { DEFAULT_EVENT_COLOR, isCompleteEvent, normalizeEvents } from '@/lib/dashboard-events'

/** Colours a new event takes in turn, so neighbouring markers stay apart. */
const NEW_EVENT_COLORS = [DEFAULT_EVENT_COLOR, 'amber', 'emerald', 'pink', 'sky', 'slate']

/** Date+time, label, colour, delete: one event per line. */
const ROW_GRID = 'grid grid-cols-[17rem_minmax(0,1fr)_6.5rem_1.75rem] items-center gap-2'

function today(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/**
 * Add, edit and delete a dashboard's events. They belong to the dashboard, not
 * to the widget the dialog was opened from: every chart of the dashboard can
 * pick them, so a change here shows on each chart that selected the event.
 *
 * The label is edited in the app's language only, as every multilingual field
 * is; the other language keeps what it holds.
 */
export function DashboardEventsDialog({
  events,
  onSave,
  onOpenChange,
}: {
  events: DashboardEvent[]
  onSave: (events: DashboardEvent[]) => void
  onOpenChange: (open: boolean) => void
}) {
  const { t, i18n } = useTranslation()
  const language = i18n.language
  // Seeded so a language never entered starts from the other one; the seeded
  // list is also the baseline, so pre-filling does not open the dialog dirty.
  const seeded = useMemo(
    () => events.map((e) => ({ ...e, label: seedLocalizedForEditing(e.label, language) })),
    [events, language],
  )
  const [draft, setDraft] = useState<DashboardEvent[]>(seeded)
  const [pendingDelete, setPendingDelete] = useState<DashboardEvent | null>(null)

  const update = (id: string, changes: Partial<DashboardEvent>) =>
    setDraft((list) => list.map((e) => (e.id === id ? { ...e, ...changes } : e)))

  const remove = (id: string) => setDraft((list) => list.filter((e) => e.id !== id))

  // A row just added and still blank holds nothing to lose, so it goes at once.
  const requestDelete = (event: DashboardEvent) => {
    const stored = events.some((e) => e.id === event.id)
    if (!stored && cleanLocalized(event.label) === undefined) remove(event.id)
    else setPendingDelete(event)
  }

  const add = () =>
    setDraft((list) => {
      const used = new Set(list.map((e) => e.color))
      const color = NEW_EVENT_COLORS.find((c) => !used.has(c)) ?? DEFAULT_EVENT_COLOR
      return [...list, { id: crypto.randomUUID(), date: today(), label: {}, color }]
    })

  const complete = draft.every(isCompleteEvent)
  const { canSaveNow, save } = useSaveForm({
    current: draft,
    baseline: seeded,
    onSave: () => {
      onSave(normalizeEvents(draft))
      onOpenChange(false)
    },
    canSave: complete,
  })

  return (
    <>
      <DialogShell
        open
        onOpenChange={onOpenChange}
        kind="settings"
        className="sm:max-w-3xl"
        title={
          <span className="inline-flex items-center gap-1.5">
            {t('dashboard.events_title')}
            <FieldInfo text={t('dashboard.events_description')} />
          </span>
        }
        onConfirm={save}
        confirmLabel={t('common.save')}
        confirmDisabled={!canSaveNow}
        dirtyTracked
      >
        {draft.length === 0 ? (
          <div className="flex flex-col items-center gap-1.5 rounded-md border border-dashed py-6 text-center text-muted-foreground">
            <CalendarClock size={18} />
            <p className="text-sm">{t('dashboard.events_empty')}</p>
          </div>
        ) : (
          <div className="space-y-1.5">
            <div className={ROW_GRID}>
              <Label>{t('dashboard.events_field_date')}</Label>
              <Label>{t('dashboard.events_field_label')}</Label>
              <Label>{t('dashboard.events_field_color')}</Label>
              <span />
            </div>
            <div className="max-h-[55vh] space-y-1.5 overflow-y-auto">
              {draft.map((event) => (
                <div key={event.id} className={ROW_GRID}>
                  <DateTimeField
                    withTime
                    value={event.date || undefined}
                    onChange={(value) => update(event.id, { date: value ?? '' })}
                  />
                  <Input
                    aria-label={t('dashboard.events_field_label')}
                    className="h-7 text-xs"
                    value={localizedRaw(event.label, language)}
                    onChange={(e) => update(event.id, { label: setLocalized(event.label, language, e.target.value) })}
                  />
                  <ColorPickerPopover value={event.color} onChange={(color) => update(event.id, { color })} />
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon-sm-tight"
                          onClick={() => requestDelete(event)}
                          aria-label={t('dashboard.events_delete')}
                        >
                          <Trash2 />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>{t('dashboard.events_delete')}</TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                </div>
              ))}
            </div>
          </div>
        )}
        <div className="flex items-center justify-between gap-2">
          <Button variant="outline" size="sm-tight" onClick={add}>
            <Plus />
            {t('dashboard.events_add')}
          </Button>
          {!complete && <p className="text-xs text-destructive">{t('dashboard.events_incomplete')}</p>}
        </div>
      </DialogShell>
      {/* Outside the shell: React bubbles key events through portals, and the
          shell's Enter-to-save would fire on the confirmation's Enter. */}
      <AlertDialog open={pendingDelete !== null} onOpenChange={(o) => { if (!o) setPendingDelete(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('dashboard.events_delete_title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('dashboard.events_delete_description', {
                name: (pendingDelete && localized(pendingDelete.label, language)) || t('dashboard.events_untitled'),
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (pendingDelete) remove(pendingDelete.id)
                setPendingDelete(null)
              }}
            >
              {t('common.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
