import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { CopyIconButton } from '@/components/ui/copy-icon-button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { getStorage } from '@/lib/storage'
import { APP_VERSION } from '@/lib/version'
import { sanitizeRecommendedUnits, sanitizeUnitConversions } from '@/lib/data-dictionary/content'
import {
  availableReferenceUnits,
  buildConceptSetSql,
  defaultReferenceUnit,
  unitLabels,
} from '@/lib/data-dictionary/sql-export'
import type { ConceptSet, DataDictionary, ResolvedConcept } from '@/types'

interface ConceptSetSqlPanelProps {
  conceptSet: ConceptSet
  concepts: readonly ResolvedConcept[]
}

const NO_UNIT = 'none'

/** The set's id as its dictionary numbers it (`concept_sets/155.json` → 155). */
function dictionaryIdOf(set: ConceptSet): string {
  const stem = set.sourceUrl?.split('/').pop()?.replace(/\.json$/i, '')
  return stem || set.uniqueId || set.id
}

/** Where the set can be read: its file in the dictionary's repository. */
function permalinkOf(set: ConceptSet, dictionary: DataDictionary | undefined): string {
  const repo = dictionary?.sourceRepo?.replace(/\.git$/, '').replace(/\/+$/, '')
  if (repo && set.sourceUrl && !/^https?:/.test(set.sourceUrl)) {
    return `${repo}/blob/${dictionary?.commit ?? dictionary?.branch ?? 'main'}/${set.sourceUrl}`
  }
  return set.sourceUrl ?? repo ?? ''
}

/**
 * The OMOP extraction SQL of a concept set (lib/data-dictionary/sql-export.ts):
 * its standard concepts per CDM table, measurements converted into the chosen
 * reference unit with the dictionary's unit conversions.
 */
export function ConceptSetSqlPanel({ conceptSet, concepts }: ConceptSetSqlPanelProps) {
  const { t, i18n } = useTranslation()
  const [dictionary, setDictionary] = useState<DataDictionary | undefined>()
  const [referenceUnit, setReferenceUnit] = useState<number | null | undefined>(undefined)
  const [dropOtherUnits, setDropOtherUnits] = useState(false)

  useEffect(() => {
    setDictionary(undefined)
    setReferenceUnit(undefined)
    if (!conceptSet.dictionaryId) return
    getStorage().dataDictionaries.getByWorkspace(conceptSet.workspaceId)
      .then((list) => setDictionary(list.find((d) => d.id === conceptSet.dictionaryId)))
      .catch(() => setDictionary(undefined))
  }, [conceptSet.id, conceptSet.dictionaryId, conceptSet.workspaceId])

  const conversions = useMemo(() => sanitizeUnitConversions(dictionary?.unitConversions) ?? [], [dictionary])
  const recommended = useMemo(() => sanitizeRecommendedUnits(dictionary?.recommendedUnits) ?? [], [dictionary])
  const standard = useMemo(() => concepts.filter((c) => c.standardConcept === 'S'), [concepts])
  const units = useMemo(() => availableReferenceUnits(standard, conversions, recommended), [standard, conversions, recommended])
  const labels = useMemo(() => unitLabels(conversions, recommended), [conversions, recommended])
  const effectiveUnit = referenceUnit === undefined ? defaultReferenceUnit(standard, recommended, units) : referenceUnit

  const sql = useMemo(() => {
    const tr = conceptSet.translations?.en
    return buildConceptSetSql(
      {
        name: tr?.name || conceptSet.name,
        id: dictionaryIdOf(conceptSet),
        version: conceptSet.version,
        permalink: permalinkOf(conceptSet, dictionary),
        toolTag: `Linkr v${APP_VERSION}`,
        today: new Date().toISOString().slice(0, 10),
      },
      concepts,
      conversions,
      recommended,
      { referenceUnitId: effectiveUnit, dropOtherUnits },
    )
  }, [conceptSet, dictionary, concepts, conversions, recommended, effectiveUnit, dropOtherUnits])

  const unitName = (u: number) => (labels.get(u) ? `${labels.get(u)} (${u})` : String(u))

  return (
    <div className="flex h-full flex-col gap-3 px-4 py-3">
      <div className="flex flex-wrap items-center gap-4">
        {units.length > 0 && (
          <div className="flex items-center gap-2">
            <Label>{t('concept_mapping.cs_sql_reference_unit')}</Label>
            <Select
              value={effectiveUnit == null ? NO_UNIT : String(effectiveUnit)}
              onValueChange={(v) => setReferenceUnit(v === NO_UNIT ? null : Number(v))}
            >
              <SelectTrigger className="h-7 w-48 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_UNIT} className="text-xs">{t('concept_mapping.cs_sql_no_conversion')}</SelectItem>
                {units.map((u) => <SelectItem key={u} value={String(u)} className="text-xs">{unitName(u)}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
        )}
        {effectiveUnit != null && (
          <label className="flex items-center gap-2">
            <Switch checked={dropOtherUnits} onCheckedChange={setDropOtherUnits} size="sm" />
            <span className="text-xs text-muted-foreground">{t('concept_mapping.cs_sql_drop_other_units')}</span>
          </label>
        )}
        <div className="ml-auto">
          <CopyIconButton text={sql} size={14} />
        </div>
      </div>
      {!conceptSet.dictionaryId && (
        <p className="text-xs text-muted-foreground">{t('concept_mapping.cs_sql_no_dictionary')}</p>
      )}
      <pre className="min-h-0 flex-1 overflow-auto rounded-md border bg-muted/30 p-3 font-mono text-xs leading-relaxed" lang={i18n.language}>
        {sql}
      </pre>
    </div>
  )
}
