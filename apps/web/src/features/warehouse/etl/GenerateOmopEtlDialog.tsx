import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle } from 'lucide-react'
import { DialogShell } from '@/components/ui/dialog-shell'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import { FormField } from '@/components/ui/form-field'
import { Input } from '@/components/ui/input'
import { SectionLabel } from '@/components/ui/section-label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useEtlStore } from '@/stores/etl-store'
import { useDataSourceStore } from '@/stores/data-source-store'
import { useSchemaPresetStore } from '@/stores/schema-preset-store'
import { localized } from '@/lib/localized'
import { parseDdl } from '@/lib/ddl-parse'
import { eventTargetChoices, generateOmopEtl, generatedScriptState, type EtlConceptMode } from '@/lib/schema-classes/omop-etl'
import { findSourcePreset } from '@/lib/find-source-preset'
import type { EtlFile } from '@/types'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  pipelineId: string
}

const SKIP = '__skip'

/**
 * Generate the OMOP load scripts from the two databases' schemas (plan §9): the
 * source mapping says how to read each class, the target's where it goes. A
 * script nobody edited is overwritten on regeneration; an edited one only when
 * the user ticks it.
 */
export function GenerateOmopEtlDialog({ open, onOpenChange, pipelineId }: Props) {
  const { t, i18n } = useTranslation()
  const pipeline = useEtlStore((s) => s.etlPipelines.find((p) => p.id === pipelineId))
  const files = useEtlStore((s) => s.files)
  const dataSources = useDataSourceStore((s) => s.dataSources)
  const presets = useSchemaPresetStore((s) => s.presets)
  const source = dataSources.find((d) => d.id === pipeline?.sourceDataSourceId)
  const target = dataSources.find((d) => d.id === pipeline?.targetDataSourceId)

  const vocabMode = pipeline?.config?.vocabulary?.mode
  const [mode, setMode] = useState<EtlConceptMode>(!pipeline?.mappingProjectId ? 'as-is' : vocabMode === 'stcm' || !vocabMode ? 'stcm' : 'ccr')
  const [typeConcept, setTypeConcept] = useState('32817')
  const [eventTargets, setEventTargets] = useState<Record<string, string | null>>({})
  const [overwrite, setOverwrite] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const ddl = useMemo(() => {
    const text = target?.schemaMapping?.ddl ?? (target ? findSourcePreset(target, presets)?.mapping.ddl : undefined)
    return text ? parseDdl(text) : []
  }, [target, presets])

  const choices = useMemo(
    () => (source?.schemaMapping && target?.schemaMapping ? eventTargetChoices(source.schemaMapping, target.schemaMapping) : []),
    [source?.schemaMapping, target?.schemaMapping],
  )

  const result = useMemo(() => {
    if (!source?.schemaMapping || !target?.schemaMapping) return null
    return generateOmopEtl(source.schemaMapping, target.schemaMapping, ddl, {
      sourceLabel: localized(source.name, i18n.language),
      typeConceptId: Number(typeConcept) || undefined,
      conceptMode: mode,
      eventTargets,
    })
  }, [source, target, ddl, typeConcept, mode, eventTargets, i18n.language])

  const own = files.filter((f) => f.pipelineId === pipelineId && f.type === 'file' && !f.parentId)
  const planned = (result?.scripts ?? []).map((s) => {
    const existing = own.find((f) => f.name === s.name)
    const state = existing ? generatedScriptState(existing.content ?? '') : null
    return { ...s, existing, status: !existing ? 'new' : state === 'generated' ? 'update' : 'edited' } as const
  })
  const writable = planned.filter((p) => p.status !== 'edited' || overwrite.has(p.name))

  const write = async () => {
    setBusy(true)
    setError(null)
    try {
      const { createFile, updateFile } = useEtlStore.getState()
      for (const p of writable) {
        if (p.existing) {
          await updateFile(p.existing.id, { content: p.sql })
          continue
        }
        const file: EtlFile = {
          id: crypto.randomUUID(),
          pipelineId,
          name: p.name,
          type: 'file',
          parentId: null,
          content: p.sql,
          language: 'sql',
          order: p.order,
          createdAt: new Date().toISOString(),
        }
        await createFile(file)
      }
      onOpenChange(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const missing = !source?.schemaMapping ? t('etl.gen_no_source') : !target?.schemaMapping ? t('etl.gen_no_target') : null

  return (
    <DialogShell
      open={open}
      onOpenChange={onOpenChange}
      kind="settings"
      title={t('etl.gen_title')}
      description={t('etl.gen_description')}
      confirmLabel={t('etl.gen_confirm', { count: writable.length })}
      confirmDisabled={!!missing || writable.length === 0}
      onConfirm={() => void write()}
      busy={busy}
    >
      {missing ? (
        <p className="text-xs text-muted-foreground">{missing}</p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3">
            <FormField label={t('etl.gen_concepts')}>
              {({ id }) => (
                <Select value={mode} onValueChange={(v) => setMode(v as EtlConceptMode)}>
                  <SelectTrigger id={id} className="h-8 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="ccr">{t('etl.gen_concepts_ccr')}</SelectItem>
                    <SelectItem value="stcm">{t('etl.gen_concepts_stcm')}</SelectItem>
                    <SelectItem value="as-is">{t('etl.gen_concepts_as_is')}</SelectItem>
                  </SelectContent>
                </Select>
              )}
            </FormField>
            <FormField label={t('etl.gen_type_concept')}>
              {({ id }) => <Input id={id} className="h-8 text-xs" inputMode="numeric" value={typeConcept} onChange={(e) => setTypeConcept(e.target.value)} />}
            </FormField>
          </div>

          {choices.length > 0 && (
            <div className="space-y-1.5">
              <SectionLabel>{t('etl.gen_events')}</SectionLabel>
              {choices.map((c) => (
                <div key={c.specKey} className="flex items-center gap-2 text-xs">
                  <span className="min-w-0 flex-1 truncate">{c.label}</span>
                  {c.cls === 'drug' && <Badge variant="outline">{t('etl.gen_drug')}</Badge>}
                  <Select
                    value={(c.specKey in eventTargets ? eventTargets[c.specKey] : c.default) ?? SKIP}
                    onValueChange={(v) => setEventTargets({ ...eventTargets, [c.specKey]: v === SKIP ? null : v })}
                  >
                    <SelectTrigger className="h-7 w-48 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={SKIP}>{t('etl.gen_skip')}</SelectItem>
                      {c.tables.map((table) => (
                        <SelectItem key={table} value={table}>{table}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ))}
            </div>
          )}

          <div className="space-y-1.5">
            <SectionLabel>{t('etl.gen_scripts')}</SectionLabel>
            {planned.length === 0 && <p className="text-xs text-muted-foreground">{t('etl.gen_nothing')}</p>}
            {planned.map((p) => (
              <div key={p.name} className="flex items-center gap-2 text-xs">
                <span className="min-w-0 flex-1 truncate font-mono">{p.name}</span>
                {p.status === 'edited' ? (
                  <label className="flex items-center gap-1.5 text-amber-600 dark:text-amber-400">
                    <Checkbox
                      checked={overwrite.has(p.name)}
                      onCheckedChange={(v) => {
                        const next = new Set(overwrite)
                        if (v) next.add(p.name)
                        else next.delete(p.name)
                        setOverwrite(next)
                      }}
                    />
                    {t('etl.gen_overwrite_edited')}
                  </label>
                ) : (
                  <Badge variant="outline">{t(p.status === 'new' ? 'etl.gen_status_new' : 'etl.gen_status_update')}</Badge>
                )}
              </div>
            ))}
          </div>

          {(result?.warnings.length ?? 0) > 0 && (
            <ul className="space-y-1 text-xs text-amber-600 dark:text-amber-400">
              {result!.warnings.map((w) => (
                <li key={JSON.stringify(w)} className="flex items-start gap-1.5">
                  <AlertTriangle size={12} className="mt-0.5 shrink-0" />
                  {w.kind === 'table-not-in-ddl'
                    ? t('etl.gen_warn_table_not_in_ddl', { table: w.table })
                    : w.kind === 'no-target-relation'
                      ? t('etl.gen_warn_no_target_relation', { relation: w.relation })
                      : t('etl.gen_warn_no_target_table', { table: w.label })}
                </li>
              ))}
            </ul>
          )}
          {error && <p className="text-xs text-destructive">{error}</p>}
        </>
      )}
    </DialogShell>
  )
}
