import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, ArrowUpFromLine, Pencil, RefreshCw, RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { DialogShell } from '@/components/ui/dialog-shell'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { localized } from '@/lib/localized'
import { sanitizeSchemaMapping } from '@/lib/schema-helpers'
import { diffOverrides, effectiveMapping, isEmptyOverrides, revertOverride, staleOverrides } from '@/lib/schema-classes/overrides'
import { specAt, withSpec } from '@/lib/schema-classes/spec'
import { useDataSourceStore } from '@/stores/data-source-store'
import { useSchemaPresetStore } from '@/stores/schema-preset-store'
import { useMyWorkspaceRole } from '@/hooks/use-context-role'
import { MappingEditor, ParamsEditor } from '@/features/warehouse/schema-mapping/MappingEditor'
import type { DataSource } from '@/types'
import type { SchemaMapping, SchemaOverrides } from '@/types/schema-mapping'
import { findSourcePreset } from './AddDatabaseDialog'

/**
 * A database's mapping: its preset's copy (the base) with what this site changes
 * on top (plan §7) — parameter values first, whole relations for a structural
 * difference. The base is replaced only by an explicit "Update from preset",
 * which keeps the overrides and flags those whose base the preset changed.
 */
export function DatabaseMappingTab({ source, readOnly }: { source: DataSource; readOnly?: boolean }) {
  const { t, i18n } = useTranslation()
  const updateDataSource = useDataSourceStore((s) => s.updateDataSource)
  const presets = useSchemaPresetStore((s) => s.presets)
  const savePreset = useSchemaPresetStore((s) => s.savePreset)
  const presetsLoaded = useSchemaPresetStore((s) => s.loaded)
  const loadPresets = useSchemaPresetStore((s) => s.loadPresets)
  // The installed preset is what "Update from preset" and "Promote" act on; the
  // store is filled by the Schemas page, which this tab may be opened without.
  useEffect(() => {
    if (!presetsLoaded) void loadPresets(source.workspaceId)
  }, [presetsLoaded, loadPresets, source.workspaceId])
  const { can } = useMyWorkspaceRole()
  const canWrite = !readOnly && can('databases:write')
  const canPromote = canWrite && can('schemas:write')

  const base = source.schemaBaseMapping ?? source.schemaMapping
  const overrides = source.schemaOverrides ?? null
  const preset = useMemo(() => findSourcePreset(source, presets), [source, presets])

  const [draft, setDraft] = useState<{ mapping: SchemaMapping; params: Record<string, string> } | null>(null)
  const [updateOpen, setUpdateOpen] = useState(false)

  if (!base) {
    return <p className="px-6 py-10 text-center text-sm text-muted-foreground">{t('schema_mapping.db_no_mapping')}</p>
  }

  const editing = !!draft
  const shown = draft?.mapping ?? source.schemaMapping ?? base
  const pendingOverrides: SchemaOverrides | null = draft
    ? diffOverrides(base, draft.mapping, { ...(overrides ?? {}), params: draft.params })
    : overrides
  const overridden = new Set(Object.keys(pendingOverrides?.relations ?? {}))
  const stale = new Set(staleOverrides(base, overrides))

  const save = async (next: SchemaOverrides | null) => {
    await updateDataSource(source.id, { schemaOverrides: isEmptyOverrides(next) ? null : next })
  }

  const startEdit = () =>
    setDraft({ mapping: structuredClone(source.schemaMapping ?? base), params: { ...(overrides?.params ?? {}) } })

  const revert = (specKey: string) => {
    if (draft) {
      setDraft({ ...draft, mapping: withSpec(draft.mapping, specKey, specAt(base, specKey)) })
    } else if (overrides) {
      void save(revertOverride(overrides, specKey))
    }
  }

  /** Push one override up into the preset, then follow the preset: the relation
   *  is no longer a difference. */
  const promote = async (specKey: string) => {
    const spec = specAt(source.schemaMapping ?? base, specKey)
    if (!preset || !spec || !overrides) return
    const presetMapping = specAt(preset.mapping, specKey)
      ? withSpec(preset.mapping, specKey, spec)
      : effectiveMapping(preset.mapping, { relations: { [specKey]: spec } })
    await savePreset({ ...preset, mapping: presetMapping, updatedAt: new Date().toISOString() })
    const next = revertOverride(overrides, specKey)
    await updateDataSource(source.id, {
      schemaMapping: sanitizeSchemaMapping(presetMapping),
      schemaOverrides: isEmptyOverrides(next) ? null : next,
    })
  }

  const relationExtra = (specKey: string) => {
    if (!overridden.has(specKey)) return null
    return (
      <span className="flex items-center gap-1">
        <Badge variant="outline" className="border-amber-400/50 text-amber-600 dark:text-amber-400">
          {t('schema_mapping.overridden')}
        </Badge>
        {stale.has(specKey) && (
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <AlertTriangle size={12} className="text-amber-600" />
              </TooltipTrigger>
              <TooltipContent className="max-w-64">{t('schema_mapping.stale_override')}</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        )}
        {canWrite && (
          <Button variant="ghost" size="sm" className="h-5 gap-1 px-1.5 text-[10px]" onClick={() => revert(specKey)}>
            <RotateCcw size={10} />
            {t('schema_mapping.revert')}
          </Button>
        )}
        {canPromote && preset && !editing && (
          <Button variant="ghost" size="sm" className="h-5 gap-1 px-1.5 text-[10px]" onClick={() => void promote(specKey)}>
            <ArrowUpFromLine size={10} />
            {t('schema_mapping.promote')}
          </Button>
        )}
      </span>
    )
  }

  const presetChanged = !!preset && JSON.stringify(sanitizeSchemaMapping(preset.mapping)) !== JSON.stringify(base)
  const staleAfterUpdate = preset ? staleOverrides(sanitizeSchemaMapping(preset.mapping), overrides) : []

  return (
    <div className="space-y-4 px-6 py-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-0 flex-1 text-xs text-muted-foreground">
          {t('schema_mapping.db_from_preset', {
            name: localized(source.schemaSource?.label ?? base.presetLabel, i18n.language),
            version: source.schemaSource?.version ?? '—',
          })}
          {overridden.size > 0 && ` · ${t('schema_mapping.db_overridden_count', { count: overridden.size })}`}
        </div>
        {canWrite && !editing && presetChanged && (
          <Button variant="outline" size="sm" className="h-7 gap-1 text-xs" onClick={() => setUpdateOpen(true)}>
            <RefreshCw size={12} />
            {t('schema_mapping.update_from_preset')}
          </Button>
        )}
        {canWrite && !editing && (
          <Button variant="outline" size="sm" className="h-7 gap-1 text-xs" onClick={startEdit}>
            <Pencil size={12} />
            {t('common.edit')}
          </Button>
        )}
        {editing && (
          <>
            <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setDraft(null)}>
              {t('common.cancel')}
            </Button>
            <Button
              size="sm"
              className="h-7 text-xs"
              onClick={async () => {
                await save(pendingOverrides)
                setDraft(null)
              }}
            >
              {t('common.save')}
            </Button>
          </>
        )}
      </div>

      <MappingEditor
        mapping={shown}
        readOnly={!editing}
        onChange={(m) => draft && setDraft({ ...draft, mapping: m })}
        previewSources={[{ id: source.id, label: localized(source.name, i18n.language) }]}
        relationExtra={relationExtra}
        canRemove={(specKey) => !specAt(base, specKey)}
        paramsSlot={
          <ParamsEditor
            params={base.params ?? {}}
            lang={i18n.language}
            readOnly={!editing}
            overrides={draft?.params ?? overrides?.params ?? {}}
            onOverrideChange={(params) => draft && setDraft({ ...draft, params, mapping: effectiveMapping(base, { ...(pendingOverrides ?? {}), params }) })}
          />
        }
      />

      {preset && (
        <DialogShell
          open={updateOpen}
          onOpenChange={setUpdateOpen}
          title={t('schema_mapping.update_title')}
          description={t('schema_mapping.update_description', {
            from: source.schemaSource?.version ?? '—',
            to: preset.version ?? '—',
          })}
          confirmLabel={t('schema_mapping.update_confirm')}
          onConfirm={async () => {
            await updateDataSource(source.id, {
              schemaMapping: sanitizeSchemaMapping(preset.mapping),
              ...(source.schemaSource
                ? { schemaSource: { ...source.schemaSource, ...(preset.version ? { version: preset.version } : {}) } }
                : {}),
            })
            setUpdateOpen(false)
          }}
        >
          {overridden.size === 0 ? (
            <p className="text-xs text-muted-foreground">{t('schema_mapping.update_no_overrides')}</p>
          ) : staleAfterUpdate.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t('schema_mapping.update_overrides_kept')}</p>
          ) : (
            <div className="space-y-1 text-xs">
              <p>{t('schema_mapping.update_stale')}</p>
              <ul className="list-inside list-disc font-mono">
                {staleAfterUpdate.map((k) => (
                  <li key={k}>{k}</li>
                ))}
              </ul>
            </div>
          )}
        </DialogShell>
      )}
    </div>
  )
}
