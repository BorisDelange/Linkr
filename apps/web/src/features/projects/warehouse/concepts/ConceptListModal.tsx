import { useState, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, Copy, Pencil, Plus, Trash2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  ConceptDataTable,
  type ConceptColumn,
} from '@/components/ui/concept-data-table'
import {
  CLIPBOARD_COPY_FORMATS,
  CLIPBOARD_COPY_FORMAT_LABELS,
  formatClipboardList,
  type ClipboardCopyFormat,
} from '@/lib/concept-mapping/clipboard-list-format'
import { columnLabel } from '@/lib/format-helpers'
import { localized } from '@/lib/localized'
import type { ConceptRow } from './use-concepts'
import type { ConceptList } from '@/types'

/** Which identifier the copied snippet carries. */
type CopyField = 'concept_id' | 'concept_code'

interface ConceptListModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  concepts: ConceptRow[]
  onRemove: (conceptId: number) => void
  onClear: () => void
  /** False when the source has no code column (MIMIC's d_items and the like):
   *  copying codes would emit empty strings, so only ids are offered. */
  hasCodeColumn: boolean
  /** Which column names the concept's terminology, mirroring the table's first
   *  column: `vocabulary_id` when the source has one, else `_dict_key` (the
   *  dictionary the row came from), else neither. */
  terminologyColumn: 'vocabulary_id' | '_dict_key' | null
  /** Saved lists for this project, and which one is being shown. */
  lists: ConceptList[]
  activeListId: string | undefined
  onSelectList: (listId: string) => void
  onCreateList: () => void
  onEditList: (list: ConceptList) => void
  onDeleteList: (list: ConceptList) => void
}

/** The scratch list of concepts gathered while browsing, with the same
 *  SQL/R/Python copy formats as the mapping editor's clipboard list. */
export function ConceptListModal({
  open,
  onOpenChange,
  concepts,
  onRemove,
  onClear,
  hasCodeColumn,
  terminologyColumn,
  lists,
  activeListId,
  onSelectList,
  onCreateList,
  onEditList,
  onDeleteList,
}: ConceptListModalProps) {
  const { t, i18n } = useTranslation()
  const activeList = lists.find((l) => l.id === activeListId) ?? null
  const activeListDescription = activeList
    ? localized(activeList.description, i18n.language)
    : ''
  const [format, setFormat] = useState<ClipboardCopyFormat>('sql')
  const [rawField, setField] = useState<CopyField>('concept_id')
  const [copied, setCopied] = useState(false)
  // Without a code column there is nothing to choose between.
  const field: CopyField = hasCodeColumn ? rawField : 'concept_id'

  // Same column set and order as the Concepts table — terminology first, then
  // id / name / code — plus a remove action.
  const columns = useMemo<ConceptColumn<ConceptRow>[]>(() => {
    const cols: ConceptColumn<ConceptRow>[] = []
    if (terminologyColumn) {
      cols.push({
        id: terminologyColumn,
        header: columnLabel(terminologyColumn),
        accessor: (c) => (c[terminologyColumn] as string | undefined) ?? '',
        filter: 'select',
        size: 120,
      })
    }
    cols.push({
      id: 'concept_id',
      header: t('concepts.column_id'),
      accessor: (c) => c.concept_id,
      cell: (c) => <span className="font-mono">{c.concept_id}</span>,
      tooltip: 'font-mono',
      filter: 'number',
      size: 100,
    })
    cols.push({
      id: 'concept_name',
      header: t('concepts.column_name'),
      accessor: (c) => c.concept_name,
      filter: 'text',
      size: 260,
    })
    if (hasCodeColumn) {
      cols.push({
        id: 'concept_code',
        header: t('concepts.column_code'),
        accessor: (c) => (c.concept_code as string | undefined) ?? '',
        cell: (c) => <span className="font-mono">{String(c.concept_code ?? '')}</span>,
        tooltip: 'font-mono',
        filter: 'text',
        size: 120,
      })
    }
    cols.push({
      id: '_remove',
      header: '',
      accessor: () => '',
      sortable: false,
      size: 44,
      minSize: 44,
      center: true,
      // A size-6 icon button would make every row taller than the Concepts
      // table's text-only rows, so it is sized to the line instead.
      cell: (c) => (
        <button
          type="button"
          className="flex size-4 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-destructive"
          onClick={() => onRemove(c.concept_id)}
          aria-label={t('common.remove')}
        >
          <X size={11} />
        </button>
      ),
    })
    return cols
  }, [terminologyColumn, hasCodeColumn, onRemove, t])

  const handleCopy = async () => {
    // The shared formatter emits `concept_code`, so the chosen field is mapped
    // onto it — a concept_id is just a numeric code as far as it is concerned
    // (and stays unquoted, which is what an OMOP IN-list wants).
    const text = formatClipboardList(
      concepts.map((c) => {
        // The comment names the terminology; on a source without vocabulary_id
        // that is the dictionary key, same as the column shown above.
        const terminology = terminologyColumn ? c[terminologyColumn] : null
        return {
          concept_code: String(field === 'concept_id' ? c.concept_id : (c.concept_code ?? '')),
          concept_name: c.concept_name,
          vocabulary_id: terminology != null ? String(terminology) : undefined,
        }
      }),
      format,
    )
    await navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[80vh] flex-col sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{t('concept_mapping.clipboard_list_title')}</DialogTitle>
        </DialogHeader>

        {/* List picker: which saved list is shown, plus its lifecycle actions. */}
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <Select
            value={activeListId ?? ''}
            onValueChange={(v) => onSelectList(v)}
            disabled={lists.length === 0}
          >
            <SelectTrigger size="sm" className="w-[240px] text-xs">
              <SelectValue placeholder={t('concepts.list_none')} />
            </SelectTrigger>
            <SelectContent>
              {lists.map((l) => (
                <SelectItem key={l.id} value={l.id} className="text-xs">
                  {localized(l.name, i18n.language) || t('concepts.list_untitled')}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Button
            variant="outline"
            size="sm"
            className="h-8 gap-1 text-xs"
            onClick={onCreateList}
          >
            <Plus size={12} />
            {t('concepts.list_new')}
          </Button>

          {activeList && (
            <>
              <Button
                variant="ghost"
                size="icon-sm"
                className="h-8 w-8"
                onClick={() => onEditList(activeList)}
                aria-label={t('common.edit')}
              >
                <Pencil size={13} />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                className="h-8 w-8 text-destructive hover:bg-destructive/10 hover:text-destructive"
                onClick={() => onDeleteList(activeList)}
                aria-label={t('common.delete')}
              >
                <Trash2 size={13} />
              </Button>
            </>
          )}
        </div>

        {activeListDescription && (
          <p className="shrink-0 text-xs text-muted-foreground">{activeListDescription}</p>
        )}

        <div className="min-h-0 flex-1 overflow-hidden">
          <ConceptDataTable
            data={concepts}
            columns={columns}
            rowKey={(c) => c.concept_id}
            emptyMessage={t('concepts.list_empty')}
          />
        </div>

        <div className="flex shrink-0 items-center justify-between gap-2 pt-2">
          <Button
            variant="ghost"
            size="sm-tight"
            className="text-destructive hover:bg-destructive/10 hover:text-destructive"
            onClick={onClear}
            disabled={concepts.length === 0}
          >
            <Trash2 size={12} />
            {t('common.clear')}
          </Button>
          <div className="flex items-center gap-2">
            {hasCodeColumn && (
              <Select value={field} onValueChange={(v) => setField(v as CopyField)}>
                <SelectTrigger size="sm" className="w-[140px] text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="concept_id" className="text-xs">
                    {t('concepts.column_id')}
                  </SelectItem>
                  <SelectItem value="concept_code" className="text-xs">
                    {t('concepts.column_code')}
                  </SelectItem>
                </SelectContent>
              </Select>
            )}
            <Select value={format} onValueChange={(v) => setFormat(v as ClipboardCopyFormat)}>
              <SelectTrigger size="sm" className="w-[110px] text-xs">
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
            <Button
              size="sm"
              className="h-8 gap-1 text-xs"
              onClick={handleCopy}
              disabled={concepts.length === 0}
            >
              {copied ? <Check size={12} /> : <Copy size={12} />}
              {t('common.copy')}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
