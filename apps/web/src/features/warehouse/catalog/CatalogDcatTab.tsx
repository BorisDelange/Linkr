import { useState, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Copy, Check, Sparkles, ExternalLink, Eye, Plus, X } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Textarea } from '@/components/ui/textarea'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useCatalogStore } from '@/stores/catalog-store'
import { useDataSourceStore } from '@/stores/data-source-store'
import { useWorkspaceStore } from '@/stores/workspace-store'
import { useOrganizationStore } from '@/stores/organization-store'
import { queryDataSource } from '@/lib/duckdb/engine'
import {
  DCAT_FIELDS,
  DCAT_VOCABULARIES,
  HEALTHDCATAP_RELEASE,
  HEALTHDCATAP_SPEC_URL,
  getFieldsByClass,
  type DcatClass,
  type DcatFieldDef,
} from '@/lib/dcat-ap/schema'
import { buildJsonLd } from '@/lib/dcat-ap/jsonld'
import type { DataCatalog, CatalogResultCache } from '@/types'

interface Props {
  catalog: DataCatalog
  cache?: CatalogResultCache | null
}

const CLASS_ORDER: { key: DcatClass; labelKey: string }[] = [
  { key: 'dataset', labelKey: 'dcat.section_dataset' },
  { key: 'catalog', labelKey: 'dcat.section_catalog' },
  { key: 'distribution', labelKey: 'dcat.section_distribution' },
  { key: 'agent', labelKey: 'dcat.section_agent' },
]

const OBLIGATION_COLORS: Record<string, string> = {
  mandatory: 'bg-red-500/10 text-red-600',
  recommended: 'bg-amber-500/10 text-amber-600',
  optional: 'bg-muted text-muted-foreground',
}

export function CatalogDcatTab({ catalog, cache }: Props) {
  const { t } = useTranslation()
  const { updateCatalog } = useCatalogStore()
  const dataSources = useDataSourceStore((s) => s.dataSources)
  const ensureMounted = useDataSourceStore((s) => s.ensureMounted)
  const schemaMapping = dataSources.find((ds) => ds.id === catalog.dataSourceId)?.schemaMapping
  const { activeWorkspaceId, _workspacesRaw } = useWorkspaceStore()
  const { getOrganization } = useOrganizationStore()
  const [copied, setCopied] = useState(false)
  const [previewOpen, setPreviewOpen] = useState(false)
  const [autoFilling, setAutoFilling] = useState(false)

  // Local metadata state — initialized from persisted catalog
  const metadata: Record<string, unknown> = catalog.dcatApMetadata ?? {}

  // Resolve workspace organization name
  const orgName = useMemo(() => {
    if (!activeWorkspaceId) return ''
    const ws = _workspacesRaw.find((w) => w.id === activeWorkspaceId)
    if (!ws) return ''
    if (ws.organizationId) {
      const org = getOrganization(ws.organizationId)
      if (org) return org.name
    }
    return ws.organization?.name ?? ''
  }, [activeWorkspaceId, _workspacesRaw, getOrganization])

  const handleFieldChange = async (key: string, value: unknown) => {
    const next = { ...metadata, [key]: value }
    // Remove empty values (including empty arrays)
    if (value === '' || value === undefined || value === null || (Array.isArray(value) && value.length === 0)) {
      delete next[key]
    }
    await updateCatalog(catalog.id, { dcatApMetadata: next })
  }

  const handleAutoFill = async () => {
    setAutoFilling(true)
    try {
      const next = { ...metadata }

      // --- Catalog-level fields ---
      if (!next['catalog.title']) {
        next['catalog.title'] = catalog.name
      }
      if (!next['catalog.description'] && catalog.description) {
        next['catalog.description'] = catalog.description
      }
      if (!next['catalog.publisher'] && orgName) {
        next['catalog.publisher'] = orgName
      }

      // --- Dataset-level fields ---
      if (!next['dataset.title']) {
        next['dataset.title'] = `${catalog.name} — Concepts Dictionary`
      }
      if (!next['dataset.description']) {
        next['dataset.description'] = 'Aggregated clinical concepts catalog with demographic breakdowns (age, sex, admission date, care site). Generated from the clinical data warehouse.'
      }
      if (!next['dataset.identifier']) {
        next['dataset.identifier'] = catalog.id
      }
      if (!next['dataset.publisher'] && orgName) {
        next['dataset.publisher'] = orgName
      }
      if (!next['dataset.custodian'] && orgName) {
        next['dataset.custodian'] = orgName
      }
      if (!next['dataset.theme']) {
        next['dataset.theme'] = 'Clinical data warehouse, Health data'
      }
      if (!next['dataset.keyword']) {
        next['dataset.keyword'] = 'Clinical data warehouse; Concepts dictionary; OMOP CDM; Health data; Demographics'
      }
      if (!next['dataset.personalData']) {
        next['dataset.personalData'] = 'No — aggregated concept counts only'
      }

      // Pre-fill from cache (number of records = rows in the catalog)
      if (!next['dataset.numberOfRecords'] && cache) {
        next['dataset.numberOfRecords'] = cache.concepts.length
      }

      // --- Query the database for additional stats ---
      if (schemaMapping) {
        try {
          await ensureMounted(catalog.dataSourceId)

          // Unique patients count
          if (!next['dataset.numberOfUniqueIndividuals'] && schemaMapping.patientTable) {
            try {
              const rows = await queryDataSource(
                catalog.dataSourceId,
                `SELECT COUNT(*) as cnt FROM "${schemaMapping.patientTable.table}"`,
              )
              const cnt = Number(rows[0]?.cnt ?? 0)
              if (cnt > 0) next['dataset.numberOfUniqueIndividuals'] = cnt
            } catch { /* ignore */ }
          }

          // Min/max age
          const pt = schemaMapping.patientTable
          const vt = schemaMapping.visitTable
          if (pt && vt && (!next['dataset.minTypicalAge'] || !next['dataset.maxTypicalAge'])) {
            const birthExpr = pt.birthDateColumn
              ? `EXTRACT(YEAR FROM AGE(MIN(vo."${vt.startDateColumn}")::TIMESTAMP, p."${pt.birthDateColumn}"::TIMESTAMP))`
              : pt.birthYearColumn
                ? `EXTRACT(YEAR FROM MIN(vo."${vt.startDateColumn}")::TIMESTAMP) - p."${pt.birthYearColumn}"`
                : null
            if (birthExpr) {
              try {
                const ageSql = `
                  SELECT MIN(age)::INTEGER as age_min, MAX(age)::INTEGER as age_max
                  FROM (
                    SELECT p."${pt.idColumn}", ${birthExpr} as age
                    FROM "${pt.table}" p
                    JOIN "${vt.table}" vo ON vo."${vt.patientIdColumn}" = p."${pt.idColumn}"
                    WHERE vo."${vt.startDateColumn}" IS NOT NULL
                    GROUP BY p."${pt.idColumn}"${pt.birthDateColumn ? `, p."${pt.birthDateColumn}"` : ''}${pt.birthYearColumn ? `, p."${pt.birthYearColumn}"` : ''}
                  ) sub WHERE age >= 0 AND age < 150
                `
                const rows = await queryDataSource(catalog.dataSourceId, ageSql)
                if (rows[0]) {
                  if (!next['dataset.minTypicalAge'] && rows[0].age_min != null) {
                    next['dataset.minTypicalAge'] = Number(rows[0].age_min)
                  }
                  if (!next['dataset.maxTypicalAge'] && rows[0].age_max != null) {
                    next['dataset.maxTypicalAge'] = Number(rows[0].age_max)
                  }
                }
              } catch { /* ignore */ }
            }
          }

          // Temporal coverage (admission date range)
          if (!next['dataset.temporal'] && vt) {
            try {
              const dateSql = `
                SELECT
                  MIN("${vt.startDateColumn}")::VARCHAR as date_min,
                  MAX("${vt.startDateColumn}")::VARCHAR as date_max
                FROM "${vt.table}" WHERE "${vt.startDateColumn}" IS NOT NULL
              `
              const rows = await queryDataSource(catalog.dataSourceId, dateSql)
              if (rows[0]?.date_min && rows[0]?.date_max) {
                const dMin = String(rows[0].date_min).slice(0, 10)
                const dMax = String(rows[0].date_max).slice(0, 10)
                next['dataset.temporal'] = `${dMin} / ${dMax}`
              }
            } catch { /* ignore */ }
          }

          // Auto-detect coding systems from concept dictionary vocabulary columns
          if ((!next['dataset.codingSystem'] || (Array.isArray(next['dataset.codingSystem']) && next['dataset.codingSystem'].length === 0))) {
            const vocabNames = new Set<string>()
            for (const cd of schemaMapping.conceptTables ?? []) {
              if (cd.vocabularyColumn) {
                try {
                  const vocabSql = `SELECT DISTINCT "${cd.vocabularyColumn}" as v FROM "${cd.table}" WHERE "${cd.vocabularyColumn}" IS NOT NULL LIMIT 100`
                  const rows = await queryDataSource(catalog.dataSourceId, vocabSql)
                  for (const r of rows) {
                    if (r.v) vocabNames.add(String(r.v).toLowerCase())
                  }
                } catch { /* ignore */ }
              }
            }
            if (vocabNames.size > 0) {
              const matched: string[] = []
              // Map known terminology names to DCAT coding system URIs
              const nameMap: Record<string, string> = {
                'snomed': 'http://snomed.info/sct',
                'loinc': 'http://loinc.org',
                'icd10': 'http://hl7.org/fhir/sid/icd-10',
                'icd10cm': 'http://hl7.org/fhir/sid/icd-10',
                'icd10pcs': 'http://hl7.org/fhir/sid/icd-10',
                'icd9cm': 'http://hl7.org/fhir/sid/icd-10',
                'icd9proc': 'http://hl7.org/fhir/sid/icd-10',
                'icd11': 'http://hl7.org/fhir/sid/icd-11',
                'rxnorm': 'http://www.nlm.nih.gov/research/umls/rxnorm',
                'rxnorm extension': 'http://www.nlm.nih.gov/research/umls/rxnorm',
                'atc': 'http://www.whocc.no/atc',
                'omop': 'https://ohdsi.org/omop',
              }
              for (const vn of vocabNames) {
                for (const [pattern, uri] of Object.entries(nameMap)) {
                  if (vn.includes(pattern) && !matched.includes(uri)) {
                    matched.push(uri)
                  }
                }
              }
              if (matched.length > 0) next['dataset.codingSystem'] = matched
            }
          }
        } catch { /* DB queries failed — skip */ }
      }

      // --- Agent-level fields ---
      if (!next['agent.name'] && orgName) {
        next['agent.name'] = orgName
      }

      await updateCatalog(catalog.id, { dcatApMetadata: next })
    } finally {
      setAutoFilling(false)
    }
  }

  const handleMultiselectToggle = async (key: string, value: string) => {
    const current = Array.isArray(metadata[key]) ? (metadata[key] as string[]) : []
    const next = current.includes(value)
      ? current.filter((v) => v !== value)
      : [...current, value]
    await handleFieldChange(key, next.length > 0 ? next : undefined)
  }

  const jsonLd = useMemo(() => buildJsonLd({
    metadata,
    schemaMapping,
    cache,
    catalog,
  }), [metadata, schemaMapping, cache, catalog])
  const jsonLdStr = useMemo(() => JSON.stringify(jsonLd, null, 2), [jsonLd])

  const handleCopyJsonLd = async () => {
    await navigator.clipboard.writeText(jsonLdStr)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  // Count completion
  const mandatoryFields = DCAT_FIELDS.filter((f) => f.obligation === 'mandatory')
  const filledMandatory = mandatoryFields.filter((f) => {
    const val = metadata[f.key]
    if (Array.isArray(val)) return val.length > 0
    return val !== undefined && val !== null && val !== ''
  })

  return (
    <div className="space-y-4">
      {/* Header with release info + auto-fill + completion */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Button variant="outline" size="sm" onClick={handleAutoFill} disabled={autoFilling}>
            <Sparkles size={14} className={autoFilling ? 'animate-spin' : ''} />
            {autoFilling ? t('dcat.auto_filling') : t('dcat.auto_fill')}
          </Button>
          <span className="text-xs text-muted-foreground">
            {t('dcat.completion', {
              filled: filledMandatory.length,
              total: mandatoryFields.length,
            })}
          </span>
          <a
            href={HEALTHDCATAP_SPEC_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground"
          >
            <ExternalLink size={10} />
            Release {HEALTHDCATAP_RELEASE}
          </a>
        </div>
        <div className="flex items-center gap-1.5">
          <Button variant="outline" size="sm" onClick={() => setPreviewOpen(true)}>
            <Eye size={14} />
            {t('dcat.preview')}
          </Button>
          <Button variant="outline" size="sm" onClick={handleCopyJsonLd}>
            {copied ? <Check size={14} /> : <Copy size={14} />}
            {copied ? t('dcat.copied') : t('dcat.copy_jsonld')}
          </Button>
        </div>
      </div>

      {/* Field sections by class */}
      {CLASS_ORDER.map(({ key: dcatClass, labelKey }) => {
        const fields = getFieldsByClass(dcatClass)
        return (
          <Card key={dcatClass} className="p-4">
            <h3 className="text-sm font-semibold">{t(labelKey)}</h3>
            <div className="mt-3 space-y-2">
              {fields.map((field) => (
                <FieldEditor
                  key={field.key}
                  field={field}
                  value={metadata[field.key]}
                  onChange={(val) => handleFieldChange(field.key, val)}
                  onMultiselectToggle={(val) => handleMultiselectToggle(field.key, val)}
                  t={t}
                />
              ))}
            </div>
          </Card>
        )
      })}

      {/* JSON-LD preview dialog */}
      <Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
        <DialogContent className="max-h-[80vh] max-w-3xl overflow-hidden">
          <DialogHeader>
            <DialogTitle className="flex items-center justify-between pr-6">
              {t('dcat.jsonld_preview')}
              <Button variant="outline" size="sm" onClick={handleCopyJsonLd}>
                {copied ? <Check size={14} /> : <Copy size={14} />}
                {copied ? t('dcat.copied') : t('dcat.copy_jsonld')}
              </Button>
            </DialogTitle>
          </DialogHeader>
          <pre className="max-h-[calc(80vh-6rem)] overflow-auto rounded-md bg-muted p-4 text-xs">
            {jsonLdStr}
          </pre>
        </DialogContent>
      </Dialog>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Field editor component
// ---------------------------------------------------------------------------

interface FieldEditorProps {
  field: DcatFieldDef
  value: unknown
  onChange: (val: unknown) => void
  onMultiselectToggle: (val: string) => void
  t: (key: string) => string
}

function FieldEditor({ field, value, onChange, onMultiselectToggle, t }: FieldEditorProps) {
  const strVal = value != null ? String(value) : ''
  const arrVal = Array.isArray(value) ? value : []
  const [customInput, setCustomInput] = useState('')

  // For multiselect: separate vocabulary values from custom free-text values
  const vocabValues = field.vocabularyKey ? (DCAT_VOCABULARIES[field.vocabularyKey] ?? []).map((o) => o.value) : []
  const customValues = arrVal.filter((v) => !vocabValues.includes(v))

  const handleAddCustom = () => {
    const trimmed = customInput.trim()
    if (!trimmed || arrVal.includes(trimmed)) return
    onChange([...arrVal, trimmed])
    setCustomInput('')
  }

  const handleRemoveCustom = (val: string) => {
    onChange(arrVal.filter((v) => v !== val))
  }

  return (
    <div className="grid grid-cols-[180px_1fr] items-start gap-x-3">
      <div className="flex items-center gap-1.5 pt-1.5">
        <Label className="text-xs leading-tight">
          {t(field.labelKey)}
        </Label>
        <Badge
          variant="secondary"
          className={`shrink-0 text-[9px] leading-none ${OBLIGATION_COLORS[field.obligation]}`}
        >
          {t(`dcat.${field.obligation}`)}
        </Badge>
      </div>
      <div>
        {field.type === 'text' && (
          <Input
            value={strVal}
            onChange={(e) => onChange(e.target.value)}
            placeholder={t(field.descriptionKey)}
            className="h-8 text-sm"
          />
        )}
        {field.type === 'uri' && (
          <Input
            type="url"
            value={strVal}
            onChange={(e) => onChange(e.target.value)}
            placeholder="https://..."
            className="h-8 text-sm"
          />
        )}
        {field.type === 'date' && (
          <Input
            type="date"
            value={strVal}
            onChange={(e) => onChange(e.target.value)}
            className="h-8 text-sm"
          />
        )}
        {field.type === 'number' && (
          <Input
            type="number"
            min={0}
            value={strVal}
            onChange={(e) => onChange(e.target.value ? Number(e.target.value) : undefined)}
            placeholder={t(field.descriptionKey)}
            className="h-8 text-sm"
          />
        )}
        {field.type === 'localized' && (
          <Textarea
            value={strVal}
            onChange={(e) => onChange(e.target.value)}
            placeholder={t(field.descriptionKey)}
            rows={2}
            className="text-sm"
          />
        )}
        {field.type === 'select' && field.vocabularyKey && (
          <Select
            value={strVal || '__none__'}
            onValueChange={(v) => onChange(v === '__none__' ? undefined : v)}
          >
            <SelectTrigger className="h-8 text-sm">
              <SelectValue placeholder={t(field.descriptionKey)} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__none__">—</SelectItem>
              {DCAT_VOCABULARIES[field.vocabularyKey]?.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>
                  {t(opt.labelKey)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        {field.type === 'multiselect' && field.vocabularyKey && (
          <div className="space-y-1.5">
            <div className="flex flex-wrap gap-1.5">
              {DCAT_VOCABULARIES[field.vocabularyKey]?.map((opt) => {
                const selected = arrVal.includes(opt.value)
                return (
                  <Badge
                    key={opt.value}
                    variant={selected ? 'default' : 'outline'}
                    className="cursor-pointer text-xs"
                    onClick={() => onMultiselectToggle(opt.value)}
                  >
                    {t(opt.labelKey)}
                  </Badge>
                )
              })}
            </div>
            {/* Custom free-text values */}
            {customValues.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {customValues.map((cv) => (
                  <Badge key={cv} variant="default" className="gap-1 pr-1 text-xs">
                    {cv}
                    <button
                      type="button"
                      className="ml-0.5 rounded-full p-0.5 opacity-60 transition-opacity hover:bg-background/20 hover:opacity-100"
                      onClick={(e) => { e.stopPropagation(); handleRemoveCustom(cv) }}
                    >
                      <X size={10} />
                    </button>
                  </Badge>
                ))}
              </div>
            )}
            {/* Add custom value input */}
            <div className="flex items-center gap-1">
              <Input
                value={customInput}
                onChange={(e) => setCustomInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleAddCustom() } }}
                placeholder={t('dcat.custom_value_placeholder')}
                className="h-7 flex-1 text-xs"
              />
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2"
                onClick={handleAddCustom}
                disabled={!customInput.trim()}
              >
                <Plus size={12} />
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
