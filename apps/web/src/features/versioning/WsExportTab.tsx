import { useState, useEffect, useCallback } from 'react'
import { useTranslation, Trans } from 'react-i18next'
import { useResolvedParams } from '@/hooks/use-resolved-params'
import {
  Download,
  FolderOpen,
  BookOpen,
  Puzzle,
  Warehouse,
  Database,
  ArrowRightLeft,
  SquareTerminal,
  Workflow,
  ShieldCheck,
  FileSpreadsheet,
  AlertTriangle,
  Loader2,
  GitBranch,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { useWorkspaceVersioningStore } from '@/stores/workspace-versioning-store'
import { getStorage } from '@/lib/storage'
import { resolveGitRemote, countExportablePlugins } from '@/lib/entity-io'

/** A linkable entity rendered as an export sub-row (project, mapping project, SQL collection, ETL pipeline). */
interface EntityRow {
  id: string
  name: string
  /** git host (e.g. "gitlab.com") when the entity is linked to a repo, else null */
  gitHost: string | null
}

/** Section keys that expose per-entity include-data rows. */
const ENTITY_SECTIONS = ['projects', 'conceptMapping', 'sqlScripts', 'etl'] as const
type EntitySectionKey = (typeof ENTITY_SECTIONS)[number]

function resolveName(name: import('@/types').LocalizedString): string {
  return typeof name === 'string' ? name : (name.en || Object.values(name)[0] || '')
}

/** Orange warning + tooltip flagging that a control bundles potentially-sensitive data files. */
function DataWarningIcon({ text }: { text: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex">
          <AlertTriangle size={12} className="text-amber-500" />
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-[16rem]" style={{ textWrap: 'wrap' }}>
        {text}
      </TooltipContent>
    </Tooltip>
  )
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    // SSH-style git@host:path — extract host between @ and :
    const m = url.match(/@([^:/]+)[:/]/)
    return m ? m[1] : url
  }
}

// ---------------------------------------------------------------------------
// Section definitions — mirrors the sidebar visual hierarchy
// ---------------------------------------------------------------------------

interface ExportSection {
  key: string
  icon: React.ComponentType<{ size?: number; className?: string }>
  labelKey: string
  colorClass: string
  /** i18n key describing exactly what this section exports (shown as a muted hint). */
  descKey?: string
  /** Sub-sections grouped under a parent (e.g. Warehouse children) */
  children?: ExportSection[]
}

const exportSections: ExportSection[] = [
  { key: 'projects', icon: FolderOpen, labelKey: 'workspace_nav.projects', colorClass: 'text-blue-700', descKey: 'app_versioning.export_section_desc_projects' },
  { key: 'wiki', icon: BookOpen, labelKey: 'workspace_nav.wiki', colorClass: 'text-emerald-500', descKey: 'app_versioning.export_section_desc_wiki' },
  { key: 'plugins', icon: Puzzle, labelKey: 'workspace_nav.plugins', colorClass: 'text-pink-500', descKey: 'app_versioning.export_section_desc_plugins' },
  {
    key: 'warehouse',
    icon: Warehouse,
    labelKey: 'workspace_nav.warehouse',
    colorClass: 'text-teal-500',
    children: [
      { key: 'schemas', icon: FileSpreadsheet, labelKey: 'app_warehouse.nav_schemas', colorClass: 'text-teal-500', descKey: 'app_versioning.export_section_desc_schemas' },
      { key: 'databases', icon: Database, labelKey: 'app_warehouse.nav_databases', colorClass: 'text-teal-500', descKey: 'app_versioning.export_section_desc_databases' },
      { key: 'conceptMapping', icon: ArrowRightLeft, labelKey: 'app_warehouse.nav_concept_mapping', colorClass: 'text-teal-500', descKey: 'app_versioning.export_section_desc_conceptMapping' },
      { key: 'sqlScripts', icon: SquareTerminal, labelKey: 'app_warehouse.nav_sql_scripts', colorClass: 'text-teal-500', descKey: 'app_versioning.export_section_desc_sqlScripts' },
      { key: 'dataQuality', icon: ShieldCheck, labelKey: 'app_warehouse.nav_data_quality', colorClass: 'text-teal-500', descKey: 'app_versioning.export_section_desc_dataQuality' },
      { key: 'catalogs', icon: BookOpen, labelKey: 'app_warehouse.nav_catalog', colorClass: 'text-teal-500', descKey: 'app_versioning.export_section_desc_catalogs' },
      { key: 'etl', icon: Workflow, labelKey: 'app_warehouse.nav_etl', colorClass: 'text-teal-500', descKey: 'app_versioning.export_section_desc_etl' },
    ],
  },
]

/** All leaf keys (flat) */
function allLeafKeys(sections: ExportSection[]): string[] {
  const keys: string[] = []
  for (const s of sections) {
    if (s.children) keys.push(...allLeafKeys(s.children))
    else keys.push(s.key)
  }
  return keys
}

const ALL_KEYS = allLeafKeys(exportSections)

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function WsExportTab({ workspaceId }: { workspaceId?: string } = {}) {
  const { t } = useTranslation()
  const { wsUid: resolvedWsUid } = useResolvedParams()
  const wsUid = workspaceId ?? resolvedWsUid
  const { exportZip, loading } = useWorkspaceVersioningStore()
  const [exporting, setExporting] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const [includeCredentials, setIncludeCredentials] = useState(false)
  const [showExportConfirm, setShowExportConfirm] = useState(false)
  const [counts, setCounts] = useState<Record<string, number>>({})
  const [countsLoading, setCountsLoading] = useState(true)
  const [entities, setEntities] = useState<Record<EntitySectionKey, EntityRow[]>>({
    projects: [], conceptMapping: [], sqlScripts: [], etl: [],
  })
  /** Per-section opt-in to bundle data files (applies to every unlinked, included entity in the section). */
  const [includeSectionData, setIncludeSectionData] = useState<Set<EntitySectionKey>>(() => new Set())
  /** Entity ids explicitly excluded from the export. Empty = every entity included by default. */
  const [excludedEntities, setExcludedEntities] = useState<Set<string>>(() => new Set())
  /** Per-item lists for sections exported whole. Each item is toggleable via excludedEntities (keyed by id). */
  const [simpleItems, setSimpleItems] = useState<Record<string, { id: string; name: string }[]>>({})

  // Load section counts
  useEffect(() => {
    if (!wsUid) return
    let cancelled = false

    async function loadCounts() {
      if (!wsUid) return
      setCountsLoading(true)
      const storage = getStorage()
      const [
        projects, wikiPages, pluginCount, schemas,
        dataSources, mappingProjects, _conceptSets,
        sqlCollections, etlPipelines, dqRuleSets,
        catalogs, serviceMappings,
      ] = await Promise.all([
        storage.projects.getAll().then(all => all.filter(p => p.workspaceId === wsUid)),
        storage.wikiPages.getByWorkspace(wsUid),
        countExportablePlugins(wsUid, storage),
        storage.schemaPresets.getByWorkspace(wsUid),
        storage.dataSources.getByWorkspace(wsUid),
        storage.mappingProjects.getByWorkspace(wsUid),
        storage.conceptSets.getByWorkspace(wsUid),
        storage.sqlScriptCollections.getByWorkspace(wsUid),
        storage.etlPipelines.getByWorkspace(wsUid),
        storage.dqRuleSets.getByWorkspace(wsUid),
        storage.dataCatalogs.getByWorkspace(wsUid),
        storage.serviceMappings.getByWorkspace(wsUid),
      ])
      if (cancelled) return
      const nextCounts: Record<string, number> = {
        projects: projects.length,
        wiki: wikiPages.length,
        plugins: pluginCount,
        schemas: schemas.length,
        databases: dataSources.length,
        conceptMapping: mappingProjects.length,
        sqlScripts: sqlCollections.length,
        etl: etlPipelines.length,
        dataQuality: dqRuleSets.length,
        catalogs: catalogs.length + serviceMappings.length,
      }
      setCounts(nextCounts)
      // Default selection = every non-empty section (empty ones aren't checkable).
      setSelected(new Set(ALL_KEYS.filter(k => (nextCounts[k] ?? 0) > 0)))
      const gitHost = (e: { gitRemoteConfig?: import('@/types').GitRemoteConfig; gitUrl?: string }) => {
        const git = resolveGitRemote(e)
        return git ? hostOf(git.url) : null
      }
      setEntities({
        projects: projects.map(p => ({ id: p.uid, name: resolveName(p.name), gitHost: gitHost(p) })),
        conceptMapping: mappingProjects.map(m => ({ id: m.id, name: m.name, gitHost: gitHost(m) })),
        sqlScripts: sqlCollections.map(c => ({ id: c.id, name: c.name, gitHost: gitHost(c) })),
        etl: etlPipelines.map(p => ({ id: p.id, name: p.name, gitHost: gitHost(p) })),
      })
      // Sections exported whole: list items so each can be individually excluded.
      // Exclusion id must match what buildWorkspaceZip keys on (presetId for schemas, id otherwise).
      setSimpleItems({
        schemas: schemas.map(s => ({ id: s.presetId, name: s.mapping?.presetLabel || s.presetId })),
        databases: dataSources.map(d => ({ id: d.id, name: d.name || d.alias })),
        dataQuality: dqRuleSets.map(r => ({ id: r.id, name: r.name })),
        catalogs: [
          ...catalogs.map(c => ({ id: c.id, name: c.name })),
          ...serviceMappings.map(s => ({ id: s.id, name: s.name })),
        ],
      })
      setCountsLoading(false)
    }

    loadCounts()
    return () => { cancelled = true }
  }, [wsUid])

  /** A leaf section is empty (nothing to export) once counts have loaded and its count is 0. */
  const isEmpty = useCallback(
    (key: string) => !countsLoading && (counts[key] ?? 0) === 0,
    [counts, countsLoading],
  )

  const toggle = useCallback((key: string) => {
    if (isEmpty(key)) return
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [isEmpty])

  /** Toggle the section-level "include data files" option. */
  const toggleSectionData = useCallback((key: EntitySectionKey) => {
    setIncludeSectionData(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])

  /** Toggle whether an entity is included in the export at all. */
  const toggleEntityIncluded = useCallback((id: string) => {
    setExcludedEntities(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  /** Include / exclude every item of a whole-export section at once. */
  const setSimpleSectionIncluded = useCallback((key: string, on: boolean) => {
    const ids = (simpleItems[key] ?? []).map(i => i.id)
    setExcludedEntities(prev => {
      const next = new Set(prev)
      for (const id of ids) { if (on) next.delete(id); else next.add(id) }
      return next
    })
  }, [simpleItems])

  /** Include / exclude every entity of an entity section at once. */
  const setEntitySectionIncluded = useCallback((key: EntitySectionKey, on: boolean) => {
    const ids = entities[key].map(e => e.id)
    setExcludedEntities(prev => {
      const next = new Set(prev)
      for (const id of ids) { if (on) next.delete(id); else next.add(id) }
      return next
    })
  }, [entities])

  /** Every per-item id (toggleable entities + whole-export section items). */
  const allEntityIds = useCallback(
    () => [
      ...ENTITY_SECTIONS.flatMap(k => entities[k].map(e => e.id)),
      ...Object.values(simpleItems).flatMap(items => items.map(i => i.id)),
    ],
    [entities, simpleItems],
  )

  /** Unlinked + currently-included entity ids in a section — the ones a "data files" opt-in actually affects. */
  const dataEligibleIds = useCallback(
    (key: EntitySectionKey) => entities[key].filter(e => !e.gitHost && !excludedEntities.has(e.id)).map(e => e.id),
    [entities, excludedEntities],
  )

  /** Toggle a group parent = toggle all its non-empty children. */
  const toggleGroup = useCallback((children: ExportSection[]) => {
    setSelected(prev => {
      const next = new Set(prev)
      const childKeys = children.map(c => c.key).filter(k => !isEmpty(k))
      if (childKeys.length === 0) return prev
      const allSelected = childKeys.every(k => next.has(k))
      for (const k of childKeys) {
        if (allSelected) next.delete(k)
        else next.add(k)
      }
      return next
    })
  }, [isEmpty])

  /** Select / deselect every non-empty leaf section at once. */
  const setAllSections = useCallback((on: boolean) => {
    if (on) {
      setSelected(new Set(ALL_KEYS.filter(k => !isEmpty(k))))
      setExcludedEntities(new Set())
    } else {
      setSelected(new Set())
      setExcludedEntities(new Set(allEntityIds()))
      setIncludeSectionData(new Set())
    }
  }, [isEmpty, allEntityIds])

  /** Expand the per-section data opt-in to the concrete entity ids it bundles (unlinked + included). */
  const includedDataEntityIds = useCallback(
    () => [...includeSectionData].flatMap(key => dataEligibleIds(key)),
    [includeSectionData, dataEligibleIds],
  )

  const doExport = async () => {
    if (!wsUid) return
    setExporting(true)
    try {
      await exportZip(wsUid, {
        sections: Object.fromEntries(ALL_KEYS.map(k => [k, selected.has(k)])) as Record<string, boolean>,
        includeCredentials,
        includeEntityData: Object.fromEntries(includedDataEntityIds().map(id => [id, true])),
        excludeEntities: Object.fromEntries([...excludedEntities].map(id => [id, true])),
      })
    } finally {
      setExporting(false)
    }
  }

  /** True when at least one section bundles data files for a still-included entity. */
  const hasIncludedData = includedDataEntityIds().length > 0
  /** True when database connection details are bundled. */
  const hasIncludedCredentials = includeCredentials && selected.has('databases')

  const handleExport = () => {
    // Single confirmation gate: show it whenever the archive carries sensitive content.
    if (hasIncludedData || hasIncludedCredentials) setShowExportConfirm(true)
    else doExport()
  }

  const noneSelected = ALL_KEYS.every(k => !selected.has(k))

  // ---------------------------------------------------------------------------
  // Render helpers
  // ---------------------------------------------------------------------------

  function renderSection(section: ExportSection, indent = false) {
    if (section.children) {
      const childKeys = section.children.map(c => c.key)
      const nonEmptyChildKeys = childKeys.filter(k => !isEmpty(k))
      const allChecked = nonEmptyChildKeys.length > 0 && nonEmptyChildKeys.every(k => selected.has(k))
      const someChecked = childKeys.some(k => selected.has(k))
      const groupEmpty = !countsLoading && nonEmptyChildKeys.length === 0

      return (
        <div key={section.key} className="space-y-1">
          {/* Group header */}
          <div className={cn('flex items-center gap-2 py-1', indent && 'pl-6')}>
            <Checkbox
              id={`ws-export-${section.key}`}
              disabled={groupEmpty}
              checked={allChecked ? true : someChecked ? 'indeterminate' : false}
              onCheckedChange={() => toggleGroup(section.children!)}
            />
            <Label
              htmlFor={`ws-export-${section.key}`}
              className={cn('flex items-center gap-1.5 text-sm font-medium', groupEmpty ? 'text-muted-foreground/50 cursor-default' : 'cursor-pointer')}
            >
              <section.icon size={15} className={section.colorClass} />
              {t(section.labelKey)}
            </Label>
            {!groupEmpty && (
              <span className="ml-auto flex items-center gap-1 text-[10px] text-muted-foreground/70">
                <button type="button" className="underline hover:text-foreground" onClick={() => { setSelected(prev => { const n = new Set(prev); nonEmptyChildKeys.forEach(k => n.add(k)); return n }) }}>
                  {t('common.all')}
                </button>
                <span>/</span>
                <button type="button" className="underline hover:text-foreground" onClick={() => { setSelected(prev => { const n = new Set(prev); childKeys.forEach(k => n.delete(k)); return n }) }}>
                  {t('common.none')}
                </button>
              </span>
            )}
          </div>
          {/* Children */}
          <div className="space-y-0.5">
            {section.children.map(child => renderSection(child, true))}
          </div>
        </div>
      )
    }

    const count = counts[section.key]
    const isDatabases = section.key === 'databases'
    const empty = isEmpty(section.key)

    return (
      <div key={section.key}>
        <div className={cn('flex items-center gap-2 py-1', indent && 'pl-6')}>
          <Checkbox
            id={`ws-export-${section.key}`}
            disabled={empty}
            checked={selected.has(section.key)}
            onCheckedChange={() => toggle(section.key)}
          />
          <Label
            htmlFor={`ws-export-${section.key}`}
            className={cn('flex items-center gap-1.5 text-sm font-normal', empty ? 'text-muted-foreground/50 cursor-default' : 'cursor-pointer')}
          >
            <section.icon size={14} className={cn(section.colorClass, empty && 'opacity-50')} />
            {t(section.labelKey)}
            {!countsLoading && count != null && (
              <span className="text-xs text-muted-foreground ml-0.5">
                {empty ? t('app_versioning.export_empty_hint') : `(${count})`}
              </span>
            )}
          </Label>

          {/* Bulk Items toggle for entity sections (projects, mapping, SQL, ETL) */}
          {ENTITY_SECTIONS.includes(section.key as EntitySectionKey)
            && selected.has(section.key)
            && entities[section.key as EntitySectionKey].length > 0 && (
            <span className="ml-auto flex items-center gap-1 text-[10px] text-muted-foreground/70">
              {t('app_versioning.export_items_label')}
              <button type="button" className="underline hover:text-foreground" onClick={() => setEntitySectionIncluded(section.key as EntitySectionKey, true)}>
                {t('common.all')}
              </button>
              <span>/</span>
              <button type="button" className="underline hover:text-foreground" onClick={() => setEntitySectionIncluded(section.key as EntitySectionKey, false)}>
                {t('common.none')}
              </button>
            </span>
          )}

          {/* Bulk "include item" toggle for whole-export sections (schemas, databases, …) */}
          {!ENTITY_SECTIONS.includes(section.key as EntitySectionKey)
            && selected.has(section.key)
            && (simpleItems[section.key]?.length ?? 0) > 0 && (
            <span className="ml-auto flex items-center gap-1 text-[10px] text-muted-foreground/70">
              {t('app_versioning.export_items_label')}
              <button type="button" className="underline hover:text-foreground" onClick={() => setSimpleSectionIncluded(section.key, true)}>
                {t('common.all')}
              </button>
              <span>/</span>
              <button type="button" className="underline hover:text-foreground" onClick={() => setSimpleSectionIncluded(section.key, false)}>
                {t('common.none')}
              </button>
            </span>
          )}
        </div>

        {/* What this section exports (muted hint), shown when selected. */}
        {section.descKey && selected.has(section.key) && (
          <p className={cn('text-[11px] text-muted-foreground/80 leading-relaxed pb-1', indent ? 'pl-12' : 'pl-6')}>
            {t(section.descKey)}
          </p>
        )}

        {/* Entity sections: single section-level "include data files" opt-in. */}
        {ENTITY_SECTIONS.includes(section.key as EntitySectionKey)
          && selected.has(section.key)
          && dataEligibleIds(section.key as EntitySectionKey).length > 0 && (
          <div className="flex items-center gap-2 pl-12 pb-1">
            <Checkbox
              id={`ws-export-secdata-${section.key}`}
              checked={includeSectionData.has(section.key as EntitySectionKey)}
              onCheckedChange={() => toggleSectionData(section.key as EntitySectionKey)}
            />
            <Label htmlFor={`ws-export-secdata-${section.key}`} className="flex items-center gap-1.5 text-xs font-normal cursor-pointer text-muted-foreground">
              {t('app_versioning.export_include_entity_data')}
              <DataWarningIcon text={t('app_versioning.export_data_warning_tooltip')} />
            </Label>
          </div>
        )}

        {/* Databases: section-level "include connection details" opt-in (first, like the data opt-in). */}
        {isDatabases && selected.has('databases') && (
          <div className="pl-12 space-y-2 pb-1">
            <div className="flex items-center gap-2">
              <Checkbox
                id="ws-export-db-credentials"
                checked={includeCredentials}
                onCheckedChange={(v) => setIncludeCredentials(v === true)}
              />
              <Label htmlFor="ws-export-db-credentials" className="flex items-center gap-1.5 text-xs font-normal cursor-pointer text-muted-foreground">
                {t('app_versioning.export_include_credentials')}
                <DataWarningIcon text={t('app_versioning.export_credentials_warning_tooltip')} />
              </Label>
            </div>
            <p className="text-[11px] text-muted-foreground leading-relaxed">
              {includeCredentials
                ? t('app_versioning.export_credentials_on_hint')
                : t('app_versioning.export_credentials_off_hint')}
            </p>
          </div>
        )}

        {/* Per-item checkboxes for sections exported whole (schemas, databases, data quality, catalogs). */}
        {!ENTITY_SECTIONS.includes(section.key as EntitySectionKey)
          && selected.has(section.key)
          && (simpleItems[section.key]?.length ?? 0) > 0 && (
          <div className={cn('space-y-1 pb-1', indent ? 'pl-12' : 'pl-6')}>
            {simpleItems[section.key].map(item => (
              <div key={item.id} className="flex items-center gap-2">
                <Checkbox
                  id={`ws-export-item-${item.id}`}
                  checked={!excludedEntities.has(item.id)}
                  onCheckedChange={() => toggleEntityIncluded(item.id)}
                />
                <Label htmlFor={`ws-export-item-${item.id}`} className="text-[11px] font-normal cursor-pointer text-muted-foreground">
                  <span className="truncate max-w-[16rem]">{item.name}</span>
                </Label>
              </div>
            ))}
          </div>
        )}

        {/* Per-entity rows: git badge (metadata only) or include-data checkbox */}
        {ENTITY_SECTIONS.includes(section.key as EntitySectionKey)
          && selected.has(section.key)
          && entities[section.key as EntitySectionKey].length > 0 && (
          <div className="pl-12 space-y-1 pt-1">
            {entities[section.key as EntitySectionKey].map(ent => (
              <div key={ent.id} className="flex items-center gap-2">
                <Checkbox
                  id={`ws-export-entity-${ent.id}`}
                  checked={!excludedEntities.has(ent.id)}
                  onCheckedChange={() => toggleEntityIncluded(ent.id)}
                />
                <Label htmlFor={`ws-export-entity-${ent.id}`} className="flex items-center gap-1.5 text-[11px] font-normal cursor-pointer text-muted-foreground">
                  <span className="truncate max-w-[14rem]">{ent.name}</span>
                  {ent.gitHost && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="inline-flex items-center gap-1 rounded-full bg-violet-500/10 px-1.5 py-0.5 text-[10px] font-medium text-violet-600 dark:text-violet-400 leading-none">
                          <GitBranch size={10} />
                          {ent.gitHost}
                        </span>
                      </TooltipTrigger>
                      <TooltipContent className="max-w-[15rem]" style={{ textWrap: 'wrap' }}>
                        {t('app_versioning.export_git_linked_tooltip')}
                      </TooltipContent>
                    </Tooltip>
                  )}
                </Label>
              </div>
            ))}
          </div>
        )}
      </div>
    )
  }

  return (
    <>
      {/* Bounded flex column so all 4 borders stay visible and only the list scrolls. */}
      <Card className="flex max-h-full min-h-0 flex-col overflow-hidden">
        <CardHeader className="shrink-0">
          <CardTitle className="text-sm">{t('versioning.export_title')}</CardTitle>
          <CardDescription>{t('app_versioning.export_description')}</CardDescription>
          {/* Select all / none — kept in the (non-scrolling) header so they stay visible on scroll. */}
          <div className="flex items-center gap-2 pt-1 text-xs text-muted-foreground">
            <button type="button" className="underline hover:text-foreground" onClick={() => setAllSections(true)}>
              {t('common.select_all')}
            </button>
            <span>/</span>
            <button type="button" className="underline hover:text-foreground" onClick={() => setAllSections(false)}>
              {t('common.select_none')}
            </button>
          </div>
        </CardHeader>
        <CardContent className="min-h-0 flex-1 space-y-1 overflow-auto">
          {/* Section checkboxes */}
          {exportSections.map(s => renderSection(s))}
        </CardContent>

        {/* Fixed footer so the Download button (and the card's bottom border) stay visible. */}
        <div className="shrink-0 flex justify-end border-t border-border px-6 py-3">
          <Button
            size="sm"
            onClick={handleExport}
            disabled={exporting || loading || noneSelected}
            className="gap-1.5"
          >
            {exporting ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
            {t('versioning.export_download')}
          </Button>
        </div>
      </Card>

      {/* Unified sensitive-export confirmation — surfaces each applicable warning (data, credentials). */}
      <AlertDialog open={showExportConfirm} onOpenChange={setShowExportConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertTriangle size={18} className="text-amber-500" />
              {t('app_versioning.export_confirm_title')}
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-3">
                {hasIncludedData && (
                  <p>
                    {hasIncludedCredentials && <span className="font-medium">1) </span>}
                    <Trans i18nKey="app_versioning.export_data_confirm_body" components={{ b: <strong /> }} />
                  </p>
                )}
                {hasIncludedCredentials && (
                  <div className="space-y-1">
                    <p>
                      {hasIncludedData && <span className="font-medium">2) </span>}
                      <Trans i18nKey="app_versioning.export_credentials_confirm_body" components={{ b: <strong /> }} />
                    </p>
                    <ul className="list-disc pl-4 space-y-1 text-xs">
                      <li>{t('app_versioning.export_credentials_confirm_included')}</li>
                      <li>{t('app_versioning.export_credentials_confirm_excluded')}</li>
                    </ul>
                  </div>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => { setShowExportConfirm(false); doExport() }}
              className="bg-amber-600 hover:bg-amber-700"
            >
              {t('app_versioning.export_confirm_action')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
