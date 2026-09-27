import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, ChevronRight, Search } from 'lucide-react'
import { DialogShell } from '@/components/ui/dialog-shell'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Input } from '@/components/ui/input'
import { matchesSidebarSearch } from '@/components/SidebarSearch'
import { cn } from '@/lib/utils'
import { localized } from '@/lib/localized'
import { resolvePointer } from '@/lib/import-identity'
import { checksFromTemplates, ddlCheckTemplates, mappingCheckTemplates, type DqCheckTemplate } from '@/lib/dq-templates'
import { useDqStore } from '@/stores/dq-store'
import { useSchemaPresetStore } from '@/stores/schema-preset-store'
import { useDataSourceStore } from '@/stores/data-source-store'
import { findSourcePreset } from '@/lib/find-source-preset'
import { CATEGORY_DOT } from './DqConstants'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  ruleSetId: string
  origin: 'ddl' | 'mapping'
}

/**
 * Adds a schema's DDL or mapping checks to an existing rule set. Only the ones
 * it does not hold yet are offered (matched on `templateKey`), so this is also
 * how a rule set catches up with its schema, or gets back a check deleted by
 * mistake.
 */
export function AddSchemaChecksDialog({ open, onOpenChange, ruleSetId, origin }: Props) {
  const { t, i18n } = useTranslation()
  const ruleSet = useDqStore((s) => s.dqRuleSets.find((rs) => rs.id === ruleSetId))
  const customChecks = useDqStore((s) => s.customChecks)
  const createCustomChecks = useDqStore((s) => s.createCustomChecks)
  const updateRuleSet = useDqStore((s) => s.updateRuleSet)
  const allPresets = useSchemaPresetStore((s) => s.presets)
  const presetsLoaded = useSchemaPresetStore((s) => s.loaded)
  const loadPresets = useSchemaPresetStore((s) => s.loadPresets)
  const database = useDataSourceStore((s) => s.dataSources.find((ds) => ds.id === ruleSet?.dataSourceId))

  const presets = useMemo(
    () => allPresets.filter((p) => !ruleSet || p.workspaceId === ruleSet.workspaceId),
    [allPresets, ruleSet],
  )
  // The rule set's own schema, else its database's, else the first one.
  const defaultPresetId = useMemo(() => {
    if (!ruleSet) return undefined
    return (resolvePointer(presets, ruleSet.schemaPresetRef, ruleSet.workspaceId)
      ?? (database ? findSourcePreset(database, presets) : undefined)
      ?? presets[0])?.id
  }, [ruleSet, presets, database])

  const [pickedPresetId, setPickedPresetId] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set())
  const presetId = pickedPresetId ?? defaultPresetId
  const preset = presets.find((p) => p.id === presetId)

  useEffect(() => {
    if (open && !presetsLoaded) void loadPresets(ruleSet?.workspaceId)
  }, [open, presetsLoaded, loadPresets, ruleSet?.workspaceId])

  const existingKeys = useMemo(
    () => new Set(customChecks.filter((c) => c.ruleSetId === ruleSetId && c.templateKey).map((c) => c.templateKey!)),
    [customChecks, ruleSetId],
  )
  const { missing, presentCount } = useMemo(() => {
    if (!preset) return { missing: [] as DqCheckTemplate[], presentCount: 0 }
    const translate = (key: string, vars?: Record<string, unknown>) => t(key, vars ?? {})
    const all = origin === 'ddl'
      ? (preset.mapping.ddl ? ddlCheckTemplates(preset.mapping.ddl, translate) : [])
      : mappingCheckTemplates(preset.mapping, translate)
    const fresh = all.filter((c) => !existingKeys.has(c.templateKey))
    return { missing: fresh, presentCount: all.length - fresh.length }
  }, [preset, origin, existingKeys, t])

  const visible = useMemo(
    () => missing.filter((c) => matchesSidebarSearch(c.name, query) || matchesSidebarSearch(c.tableName, query)),
    [missing, query],
  )
  const groups = useMemo(() => {
    const byTable = new Map<string, DqCheckTemplate[]>()
    for (const c of visible) byTable.set(c.tableName, [...(byTable.get(c.tableName) ?? []), c])
    return [...byTable.entries()]
  }, [visible])

  const toggle = (keys: string[], on: boolean) => setSelected((prev) => {
    const next = new Set(prev)
    for (const k of keys) {
      if (on) next.add(k)
      else next.delete(k)
    }
    return next
  })
  const allVisibleSelected = visible.length > 0 && visible.every((c) => selected.has(c.templateKey))

  const reset = () => {
    setPickedPresetId(null)
    setQuery('')
    setSelected(new Set())
    setOpenGroups(new Set())
  }

  const handleAdd = async () => {
    if (!ruleSet || !preset) return
    const picked = missing.filter((c) => selected.has(c.templateKey))
    const nextOrder = customChecks.reduce((max, c) => Math.max(max, c.order + 1), 0)
    await createCustomChecks(checksFromTemplates(ruleSetId, picked, nextOrder))
    if (!ruleSet.schemaPresetRef) {
      await updateRuleSet(ruleSetId, {
        schemaPresetRef: {
          ...(preset.lineageId ? { lineageId: preset.lineageId } : {}),
          entityId: preset.entityId,
          label: preset.mapping.presetLabel,
        },
      })
    }
    reset()
    onOpenChange(false)
  }

  return (
    <DialogShell
      open={open}
      onOpenChange={(next) => {
        if (!next) reset()
        onOpenChange(next)
      }}
      kind="workbench"
      className="sm:max-w-2xl"
      title={t(origin === 'ddl' ? 'data_quality.add_from_ddl_title' : 'data_quality.add_from_mapping_title')}
      description={t(origin === 'ddl' ? 'data_quality.add_from_ddl_description' : 'data_quality.add_from_mapping_description')}
      onConfirm={() => void handleAdd()}
      confirmLabel={t('data_quality.add_n_checks', { count: selected.size })}
      confirmDisabled={selected.size === 0}
    >
      <div className="flex h-full min-h-0 flex-col gap-3">
        <div className="flex items-center gap-3">
          <Label className="shrink-0">{t('data_quality.rs_schema')}</Label>
          <Select value={presetId ?? ''} onValueChange={(v) => { setPickedPresetId(v); setSelected(new Set()) }}>
            <SelectTrigger className="w-64">
              <SelectValue placeholder={t('data_quality.select_schema')} />
            </SelectTrigger>
            <SelectContent>
              {presets.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {localized(p.mapping.presetLabel, i18n.language) || p.entityId}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <span className="ml-auto text-xs text-muted-foreground">
            {t('data_quality.schema_checks_status', { missing: missing.length, present: presentCount })}
          </span>
        </div>

        {missing.length === 0 ? (
          <p className="py-10 text-center text-sm text-muted-foreground">
            {preset ? t('data_quality.schema_checks_all_present') : t('data_quality.select_schema')}
          </p>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-md border">
            <div className="flex items-center gap-2 border-b px-2 py-1">
              <Checkbox
                checked={allVisibleSelected}
                onCheckedChange={(on) => toggle(visible.map((c) => c.templateKey), !!on)}
                className="size-3.5"
                aria-label={t('data_quality.select_all')}
              />
              <span className="text-[10px] text-muted-foreground">
                {t('data_quality.n_selected', { count: selected.size })}
              </span>
              <div className="relative ml-auto w-56">
                <Search size={12} className="pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={t('data_quality.search_checks')}
                  className="h-6 pl-6 text-xs"
                />
              </div>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto py-1 pl-1 pr-3">
              {groups.map(([table, checks]) => {
                const expanded = !!query || groups.length === 1 || openGroups.has(table)
                const keys = checks.map((c) => c.templateKey)
                const count = keys.filter((k) => selected.has(k)).length
                return (
                  <div key={table}>
                    <div className="flex h-7 items-center gap-1.5 rounded px-1 hover:bg-accent/50">
                      <Checkbox
                        checked={count === keys.length ? true : count > 0 ? 'indeterminate' : false}
                        onCheckedChange={(on) => toggle(keys, !!on)}
                        className="size-3.5"
                      />
                      <button
                        type="button"
                        onClick={() => setOpenGroups((prev) => {
                          const next = new Set(prev)
                          if (next.has(table)) next.delete(table)
                          else next.add(table)
                          return next
                        })}
                        className="flex min-w-0 flex-1 items-center gap-1 text-left text-xs"
                      >
                        {expanded ? <ChevronDown size={12} className="shrink-0" /> : <ChevronRight size={12} className="shrink-0" />}
                        <span className="truncate font-mono">{table}</span>
                        <span className="ml-auto shrink-0 text-[10px] tabular-nums text-muted-foreground">
                          {count ? `${count}/${keys.length}` : keys.length}
                        </span>
                      </button>
                    </div>
                    {expanded && checks.map((c) => (
                      <label
                        key={c.templateKey}
                        className="flex h-7 cursor-pointer items-center gap-2 rounded pl-7 pr-1 text-xs hover:bg-accent/50"
                        title={c.description}
                      >
                        <Checkbox
                          checked={selected.has(c.templateKey)}
                          onCheckedChange={(on) => toggle([c.templateKey], !!on)}
                          className="size-3.5"
                        />
                        <span className={cn('inline-block size-2 shrink-0 rounded-full', CATEGORY_DOT[c.category])} />
                        <span className="min-w-0 flex-1 truncate">{c.name}</span>
                        <span className="shrink-0 text-[10px] text-muted-foreground">
                          {t(`data_quality.severity_${c.severity}`)}
                        </span>
                      </label>
                    ))}
                  </div>
                )
              })}
            </div>
          </div>
        )}
      </div>
    </DialogShell>
  )
}
