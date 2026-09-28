import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, ArrowUpFromLine, Check, Pencil, RefreshCw, RotateCcw, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { DialogShell } from '@/components/ui/dialog-shell'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { localized } from '@/lib/localized'
import { sanitizeSchemaMapping } from '@/lib/schema-helpers'
import { appliedSpecKey, diffOverrides, effectiveMapping, isEmptyOverrides, overrideKeyFor, revertOverride, staleOverrides } from '@/lib/schema-classes/overrides'
import { specAt, withSpec } from '@/lib/schema-classes/spec'
import { useDataSourceStore } from '@/stores/data-source-store'
import { useSchemaPresetStore } from '@/stores/schema-preset-store'
import { useMyWorkspaceRole } from '@/hooks/use-context-role'
import { MappingEditor } from '@/features/warehouse/schema-mapping/MappingEditor'
import type { DataSource } from '@/types'
import type { SchemaMapping, SchemaOverrides } from '@/types/schema-mapping'
import { findSourcePreset } from '@/lib/find-source-preset'

/**
 * A database's mapping: its preset's copy (the base) with what this site changes
 * on top (plan §7): whole relations, replaced, added or removed. The base is replaced only by an explicit "Update from preset",
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

  const [draft, setDraft] = useState<{ mapping: SchemaMapping } | null>(null)
  const [updateOpen, setUpdateOpen] = useState(false)

  if (!base) {
    return <p className="px-6 py-10 text-center text-sm text-muted-foreground">{t('schema_mapping.db_no_mapping')}</p>
  }

  const editing = !!draft
  const shown = draft?.mapping ?? source.schemaMapping ?? base
  const pendingOverrides: SchemaOverrides | null = draft
    ? diffOverrides(base, draft.mapping, overrides)
    : overrides
  // Keyed as the editor shows them: an override that renamed a base relation
  // shows under its new name.
  const overridden = new Set(Object.entries(pendingOverrides?.relations ?? {}).map(([key, spec]) => appliedSpecKey(key, spec)))
  const stale = new Set(staleOverrides(base, overrides).map((key) => appliedSpecKey(key, overrides!.relations![key])))

  const save = async (next: SchemaOverrides | null) => {
    await updateDataSource(source.id, { schemaOverrides: isEmptyOverrides(next) ? null : next })
  }

  const startEdit = () =>
    setDraft({ mapping: structuredClone(source.schemaMapping ?? base) })

  const revert = (shownKey: string) => {
    if (draft) {
      const key = overrideKeyFor(pendingOverrides, shownKey)
      setDraft({ ...draft, mapping: withSpec(draft.mapping, shownKey, specAt(base, key)) })
    } else if (overrides) {
      void save(revertOverride(overrides, overrideKeyFor(overrides, shownKey)))
    }
  }

  const removedKeys = pendingOverrides?.removed ?? []
  /** Bring a removed base relation back: re-added to the draft, or the removal
   *  dropped from the stored overrides. */
  const restore = (specKey: string) => {
    const baseSpec = specAt(base, specKey)
    if (!baseSpec) return
    if (draft) setDraft({ ...draft, mapping: effectiveMapping(draft.mapping, { relations: { [specKey]: baseSpec } }) })
    else if (overrides) void save(revertOverride(overrides, specKey))
  }

  /** Push one override up into the preset, then follow the preset: the relation
   *  is no longer a difference. */
  const promote = async (shownKey: string) => {
    const spec = specAt(source.schemaMapping ?? base, shownKey)
    const specKey = overrideKeyFor(overrides, shownKey)
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
            <Button variant="ghost" size="sm" className="h-7 gap-1 text-xs" onClick={() => setDraft(null)}>
              <X size={12} />
              {t('common.cancel')}
            </Button>
            <Button
              size="sm"
              className="h-7 gap-1 text-xs"
              onClick={async () => {
                await save(pendingOverrides)
                setDraft(null)
              }}
            >
              <Check size={12} />
              {t('common.save')}
            </Button>
          </>
        )}
      </div>

      {removedKeys.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
          <span>{t('schema_mapping.db_removed_relations')}</span>
          {removedKeys.map((key) => (
            <Badge key={key} variant="outline" className="gap-1 font-mono">
              {key}
              {canWrite && (
                <button
                  type="button"
                  className="text-muted-foreground hover:text-foreground"
                  onClick={() => restore(key)}
                  aria-label={t('schema_mapping.restore')}
                  title={t('schema_mapping.restore')}
                >
                  <RotateCcw size={10} />
                </button>
              )}
            </Badge>
          ))}
        </div>
      )}

      <MappingEditor
        mapping={shown}
        readOnly={!editing}
        onChange={(m) => draft && setDraft({ ...draft, mapping: m })}
        previewSources={[{ id: source.id, label: localized(source.name, i18n.language) }]}
        relationExtra={relationExtra}
        persist={canWrite && !editing ? (m) => void save(diffOverrides(base, m, overrides)) : undefined}
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
