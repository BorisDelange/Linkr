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
import { cn } from '@/lib/utils'
import { useWorkspaceVersioningStore } from '@/stores/workspace-versioning-store'
import { getStorage } from '@/lib/storage'

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
  { key: 'projects', icon: FolderOpen, labelKey: 'app_versioning.export_section_projects', colorClass: 'text-amber-500' },
  { key: 'wiki', icon: BookOpen, labelKey: 'app_versioning.export_section_wiki', colorClass: 'text-emerald-500' },
  { key: 'plugins', icon: Puzzle, labelKey: 'app_versioning.export_section_plugins', colorClass: 'text-pink-500' },
  {
    key: 'warehouse',
    icon: Warehouse,
    labelKey: 'app_versioning.export_section_warehouse',
    colorClass: 'text-teal-500',
    children: [
      { key: 'schemas', icon: FileSpreadsheet, labelKey: 'app_versioning.export_section_schemas', colorClass: 'text-teal-500' },
      { key: 'databases', icon: Database, labelKey: 'app_versioning.export_section_databases', colorClass: 'text-teal-500' },
      { key: 'conceptMapping', icon: ArrowRightLeft, labelKey: 'app_versioning.export_section_concept_mapping', colorClass: 'text-teal-500' },
      { key: 'sqlScripts', icon: SquareTerminal, labelKey: 'app_versioning.export_section_sql_scripts', colorClass: 'text-teal-500' },
      { key: 'etl', icon: Workflow, labelKey: 'app_versioning.export_section_etl', colorClass: 'text-teal-500' },
      { key: 'dataQuality', icon: ShieldCheck, labelKey: 'app_versioning.export_section_data_quality', colorClass: 'text-teal-500' },
      { key: 'catalogs', icon: BookOpen, labelKey: 'app_versioning.export_section_catalogs', colorClass: 'text-teal-500' },
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

export function WsExportTab() {
  const { t } = useTranslation()
  const { wsUid } = useParams<{ wsUid: string }>()
  const { exportZip, loading } = useWorkspaceVersioningStore()
  const [exporting, setExporting] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(() => new Set(ALL_KEYS))
  const [includeCredentials, setIncludeCredentials] = useState(false)
  const [showCredentialsConfirm, setShowCredentialsConfirm] = useState(false)
  const [counts, setCounts] = useState<Record<string, number>>({})
  const [countsLoading, setCountsLoading] = useState(true)

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
        conceptMapping: mappingProjects.length + conceptSets.length,
        sqlScripts: sqlCollections.length,
        etl: etlPipelines.length,
        dataQuality: dqRuleSets.length,
        catalogs: catalogs.length + serviceMappings.length,
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
      </div>
    )
  }

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">{t('versioning.export_title')}</CardTitle>
          <CardDescription>{t('app_versioning.export_description')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Section checkboxes */}
          <div className="space-y-1">
            {exportSections.map(s => renderSection(s))}
          </div>

          {/* Projects hint */}
          <p className="text-xs text-muted-foreground pl-6">
            {t('app_versioning.export_projects_hint')}
          </p>

          <Button
            size="sm"
            onClick={handleExport}
            disabled={exporting || loading || noneSelected}
            className="gap-1.5"
          >
            {exporting ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
            {t('versioning.export_download')}
          </Button>
        </CardContent>
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
