import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ClipboardList, Settings2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { useBooleanLabels } from '@/hooks/use-boolean-labels'
import { TypeBadge } from '@/features/projects/lab/datasets/TypeBadge'
import { cellInputValue, parseCellInput } from '@/features/projects/lab/datasets/use-cell-editing'
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

/**
 * The manual data collection panel: the fields to fill for the patient whose
 * chart is open.
 *
 * Each value is written straight into the bound dataset as an edit op — no draft,
 * no separate save. A clinician filling a form should not have to remember to
 * commit it, and the log makes every entry reversible anyway.
 */
export function CollectionSidebar({
  open, onOpenChange, projectUid, boardId, config,
  personId, visitId, visitDetailId, canWrite,
}: Props) {
  const { t } = useTranslation()
  const booleanLabels = useBooleanLabels()
  const [setupOpen, setSetupOpen] = useState(false)
  const { dataset, fields, setValue } = usePatientCollection(config, {
    personId, visitId, visitDetailId,
  })

  return (
    <>
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent side="right" className="flex w-[340px] flex-col gap-0 p-0 sm:max-w-none">
          <SheetHeader className="flex-row items-center justify-between space-y-0 border-b px-3 py-2.5">
            <SheetTitle className="flex items-center gap-2">
              <ClipboardList size={14} />
              {t('patient_data.collection')}
            </SheetTitle>
            {/* Sheet renders its own close at top-4 right-4, so this sits clear of
                it rather than underneath. */}
            {canWrite && (
              <Button
                variant="ghost"
                size="xs"
                className="mr-6"
                onClick={() => setSetupOpen(true)}
              >
                <Settings2 className="size-3.5" />
                <span className="ml-1">{t('patient_data.collection_variables')}</span>
              </Button>
            )}
          </SheetHeader>

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
                  fields.map(({ column, value }) => (
                    <div key={column.id} className="space-y-1">
                      <Label className="flex items-center gap-1.5">
                        <TypeBadge type={column.type} size="sm" />
                        {column.label ?? column.name}
                      </Label>
                      {column.type === 'boolean' ? (
                        <Select
                          value={value == null ? '' : String(value)}
                          onValueChange={(v) => void setValue(column.id, v === 'true')}
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
                          className="h-7 text-xs"
                          type={column.type === 'date' ? 'date' : column.type === 'number' ? 'number' : 'text'}
                          defaultValue={cellInputValue(value)}
                          disabled={!canWrite}
                          // Written on blur, not per keystroke: one op per value
                          // entered, rather than one per character typed.
                          onBlur={(e) => {
                            const next = parseCellInput(e.target.value, column.type)
                            if (String(next ?? '') !== String(value ?? '')) {
                              void setValue(column.id, next)
                            }
                          }}
                          onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }}
                        />
                      )}
                      {column.description && (
                        <p className="text-[10px] text-muted-foreground">{column.description}</p>
                      )}
                    </div>
                  ))
                )}
              </div>
            </ScrollArea>
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
