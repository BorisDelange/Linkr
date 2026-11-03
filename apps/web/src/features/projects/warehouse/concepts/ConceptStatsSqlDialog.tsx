import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { DialogShell } from '@/components/ui/dialog-shell'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { CodeViewer } from '@/components/editor/CodeViewer'
import { SqlFormSelect, type SqlForm } from '@/components/editor/SqlFormSelect'
import type { StatsSqlQuery } from './use-concept-stats-sql'

/** Fixed viewer height, so switching tabs never resizes the dialog. Statements
 *  differ a lot in length (the histogram is several times the count, the native
 *  form several times the Linkr one), so it takes most of the screen. */
const VIEWER_HEIGHT = '60vh'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The statements behind the stats panel, in execution order. */
  queries: StatsSqlQuery[]
}

/**
 * The SQL behind a concept's statistics.
 *
 * Three statements, not one: a count decides whether the concept has any record
 * at all, and only then do the distribution and histogram run (in parallel).
 * Showing the count explains why the other two sometimes produce nothing.
 *
 * These are rebuilt from the same pure builders the loader calls, not captured
 * from a run — in server mode a shared cache can answer without querying the
 * database at all. Hence "the queries behind these statistics", never "the
 * queries that ran".
 *
 * Each in two forms: on the Linkr relations, and on the database's own tables.
 */
export function ConceptStatsSqlDialog({ open, onOpenChange, queries }: Props) {
  const { t } = useTranslation()
  const [tab, setTab] = useState(queries[0]?.titleKey ?? '')
  const [form, setForm] = useState<SqlForm>('linkr')

  // The set changes with the concept (a concept with no value column has only
  // the count), so a remembered tab can name a query that is no longer there.
  const active = queries.find((q) => q.titleKey === tab) ?? queries[0]

  const shownSql = !active ? ''
    : form === 'native' ? active.native ?? `-- ${t('common.sql_form_no_native')}`
      : active.sql

  return (
    <DialogShell
      open={open}
      onOpenChange={onOpenChange}
      kind="settings"
      title={t('concepts.stats_sql_title')}
      description={t('concepts.stats_sql_description')}
      className="sm:max-w-3xl"
    >
      <Tabs value={active?.titleKey ?? ''} onValueChange={setTab}>
        <TabsList className="w-full">
          {queries.map((q) => (
            <TabsTrigger key={q.titleKey} value={q.titleKey} className="flex-1">
              {t(q.titleKey)}
            </TabsTrigger>
          ))}
        </TabsList>
        <div className="mt-3">
          <SqlFormSelect value={form} onChange={setForm} />
        </div>
        <div className="mt-2 overflow-hidden rounded-md border">
          <CodeViewer value={shownSql} language="sql" height={VIEWER_HEIGHT} />
        </div>
      </Tabs>
    </DialogShell>
  )
}
