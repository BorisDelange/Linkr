import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { DialogShell } from '@/components/ui/dialog-shell'
import { FormField } from '@/components/ui/form-field'
import { Input } from '@/components/ui/input'
import { NumberInput } from '@/components/ui/number-input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import {
  createEmbeddingConfig, updateEmbeddingConfig,
  type ConfigInput, type EmbeddingConfig, type EmbeddingModel, type TargetFilters,
} from '@/lib/api/suggestion-engines'
import { TargetScopeFields } from './TargetScopeFields'

const SLUG_RE = /^[a-z0-9][a-z0-9._-]{0,39}$/

function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[-._]+|[-._]+$/g, '').slice(0, 40)
}

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  workspaceId: string
  models: EmbeddingModel[]
  vocabularies: string[]
  conceptClasses: string[]
  /** Edit this one; create when null. */
  config: EmbeddingConfig | null
  onSaved: () => void
}

/** Create or edit an embedding configuration: model, text template, target scope, device. */
export function EmbeddingConfigDialog({ open, onOpenChange, workspaceId, models, vocabularies, conceptClasses, config, onSaved }: Props) {
  const { t } = useTranslation()
  const [name, setName] = useState(config?.name ?? '')
  const [slug, setSlug] = useState(config?.slug ?? '')
  const [slugTouched, setSlugTouched] = useState(!!config)
  const [modelId, setModelId] = useState(config?.modelId ?? models[0]?.id ?? '')
  const [template, setTemplate] = useState<EmbeddingConfig['template']>(config?.template ?? 'name_class')
  const [filters, setFilters] = useState<TargetFilters>(
    config?.filters ?? { onlyStandard: true, onlyValid: true, domains: [], vocabularies: [], conceptClasses: [] },
  )
  const [device, setDevice] = useState<EmbeddingConfig['device']>(config?.device ?? 'auto')
  const [batchSize, setBatchSize] = useState(config?.batchSize ?? 256)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const effectiveSlug = slugTouched ? slug : slugify(name)
  const indexChanges = !!config && (
    config.modelId !== modelId || config.template !== template || JSON.stringify(config.filters) !== JSON.stringify(filters)
  )

  const save = async () => {
    setSaving(true)
    setError(null)
    const body: ConfigInput = { name: name.trim(), slug: effectiveSlug, modelId, template, filters, device, batchSize }
    try {
      if (config) await updateEmbeddingConfig(workspaceId, config.id, body)
      else await createEmbeddingConfig(workspaceId, body)
      onSaved()
      onOpenChange(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <DialogShell
      open={open}
      onOpenChange={onOpenChange}
      kind="settings"
      title={config ? t('concept_mapping.engines_config_edit_title') : t('concept_mapping.engines_config_new_title')}
      description={t('concept_mapping.engines_config_description')}
      onConfirm={save}
      confirmLabel={config ? t('common.save') : t('common.create')}
      confirmDisabled={!name.trim() || !SLUG_RE.test(effectiveSlug) || !modelId}
      busy={saving}
    >
      <div className="grid grid-cols-2 gap-3">
        <FormField label={t('concept_mapping.engines_config_name')} required>
          {({ id }) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} />}
        </FormField>
        <FormField
          label={t('concept_mapping.engines_config_slug')}
          hint={t('concept_mapping.engines_config_slug_hint', { method: `semantic/${effectiveSlug || '…'}` })}
          hintInTooltip
          required
        >
          {({ id }) => (
            <Input
              id={id}
              className="font-mono"
              value={effectiveSlug}
              aria-invalid={!!effectiveSlug && !SLUG_RE.test(effectiveSlug)}
              onChange={(e) => { setSlugTouched(true); setSlug(e.target.value) }}
            />
          )}
        </FormField>
      </div>
      <FormField label={t('concept_mapping.engines_config_model')} required>
        {({ id }) => (
          <Select value={modelId} onValueChange={setModelId}>
            <SelectTrigger id={id}><SelectValue /></SelectTrigger>
            <SelectContent>
              {models.map((m) => <SelectItem key={m.id} value={m.id}>{m.name}</SelectItem>)}
            </SelectContent>
          </Select>
        )}
      </FormField>
      <FormField label={t('concept_mapping.engines_config_template')} hint={t('concept_mapping.engines_config_template_hint')} hintInTooltip>
        {({ id }) => (
          <Select value={template} onValueChange={(v) => setTemplate(v as EmbeddingConfig['template'])}>
            <SelectTrigger id={id}><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="name_class">{t('concept_mapping.engines_template_name_class')}</SelectItem>
              <SelectItem value="name">{t('concept_mapping.engines_template_name')}</SelectItem>
            </SelectContent>
          </Select>
        )}
      </FormField>
      <TargetScopeFields value={filters} onChange={setFilters} vocabularies={vocabularies} conceptClasses={conceptClasses} allLabel={t('concept_mapping.engines_all')} />
      <div className="grid grid-cols-2 gap-3">
        <FormField label={t('concept_mapping.engines_config_device')} hint={t('concept_mapping.engines_config_device_hint')} hintInTooltip>
          {({ id }) => (
            <Select value={device} onValueChange={(v) => setDevice(v as EmbeddingConfig['device'])}>
              <SelectTrigger id={id}><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">{t('concept_mapping.engines_device_auto')}</SelectItem>
                <SelectItem value="cpu">CPU</SelectItem>
                <SelectItem value="cuda">CUDA (NVIDIA)</SelectItem>
                <SelectItem value="mps">MPS (Apple)</SelectItem>
              </SelectContent>
            </Select>
          )}
        </FormField>
        <FormField label={t('concept_mapping.engines_config_batch')}>
          {({ id }) => <NumberInput id={id} value={batchSize} onValueChange={setBatchSize} min={1} max={4096} integer />}
        </FormField>
      </div>
      {indexChanges && <p className="text-xs text-warning-foreground">{t('concept_mapping.engines_config_index_reset')}</p>}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </DialogShell>
  )
}
