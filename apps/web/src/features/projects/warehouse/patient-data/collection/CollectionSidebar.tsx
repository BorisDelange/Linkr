import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ClipboardList, Settings2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet'
import { useBooleanLabels } from '@/hooks/use-boolean-labels'
import { cn } from '@/lib/utils'
import { TypeBadge } from '@/features/projects/lab/datasets/TypeBadge'
import { cellInputValue, parseCellInput } from '@/features/projects/lab/datasets/use-cell-editing'
import type { DatasetCellValue } from '@linkr/format'
import type { PatientCollectionConfig } from '@/types'
import { usePatientCollection } from './use-patient-collection'
import { CollectionSetupDialog } from './CollectionSetupDialog'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  projectUid: string
  boardId: string | undefined
  config: PatientCollectionConfig | undefined
  personId: string | null
  visitId: string | null
  visitDetailId: string | null
  canWrite: boolean
}

const MIN_WIDTH = 280
const MAX_WIDTH = 720
const DEFAULT_WIDTH = 340
const WIDTH_KEY = 'linkr.collection-sidebar-width'

/**
 * The manual collection panel: the fields to fill for the patient whose chart is
 * open.
 *
 * In `auto` mode each value is written as it is entered — a clinician filling a
 * form should not have to remember to commit it, and the log makes every entry
 * reversible anyway. In `manual` mode edits are held until Save, which suits a
 * form filled in one sitting, where a half-entered value should not reach the
 * dataset.
 */
export function CollectionSidebar({
  open, onOpenChange, projectUid, boardId, config,
  personId, visitId, visitDetailId, canWrite,
}: Props) {
  const { t } = useTranslation()
  const booleanLabels = useBooleanLabels()
  const [setupOpen, setSetupOpen] = useState(false)
  const [width, setWidth] = useState(readStoredWidth)
  const { dataset, fields, setValue } = usePatientCollection(config, {
    personId, visitId, visitDetailId,
  })

  const manual = config?.saveMode === 'manual'
  /** Unsaved edits by column id. Only ever populated in manual mode. */
  const [pending, setPending] = useState<Record<string, DatasetCellValue>>({})
  const [saving, setSaving] = useState(false)

  // A different patient is a different form: anything unsaved belonged to the one
  // just left, and carrying it over would file it under the wrong person.
  useEffect(() => { setPending({}) }, [personId, visitId, visitDetailId])

  const commit = (columnId: string, value: DatasetCellValue) => {
    if (manual) setPending((p) => ({ ...p, [columnId]: value }))
    else void setValue(columnId, value)
  }

  const saveAll = async () => {
    setSaving(true)
    try {
      for (const [columnId, value] of Object.entries(pending)) {
        await setValue(columnId, value)
      }
      setPending({})
    } finally {
      setSaving(false)
    }
  }

  const startResize = useResizer(width, setWidth)
  const dirty = Object.keys(pending).length > 0
  // Keyed on the patient so switching person re-seeds the inputs; an uncontrolled
  // input keeps whatever the previous patient had in it.
  const patientKey = `${personId}:${visitId}:${visitDetailId}`

  return (
    <>
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent
          side="right"
          showCloseButton={false}
          className="flex flex-col gap-0 p-0 sm:max-w-none"
          style={{ width }}
        >
          {/* Drag handle on the inner edge — a right-hand sheet grows leftwards. */}
          <div
            onMouseDown={startResize}
            className="absolute inset-y-0 left-0 z-20 w-1 cursor-col-resize hover:bg-primary/40"
          />

          <div className="flex shrink-0 items-center gap-2 border-b px-3 py-2.5">
            <ClipboardList size={14} className="shrink-0 text-muted-foreground" />
            <SheetTitle className="min-w-0 flex-1 truncate">
              {t('patient_data.collection')}
            </SheetTitle>
            {canWrite && (
              <Button
                variant="ghost"
                size="icon-xs"
                title={t('patient_data.collection_setup')}
                onClick={() => setSetupOpen(true)}
              >
                <Settings2 className="size-3.5" />
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon-xs"
              title={t('common.close')}
              onClick={() => onOpenChange(false)}
            >
              <X className="size-3.5" />
            </Button>
          </div>

          {!config?.datasetFileId ? (
            <EmptyState
              message={t('patient_data.collection_not_configured')}
              action={canWrite ? (
                <Button size="sm" onClick={() => setSetupOpen(true)}>
                  {t('patient_data.collection_configure')}
                </Button>
              ) : null}
            />
          ) : !personId ? (
            <EmptyState message={t('patient_data.select_patient_first')} />
          ) : (
            <>
              <ScrollArea className="min-h-0 flex-1">
                <div className="space-y-3 px-3 py-3">
                  <p className="text-[10px] text-muted-foreground">
                    {t('patient_data.collection_writes_to', { name: dataset?.name ?? '' })}
                  </p>
                  {fields.length === 0 ? (
                    <p className="text-xs text-muted-foreground">
                      {t('patient_data.collection_no_variables')}
                    </p>
                  ) : (
                    fields.map(({ column, value }) => {
                      const shown = column.id in pending ? pending[column.id] : value
                      return (
                        <div key={column.id} className="space-y-1">
                          <Label className="flex items-center gap-1.5">
                            <TypeBadge type={column.type} size="sm" />
                            <span className="min-w-0 truncate">{column.label ?? column.name}</span>
                            {column.id in pending && (
                              <span
                                title={t('patient_data.collection_unsaved')}
                                className="ml-auto size-1.5 shrink-0 rounded-full bg-primary"
                              />
                            )}
                          </Label>
                          {column.type === 'boolean' ? (
                            <Select
                              value={shown == null ? '' : String(shown)}
                              onValueChange={(v) => commit(column.id, v === 'true')}
                              disabled={!canWrite}
                            >
                              <SelectTrigger className="h-7 text-xs">
                                <SelectValue placeholder="—" />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="true">{booleanLabels.true}</SelectItem>
                                <SelectItem value="false">{booleanLabels.false}</SelectItem>
                              </SelectContent>
                            </Select>
                          ) : (
                            <Input
                              key={patientKey}
                              className="h-7 text-xs"
                              type={column.type === 'date' ? 'date' : column.type === 'number' ? 'number' : 'text'}
                              defaultValue={cellInputValue(shown)}
                              disabled={!canWrite}
                              // On blur, not per keystroke: one entry per value.
                              onBlur={(e) => {
                                const next = parseCellInput(e.target.value, column.type)
                                if (String(next ?? '') !== String(shown ?? '')) commit(column.id, next)
                              }}
                              onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }}
                            />
                          )}
                          {column.description && (
                            <p className="text-[10px] text-muted-foreground">{column.description}</p>
                          )}
                        </div>
                      )
                    })
                  )}
                </div>
              </ScrollArea>

              {manual && canWrite && (
                <div className={cn(
                  'flex shrink-0 items-center justify-end gap-2 border-t px-3 py-2',
                  !dirty && 'opacity-60',
                )}>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={!dirty || saving}
                    onClick={() => setPending({})}
                  >
                    {t('common.cancel')}
                  </Button>
                  <Button size="sm" disabled={!dirty || saving} onClick={() => void saveAll()}>
                    {t('common.save')}
                  </Button>
                </div>
              )}
            </>
          )}
        </SheetContent>
      </Sheet>

      {boardId && (
        <CollectionSetupDialog
          open={setupOpen}
          onOpenChange={setSetupOpen}
          projectUid={projectUid}
          boardId={boardId}
          config={config}
        />
      )}
    </>
  )
}

function EmptyState({ message, action }: { message: string; action?: React.ReactNode }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
      <p className="text-xs text-muted-foreground">{message}</p>
      {action}
    </div>
  )
}

function readStoredWidth(): number {
  // Wrapped: a private window or blocked site data makes this throw, and a sidebar
  // that cannot remember its width should still open.
  try {
    const stored = Number(localStorage.getItem(WIDTH_KEY))
    if (Number.isFinite(stored) && stored >= MIN_WIDTH) return Math.min(stored, MAX_WIDTH)
  } catch { /* no stored preference */ }
  return DEFAULT_WIDTH
}

/** Drag-to-resize, persisting the chosen width for next time. */
function useResizer(width: number, setWidth: (w: number) => void) {
  // Mirrored so the drag handlers read the live width without re-binding on every
  // pixel of movement.
  const widthRef = useRef(width)
  useEffect(() => { widthRef.current = width }, [width])

  return useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    const startX = e.clientX
    const startWidth = widthRef.current

    const onMove = (ev: MouseEvent) => {
      // The sheet is anchored right, so dragging left (a negative delta) widens it.
      const next = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, startWidth - (ev.clientX - startX)))
      setWidth(next)
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      try { localStorage.setItem(WIDTH_KEY, String(widthRef.current)) } catch { /* not persisted */ }
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [setWidth])
}
