import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { useParams } from 'react-router'
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
  ShieldAlert,
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
import { resolveGitRemote } from '@/lib/entity-io'

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
  /** Sub-sections grouped under a parent (e.g. Warehouse children) */
  children?: ExportSection[]
}

const exportSections: ExportSection[] = [
  { key: 'projects', icon: FolderOpen, labelKey: 'workspace_nav.projects', colorClass: 'text-blue-700' },
  { key: 'wiki', icon: BookOpen, labelKey: 'workspace_nav.wiki', colorClass: 'text-emerald-500' },
  { key: 'plugins', icon: Puzzle, labelKey: 'workspace_nav.plugins', colorClass: 'text-pink-500' },
  {
    key: 'warehouse',
    icon: Warehouse,
    labelKey: 'workspace_nav.warehouse',
    colorClass: 'text-teal-500',
    children: [
      { key: 'schemas', icon: FileSpreadsheet, labelKey: 'app_warehouse.nav_schemas', colorClass: 'text-teal-500' },
      { key: 'databases', icon: Database, labelKey: 'app_warehouse.nav_databases', colorClass: 'text-teal-500' },
      { key: 'conceptMapping', icon: ArrowRightLeft, labelKey: 'app_warehouse.nav_concept_mapping', colorClass: 'text-teal-500' },
      { key: 'sqlScripts', icon: SquareTerminal, labelKey: 'app_warehouse.nav_sql_scripts', colorClass: 'text-teal-500' },
      { key: 'dataQuality', icon: ShieldCheck, labelKey: 'app_warehouse.nav_data_quality', colorClass: 'text-teal-500' },
      { key: 'catalogs', icon: BookOpen, labelKey: 'app_warehouse.nav_catalog', colorClass: 'text-teal-500' },
      { key: 'etl', icon: Workflow, labelKey: 'app_warehouse.nav_etl', colorClass: 'text-teal-500' },
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
  const params = useParams<{ wsUid: string }>()
  const wsUid = workspaceId ?? params.wsUid
  const { exportZip, loading } = useWorkspaceVersioningStore()
  const [exporting, setExporting] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(() => new Set(ALL_KEYS))
  const [includeCredentials, setIncludeCredentials] = useState(false)
  const [showCredentialsConfirm, setShowCredentialsConfirm] = useState(false)
  const [counts, setCounts] = useState<Record<string, number>>({})
  const [countsLoading, setCountsLoading] = useState(true)
  const [entities, setEntities] = useState<Record<EntitySectionKey, EntityRow[]>>({
    projects: [], conceptMapping: [], sqlScripts: [], etl: [],
  })
  /** Per-entity opt-in to include full content (only meaningful for unlinked entities). */
  const [includeEntityData, setIncludeEntityData] = useState<Set<string>>(() => new Set())
  /** Entity ids explicitly excluded from the export. Empty = every entity included by default. */
  const [excludedEntities, setExcludedEntities] = useState<Set<string>>(() => new Set())

  // Load section counts
  useEffect(() => {
    if (!wsUid) return
    let cancelled = false

    async function loadCounts() {
      setCountsLoading(true)
      const storage = getStorage()
      const [
        projects, wikiPages, plugins, schemas,
        dataSources, mappingProjects, conceptSets,
        sqlCollections, etlPipelines, dqRuleSets,
        catalogs, serviceMappings,
      ] = await Promise.all([
        storage.projects.getAll().then(all => all.filter(p => p.workspaceId === wsUid)),
        storage.wikiPages.getByWorkspace(wsUid),
        storage.userPlugins.getByWorkspace(wsUid),
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
      setCounts({
        projects: projects.length,
        wiki: wikiPages.length,
        plugins: plugins.length,
        schemas: schemas.length,
        databases: dataSources.length,
        conceptMapping: mappingProjects.length,
        sqlScripts: sqlCollections.length,
        etl: etlPipelines.length,
        dataQuality: dqRuleSets.length,
        catalogs: catalogs.length + serviceMappings.length,
      })
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
      setCountsLoading(false)
    }

    loadCounts()
    return () => { cancelled = true }
  }, [wsUid])

  const toggle = useCallback((key: string) => {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])

  const toggleEntityData = useCallback((id: string) => {
    setIncludeEntityData(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  /** Toggle whether an entity is included at all. Excluding also clears its data opt-in. */
  const toggleEntityIncluded = useCallback((id: string) => {
    setExcludedEntities(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
    setIncludeEntityData(prev => {
      if (!prev.has(id)) return prev
      const next = new Set(prev)
      next.delete(id)
      return next
    })
  }, [])

  /** Every entity id across the four entity sections. */
  const allEntityIds = useCallback(
    () => ENTITY_SECTIONS.flatMap(k => entities[k].map(e => e.id)),
    [entities],
  )

  /** Unlinked + currently-included entity ids in a section (those that show an "include data" row). */
  const dataEligibleIds = useCallback(
    (key: EntitySectionKey) => entities[key].filter(e => !e.gitHost && !excludedEntities.has(e.id)).map(e => e.id),
    [entities, excludedEntities],
  )

  /** Check or uncheck every "include data" sub-option in a section at once. */
  const setSectionData = useCallback((key: EntitySectionKey, on: boolean) => {
    const ids = dataEligibleIds(key)
    setIncludeEntityData(prev => {
      const next = new Set(prev)
      for (const id of ids) { if (on) next.add(id); else next.delete(id) }
      return next
    })
  }, [dataEligibleIds])

  /** Toggle a group parent = toggle all children */
  const toggleGroup = useCallback((children: ExportSection[]) => {
    setSelected(prev => {
      const next = new Set(prev)
      const childKeys = children.map(c => c.key)
      const allSelected = childKeys.every(k => next.has(k))
      for (const k of childKeys) {
        if (allSelected) next.delete(k)
        else next.add(k)
      }
      return next
    })
  }, [])

  const doExport = async () => {
    if (!wsUid) return
    setExporting(true)
    try {
      await exportZip(wsUid, {
        sections: Object.fromEntries(ALL_KEYS.map(k => [k, selected.has(k)])) as Record<string, boolean>,
        includeCredentials,
        includeEntityData: Object.fromEntries([...includeEntityData].map(id => [id, true])),
        excludeEntities: Object.fromEntries([...excludedEntities].map(id => [id, true])),
      })
    } finally {
      setExporting(false)
    }
  }

  const handleExport = () => {
    if (includeCredentials && selected.has('databases')) {
      setShowCredentialsConfirm(true)
    } else {
      doExport()
    }
  }

  const noneSelected = ALL_KEYS.every(k => !selected.has(k))

  // ---------------------------------------------------------------------------
  // Render helpers
  // ---------------------------------------------------------------------------

  function renderSection(section: ExportSection, indent = false) {
    if (section.children) {
      const childKeys = section.children.map(c => c.key)
      const allChecked = childKeys.every(k => selected.has(k))
      const someChecked = childKeys.some(k => selected.has(k))

      return (
        <div key={section.key} className="space-y-1">
          {/* Group header */}
          <div className={cn('flex items-center gap-2 py-1', indent && 'pl-6')}>
            <Checkbox
              id={`ws-export-${section.key}`}
              checked={allChecked ? true : someChecked ? 'indeterminate' : false}
              onCheckedChange={() => toggleGroup(section.children!)}
            />
            <Label
              htmlFor={`ws-export-${section.key}`}
              className="flex items-center gap-1.5 text-sm font-medium cursor-pointer"
            >
              <section.icon size={15} className={section.colorClass} />
              {t(section.labelKey)}
            </Label>
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

    return (
      <div key={section.key}>
        <div className={cn('flex items-center gap-2 py-1', indent && 'pl-6')}>
          <Checkbox
            id={`ws-export-${section.key}`}
            checked={selected.has(section.key)}
            onCheckedChange={() => toggle(section.key)}
          />
          <Label
            htmlFor={`ws-export-${section.key}`}
            className="flex items-center gap-1.5 text-sm font-normal cursor-pointer"
          >
            <section.icon size={14} className={section.colorClass} />
            {t(section.labelKey)}
            {!countsLoading && count != null && (
              <span className="text-xs text-muted-foreground ml-0.5">({count})</span>
            )}
          </Label>

          {/* Bulk "include data" toggle for sections with unlinked, included entities */}
          {ENTITY_SECTIONS.includes(section.key as EntitySectionKey)
            && selected.has(section.key)
            && dataEligibleIds(section.key as EntitySectionKey).length > 0 && (
            <span className="ml-auto flex items-center gap-1 text-[10px] text-muted-foreground/70">
              {t('app_versioning.export_data_label')}
              <button type="button" className="underline hover:text-foreground" onClick={() => setSectionData(section.key as EntitySectionKey, true)}>
                {t('common.all')}
              </button>
              <span>/</span>
              <button type="button" className="underline hover:text-foreground" onClick={() => setSectionData(section.key as EntitySectionKey, false)}>
                {t('common.none')}
              </button>
            </span>
          )}
        </div>

        {/* Databases: sub-option for credentials */}
        {isDatabases && selected.has('databases') && (
          <div className="pl-12 space-y-2 pt-1">
            <div className="flex items-center gap-2">
              <Checkbox
                id="ws-export-db-credentials"
                checked={includeCredentials}
                onCheckedChange={(v) => setIncludeCredentials(v === true)}
              />
              <Label htmlFor="ws-export-db-credentials" className="flex items-center gap-1.5 text-xs font-normal cursor-pointer text-muted-foreground">
                <ShieldAlert size={12} className="text-amber-500" />
                {t('app_versioning.export_include_credentials')}
              </Label>
            </div>
            <p className="text-[11px] text-muted-foreground leading-relaxed">
              {includeCredentials
                ? t('app_versioning.export_credentials_on_hint')
                : t('app_versioning.export_credentials_off_hint')}
            </p>
          </div>
        )}

        {/* Per-entity rows: git badge (metadata only) or include-data checkbox */}
        {ENTITY_SECTIONS.includes(section.key as EntitySectionKey)
          && selected.has(section.key)
          && entities[section.key as EntitySectionKey].length > 0 && (
          <div className="pl-12 space-y-1 pt-1">
            {entities[section.key as EntitySectionKey].map(ent => {
              const included = !excludedEntities.has(ent.id)
              return (
                <div key={ent.id} className="space-y-0.5">
                  {/* Main row: include-or-not + (git badge with tooltip when linked) */}
                  <div className="flex items-center gap-2">
                    <Checkbox
                      id={`ws-export-entity-${ent.id}`}
                      checked={included}
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

                  {/* Unlinked + included: sub-option to also bundle its data */}
                  {included && !ent.gitHost && (
                    <div className="flex items-center gap-2 pl-6">
                      <Checkbox
                        id={`ws-export-data-${ent.id}`}
                        checked={includeEntityData.has(ent.id)}
                        onCheckedChange={() => toggleEntityData(ent.id)}
                      />
                      <Label htmlFor={`ws-export-data-${ent.id}`} className="text-[10px] font-normal cursor-pointer text-muted-foreground/70">
                        {t('app_versioning.export_include_entity_data')}
                      </Label>
                    </div>
                  )}
                </div>
              )
            })}
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
        </CardHeader>
        <CardContent className="min-h-0 flex-1 space-y-4 overflow-auto">
          {/* Select all / none */}
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 px-2.5 text-xs"
              onClick={() => { setSelected(new Set(ALL_KEYS)); setExcludedEntities(new Set()) }}
            >
              {t('common.select_all')}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 px-2.5 text-xs"
              onClick={() => { setSelected(new Set()); setExcludedEntities(new Set(allEntityIds())); setIncludeEntityData(new Set()) }}
            >
              {t('common.select_none')}
            </Button>
          </div>

          {/* Section checkboxes */}
          <div className="space-y-1">
            {exportSections.map(s => renderSection(s))}
          </div>
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

      {/* Credentials confirmation dialog */}
      <AlertDialog open={showCredentialsConfirm} onOpenChange={setShowCredentialsConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertTriangle size={18} className="text-amber-500" />
              {t('app_versioning.export_credentials_confirm_title')}
            </AlertDialogTitle>
            <AlertDialogDescription className="space-y-2">
              <p>{t('app_versioning.export_credentials_confirm_body')}</p>
              <ul className="list-disc pl-4 space-y-1 text-xs">
                <li>{t('app_versioning.export_credentials_confirm_included')}</li>
                <li>{t('app_versioning.export_credentials_confirm_excluded')}</li>
              </ul>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => { setShowCredentialsConfirm(false); doExport() }}
              className="bg-amber-600 hover:bg-amber-700"
            >
              {t('app_versioning.export_credentials_confirm_action')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
