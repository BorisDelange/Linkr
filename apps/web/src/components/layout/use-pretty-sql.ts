import { useEffect, useState } from 'react'
import { prettySql } from '@/lib/sql-pretty'

// Past this, the layout would cost more than it helps: shown as it came.
const PRETTY_MAX = 100_000

/** `sql` laid out for reading once `on`; the text as it came meanwhile. */
export function usePrettySql(sql: string | null, on: boolean): string | null {
  const [pretty, setPretty] = useState<{ from: string; text: string } | null>(null)
  useEffect(() => {
    if (!on || !sql || sql.length > PRETTY_MAX) return
    let live = true
    void prettySql(sql).then((text) => { if (live) setPretty({ from: sql, text }) })
    return () => { live = false }
  }, [sql, on])
  return sql && pretty?.from === sql ? pretty.text : sql
}
