import i18n from '@/lib/i18n'
import { requestCodeAcceptance } from '@/stores/code-acceptance-prompt'
import { useDataSourceStore } from '@/stores/data-source-store'
import type { DataSource } from '@/types'

function databaseName(ds: DataSource): string {
  if (typeof ds.name === 'string') return ds.name
  return ds.name?.[i18n.language] ?? ds.name?.en ?? ds.alias
}

/** Ask for this database's SQL in the code dialog: every text, on one answer. */
export async function reviewMappingSql(ds: DataSource): Promise<void> {
  const label = databaseName(ds)
  const answers = await Promise.all(
    (ds.unacceptedFreeSql ?? []).map((code) => requestCodeAcceptance({ code, language: 'sql', label })),
  )
  if (answers.every(Boolean)) useDataSourceStore.getState().markFreeSqlAccepted(ds.id)
}
