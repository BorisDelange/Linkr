import { useState, useEffect, useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useResolvedParams } from '@/hooks/use-resolved-params'
import { useMyWorkspaceRole } from '@/hooks/use-context-role'
import { isServerMode } from '@/lib/api-client'
import { useDataSourceStore } from '@/stores/data-source-store'
import { useAppStore } from '@/stores/app-store'
import { localized } from '@/lib/localized'
import type { DataSource, CustomSchemaPreset } from '@/types'
import { Database, Plus, FileCode, Search, Plug, ChevronDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { ListPageToolbar, type FilterGroup, type SortState } from '@/components/ui/list-page-toolbar'
import { applySort, baseSortFields } from '@/lib/list-sort'
import { Label } from '@/components/ui/label'
import { RequiredMark } from '@/components/ui/required-mark'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
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
import { BUILTIN_PRESET_IDS, SCHEMA_PRESETS } from '@/lib/schema-presets'
import { generateAlias } from '@/lib/duckdb/engine'
import { getStorage } from '@/lib/storage'
import { DatabaseCard } from '@/features/projects/warehouse/databases/DatabaseCard'
import { AddDatabaseDialog } from '@/features/projects/warehouse/databases/AddDatabaseDialog'
import { DatabaseDetailSheet } from '@/features/projects/warehouse/databases/DatabaseDetailSheet'

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

  // Collect all presets that have a DDL
  const presetsWithDDL: { id: string; label: string; ddl: string; mapping: import('@/types/schema-mapping').SchemaMapping }[] = []
  for (const presetId of BUILTIN_PRESET_IDS) {
    const preset = SCHEMA_PRESETS[presetId]
    if (preset?.ddl) {
      presetsWithDDL.push({ id: presetId, label: localized(preset.presetLabel, language), ddl: preset.ddl, mapping: preset })
    }
  }
  for (const cp of customPresets) {
    if (cp.mapping.ddl) {
      presetsWithDDL.push({ id: cp.presetId, label: localized(cp.mapping.presetLabel, language), ddl: cp.mapping.ddl, mapping: cp.mapping })
    }
  }

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
        name: name.trim(),
        description: description.trim() || t('databases.created_from_preset', { preset: selectedPreset.label }),
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
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('databases.create_from_schema')}</DialogTitle>
          <DialogDescription>{t('databases.create_from_schema_description')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
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
              onKeyDown={(e) => {
                if (e.key === 'Enter' && name.trim() && selectedPreset) { e.preventDefault(); handleCreate() }
              }}
            />
          </div>

          <div className="space-y-2">
            <Label>{t('databases.field_identifier')}</Label>
            <Input
              value={alias}
              onChange={(e) => {
                setAlias(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_'))
                setAliasManuallyEdited(true)
              }}
              placeholder="mimic_iv_raw"
              className="font-mono text-xs"
            />
            <p className="text-[11px] text-muted-foreground">{t('databases.field_alias_hint')}</p>
          </div>

          <div className="space-y-2">
            <Label>{t('databases.field_description')}</Label>
            <Input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t('databases.field_description_placeholder')}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('common.cancel')}
          </Button>
          <Button
            onClick={handleCreate}
            disabled={!name.trim() || !selectedPreset || creating}
          >
            {t('common.create')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export function AppDatabasesPage() {
  const { t } = useTranslation()
  const { wsUid } = useResolvedParams()
  const canWrite = useMyWorkspaceRole().can('databases:write')
  const dataSources = useDataSourceStore((s) => s.dataSources)
  const { testConnection, disconnectDataSource, removeDataSource, reconnectDataSource, retestDataSource } = useDataSourceStore()
  // In server mode the DB lives on the server: (re)connecting means re-testing
  // the stored connection there (testConnection/reconnect are front-only no-ops).
  const connectAction = (id: string) => (isServerMode() ? retestDataSource(id) : testConnection(id))
  const reconnectAction = (id: string) => (isServerMode() ? retestDataSource(id) : reconnectDataSource(id))
  const projects = useAppStore((s) => s._projectsRaw)
  const language = useAppStore((s) => s.language)

  const [dialogOpen, setDialogOpen] = useState(false)
  const [presetDialogOpen, setPresetDialogOpen] = useState(false)
  const [sourceToRemove, setSourceToRemove] = useState<DataSource | null>(null)
  const [selectedSource, setSelectedSource] = useState<DataSource | null>(null)
  const [sourceToEdit, setSourceToEdit] = useState<DataSource | null>(null)
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
        const haystack = `${ds.name} ${ds.description ?? ''}`.toLowerCase()
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
      name: (ds) => ds.name,
      createdAt: (ds) => ds.createdAt,
      updatedAt: (ds) => ds.updatedAt,
    })
  }, [visibleSources, searchQuery, statusFilter, projectFilter, getLinkedProjects, sort])

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

  const currentSelectedSource = selectedSource
    ? dataSources.find((ds) => ds.id === selectedSource.id) ?? null
    : null

  const handleRemove = () => {
    if (sourceToRemove) {
      removeDataSource(sourceToRemove.id)
      if (selectedSource?.id === sourceToRemove.id) {
        setSelectedSource(null)
      }
      setSourceToRemove(null)
    }
  }

  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto max-w-3xl px-6 py-10">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-foreground">{t('app_warehouse.nav_databases')}</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {t('app_warehouse.databases_description', { count: visibleSources.length })}
            </p>
          </div>
          <div className="flex items-center gap-1">
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
        <div className="mt-4 space-y-3">
          {filteredSources.map((ds) => {
            const linkedProjects = getLinkedProjects(ds.id)
            return (
              <div key={ds.id} className="space-y-1">
                <DatabaseCard
                  source={ds}
                  onClick={() => setSelectedSource(ds)}
                  onTestConnection={() => connectAction(ds.id)}
                  onDisconnect={() => disconnectDataSource(ds.id)}
                  onReconnect={() => reconnectAction(ds.id)}
                  onEdit={() => setSourceToEdit(ds)}
                  onRemove={() => setSourceToRemove(ds)}
                />
                {linkedProjects.length > 0 && (
                  <div className="flex items-center gap-1.5 pl-4">
                    <span className="text-[10px] text-muted-foreground">
                      {t('app_warehouse.linked_projects')}:
                    </span>
                    {linkedProjects.map((p) => {
                      const name = p.name[language] ?? p.name['en'] ?? Object.values(p.name)[0] ?? ''
                      return (
                        <Badge key={p.uid} variant="secondary" className="text-[10px] px-1.5 py-0">
                          {name}
                        </Badge>
                      )
                    })}
                  </div>
                )}
                {linkedProjects.length === 0 && (
                  <p className="pl-4 text-[10px] text-muted-foreground/60">
                    {t('app_warehouse.no_linked_projects')}
                  </p>
                )}
              </div>
            )
          })}
        </div>
      )}

      <CreateFromPresetDialog
        open={presetDialogOpen}
        onOpenChange={setPresetDialogOpen}
      />

      <AddDatabaseDialog
        open={dialogOpen || !!sourceToEdit}
        onOpenChange={(open) => {
          if (!open) {
            setDialogOpen(false)
            setSourceToEdit(null)
          } else {
            setDialogOpen(true)
          }
        }}
        editingSource={sourceToEdit}
      />

      <DatabaseDetailSheet
        source={currentSelectedSource}
        open={!!currentSelectedSource}
        onOpenChange={(open) => { if (!open) setSelectedSource(null) }}
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
