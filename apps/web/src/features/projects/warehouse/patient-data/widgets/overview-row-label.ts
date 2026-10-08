import { looksLikeDrugName, shortenDrugName, type OverviewRow } from './overview-layout'

/** Generic row labels go through i18n; concept and table names come from the data. */
export function rowLabel(row: OverviewRow, t: (k: string, o?: Record<string, unknown>) => string): string {
  if (row.kind === 'other') {
    if (row.scrolledAbove || row.scrolledBelow) {
      return t('patient_data.overview_other_scrolled', {
        above: row.scrolledAbove ?? 0,
        below: row.scrolledBelow ?? 0,
      })
    }
    return t('patient_data.overview_other')
  }
  if (row.kind === 'class') {
    if (row.label === '__otherClasses') return t('patient_data.overview_other_classes')
    if (row.label === '__unmapped') return t('patient_data.overview_other')
    return row.label
  }
  if (row.kind === 'concept' && (row.drug || looksLikeDrugName(row.label))) return shortenDrugName(row.label)
  return row.label.replace(/_/g, ' ')
}
