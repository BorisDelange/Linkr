import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, Copy, Trash2, X } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { ConceptDataTable, type ConceptColumn } from '@/components/ui/concept-data-table'
import {
  formatClipboardList,
  CLIPBOARD_COPY_FORMATS,
  CLIPBOARD_COPY_FORMAT_LABELS,
  type ClipboardCopyFormat,
} from '@/lib/concept-mapping/clipboard-list-format'
import type { SourceConceptRow } from '../MappingEditorTab'

interface ClipboardListModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  items: SourceConceptRow[]
  onRemove: (conceptId: number) => void
  onClear: () => void
  isFileSource?: boolean
}

export function ClipboardListModal({ open, onOpenChange, items, onRemove, onClear, isFileSource }: ClipboardListModalProps) {
  const { t } = useTranslation()
  const [format, setFormat] = useState<ClipboardCopyFormat>('sql')
  const [copied, setCopied] = useState(false)
  const [orderedItems, setOrderedItems] = useState<SourceConceptRow[]>(items)

  // The list is copied in display order (sorted + filtered), so what the user
  // sees in the table is exactly what lands on the clipboard.
  const handleCopy = async (rowsInOrder: SourceConceptRow[]) => {
    const text = formatClipboardList(rowsInOrder, format)
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1200)
    } catch {
      // Clipboard write can fail (permissions / non-secure context) — no-op.
    }
  }

  const columns = useMemo<ConceptColumn<SourceConceptRow>[]>(() => {
    const cols: ConceptColumn<SourceConceptRow>[] = [
      {
        id: 'terminology_name',
        header: t('concept_mapping.col_terminology'),
        accessor: (r) => r.terminology_name || r.vocabulary_id || '',
        filter: 'select',
        size: 120,
        minSize: 60,
      },
      {
        id: 'concept_id',
        header: t('concept_mapping.col_source_concept_id'),
        accessor: (r) => r.concept_id,
        cell: (r) => <span className="font-mono text-xs">{r.concept_id}</span>,
        filter: 'number',
        size: 90,
        minSize: 50,
      },
      {
        id: 'concept_name',
        header: t('concept_mapping.col_name'),
        accessor: (r) => r.concept_name,
        filter: 'text',
        size: 260,
        minSize: 100,
      },
    ]
    if (isFileSource) {
      cols.push({
        id: 'concept_code',
        header: t('concept_mapping.col_concept_code'),
        accessor: (r) => r.concept_code ?? '',
        filter: 'text',
        tooltip: 'font-mono',
        size: 120,
        minSize: 60,
      })
    }
    cols.push({
      id: '_remove',
      header: '',
      accessor: () => null,
      cell: (r) => (
        <button
          type="button"
          onClick={() => onRemove(r.concept_id)}
          className="flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-destructive"
          aria-label="Remove"
        >
          <X size={12} />
        </button>
      ),
      filter: 'none',
      sortable: false,
      resizable: false,
      size: 32,
      minSize: 32,
    })
    return cols
  }, [t, isFileSource, onRemove])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>{t('concept_mapping.clipboard_list_title')}</DialogTitle>
          <DialogDescription>
            {t('concept_mapping.clipboard_list_count', { count: items.length })}
          </DialogDescription>
        </DialogHeader>

        {items.length === 0 ? (
          <div className="py-8 text-center text-sm text-muted-foreground">
            <p>{t('concept_mapping.clipboard_list_empty')}</p>
            <p>{t('concept_mapping.clipboard_list_empty_hint')}</p>
          </div>
        ) : (
          <div className="max-h-[55vh] overflow-auto rounded border">
            <ConceptDataTable
              data={items}
              columns={columns}
              rowKey={(r) => r.concept_id}
              onVisibleRowsChange={setOrderedItems}
            />
          </div>
        )}

        <DialogFooter className="sm:justify-between">
          <Button
            variant="ghost"
            size="sm"
            className="gap-1.5 text-destructive hover:bg-destructive/10 hover:text-destructive"
            disabled={items.length === 0}
            onClick={onClear}
          >
            <Trash2 size={14} />
            {t('concept_mapping.clipboard_clear')}
          </Button>
          <div className="flex items-center gap-2">
            <Select value={format} onValueChange={(v) => setFormat(v as ClipboardCopyFormat)}>
              <SelectTrigger size="sm" className="w-[110px] text-xs" aria-label={t('concept_mapping.clipboard_copy_format')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CLIPBOARD_COPY_FORMATS.map((f) => (
                  <SelectItem key={f} value={f} className="text-xs">
                    {CLIPBOARD_COPY_FORMAT_LABELS[f]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button size="sm" className="gap-1.5" disabled={items.length === 0} onClick={() => handleCopy(orderedItems)}>
              {copied ? <Check size={14} /> : <Copy size={14} />}
              {copied ? t('concept_mapping.clipboard_copied') : t('concept_mapping.clipboard_copy')}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
