import { useState, useEffect, useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { useResolvedParams } from '@/hooks/use-resolved-params'
import { resolveByIdPrefix } from '@/lib/short-id'
import { paths } from '@/lib/paths'
import { useMyWorkspaceRole } from '@/hooks/use-context-role'
import { isServerMode } from '@/lib/api-client'
import { useDataSourceStore } from '@/stores/data-source-store'
import { useAppStore } from '@/stores/app-store'
import { localized, setLocalized } from '@/lib/localized'
import type { DataSource, CustomSchemaPreset } from '@/types'
import { Database, Plus, FileCode, Search, Plug, ChevronDown, Loader2, Upload } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { BadgeStrip } from '@/components/ui/badge-strip'
import { Input } from '@/components/ui/input'
import { ListPageToolbar, type FilterGroup, type SortState } from '@/components/ui/list-page-toolbar'
import { applySort, baseSortFields } from '@/lib/list-sort'
import { Label } from '@/components/ui/label'
import { FieldInfo } from '@/components/ui/field-info'
import { RequiredMark } from '@/components/ui/required-mark'
import { DialogShell } from '@/components/ui/dialog-shell'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
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
import { generateAlias } from '@/lib/duckdb/engine'
import { getStorage } from '@/lib/storage'
import { ImportSourceDialog, type ImportGitRemote } from '@/components/ui/import-source-dialog'
import { ImportConflictDialog } from '@/components/ui/import-conflict-dialog'
import { parseDatabaseZip, importParsedDatabase, type ParsedDatabaseZip } from '@/lib/entity-io'
import { DatabaseCard } from '@/features/projects/warehouse/databases/DatabaseCard'
import { AddDatabaseDialog } from '@/features/projects/warehouse/databases/AddDatabaseDialog'
import { DatabaseDetailPage } from '@/features/projects/warehouse/databases/DatabaseDetailPage'

const DATA_SOURCE_STATUSES = ['connected', 'disconnected', 'error', 'configuring'] as const
const STATUS_DOT: Record<string, string> = {
  connected: 'bg-emerald-500',
  disconnected: 'bg-slate-400',
  error: 'bg-red-500',
  configuring: 'bg-amber-500',
}

// ---------------------------------------------------------------------------
// CreateFromPresetDialog — create an empty database from a preset DDL
// ---------------------------------------------------------------------------

function CreateFromPresetDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { t } = useTranslation()
  const language = useAppStore((s) => s.language)
  const { wsUid } = useResolvedParams()
  const { createEmptyDatabase } = useDataSourceStore()
  const [customPresets, setCustomPresets] = useState<CustomSchemaPreset[]>([])
  const [selectedPresetId, setSelectedPresetId] = useState('')
  const [name, setName] = useState('')
  const [alias, setAlias] = useState('')
  const [description, setDescription] = useState('')
  const [aliasManuallyEdited, setAliasManuallyEdited] = useState(false)
  const [creating, setCreating] = useState(false)

  const loadPresets = useCallback(async () => {
    try {
      const presets = wsUid
        ? await getStorage().schemaPresets.getByWorkspace(wsUid)
        : await getStorage().schemaPresets.getAll()
      setCustomPresets(presets)
    } catch {
      // IDB not ready
    }
  }, [wsUid])

  useEffect(() => {
    if (open) loadPresets()
  }, [open, loadPresets])

  // Only the schemas the workspace actually holds — the same list the Schemas
  // page shows. Offering the built-ins on top listed schemas that are not in
  // the workspace, and duplicated any the user had added from a built-in
  // (a custom preset keeps the built-in's presetId when it overrides it).
  const presetsWithDDL = customPresets
    .filter((cp) => cp.mapping.ddl)
    .map((cp) => ({
      id: cp.entityId ?? cp.id,
      label: localized(cp.mapping.presetLabel, language),
      ddl: cp.mapping.ddl!,
      mapping: cp.mapping,
    }))

  const selectedPreset = presetsWithDDL.find((p) => p.id === selectedPresetId)

  // Auto-fill name (and alias) when preset changes
  useEffect(() => {
    if (selectedPreset && !name) {
      setName(selectedPreset.label)
      if (!aliasManuallyEdited) setAlias(generateAlias(selectedPreset.label))
    }
  }, [selectedPresetId]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleCreate = async () => {
    if (!selectedPreset || !name.trim()) return
    setCreating(true)
    try {
      await createEmptyDatabase({
        name: setLocalized({}, language, name.trim()),
        description: setLocalized({}, language,
          description.trim() || t('databases.created_from_preset', { preset: selectedPreset.label })),
        schemaMapping: selectedPreset.mapping,
        ddl: selectedPreset.ddl,
        alias: alias.trim() || undefined,
      })
      onOpenChange(false)
      setSelectedPresetId('')
      setName('')
      setAlias('')
      setDescription('')
      setAliasManuallyEdited(false)
    } finally {
      setCreating(false)
    }
  }

  return (
    <DialogShell
      open={open}
      onOpenChange={onOpenChange}
      title={t('databases.create_from_schema')}
      description={t('databases.create_from_schema_description')}
      onConfirm={handleCreate}
      confirmLabel={t('common.create')}
      confirmDisabled={!name.trim() || !selectedPreset}
      busy={creating}
      footerExtra={
        /* Running the DDL can take a while on a large schema — say so, rather
           than leaving a disabled button as the only feedback. */
        <span className="flex items-center gap-2 text-xs text-muted-foreground sm:mr-auto">
          {creating && (
            <>
              <Loader2 size={13} className="shrink-0 animate-spin" />
              {t('databases.creating_may_take_a_while')}
            </>
          )}
        </span>
      }
    >
          <div className="space-y-2">
            <Label>{t('databases.schema_preset')}<RequiredMark /></Label>
            <Select value={selectedPresetId} onValueChange={setSelectedPresetId}>
              <SelectTrigger>
                <SelectValue placeholder={t('databases.select_preset')} />
              </SelectTrigger>
              <SelectContent>
                {presetsWithDDL.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {presetsWithDDL.length === 0 && (
              <p className="text-xs text-muted-foreground">{t('databases.no_presets_with_ddl')}</p>
            )}
          </div>

          <div className="space-y-2">
            <Label>{t('databases.database_name')}<RequiredMark /></Label>
            <Input
              value={name}
              onChange={(e) => {
                setName(e.target.value)
                if (!aliasManuallyEdited) setAlias(generateAlias(e.target.value))
              }}
              placeholder={t('databases.database_name_placeholder')}
            />
          </div>

          <div className="space-y-2">
            <Label className="flex items-center gap-1.5">
              {t('databases.field_identifier')}
              <FieldInfo text={t('databases.field_alias_hint')} />
            </Label>
            <Input
              value={alias}
              onChange={(e) => {
                setAlias(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_'))
                setAliasManuallyEdited(true)
              }}
              placeholder="mimic_iv_raw"
              className="font-mono text-xs"
            />
          </div>

          <div className="space-y-2">
            <Label>{t('databases.field_description')}</Label>
            <Input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t('databases.field_description_placeholder')}
            />
          </div>
    </DialogShell>
  )
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export function AppDatabasesPage() {
  const { t } = useTranslation()
  const { wsUid, raw } = useResolvedParams()
  const navigate = useNavigate()
  const canWrite = useMyWorkspaceRole().can('databases:write')
  const dataSources = useDataSourceStore((s) => s.dataSources)
  const { testConnection, disconnectDataSource, removeDataSource, reconnectDataSource, retestDataSource, loadDataSources } = useDataSourceStore()
  // In server mode the DB lives on the server: (re)connecting means re-testing
  // the stored connection there (testConnection/reconnect are front-only no-ops).
  const connectAction = (id: string) => (isServerMode() ? retestDataSource(id) : testConnection(id))
  const reconnectAction = (id: string) => (isServerMode() ? retestDataSource(id) : reconnectDataSource(id))
  const projects = useAppStore((s) => s._projectsRaw)
  const language = useAppStore((s) => s.language)

  const [dialogOpen, setDialogOpen] = useState(false)
  const [presetDialogOpen, setPresetDialogOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [conflict, setConflict] = useState<{ name: string; pending: ParsedDatabaseZip; gitRemote?: ImportGitRemote } | null>(null)
  const [sourceToRemove, setSourceToRemove] = useState<DataSource | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<string[]>([])
  const [projectFilter, setProjectFilter] = useState<string[]>([])
  const [sort, setSort] = useState<SortState | null>(null)

  // Show only databases for the current workspace, hide vocabulary-only sources
  const visibleSources = dataSources.filter((ds) => !ds.isVocabularyReference && ds.workspaceId === wsUid)

  const getLinkedProjects = useCallback(
    (dataSourceId: string) => projects.filter((p) => p.linkedDataSourceIds?.includes(dataSourceId)),
    [projects],
  )

  const projectName = useCallback(
    (p: (typeof projects)[number]) => p.name[language] ?? p.name['en'] ?? Object.values(p.name)[0] ?? '',
    [language],
  )

  // Fuzzy search + status + linked-project filters.
  const filteredSources = useMemo(() => {
    const words = searchQuery.toLowerCase().split(/\s+/).filter(Boolean)
    const matched = visibleSources.filter((ds) => {
      if (words.length) {
        const haystack = `${localized(ds.name, language)} ${localized(ds.description, language)}`.toLowerCase()
        if (!words.every((w) => haystack.includes(w))) return false
      }
      if (statusFilter.length && !statusFilter.includes(ds.status)) return false
      if (projectFilter.length) {
        const linked = new Set(getLinkedProjects(ds.id).map((p) => p.uid))
        if (!projectFilter.some((uid) => linked.has(uid))) return false
      }
      return true
    })
    return applySort(matched, sort, {
      name: (ds) => localized(ds.name, language),
      createdAt: (ds) => ds.createdAt,
      updatedAt: (ds) => ds.updatedAt,
    })
  }, [visibleSources, searchQuery, statusFilter, projectFilter, getLinkedProjects, sort, language])

  const linkedProjectOptions = useMemo(() => {
    const seen = new Map<string, string>()
    for (const ds of visibleSources) for (const p of getLinkedProjects(ds.id)) if (!seen.has(p.uid)) seen.set(p.uid, projectName(p))
    return [...seen.entries()].map(([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label))
  }, [visibleSources, getLinkedProjects, projectName])

  const filterGroups: FilterGroup[] = [
    {
      key: 'status',
      label: t('databases.status'),
      selected: statusFilter,
      onChange: setStatusFilter,
      options: DATA_SOURCE_STATUSES.map((s) => ({
        value: s,
        label: t(`databases.status_${s}`),
        dotClass: STATUS_DOT[s],
      })),
    },
    {
      key: 'projects',
      label: t('app_warehouse.linked_projects'),
      selected: projectFilter,
      onChange: setProjectFilter,
      options: linkedProjectOptions,
    },
  ]

  const handleRemove = () => {
    if (sourceToRemove) {
      removeDataSource(sourceToRemove.id)
      setSourceToRemove(null)
    }
  }

  const doImport = useCallback(async (
    parsed: ParsedDatabaseZip,
    duplicate: boolean,
    gitRemote?: ImportGitRemote,
  ) => {
    await importParsedDatabase(
      parsed,
      getStorage(),
      duplicate,
      wsUid,
      gitRemote ? { url: gitRemote.url, branch: gitRemote.branch } : undefined,
    )
    await loadDataSources()
  }, [wsUid, loadDataSources])

  /** A database repo carries its Parquet, so the ZIP is read as bytes rather than
   *  through parseImportZip (which decodes every entry as text). */
  const handleImport = useCallback(async (file: File, gitRemote?: ImportGitRemote) => {
    const parsed = await parseDatabaseZip(file)
    if (!parsed) throw new Error(t('databases.import_not_a_database'))
    const existing = await getStorage().dataSources.getById(parsed.id).catch(() => null)
    if (existing) {
      setConflict({ name: localized(existing.name, language), pending: parsed, gitRemote })
    } else {
      await doImport(parsed, false, gitRemote)
    }
  }, [doImport, language, t])

  // Ids are shortened in the URL, so resolve the prefix against this workspace's
  // own list — the same way every other detail route does.
  const siblingIds = visibleSources.map((ds: DataSource) => ds.id)
  if (raw.dbId) {
    return (
      <DatabaseDetailPage
        source={resolveByIdPrefix(visibleSources, raw.dbId, (ds) => ds.id)}
        onBack={() => navigate(paths.warehouseDatabases(wsUid ?? ''))}
      />
    )
  }

  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto max-w-4xl px-6 py-10">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-foreground">{t('app_warehouse.nav_databases')}</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {t('app_warehouse.databases_description', { count: visibleSources.length })}
            </p>
          </div>
          <div className="flex items-center gap-1">
            <Button
              size="sm"
              variant="outline"
              className="gap-1 text-xs"
              disabled={!canWrite}
              onClick={() => setImportOpen(true)}
            >
              <Upload size={14} />
              {t('common.import')}
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="sm" className="gap-1 text-xs" disabled={!canWrite}>
                  <Plus size={14} />
                  {t('databases.add_database')}
                  <ChevronDown size={14} className="ml-1 opacity-60" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => setDialogOpen(true)}>
                  <Plug size={14} />
                  {t('databases.add_connection')}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setPresetDialogOpen(true)}>
                  <FileCode size={14} />
                  {t('databases.create_from_schema')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        {/* Search + filters */}
        {visibleSources.length > 0 && (
          <ListPageToolbar
            searchQuery={searchQuery}
            onSearchChange={setSearchQuery}
            searchPlaceholder={t('databases.search_placeholder')}
            filterGroups={filterGroups}
            sort={{ options: baseSortFields(t), value: sort, onChange: setSort }}
          />
        )}

      {visibleSources.length === 0 ? (
        <Card className="mt-4">
          <div className="flex flex-col items-center py-12">
            <Database size={40} className="text-muted-foreground" />
            <p className="mt-4 text-sm font-medium text-foreground">
              {t('databases.no_databases')}
            </p>
            <p className="mt-1 max-w-xs text-center text-xs text-muted-foreground">
              {t('databases.no_databases_description')}
            </p>
          </div>
        </Card>
      ) : filteredSources.length === 0 ? (
        <div className="mt-4 flex flex-col items-center py-8">
          <Search size={24} className="text-muted-foreground/50" />
          <p className="mt-2 text-sm text-muted-foreground">{t('databases.no_results')}</p>
        </div>
      ) : (
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          {filteredSources.map((ds) => (
            <DatabaseCard
              key={ds.id}
              source={ds}
              onClick={() => navigate(paths.warehouseDatabase(wsUid ?? '', ds.id, siblingIds))}
              onOpenLicense={() => navigate(`${paths.warehouseDatabase(wsUid ?? '', ds.id, siblingIds)}?tab=license`)}
              onOpenDocs={(tab) => navigate(`${paths.warehouseDatabase(wsUid ?? '', ds.id, siblingIds)}?tab=${tab}`)}
              onOpenVersioning={() => navigate(`${paths.warehouseDatabase(wsUid ?? '', ds.id, siblingIds)}?tab=versioning`)}
              onTestConnection={() => connectAction(ds.id)}
              onDisconnect={() => disconnectDataSource(ds.id)}
              onReconnect={() => reconnectAction(ds.id)}
              onRemove={() => setSourceToRemove(ds)}
              belowStats={
                ds.badges?.length ? <BadgeStrip className="mt-1" badges={ds.badges} /> : undefined
              }
            />
          ))}
        </div>
      )}

      <CreateFromPresetDialog
        open={presetDialogOpen}
        onOpenChange={setPresetDialogOpen}
      />

      {/* Creation only — editing an existing database goes through the card's
          actions menu, which renders this same dialog with the item. */}
      <AddDatabaseDialog open={dialogOpen} onOpenChange={setDialogOpen} />

      {/* `database` has no git scope on purpose (it is install-only, never pushed),
          so the catalog tab is named by type instead. */}
      <ImportSourceDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        accept=".zip"
        onImport={handleImport}
        catalogType="database"
        onCatalogInstalled={loadDataSources}
      />

      <ImportConflictDialog
        open={!!conflict}
        onOpenChange={(open) => { if (!open) setConflict(null) }}
        existingName={conflict?.name ?? ''}
        onDuplicate={() => { if (conflict) void doImport(conflict.pending, true, conflict.gitRemote); setConflict(null) }}
        onOverwrite={() => { if (conflict) void doImport(conflict.pending, false, conflict.gitRemote); setConflict(null) }}
      />


      <AlertDialog
        open={!!sourceToRemove}
        onOpenChange={(open) => { if (!open) setSourceToRemove(null) }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('app_warehouse.delete_confirm_title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('app_warehouse.delete_confirm_description')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={handleRemove}
            >
              {t('common.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      </div>
    </div>
  )
}
