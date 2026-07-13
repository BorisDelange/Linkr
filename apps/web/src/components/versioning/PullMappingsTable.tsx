import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CheckSquare, Square } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { cn } from '@/lib/utils'
import type { MappingChange } from '@/lib/concept-mapping/merge'
import type { ConceptMapping } from '@/types'

interface PullMappingsTableProps {
  changes: MappingChange[]
  /** Keys currently kept (clean changes ticked / conflicts resolved as 'remote'). */
  selected: Set<string>
  /** Per-conflict choice; a conflict counts as "selected" when it's 'remote'. */
  conflictChoices: Record<string, 'remote' | 'local'>
  onClose: () => void
  /** Commit the edited selection + conflict choices back to the parent. */
  onApply: (selected: Set<string>, conflictChoices: Record<string, 'remote' | 'local'>) => void
}

const CHANGE_CLS: Record<MappingChange['type'], string> = {
  add: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
  update: 'bg-sky-500/15 text-sky-700 dark:text-sky-400',
  delete: 'bg-rose-500/15 text-rose-700 dark:text-rose-400',
  conflict: 'bg-amber-500/15 text-amber-700 dark:text-amber-400',
}

function field(m: ConceptMapping | null, pick: (m: ConceptMapping) => string | number | undefined): string {
  if (!m) return '—'
  const v = pick(m)
  return v == null || v === '' ? '—' : String(v)
}

/**
 * Full-size datatable to pick exactly which mapping changes to pull, when there
 * are too many for the inline summary. Same visual language as the mapping tables
 * elsewhere (source/target columns, status), plus a change-type column and a
 * per-conflict mine/theirs toggle. Select-all / none at the top.
 */
export function PullMappingsTable({ changes, selected, conflictChoices, onClose, onApply }: PullMappingsTableProps) {
  const { t } = useTranslation()
  const [sel, setSel] = useState<Set<string>>(new Set(selected))
  const [choices, setChoices] = useState<Record<string, 'remote' | 'local'>>({ ...conflictChoices })
  const [filter, setFilter] = useState('')

  const rows = useMemo(() => {
    const q = filter.trim().toLowerCase()
    if (!q) return changes
    return changes.filter((c) => {
      const m = c.remote ?? c.local
      return (
        (m?.sourceConceptName ?? '').toLowerCase().includes(q) ||
        (m?.targetConceptName ?? '').toLowerCase().includes(q) ||
        (m?.sourceConceptCode ?? '').toLowerCase().includes(q)
      )
    })
  }, [changes, filter])

  const toggle = (key: string) => {
    const next = new Set(sel)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    setSel(next)
  }

  const allVisibleSelected = rows.length > 0 && rows.every((c) => sel.has(c.key))
  const setAllVisible = (on: boolean) => {
    const next = new Set(sel)
    for (const c of rows) {
      if (on) next.add(c.key)
      else next.delete(c.key)
    }
    setSel(next)
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex h-[88vh] w-[94vw] max-w-[1200px] flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="shrink-0 border-b px-4 py-3">
          <DialogTitle className="text-sm">{t('versioning.pull_mappings_pick')}</DialogTitle>
        </DialogHeader>

        <div className="flex shrink-0 items-center gap-2 border-b px-4 py-2">
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder={t('common.search')}
            className="h-8 w-64 rounded-md border bg-background px-2 text-xs"
          />
          <div className="flex-1" />
          <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setAllVisible(true)}>
            {t('versioning.pull_select_all')}
          </Button>
          <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setAllVisible(false)}>
            {t('versioning.pull_select_none')}
          </Button>
          <span className="text-[11px] text-muted-foreground">
            {t('versioning.pull_selected_count', { count: sel.size, total: changes.length })}
          </span>
        </div>

        <ScrollArea className="min-h-0 flex-1">
          <Table className="text-xs">
            <TableHeader>
              <TableRow>
                <TableHead className="w-8">
                  <button className="flex w-full justify-center" onClick={() => setAllVisible(!allVisibleSelected)}>
                    {allVisibleSelected ? <CheckSquare size={14} className="text-primary" /> : <Square size={14} className="text-muted-foreground" />}
                  </button>
                </TableHead>
                <TableHead className="w-20">{t('versioning.pull_col_change')}</TableHead>
                <TableHead>{t('concept_mapping.col_source_concept_name')}</TableHead>
                <TableHead>{t('concept_mapping.col_target_concept_name')}</TableHead>
                <TableHead className="w-24">{t('concept_mapping.col_status')}</TableHead>
                <TableHead className="w-40">{t('versioning.pull_col_resolution')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((c) => {
                const m = c.remote ?? c.local
                const isConflict = c.type === 'conflict'
                return (
                  <TableRow key={c.key} className={cn(sel.has(c.key) && 'bg-muted/40')}>
                    <TableCell>
                      <button className="flex w-full justify-center" onClick={() => toggle(c.key)}>
                        {sel.has(c.key) ? <CheckSquare size={14} className="text-primary" /> : <Square size={14} className="text-muted-foreground" />}
                      </button>
                    </TableCell>
                    <TableCell>
                      <span className={cn('rounded px-1.5 py-0.5 text-[9px] font-bold uppercase', CHANGE_CLS[c.type])}>
                        {t(`versioning.pull_change_${c.type}`)}
                      </span>
                    </TableCell>
                    <TableCell className="max-w-[240px] truncate" title={field(m, (x) => x.sourceConceptName)}>
                      {field(m, (x) => x.sourceConceptName)}
                    </TableCell>
                    <TableCell className="max-w-[240px] truncate" title={field(m, (x) => x.targetConceptName)}>
                      {field(m, (x) => x.targetConceptName)}
                    </TableCell>
                    <TableCell className="text-muted-foreground">{field(m, (x) => x.status)}</TableCell>
                    <TableCell>
                      {isConflict ? (
                        <div className="flex gap-1">
                          <button
                            onClick={() => setChoices((s) => ({ ...s, [c.key]: 'local' }))}
                            className={cn('rounded border px-1.5 py-0.5 text-[10px]', (choices[c.key] ?? 'remote') === 'local' ? 'border-primary bg-primary/10' : 'border-border text-muted-foreground')}
                          >
                            {t('versioning.pull_keep_mine')}
                          </button>
                          <button
                            onClick={() => setChoices((s) => ({ ...s, [c.key]: 'remote' }))}
                            className={cn('rounded border px-1.5 py-0.5 text-[10px]', (choices[c.key] ?? 'remote') === 'remote' ? 'border-primary bg-primary/10' : 'border-border text-muted-foreground')}
                          >
                            {t('versioning.pull_take_theirs')}
                          </button>
                        </div>
                      ) : (
                        <span className="text-[10px] text-muted-foreground">—</span>
                      )}
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </ScrollArea>

        <div className="flex shrink-0 items-center justify-end gap-2 border-t px-4 py-3">
          <Button variant="ghost" size="sm" onClick={onClose}>{t('common.cancel')}</Button>
          <Button size="sm" onClick={() => onApply(sel, choices)}>{t('common.confirm')}</Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
