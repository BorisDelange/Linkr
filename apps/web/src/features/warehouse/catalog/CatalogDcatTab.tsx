import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, Copy, Download, ExternalLink, FileJson, Info, Plus, Sparkles, X } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import { SectionLabel } from '@/components/ui/section-label'
import { DatePickerField } from '@/components/ui/date-picker-field'
import { DialogShell } from '@/components/ui/dialog-shell'
import { MultiSelectFilter, MULTI_SELECT_FORM_TRIGGER } from '@/components/ui/multi-select-filter'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { CodeViewer } from '@/components/editor/CodeViewer'
import { CodeViewerBoundary } from '@/components/editor/CodeViewerBoundary'
import { localized } from '@/lib/localized'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/stores/app-store'
import { useCatalogStore } from '@/stores/catalog-store'
import { useMyWorkspaceRole } from '@/hooks/use-context-role'
import { useSaveForm } from '@/hooks/use-save-form'
import { useDataSourceStore } from '@/stores/data-source-store'
import { useWorkspaceStore } from '@/stores/workspace-store'
import { useOrganizationStore } from '@/stores/organization-store'
import { queryDataSource } from '@/lib/duckdb/engine'
import {
  COUNTRY_ALPHA2,
  DCAT_FIELDS,
  DCAT_VOCABULARIES,
  HEALTHDCATAP_RELEASE,
  HEALTHDCATAP_SPEC_URL,
  effectiveObligation,
  getFieldsBySection,
  isFilled,
  normalizeDcatMetadata,
  vocabularyIri,
  type DcatAgentRole,
  type DcatFieldDef,
  type DcatSection,
  type VocabularyOption,
} from '@/lib/dcat-ap/schema'
import { buildJsonLd } from '@/lib/dcat-ap/jsonld'
import { copyText } from '@/lib/clipboard'
import type { DataCatalog, CatalogResultCache, SchemaMapping } from '@/types'
import { classRelation, conceptRelations, has } from '@/lib/schema-classes/relations'

interface Props {
  catalog: DataCatalog
  cache?: CatalogResultCache | null
}

/** Linkr's organization types → EHDS publisher types. `consortium` and `other` have no counterpart. */
const ORG_TYPE_TO_PUBLISHER: Record<string, string | undefined> = {
  hospital: vocabularyIri('publisherType', 'inpatient-institute'),
  university: vocabularyIri('publisherType', 'university'),
  research_institute: vocabularyIri('publisherType', 'research-institute-org'),
  company: vocabularyIri('publisherType', 'private-company'),
}

/** An organization's free-text country ("France", "FR", "FRA") → EU country IRI, when recognisable. */
function countryIri(country: unknown): string | undefined {
  const values = typeof country === 'string' ? [country] : country && typeof country === 'object' ? Object.values(country as Record<string, string>) : []
  for (const raw of values) {
    const v = String(raw).trim().toLowerCase()
    if (!v) continue
    for (const [alpha3, alpha2] of Object.entries(COUNTRY_ALPHA2)) {
      const names = ['en', 'fr'].map((l) => new Intl.DisplayNames([l], { type: 'region' }).of(alpha2)?.toLowerCase())
      if (v === alpha3.toLowerCase() || v === alpha2.toLowerCase() || names.includes(v)) return vocabularyIri('country', alpha3)
    }
  }
  return undefined
}

const SECTIONS: DcatSection[] = ['identity', 'health', 'coverage', 'agents', 'distribution', 'catalog', 'generated']
const AGENT_ROLES: DcatAgentRole[] = ['contact', 'publisher', 'hdab', 'custodian', 'coordinator']

const OBLIGATION_COLORS: Record<string, string> = {
  mandatory: 'bg-red-500/10 text-red-600 dark:text-red-400',
  recommended: 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
  optional: 'bg-muted text-muted-foreground',
}

/** Terminology names found in concept dictionaries → R8 coding-system codes. Most specific first. */
const VOCABULARY_CODES: [RegExp, string][] = [
  [/^icd10(cm|gm|fr|ca)/, 'ICD-10-NAT'],
  [/^icd10pcs|^ccam|^ops$/, 'PROC-CODES-NAT'],
  [/^icd10/, 'ICD-10'],
  [/^icd11/, 'ICD-11'],
  [/^icd9/, 'ICD-9-CM'],
  [/^icdo/, 'ICD-O'],
  [/^snomed/, 'SNOMED-CT'],
  [/^loinc/, 'LOINC'],
  [/^rxnorm/, 'RXNORM'],
  [/^atc/, 'ATC'],
  [/^ucum/, 'UCUM'],
  [/^meddra/, 'MEDDRA'],
  [/^hpo/, 'HPO'],
  [/^nci/, 'NCIT'],
  [/^mesh/, 'MESH'],
]

export function CatalogDcatTab({ catalog, cache }: Props) {
  const { t } = useTranslation()
  const canWrite = useMyWorkspaceRole().can('catalog:write')
  const language = useAppStore((s) => s.language)
  const { updateCatalog } = useCatalogStore()
  const dataSources = useDataSourceStore((s) => s.dataSources)
  const ensureMounted = useDataSourceStore((s) => s.ensureMounted)
  const schemaMapping = dataSources.find((ds) => ds.id === catalog.dataSourceId)?.schemaMapping
  const { activeWorkspaceId, _workspacesRaw } = useWorkspaceStore()
  const { getOrganization } = useOrganizationStore()
  const [previewOpen, setPreviewOpen] = useState(false)
  const [autoFilling, setAutoFilling] = useState(false)
  const [section, setSection] = useState<DcatSection | 'all'>('identity')
  const [mandatoryOnly, setMandatoryOnly] = useState(false)

  // Edits (and Auto-fill) go to a draft; nothing is written until Save.
  const saved = useMemo(() => normalizeDcatMetadata(catalog.dcatApMetadata), [catalog.dcatApMetadata])
  const [draft, setDraft] = useState(saved)
  const [draftBase, setDraftBase] = useState(saved)
  // A new saved version (ours, or another tab's) replaces the draft only when
  // there are no pending edits to lose.
  if (draftBase !== saved) {
    setDraftBase(saved)
    if (JSON.stringify(draft) === JSON.stringify(draftBase)) setDraft(saved)
  }
  const metadata = draft
  const { isDirty, canSaveNow, save } = useSaveForm({
    current: draft,
    baseline: saved,
    onSave: () => updateCatalog(catalog.id, { dcatApMetadata: draft }),
    canSave: canWrite,
  })

  const organization = useMemo(() => {
    const ws = _workspacesRaw.find((w) => w.id === activeWorkspaceId)
    if (!ws) return undefined
    return (ws.organizationId ? getOrganization(ws.organizationId) : undefined) ?? ws.organization
  }, [activeWorkspaceId, _workspacesRaw, getOrganization])
  const orgName = localized(organization?.name, language)

  const handleFieldChange = (key: string, value: unknown) => {
    setDraft((prev) => {
      const next = { ...prev, [key]: value }
      if (!isFilled(value) && value !== false) delete next[key]
      return next
    })
  }

  const handleAutoFill = async () => {
    setAutoFilling(true)
    try {
      const next = { ...metadata }
      const fill = (key: string, value: unknown) => {
        if (!isFilled(next[key]) && isFilled(value)) next[key] = value
      }
      const name = localized(catalog.name, language)
      const description = localized(catalog.description, language)
      const isOmop = /omop/i.test(localized(schemaMapping?.presetLabel, 'en'))

      fill('catalog.title', name)
      fill('catalog.description', description)
      fill('dataset.title', name)
      fill('dataset.description', description)
      fill('dataset.identifier', catalog.entityId ?? catalog.id)
      fill('dataset.accessRights', vocabularyIri('accessRights', 'NON_PUBLIC'))
      fill('dataset.theme', [vocabularyIri('dataTheme', 'HEAL')])
      fill('dataset.keyword', ['Clinical data warehouse', isOmop ? 'OMOP CDM' : '', 'Health data'].filter(Boolean).join('; '))
      fill('dataset.healthCategory', [vocabularyIri('healthCategory', 'EHRS')])
      fill('dataset.wasGeneratedBy', [vocabularyIri('healthActivity', 'HOSPITAL_RECORDS')])
      fill('dataset.personalData', ['HealthRecord', 'Age', 'Gender'].map((c) => vocabularyIri('personalData', c)))
      if (next['dataset.hasStructuredData'] == null && schemaMapping) next['dataset.hasStructuredData'] = true
      if (isOmop) fill('dataset.conformsTo', [vocabularyIri('standard', 'OMOP-CDM')])
      // The workspace's organization is the publisher and, by default, the custodian.
      fill('publisher.name', orgName)
      fill('publisher.type', organization?.type ? ORG_TYPE_TO_PUBLISHER[organization.type] : undefined)
      fill('publisher.email', organization?.email)
      fill('publisher.contactPage', organization?.website)
      fill('custodian.name', orgName)
      fill('custodian.email', organization?.email)
      fill('contact.email', organization?.email)
      fill('catalog.homepage', organization?.website)
      const country = countryIri(organization?.country)
      if (country) fill('dataset.spatial', [country])
      if (cache) {
        fill('dataset.numberOfUniqueIndividuals', cache.totalPatients || undefined)
        fill('dataset.numberOfRecords', cache.totalVisits || undefined)
      }

      if (schemaMapping) {
        try {
          await ensureMounted(catalog.dataSourceId)
          const patient = classRelation(schemaMapping, 'patient')
          const visit = classRelation(schemaMapping, 'visit')

          // Age at first stay: the exact birth date when present, else the birth
          // year (MIMIC-IV leaves every OMOP birth_datetime empty).
          if (patient && visit && has(patient, 'birth_year') && (!isFilled(next['dataset.minTypicalAge']) || !isFilled(next['dataset.maxTypicalAge']))) {
            const byYear = 'EXTRACT(YEAR FROM MIN(vo.start_datetime)::TIMESTAMP) - p.birth_year'
            const age = has(patient, 'birth_date')
              ? `COALESCE(EXTRACT(YEAR FROM AGE(MIN(vo.start_datetime)::TIMESTAMP, p.birth_date::TIMESTAMP)), ${byYear})`
              : byYear
            try {
              const rows = await queryDataSource(catalog.dataSourceId, `
                SELECT MIN(age)::INTEGER AS age_min, MAX(age)::INTEGER AS age_max
                FROM (
                  SELECT p.patient_id, ${age} AS age
                  FROM ${patient.name} p
                  JOIN ${visit.name} vo ON vo.patient_id = p.patient_id
                  WHERE vo.start_datetime IS NOT NULL
                  GROUP BY p.patient_id, p.birth_date, p.birth_year
                ) sub WHERE age >= 0 AND age < 150`)
              fill('dataset.minTypicalAge', rows[0]?.age_min != null ? Number(rows[0].age_min) : undefined)
              fill('dataset.maxTypicalAge', rows[0]?.age_max != null ? Number(rows[0].age_max) : undefined)
            } catch { /* optional figure */ }
          }

          if (visit) {
            try {
              const rows = await queryDataSource(catalog.dataSourceId, `
                SELECT MIN(start_datetime)::VARCHAR AS date_min, MAX(start_datetime)::VARCHAR AS date_max
                FROM ${visit.name} WHERE start_datetime IS NOT NULL`)
              fill('dataset.temporalStart', rows[0]?.date_min ? String(rows[0].date_min).slice(0, 10) : undefined)
              fill('dataset.temporalEnd', rows[0]?.date_max ? String(rows[0].date_max).slice(0, 10) : undefined)
            } catch { /* optional figure */ }
          }

          if (!isFilled(next['dataset.codingSystem'])) {
            const codes = new Set<string>(isOmop ? ['OHDSI-VOCAB'] : [])
            for (const dict of conceptRelations(schemaMapping)) {
              if (!has(dict, 'terminology_id')) continue
              try {
                const rows = await queryDataSource(catalog.dataSourceId,
                  `SELECT DISTINCT terminology_id AS v FROM ${dict.name} WHERE terminology_id IS NOT NULL LIMIT 200`)
                for (const r of rows) {
                  const name = String(r.v ?? '').toLowerCase().replace(/[\s._-]/g, '')
                  const match = VOCABULARY_CODES.find(([re]) => re.test(name))
                  if (match) codes.add(match[1])
                }
              } catch { /* a dictionary without that column */ }
            }
            fill('dataset.codingSystem', [...codes].map((c) => vocabularyIri('codingSystem', c)).filter(Boolean))
          }
        } catch { /* database unavailable: keep what was filled */ }
      }

      setDraft(next)
    } finally {
      setAutoFilling(false)
    }
  }

  const jsonLdStr = useMemo(
    () => JSON.stringify(buildJsonLd({ metadata, schemaMapping, cache, catalog }), null, 2),
    [metadata, schemaMapping, cache, catalog],
  )

  const progress = useMemo(() => {
    const of = (fields: DcatFieldDef[]) => {
      const mandatory = fields.filter((f) => effectiveObligation(f, metadata) === 'mandatory')
      return { filled: mandatory.filter((f) => isFilled(metadata[f.key])).length, total: mandatory.length }
    }
    return {
      all: of(DCAT_FIELDS),
      bySection: Object.fromEntries(SECTIONS.map((s) => [s, of(getFieldsBySection(s))])) as Record<DcatSection, { filled: number; total: number }>,
    }
  }, [metadata])

  const shown = section === 'all' ? SECTIONS : [section]
  const visible = (f: DcatFieldDef) => !mandatoryOnly || effectiveObligation(f, metadata) === 'mandatory'

  return (
    <TooltipProvider delayDuration={0}>
      {/* The sections sit at the tab’s left edge; the form and its toolbar share one centred column. */}
      {/* A phantom column as wide as the sections balances them, so the form sits
          in the middle of the tab rather than of what the sections leave. */}
      <div className="grid grid-cols-[12rem_minmax(0,1fr)] gap-6 py-4 xl:grid-cols-[12rem_minmax(0,1fr)_12rem]">
        {/* Sections — one at a time keeps a 50-field form readable; All is there to review everything */}
        <nav className="sticky top-4 flex flex-col gap-1 self-start">
          {(['all', ...SECTIONS] as const).map((s) => {
            const p = s === 'all' ? progress.all : progress.bySection[s]
            const complete = p.total > 0 && p.filled === p.total
            return (
              <button
                key={s}
                type="button"
                onClick={() => setSection(s)}
                className={cn(
                  'flex items-center justify-between gap-2 rounded-md px-2.5 py-1.5 text-left text-xs transition-colors',
                  section === s ? 'bg-accent font-medium text-foreground' : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
                )}
              >
                <span className="truncate">{t(`dcat.section_${s}`)}</span>
                {p.total > 0 && (complete
                  ? <Check size={12} className="shrink-0 text-emerald-600 dark:text-emerald-400" />
                  : <span className="shrink-0 text-[10px] tabular-nums text-red-600 dark:text-red-400">{p.filled}/{p.total}</span>)}
              </button>
            )
          })}
        </nav>

        <div className="mx-auto flex w-full max-w-4xl min-w-0 flex-col gap-3">
          {/* One toolbar row: filling on the left, looking at the result on the right */}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-3">
              <Button variant="outline" size="sm" className="gap-1.5" onClick={handleAutoFill} disabled={autoFilling || !canWrite}>
                <Sparkles size={14} className={autoFilling ? 'animate-spin' : ''} />
                {autoFilling ? t('dcat.auto_filling') : t('dcat.auto_fill')}
              </Button>
              <span className={cn('text-xs tabular-nums', progress.all.filled === progress.all.total ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground')}>
                {t('dcat.completion', progress.all)}
              </span>
              <a
                href={HEALTHDCATAP_SPEC_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground"
              >
                <ExternalLink size={10} />
                {t('dcat.release_link', { release: HEALTHDCATAP_RELEASE })}
              </a>
            </div>
            <div className="flex items-center gap-3">
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                <Switch checked={mandatoryOnly} onCheckedChange={setMandatoryOnly} />
                {t('dcat.mandatory_only')}
              </label>
              <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setPreviewOpen(true)}>
                <FileJson size={14} />
                JSON-LD
              </Button>
              <Button variant="outline" size="sm" disabled={!isDirty} onClick={() => setDraft(saved)}>
                {t('common.cancel')}
              </Button>
              <Button size="sm" disabled={!canSaveNow} onClick={save}>
                {t('common.save')}
              </Button>
            </div>
          </div>

          {shown.map((s) => (
            <Card key={s} className="flex flex-col gap-3 p-5">
              <div className="flex items-center justify-between gap-2">
                <SectionLabel as="h3">{t(`dcat.section_${s}`)}</SectionLabel>
                {progress.bySection[s].total > 0 && (
                  <span className="text-[10px] tabular-nums text-muted-foreground">{t('dcat.section_progress', progress.bySection[s])}</span>
                )}
              </div>
              {s === 'generated' && <GeneratedSummary schemaMapping={schemaMapping} cache={cache} jsonLd={jsonLdStr} />}
              {s === 'agents'
                ? AGENT_ROLES.map((role) => {
                    const fields = getFieldsBySection('agents').filter((f) => f.agentRole === role && visible(f))
                    if (!fields.length) return null
                    return (
                      <div key={role} className="flex flex-col gap-2 border-t pt-3 first-of-type:border-t-0 first-of-type:pt-0">
                        <p className="text-xs font-semibold">{t(`dcat.role_${role}`)}</p>
                        {fields.map((f) => (
                          <FieldEditor key={f.key} field={f} metadata={metadata} canWrite={canWrite} onChange={(v) => handleFieldChange(f.key, v)} />
                        ))}
                        </div>
                      )
                    })
                  : getFieldsBySection(s).filter(visible).map((f) => (
                      <FieldEditor key={f.key} field={f} metadata={metadata} canWrite={canWrite} onChange={(v) => handleFieldChange(f.key, v)} />
                    ))}
              </Card>
            ))}
        </div>

        <JsonLdDialog open={previewOpen} onOpenChange={setPreviewOpen} json={jsonLdStr} fileName={`${catalog.entityId ?? catalog.id}.jsonld`} />
      </div>
    </TooltipProvider>
  )
}

/** What the Generated section builds on its own, so the user sees it is covered. */
function GeneratedSummary({ schemaMapping, cache, jsonLd }: {
  schemaMapping?: SchemaMapping
  cache?: CatalogResultCache | null
  jsonLd: string
}) {
  const { t } = useTranslation()
  const tableCount = useMemo(() => {
    const parsed = JSON.parse(jsonLd) as { 'dcat:dataset'?: { 'healthdcatap:hasVariables'?: { 'csvw:table'?: unknown[] | unknown } } }
    const tables = parsed['dcat:dataset']?.['healthdcatap:hasVariables']?.['csvw:table']
    return Array.isArray(tables) ? tables.length : tables ? 1 : 0
  }, [jsonLd])
  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs text-muted-foreground">{t('dcat.generated_intro')}</p>
      <GeneratedRow
        ok={tableCount > 0}
        title={t('dcat.generated_variables')}
        detail={schemaMapping ? t('dcat.generated_variables_detail', { count: tableCount }) : t('dcat.generated_variables_none')}
      />
      <GeneratedRow
        ok={!!cache?.concepts.length}
        title={t('dcat.generated_analytics')}
        detail={cache?.concepts.length ? t('dcat.generated_analytics_detail') : t('dcat.generated_analytics_none')}
      />
    </div>
  )
}

function GeneratedRow({ ok, title, detail }: { ok: boolean; title: string; detail: string }) {
  return (
    <div className="flex items-start gap-2 rounded-lg border bg-muted/30 px-3 py-2">
      {ok
        ? <Check size={14} className="mt-px shrink-0 text-emerald-600 dark:text-emerald-400" />
        : <Info size={14} className="mt-px shrink-0 text-muted-foreground" />}
      <div className="min-w-0">
        <p className="text-xs font-medium">{title}</p>
        <p className="text-xs text-muted-foreground">{detail}</p>
      </div>
    </div>
  )
}

function JsonLdDialog({ open, onOpenChange, json, fileName }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  json: string
  fileName: string
}) {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    if (!(await copyText(json))) return
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }
  const download = () => {
    const url = URL.createObjectURL(new Blob([json], { type: 'application/ld+json' }))
    const a = document.createElement('a')
    a.href = url
    a.download = fileName
    a.click()
    URL.revokeObjectURL(url)
  }
  return (
    <DialogShell
      open={open}
      onOpenChange={onOpenChange}
      kind="workbench"
      className="sm:max-w-[min(1320px,96vw)]"
      title={t('dcat.jsonld_preview')}
      cancelLabel={t('common.close')}
      footerExtra={
        <div className="flex items-center gap-2 sm:mr-auto">
          <Button variant="outline" size="sm" className="gap-1.5" onClick={() => void copy()}>
            {copied ? <Check size={14} /> : <Copy size={14} />}
            {copied ? t('dcat.copied') : t('dcat.copy_jsonld')}
          </Button>
          <Button variant="outline" size="sm" className="gap-1.5" onClick={download}>
            <Download size={14} />
            {t('dcat.export_jsonld')}
          </Button>
        </div>
      }
    >
      <div className="h-full min-h-0 overflow-hidden rounded-md border">
        <CodeViewerBoundary fallback={<pre className="h-full overflow-auto p-3 text-xs">{json}</pre>}>
          <CodeViewer value={json} language="json" height="100%" />
        </CodeViewerBoundary>
      </div>
    </DialogShell>
  )
}

// ---------------------------------------------------------------------------
// One field
// ---------------------------------------------------------------------------

function optionLabel(o: VocabularyOption, t: (k: string) => string, language: string): string {
  if (o.labelKey) return t(o.labelKey)
  const country = o.value.match(/\/country\/([A-Z]{3})$/)?.[1]
  if (country) return new Intl.DisplayNames([language], { type: 'region' }).of(COUNTRY_ALPHA2[country]) ?? o.label
  return o.label
}

function FieldEditor({ field, metadata, canWrite, onChange }: {
  field: DcatFieldDef
  metadata: Record<string, unknown>
  canWrite: boolean
  onChange: (value: unknown) => void
}) {
  const { t } = useTranslation()
  const language = useAppStore((s) => s.language)
  const value = metadata[field.key]
  const strVal = value != null ? String(value) : ''
  const arrVal = Array.isArray(value) ? value.map(String) : []
  const obligation = effectiveObligation(field, metadata)
  const options = field.vocabularyKey ? DCAT_VOCABULARIES[field.vocabularyKey] ?? [] : []
  const id = `dcat-${field.key}`

  return (
    <div className="grid grid-cols-1 items-start gap-x-3 gap-y-1 sm:grid-cols-[16rem_minmax(0,1fr)]">
      {/* The obligation badge closes the label column, so every badge lines up against its field. */}
      <div className="flex min-h-8 items-center gap-1.5">
        <Label htmlFor={id} className="leading-tight">{t(field.labelKey)}</Label>
        <Tooltip>
          <TooltipTrigger asChild>
            <button type="button" className="text-muted-foreground hover:text-foreground" aria-label={t(field.descriptionKey)}>
              <Info size={12} />
            </button>
          </TooltipTrigger>
          <TooltipContent side="right" className="max-w-xs">
            <p>{t(field.descriptionKey)}</p>
            <p className="mt-1 font-mono text-[10px] opacity-70">{field.uri}</p>
          </TooltipContent>
        </Tooltip>
        {obligation !== 'optional' && (
          <Badge variant="secondary" size="xs" className={cn('ml-auto shrink-0', OBLIGATION_COLORS[obligation])}>
            {t(`dcat.${obligation}`)}
          </Badge>
        )}
      </div>
      <div className="min-w-0">
        {(field.type === 'text' || field.type === 'email' || field.type === 'uri') && (
          <Input
            id={id}
            type={field.type === 'text' ? 'text' : field.type === 'email' ? 'email' : 'url'}
            value={strVal}
            disabled={!canWrite}
            onChange={(e) => onChange(e.target.value)}
            placeholder={field.type === 'uri' ? 'https://…' : field.type === 'email' ? 'name@example.org' : undefined}
            className="h-8 text-xs"
          />
        )}
        {field.type === 'localized' && (
          <Textarea id={id} value={strVal} disabled={!canWrite} onChange={(e) => onChange(e.target.value)} rows={2} className="text-xs" />
        )}
        {field.type === 'number' && (
          <Input
            id={id}
            type="number"
            min={0}
            value={strVal}
            disabled={!canWrite}
            onChange={(e) => onChange(e.target.value ? Number(e.target.value) : undefined)}
            className="h-8 w-40 text-xs"
          />
        )}
        {field.type === 'date' && (
          <div className="w-48">
            <DatePickerField value={strVal || undefined} onChange={(v) => onChange(v ?? '')} />
          </div>
        )}
        {field.type === 'boolean' && (
          <div className="flex h-8 items-center gap-2">
            <Switch id={id} checked={value === true || value === 'true'} disabled={!canWrite} onCheckedChange={(v) => onChange(v)} />
            <span className="text-xs text-muted-foreground">{value === true || value === 'true' ? t('dcat.yes') : t('dcat.no')}</span>
          </div>
        )}
        {field.type === 'select' && (
          <Select value={strVal || '__none__'} disabled={!canWrite} onValueChange={(v) => onChange(v === '__none__' ? undefined : v)}>
            <SelectTrigger id={id} className="h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__none__" className="text-xs">—</SelectItem>
              {options.map((o) => (
                <SelectItem key={o.value} value={o.value} className="text-xs">{optionLabel(o, t, language)}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        {field.type === 'multiselect' && (
          <MultiSelectFilter
            value={arrVal}
            options={options.map((o) => ({ value: o.value, label: optionLabel(o, t, language) }))}
            placeholder="—"
            onChange={(v) => onChange(v)}
            showChevron
            // As wide as the field: category names run long, and the column has the room.
            popoverWidthClass="w-(--radix-popover-trigger-width) min-w-80"
            triggerClass={cn(MULTI_SELECT_FORM_TRIGGER, !canWrite && 'pointer-events-none opacity-50')}
          />
        )}
        {field.type === 'tags' && <TagsInput value={arrVal} canWrite={canWrite} onChange={onChange} />}
      </div>
    </div>
  )
}

function TagsInput({ value, canWrite, onChange }: { value: string[]; canWrite: boolean; onChange: (v: string[]) => void }) {
  const { t } = useTranslation()
  const [input, setInput] = useState('')
  const add = () => {
    const v = input.trim()
    if (v && !value.includes(v)) onChange([...value, v])
    setInput('')
  }
  return (
    <div className="flex flex-col gap-1.5">
      {value.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {value.map((v) => (
            <Badge key={v} variant="secondary" className="gap-0.5 pr-0.5 font-mono">
              {v}
              {canWrite && (
                <button
                  type="button"
                  onClick={() => onChange(value.filter((x) => x !== v))}
                  className="rounded-sm p-0.5 text-muted-foreground/60 transition-colors hover:bg-destructive/15 hover:text-destructive"
                  aria-label={t('common.remove')}
                >
                  <X size={10} />
                </button>
              )}
            </Badge>
          ))}
        </div>
      )}
      <div className="flex items-center gap-1">
        <Input
          value={input}
          disabled={!canWrite}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add() } }}
          placeholder={t('dcat.code_value_placeholder')}
          className="h-8 max-w-64 text-xs"
        />
        <Button variant="ghost" size="icon-sm" onClick={add} disabled={!input.trim() || !canWrite} aria-label={t('common.add')}>
          <Plus size={14} />
        </Button>
      </div>
    </div>
  )
}
