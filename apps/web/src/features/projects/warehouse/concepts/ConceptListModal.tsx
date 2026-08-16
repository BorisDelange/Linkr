import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, Copy, Trash2, X } from 'lucide-react'
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  CLIPBOARD_COPY_FORMATS,
  formatClipboardList,
  type ClipboardCopyFormat,
} from '@/lib/concept-mapping/clipboard-list-format'
import type { ConceptRow } from './use-concepts'

interface ConceptListModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  concepts: ConceptRow[]
  onRemove: (conceptId: number) => void
  onClear: () => void
}

/** The scratch list of concepts gathered while browsing, with the same
 *  SQL/R/Python copy formats as the mapping editor's clipboard list. */
export function ConceptListModal({
  open,
  onOpenChange,
  concepts,
  onRemove,
  onClear,
}: ConceptListModalProps) {
  const { t } = useTranslation()
  const [format, setFormat] = useState<ClipboardCopyFormat>('sql')
  const [copied, setCopied] = useState(false)

  const handleCopy = async () => {
    const text = formatClipboardList(
      concepts.map((c) => ({
        concept_code: c.concept_code != null ? String(c.concept_code) : undefined,
        concept_name: c.concept_name,
        vocabulary_id: c.vocabulary_id != null ? String(c.vocabulary_id) : undefined,
      })),
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
          <DialogTitle className="text-sm">
            {t('concept_mapping.clipboard_list_title')}
          </DialogTitle>
        </DialogHeader>

        {concepts.length === 0 ? (
          <p className="py-8 text-center text-xs text-muted-foreground">
            {t('concepts.list_empty')}
          </p>
        ) : (
          <div className="min-h-0 flex-1 overflow-auto rounded border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-xs">{t('concepts.column_id')}</TableHead>
                  <TableHead className="text-xs">{t('concepts.column_name')}</TableHead>
                  <TableHead className="text-xs">{t('concepts.column_code')}</TableHead>
                  <TableHead className="text-xs">{t('concepts.column_vocabulary')}</TableHead>
                  <TableHead className="w-8" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {concepts.map((c) => (
                  <TableRow key={c.concept_id}>
                    <TableCell className="font-mono text-xs">{c.concept_id}</TableCell>
                    <TableCell className="text-xs">{c.concept_name}</TableCell>
                    <TableCell className="font-mono text-xs">
                      {c.concept_code != null ? String(c.concept_code) : ''}
                    </TableCell>
                    <TableCell className="text-xs">
                      {c.vocabulary_id != null ? String(c.vocabulary_id) : ''}
                    </TableCell>
                    <TableCell className="p-1">
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        onClick={() => onRemove(c.concept_id)}
                        aria-label={t('common.remove')}
                      >
                        <X size={12} />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}

        <div className="flex shrink-0 items-center justify-between gap-2 pt-2">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1 text-xs"
            onClick={onClear}
            disabled={concepts.length === 0}
          >
            <Trash2 size={12} />
            {t('common.clear')}
          </Button>
          <div className="flex items-center gap-2">
            <Select value={format} onValueChange={(v) => setFormat(v as ClipboardCopyFormat)}>
              <SelectTrigger size="sm" className="w-[110px] text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CLIPBOARD_COPY_FORMATS.map((f) => (
                  <SelectItem key={f} value={f} className="text-xs">
                    {f.toUpperCase()}
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
