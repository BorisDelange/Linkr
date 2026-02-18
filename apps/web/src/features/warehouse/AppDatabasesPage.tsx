import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { useDataSourceStore } from '@/stores/data-source-store'
import { useAppStore } from '@/stores/app-store'
import type { DataSource, CustomSchemaPreset } from '@/types'
import { Database, Plus, FileCode, Search, Plug, ChevronDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
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
import { getStorage } from '@/lib/storage'
import { DatabaseCard } from '@/features/projects/warehouse/databases/DatabaseCard'
import { AddDatabaseDialog } from '@/features/projects/warehouse/databases/AddDatabaseDialog'
import { DatabaseDetailSheet } from '@/features/projects/warehouse/databases/DatabaseDetailSheet'

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
  const { createEmptyDatabase } = useDataSourceStore()
  const [customPresets, setCustomPresets] = useState<CustomSchemaPreset[]>([])
  const [selectedPresetId, setSelectedPresetId] = useState('')
  const [name, setName] = useState('')
  const [creating, setCreating] = useState(false)

  const loadPresets = useCallback(async () => {
    try {
      const presets = await getStorage().schemaPresets.getAll()
      setCustomPresets(presets)
    } catch {
      // IDB not ready
    }
  }, [])

  useEffect(() => {
    if (open) loadPresets()
  }, [open, loadPresets])

  // Collect all presets that have a DDL
  const presetsWithDDL: { id: string; label: string; ddl: string; mapping: import('@/types/schema-mapping').SchemaMapping }[] = []
  for (const presetId of BUILTIN_PRESET_IDS) {
    const preset = SCHEMA_PRESETS[presetId]
    if (preset?.ddl) {
      presetsWithDDL.push({ id: presetId, label: preset.presetLabel, ddl: preset.ddl, mapping: preset })
    }
  }
  for (const cp of customPresets) {
    if (cp.mapping.ddl) {
      presetsWithDDL.push({ id: cp.presetId, label: cp.mapping.presetLabel, ddl: cp.mapping.ddl, mapping: cp.mapping })
    }
  }

  const selectedPreset = presetsWithDDL.find((p) => p.id === selectedPresetId)

  // Auto-fill name when preset changes
  useEffect(() => {
    if (selectedPreset && !name) {
      setName(selectedPreset.label)
    }
  }, [selectedPresetId]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleCreate = async () => {
    if (!selectedPreset || !name.trim()) return
    setCreating(true)
    try {
      await createEmptyDatabase({
        name: name.trim(),
        description: t('databases.created_from_preset', { preset: selectedPreset.label }),
        schemaMapping: selectedPreset.mapping,
        ddl: selectedPreset.ddl,
      })
      onOpenChange(false)
      setSelectedPresetId('')
      setName('')
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
            <Label>{t('databases.schema_preset')}</Label>
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
            <Label>{t('databases.database_name')}</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('databases.database_name_placeholder')}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && name.trim() && selectedPreset) handleCreate()
              }}
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
  const dataSources = useDataSourceStore((s) => s.dataSources)
  const { testConnection, disconnectDataSource, removeDataSource, reconnectDataSource } = useDataSourceStore()
  const projects = useAppStore((s) => s._projectsRaw)
  const language = useAppStore((s) => s.language)

  const [dialogOpen, setDialogOpen] = useState(false)
  const [presetDialogOpen, setPresetDialogOpen] = useState(false)
  const [sourceToRemove, setSourceToRemove] = useState<DataSource | null>(null)
  const [selectedSource, setSelectedSource] = useState<DataSource | null>(null)
  const [sourceToEdit, setSourceToEdit] = useState<DataSource | null>(null)
  const [searchQuery, setSearchQuery] = useState('')

  // Fuzzy search: every word in query must appear in name OR description (case-insensitive)
  const filteredSources = searchQuery.trim()
    ? dataSources.filter((ds) => {
        const words = searchQuery.toLowerCase().split(/\s+/).filter(Boolean)
        const haystack = `${ds.name} ${ds.description ?? ''}`.toLowerCase()
        return words.every((w) => haystack.includes(w))
      })
    : dataSources

  const currentSelectedSource = selectedSource
    ? dataSources.find((ds) => ds.id === selectedSource.id) ?? null
    : null

  const getLinkedProjects = (dataSourceId: string) =>
    projects.filter((p) => p.linkedDataSourceIds?.includes(dataSourceId))

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
              {t('app_warehouse.databases_description', { count: dataSources.length })}
            </p>
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button>
                <Plus size={16} />
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

        {/* Search bar */}
        {dataSources.length > 0 && (
          <div className="relative mt-4">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={t('databases.search_placeholder')}
              className="pl-9"
            />
          </div>
        )}

      {filteredSources.length === 0 && dataSources.length === 0 ? (
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
                  onTestConnection={() => testConnection(ds.id)}
                  onDisconnect={() => disconnectDataSource(ds.id)}
                  onReconnect={() => reconnectDataSource(ds.id)}
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
