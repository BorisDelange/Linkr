import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ClipboardList, Settings2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DateTimeField } from '@/components/ui/date-time-field'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { useBooleanLabels } from '@/hooks/use-boolean-labels'
import { cn } from '@/lib/utils'
import { TypeBadge } from '@/features/projects/lab/datasets/TypeBadge'
import { cellInputValue, parseCellInput } from '@/features/projects/lab/datasets/use-cell-editing'
import type { DatasetCellValue } from '@linkr/format'
import type { DatasetColumn, PatientCollectionConfig } from '@/types'
import { usePatientCollection } from './use-patient-collection'
import { CollectionSetupDialog } from './CollectionSetupDialog'
import { violationOf } from './constraints'

interface Props {
  onClose: () => void
  projectUid: string
  boardId: string | undefined
  config: PatientCollectionConfig | undefined
  personId: string | null
  visitId: string | null
  visitDetailId: string | null
  canWrite: boolean
}

/** How long a field rests before an edit counts as pending, in manual mode. */
const DIRTY_DEBOUNCE_MS = 600

/**
 * The manual collection panel: the fields to fill for the patient whose chart is
 * open.
 *
 * Docked beside the patient sidebar rather than laid over the page, so the chart
 * being transcribed from stays visible and legible — a collector reads one and
 * fills the other, and an overlay that dims the source makes that the one thing you
 * cannot do.
 *
 * In `auto` mode each value is written as it is entered — a clinician filling a
 * form should not have to remember to commit it, and the log makes every entry
 * reversible anyway. In `manual` mode edits are held until Save, which suits a
 * form filled in one sitting, where a half-entered value should not reach the
 * dataset.
 */
export function CollectionSidebar({
  onClose, projectUid, boardId, config,
  personId, visitId, visitDetailId, canWrite,
}: Props) {
  const { t } = useTranslation()
  const booleanLabels = useBooleanLabels()
  const [setupOpen, setSetupOpen] = useState(false)
  const { fields, setValue } = usePatientCollection(config, {
    personId, visitId, visitDetailId,
  })

  const manual = config?.saveMode === 'manual'
  /** Unsaved edits by column id. Only ever populated in manual mode. */
  const [pending, setPending] = useState<Record<string, DatasetCellValue>>({})
  const [saving, setSaving] = useState(false)

  // A different patient is a different form: anything unsaved belonged to the one
  // just left, and carrying it over would file it under the wrong person.
  useEffect(() => { setPending({}) }, [personId, visitId, visitDetailId])

  const commit = useCallback((columnId: string, value: DatasetCellValue) => {
    if (manual) setPending((p) => ({ ...p, [columnId]: value }))
    else void setValue(columnId, value)
  }, [manual, setValue])

  const dirty = Object.keys(pending).length > 0

  const saveAll = useCallback(async () => {
    if (!dirty) return
    setSaving(true)
    try {
      for (const [columnId, value] of Object.entries(pending)) {
        await setValue(columnId, value)
      }
      setPending({})
    } finally {
      setSaving(false)
    }
  }, [dirty, pending, setValue])

  // Cmd/Ctrl+S saves, as it does in every editor. Bound on the panel rather than
  // the window so it only fires while the collector is actually working in here.
  const onKeyDown = (e: React.KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 's') {
      e.preventDefault()
      if (manual) void saveAll()
    }
  }

  // Keyed on the patient so switching person re-seeds the inputs; an uncontrolled
  // input keeps whatever the previous patient had in it.
  const patientKey = `${personId}:${visitId}:${visitDetailId}`

  return (
    <div className="flex h-full flex-col border-l bg-background" onKeyDown={onKeyDown}>
      <div className="flex shrink-0 items-center gap-2 border-b px-3 py-2.5">
        <ClipboardList size={14} className="shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium">
          {t('patient_data.collection')}
        </span>
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
        <Button variant="ghost" size="icon-xs" title={t('common.close')} onClick={onClose}>
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
              {fields.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  {t('patient_data.collection_no_variables')}
                </p>
              ) : (
                fields.map(({ column, value }) => (
                  <CollectionField
                    key={column.id}
                    column={column}
                    value={column.id in pending ? pending[column.id] : (value as DatasetCellValue)}
                    unsaved={column.id in pending}
                    disabled={!canWrite}
                    booleanLabels={booleanLabels}
                    inputKey={patientKey}
                    onCommit={(next) => commit(column.id, next)}
                    debounced={manual}
                  />
                ))
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

      {boardId && (
        <CollectionSetupDialog
          open={setupOpen}
          onOpenChange={setSetupOpen}
          projectUid={projectUid}
          boardId={boardId}
          config={config}
        />
      )}
    </div>
  )
}

interface FieldProps {
  column: DatasetColumn
  value: DatasetCellValue
  unsaved: boolean
  disabled: boolean
  booleanLabels: { true: string; false: string }
  inputKey: string
  onCommit: (value: DatasetCellValue) => void
  /** Debounce keystrokes into a commit, rather than waiting for blur. */
  debounced: boolean
}

/** One collected value, with its constraint feedback. */
function CollectionField({
  column, value, unsaved, disabled, booleanLabels, inputKey, onCommit, debounced,
}: FieldProps) {
  const { t } = useTranslation()
  const violation = useMemo(() => violationOf(column, value), [column, value])
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const cancelPendingCommit = () => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
  }
  useEffect(() => cancelPendingCommit, [])

  /** What the box shows. Controlled, and re-seeded whenever the patient changes:
   *  an uncontrolled input keeps whatever was typed, so switching patient mid-entry
   *  left the previous one's value on screen under the new one's name. */
  const [text, setText] = useState(() => cellInputValue(value))
  useEffect(() => {
    // A commit of ours is already on its way; re-seeding here would fight it.
    cancelPendingCommit()
    setText(cellInputValue(value))
    // Keyed on the patient, not on `value`: re-seeding on every value change would
    // overwrite what the user is typing the moment the first keystroke commits.
  }, [inputKey]) // eslint-disable-line react-hooks/exhaustive-deps

  /** Commit after a pause, so a half-typed value doesn't register as a change but a
   *  finished one doesn't wait for the user to leave the field either. */
  const commitSoon = (next: DatasetCellValue) => {
    cancelPendingCommit()
    timer.current = setTimeout(() => onCommit(next), DIRTY_DEBOUNCE_MS)
  }

  const label = (
    <Label className="flex items-center gap-1.5">
      <TypeBadge type={column.type} size="sm" />
      <span className="min-w-0 truncate leading-normal">{column.label ?? column.name}</span>
      {column.required && <span className="text-destructive">*</span>}
      {unsaved && (
        <span
          title={t('patient_data.collection_unsaved')}
          className="ml-auto size-1.5 shrink-0 rounded-full bg-primary"
        />
      )}
    </Label>
  )

  // An allowed-values list is a closed vocabulary, so it is a dropdown rather than a
  // free-text box: typing a value the variable does not admit is not a useful state
  // to be able to reach.
  const choices = column.allowedValues?.length ? column.allowedValues : null

  return (
    <div className="space-y-1">
      {label}
      {column.type === 'boolean' ? (
        <Select
          value={value == null ? '' : String(value)}
          onValueChange={(v) => onCommit(v === 'true')}
          disabled={disabled}
        >
          <SelectTrigger className="h-7 text-xs"><SelectValue placeholder="—" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="true">{booleanLabels.true}</SelectItem>
            <SelectItem value="false">{booleanLabels.false}</SelectItem>
          </SelectContent>
        </Select>
      ) : choices ? (
        <Select
          value={value == null ? '' : String(value)}
          onValueChange={(v) => onCommit(v)}
          disabled={disabled}
        >
          <SelectTrigger className="h-7 text-xs"><SelectValue placeholder="—" /></SelectTrigger>
          <SelectContent>
            {choices.map((choice) => (
              <SelectItem key={choice} value={choice}>{choice}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : column.type === 'date' ? (
        <DateTimeField
          withTime={column.withTime ?? false}
          value={value == null ? undefined : String(value)}
          onChange={(v) => onCommit(v ?? null)}
          disabled={disabled}
          min={column.min == null ? undefined : String(column.min)}
          max={column.max == null ? undefined : String(column.max)}
        />
      ) : (
        <Input
          className="h-7 text-xs"
          type={column.type === 'number' ? 'number' : 'text'}
          value={text}
          disabled={disabled}
          min={column.type === 'number' && column.min != null ? Number(column.min) : undefined}
          max={column.type === 'number' && column.max != null ? Number(column.max) : undefined}
          onChange={(e) => {
            setText(e.target.value)
            if (debounced) commitSoon(parseCellInput(e.target.value, column.type))
          }}
          // Blur still commits, so leaving a field never loses what is in it — the
          // debounce is what makes the change visible sooner, not what saves it.
          onBlur={(e) => {
            cancelPendingCommit()
            const next = parseCellInput(e.target.value, column.type)
            if (String(next ?? '') !== String(value ?? '')) onCommit(next)
          }}
          onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }}
        />
      )}
      {violation ? (
        <p className="text-[10px] text-destructive">{t(violation.key, violation.params)}</p>
      ) : column.description ? (
        <p className="text-[10px] text-muted-foreground">{column.description}</p>
      ) : null}
    </div>
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
