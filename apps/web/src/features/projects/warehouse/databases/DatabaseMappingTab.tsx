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
import { NoticeBanner } from '@/components/ui/notice-banner'
import type { IntrospectedTable } from '@/lib/duckdb/engine'
import { loadSourceTables } from '@/lib/sql-catalog'
import { absentRelations } from '@/lib/schema-classes/presence'

/** Missing-table notices closed, by database and the tables they listed: hidden
 *  until the page reloads, or until another table goes missing. */
const dismissedAbsent = new Set<string>()
const absentNoticeKey = (sourceId: string, absent: readonly { specKey: string; tables: string[] }[]) =>
  JSON.stringify([sourceId, ...absent.map((a) => [a.specKey, ...a.tables])])

/**
 * A database's mapping: its preset's copy (the base) with what this site changes
 * on top (plan §7): whole relations, replaced, added or removed. "Reset to preset"
 * puts the installed preset's mapping back and drops the overrides.
 */
export function DatabaseMappingTab({ source, readOnly }: { source: DataSource; readOnly?: boolean }) {
  const { t, i18n } = useTranslation()
  const updateDataSource = useDataSourceStore((s) => s.updateDataSource)
  const presets = useSchemaPresetStore((s) => s.presets)
  const savePreset = useSchemaPresetStore((s) => s.savePreset)
  const presetsLoaded = useSchemaPresetStore((s) => s.loaded)
  const loadPresets = useSchemaPresetStore((s) => s.loadPresets)
  // The installed preset is what "Reset to preset" and "Promote" act on; the
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
  const [, setDismissals] = useState(0)
  const [resetOpen, setResetOpen] = useState(false)

  // What the database actually holds: the editor suggests its tables and
  // columns, and the relations reading a table it lacks are flagged — all of
  // them when it was read and holds none. Null while unread or unreadable.
  const [schema, setSchema] = useState<{ id: string; tables: IntrospectedTable[] } | null>(null)
  useEffect(() => {
    if (source.status !== 'connected') return
    let live = true
    loadSourceTables(source.id).then(
      (tables) => { if (live) setSchema({ id: source.id, tables }) },
      () => { /* introspection failed: flag nothing, the DDL's suggestions stand in */ },
    )
    return () => { live = false }
  }, [source.id, source.status])
  const sourceSchema = schema?.id === source.id ? schema.tables : null
  const absent = useMemo(
    () => (sourceSchema && source.schemaMapping ? absentRelations(source.schemaMapping, sourceSchema.map((t) => t.name)) : []),
    [sourceSchema, source.schemaMapping],
  )
  const noticeKey = absentNoticeKey(source.id, absent)

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

  // A removal whose relation the preset no longer has removes nothing: not shown.
  const removedKeys = (pendingOverrides?.removed ?? []).filter((key) => specAt(base, key))
  /** Bring a removed base relation back: re-added to the draft, or the removal
   *  dropped from the stored overrides (also where a stale removal goes). */
  const restore = (specKey: string) => {
    const baseSpec = specAt(base, specKey)
    if (draft && baseSpec) setDraft({ ...draft, mapping: effectiveMapping(draft.mapping, { relations: { [specKey]: baseSpec } }) })
    else if (!draft && overrides) void save(revertOverride(overrides, specKey))
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
                <AlertTriangle size={12} className="text-warning" />
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
  const versionChanged = !!preset?.version && preset.version !== source.schemaSource?.version
  const canReset = presetChanged || versionChanged || !isEmptyOverrides(overrides)
  const droppedKeys = [...overridden, ...removedKeys]

  const notice = absent.length > 0 && !editing && !dismissedAbsent.has(noticeKey) ? (
    <NoticeBanner
      tone="warning"
      onDismiss={() => {
        dismissedAbsent.add(noticeKey)
        setDismissals((n) => n + 1)
      }}
      title={t('schema_mapping.absent_tables_title', { count: absent.length })}
      description={
        <>
          <p>{t('schema_mapping.absent_tables_description')}</p>
          <ul className="mt-1 space-y-0.5">
            {absent.map((a) => (
              <li key={a.specKey}>
                <span className="font-mono">{a.specKey}</span>
                {' — '}
                {t(a.empty ? 'schema_mapping.absent_tables_empty' : 'schema_mapping.absent_tables_join', { tables: a.tables.join(', ') })}
              </li>
            ))}
          </ul>
        </>
      }
    />
  ) : null

  const toolbar = (
    <>
      {canWrite && !editing && preset && canReset && (
        <Button variant="outline" size="sm" className="h-7 gap-1 text-xs" onClick={() => setResetOpen(true)}>
          <RefreshCw size={12} />
          {t('schema_mapping.reset_to_preset')}
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
    </>
  )

  return (
    <div className="space-y-4 px-6 py-4">

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
        sourceSchema={sourceSchema}
        toolbar={toolbar}
        notice={notice}
        previewSources={[{ id: source.id, label: localized(source.name, i18n.language) }]}
        relationExtra={relationExtra}
        persist={canWrite && !editing ? (m) => void save(diffOverrides(base, m, overrides)) : undefined}
      />

      {preset && (
        <DialogShell
          open={resetOpen}
          onOpenChange={setResetOpen}
          title={t('schema_mapping.reset_title')}
          description={versionChanged
            ? t('schema_mapping.reset_description_version', { from: source.schemaSource?.version ?? '—', to: preset.version })
            : t('schema_mapping.reset_description')}
          confirmLabel={t('schema_mapping.reset_confirm')}
          destructive
          onConfirm={async () => {
            await updateDataSource(source.id, {
              schemaMapping: sanitizeSchemaMapping(preset.mapping),
              schemaOverrides: null,
              ...(source.schemaSource
                ? { schemaSource: { ...source.schemaSource, ...(preset.version ? { version: preset.version } : {}) } }
                : {}),
            })
            setResetOpen(false)
          }}
        >
          {droppedKeys.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t('schema_mapping.reset_no_overrides')}</p>
          ) : (
            <div className="space-y-1 text-xs">
              <p>{t('schema_mapping.reset_dropped')}</p>
              <ul className="list-inside list-disc font-mono">
                {droppedKeys.map((k) => (
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
