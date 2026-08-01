import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { ScrollArea } from '@/components/ui/scroll-area'
import { fetchColumnDistinct } from '@/lib/api/datasets'
import { CATEGORICAL_MAX_DISTINCT } from './use-column-distinct'
import { isServerMode } from '@/lib/api-client'
import { useDatasetStore } from '@/stores/dataset-store'
import type { DatasetColumn } from '@/types'

interface Props {
  fileId: string
  column: DatasetColumn
  /** In-memory rows (local mode) used to derive distinct values without a round-trip. */
  rows: Record<string, unknown>[]
  open: boolean
  onOpenChange: (open: boolean) => void
}

/** Categorical columns get a value-label editor; numeric/boolean/date don't. */
function isCategorical(col: DatasetColumn): boolean {
  return col.type === 'string' || col.type === 'unknown'
}

export function EditColumnMetaDialog({ fileId, column, rows, open, onOpenChange }: Props) {
  const { t } = useTranslation()
  const updateColumnMeta = useDatasetStore((s) => s.updateColumnMeta)

  // The parent remounts this dialog per column (key={column.id}), so props-derived
  // initial state is safe and no reset effect is needed.
  const [label, setLabel] = useState(column.label ?? '')
  const [description, setDescription] = useState(column.description ?? '')
  const [valueLabels, setValueLabels] = useState<Record<string, string>>(column.valueLabels ?? {})
  // Server-fetched distinct codes (server mode only); local mode derives them from rows below.
  const [serverDistinct, setServerDistinct] = useState<string[]>([])

  const categorical = isCategorical(column)

  // Local mode: distinct codes are derived state from the in-memory rows, not an
  // external system — compute with useMemo rather than an effect.
  const localDistinct = useMemo(() => {
    if (!categorical || isServerMode()) return []
    const seen = new Set<string>()
    for (const row of rows) {
      const v = row[column.id]
      if (v == null || v === '') continue
      seen.add(String(v))
      if (seen.size > CATEGORICAL_MAX_DISTINCT) break
    }
    return [...seen]
  }, [categorical, rows, column.id])

  // Server mode: fetch DISTINCT once when the dialog opens.
  useEffect(() => {
    if (!open || !categorical || !isServerMode()) return
    let cancelled = false
    fetchColumnDistinct(fileId, column.id, { limit: CATEGORICAL_MAX_DISTINCT })
      .then((res) => { if (!cancelled) setServerDistinct(res.values) })
      .catch(() => { if (!cancelled) setServerDistinct([]) })
    return () => { cancelled = true }
  }, [open, fileId, column.id, categorical])

  // Union of live distinct codes and any already-mapped codes (kept even if a code
  // no longer appears in the data), so an existing mapping is never silently dropped.
  const codes = useMemo(() => {
    const set = new Set<string>([...localDistinct, ...serverDistinct])
    for (const code of Object.keys(column.valueLabels ?? {})) set.add(code)
    return [...set].sort((a, b) => a.localeCompare(b))
  }, [localDistinct, serverDistinct, column.valueLabels])

  const handleSave = () => {
    updateColumnMeta(fileId, column.id, { label, description, valueLabels })
    onOpenChange(false)
  }

  // Cmd/Ctrl+S saves the dialog, matching the save shortcut used across the app.
  // A ref holds the latest submit intent so the listener stays stable across renders.
  const submitRef = useRef<() => void>(() => {})
  useEffect(() => { submitRef.current = handleSave })
  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault()
        submitRef.current()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [open])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('datasets.col_meta_title')}</DialogTitle>
          <DialogDescription>
            {t('datasets.col_meta_desc', { name: column.name })}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="col-label" className="text-xs">{t('datasets.col_meta_label')}</Label>
            <Input
              id="col-label"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder={column.name}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="col-description" className="text-xs">{t('datasets.col_meta_description')}</Label>
            <Textarea
              id="col-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
            />
          </div>

          {categorical && codes.length > 0 && (
            <div className="space-y-1.5">
              <Label className="text-xs">{t('datasets.col_meta_value_labels')}</Label>
              <p className="text-xs text-muted-foreground">{t('datasets.col_meta_value_labels_hint')}</p>
              <ScrollArea className="max-h-56 rounded-md border">
                <div className="divide-y">
                  {codes.map((code) => (
                    <div key={code} className="flex items-center gap-2 px-2 py-1.5">
                      <code className="w-2/5 shrink-0 truncate rounded bg-muted px-1.5 py-0.5 text-xs" title={code}>
                        {code}
                      </code>
                      <Input
                        value={valueLabels[code] ?? ''}
                        onChange={(e) => setValueLabels((prev) => ({ ...prev, [code]: e.target.value }))}
                        placeholder={code}
                        className="h-7 text-xs"
                      />
                    </div>
                  ))}
                </div>
              </ScrollArea>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('common.cancel')}
          </Button>
          <Button onClick={handleSave}>{t('common.save')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
