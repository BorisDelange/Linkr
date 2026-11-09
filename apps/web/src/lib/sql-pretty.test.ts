import { describe, expect, it } from 'vitest'
import twin from '@/lib/__fixtures__/concept-runs/run-spec.json'
import { prettySql } from './sql-pretty'

// Every query a concept run sends, as the server shows them in its job.
const RUN_SQL: string[] = [
  ...twin.spec.dictionaries.flatMap((d) => [
    d.idsSql, d.pageSql, ...d.events.flatMap((e) => [e.countSql, e.batchSql]),
  ]),
  ...twin.counts.steps.flatMap((s) => s.items.map((i) => i.sql)),
  twin.counts.finalAssembleSql,
]

const squeezed = (sql: string) => sql.replace(/\s+/g, '')

describe('SQL laid out for reading', () => {
  it.each(RUN_SQL.map((sql, n) => [n, sql]))('changes only the whitespace of run query %i', async (_, sql) => {
    const pretty = await prettySql(`-- What it computes\n${sql}`)
    expect(squeezed(pretty)).toBe(squeezed(`-- What it computes\n${sql}`))
    expect(pretty.split('\n').length).toBeGreaterThan(sql.split('\n').length)
  })

  it('puts each column and each clause on its own line', async () => {
    const pretty = await prettySql('SELECT e.k, COUNT(*) AS n FROM scope e WHERE e.v IS NOT NULL GROUP BY e.k')
    expect(pretty.split('\n').map((l) => l.trim())).toEqual([
      'SELECT', 'e.k,', 'COUNT(*) AS n', 'FROM', 'scope e', 'WHERE', 'e.v IS NOT NULL', 'GROUP BY', 'e.k',
    ])
  })

  it('shows what it cannot read as it came', async () => {
    expect(await prettySql('SELECT (((')).toBe('SELECT (((')
  })
})
