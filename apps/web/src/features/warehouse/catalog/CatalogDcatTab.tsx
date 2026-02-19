import { useState, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Copy, Check, Sparkles } from 'lucide-react'
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
import { useCatalogStore } from '@/stores/catalog-store'
import {
  DCAT_FIELDS,
  DCAT_VOCABULARIES,
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
  const [copied, setCopied] = useState(false)

  // Local metadata state — initialized from persisted catalog
  const metadata: Record<string, unknown> = catalog.dcatApMetadata ?? {}

  // Auto-fill values from computed cache
  const autoValues = useMemo(() => {
    if (!cache) return {}
    const vals: Record<string, unknown> = {}
    vals['dataset.numberOfRecords'] = cache.rows.length
    vals['dataset.numberOfUniqueIndividuals'] = cache.totalPatients
    return vals
  }, [cache])

  const handleFieldChange = async (key: string, value: unknown) => {
    const next = { ...metadata, [key]: value }
    // Remove empty values
    if (value === '' || value === undefined || value === null) {
      delete next[key]
    }
    await updateCatalog(catalog.id, { dcatApMetadata: next })
  }

  const handleAutoFill = async () => {
    const next = { ...metadata }
    // Pre-fill from catalog metadata
    if (!next['catalog.title']) next['catalog.title'] = catalog.name
    if (!next['catalog.description'] && catalog.description) next['catalog.description'] = catalog.description
    if (!next['dataset.title']) next['dataset.title'] = catalog.name
    if (!next['dataset.description'] && catalog.description) next['dataset.description'] = catalog.description
    if (!next['dataset.identifier']) next['dataset.identifier'] = catalog.id
    // Pre-fill from cache
    for (const [k, v] of Object.entries(autoValues)) {
      if (!next[k] && v != null) next[k] = v
    }
    await updateCatalog(catalog.id, { dcatApMetadata: next })
  }

  const handleMultiselectToggle = async (key: string, value: string) => {
    const current = Array.isArray(metadata[key]) ? (metadata[key] as string[]) : []
    const next = current.includes(value)
      ? current.filter((v) => v !== value)
      : [...current, value]
    await handleFieldChange(key, next.length > 0 ? next : undefined)
  }

  const jsonLd = useMemo(() => buildJsonLd(metadata), [metadata])

  const handleCopyJsonLd = async () => {
    await navigator.clipboard.writeText(JSON.stringify(jsonLd, null, 2))
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  // Count completion
  const mandatoryFields = DCAT_FIELDS.filter((f) => f.obligation === 'mandatory')
  const filledMandatory = mandatoryFields.filter((f) => {
    const val = metadata[f.key]
    return val !== undefined && val !== null && val !== ''
  })

  return (
    <div className="space-y-4">
      {/* Header with auto-fill + completion */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Button variant="outline" size="sm" onClick={handleAutoFill}>
            <Sparkles size={14} />
            {t('dcat.auto_fill')}
          </Button>
          <span className="text-xs text-muted-foreground">
            {t('dcat.completion', {
              filled: filledMandatory.length,
              total: mandatoryFields.length,
            })}
          </span>
        </div>
        <Button variant="outline" size="sm" onClick={handleCopyJsonLd}>
          {copied ? <Check size={14} /> : <Copy size={14} />}
          {copied ? t('dcat.copied') : t('dcat.copy_jsonld')}
        </Button>
      </div>

      {/* Field sections by class */}
      {CLASS_ORDER.map(({ key: dcatClass, labelKey }) => {
        const fields = getFieldsByClass(dcatClass)
        return (
          <Card key={dcatClass} className="p-4">
            <h3 className="text-sm font-semibold">{t(labelKey)}</h3>
            <div className="mt-3 space-y-3">
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

      {/* JSON-LD preview */}
      <Card className="p-4">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold">{t('dcat.jsonld_preview')}</h3>
          <Button variant="ghost" size="sm" onClick={handleCopyJsonLd}>
            {copied ? <Check size={14} /> : <Copy size={14} />}
          </Button>
        </div>
        <pre className="mt-2 max-h-80 overflow-auto rounded-md bg-muted p-3 text-xs">
          {JSON.stringify(jsonLd, null, 2)}
        </pre>
      </Card>
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

  return (
    <div className="grid grid-cols-[1fr_2fr] items-start gap-3">
      <div className="flex items-center gap-2 pt-1.5">
        <Label className="text-xs">
          {t(field.labelKey)}
        </Label>
        <Badge
          variant="secondary"
          className={`text-[9px] leading-none ${OBLIGATION_COLORS[field.obligation]}`}
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
            className="text-sm"
          />
        )}
        {field.type === 'uri' && (
          <Input
            type="url"
            value={strVal}
            onChange={(e) => onChange(e.target.value)}
            placeholder="https://..."
            className="text-sm"
          />
        )}
        {field.type === 'date' && (
          <Input
            type="date"
            value={strVal}
            onChange={(e) => onChange(e.target.value)}
            className="text-sm"
          />
        )}
        {field.type === 'number' && (
          <Input
            type="number"
            min={0}
            value={strVal}
            onChange={(e) => onChange(e.target.value ? Number(e.target.value) : undefined)}
            placeholder={t(field.descriptionKey)}
            className="text-sm"
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
            <SelectTrigger className="text-sm">
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
        )}
      </div>
    </div>
  )
}
