import { useState, useRef, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useResolvedParams } from '@/hooks/use-resolved-params'
import { isServerMode } from '@/lib/api-client'
import { useDataSourceStore } from '@/stores/data-source-store'
import { useAppStore } from '@/stores/app-store'
import { localized, localizedRaw, setLocalized } from '@/lib/localized'
import { commonDirPrefix, extractTableName, generateAlias } from '@/lib/duckdb/engine'
import { getSchemaPreset } from '@/lib/schema-presets'
import { getStorage } from '@/lib/storage'
import type {
  DataSource,
  DataSourceType,
  FhirConnectionConfig,
  DatabaseConnectionConfig,
  DatabaseEngine,
  SchemaPresetId,
  CustomSchemaPreset,
  ProjectBadge,
} from '@/types'
import {
  Database,
  Globe,
  HardDrive,
  FolderOpen,
  ArrowLeft,
  Upload,
  File as FileIcon,
  X,
  Loader2,
  AlertTriangle,
  Info,
} from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { PasswordInput } from '@/components/ui/password-input'
import { Label } from '@/components/ui/label'
import { FieldInfo } from '@/components/ui/field-info'
import { RequiredMark } from '@/components/ui/required-mark'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { BadgeEditor } from '@/components/ui/badge-editor'
import { useBadgeCategories } from '@/hooks/use-badge-categories'
import { VersionField } from '@/components/ui/version-field'
import { useBadgeSuggestions } from '@/hooks/use-badge-suggestions'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

type DbTab = 'general' | 'connection' | 'metadata'

interface AddDatabaseDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** When provided, the new database is automatically linked to this project. */
  projectUid?: string
  /** When provided, the dialog opens in edit mode for this data source. */
  editingSource?: DataSource | null
}

const sourceTypes: {
  type: DataSourceType
  icon: React.ComponentType<{ size?: number; className?: string }>
  labelKey: string
  descKey: string
  color: string
  /** Not yet available — shown greyed out. */
  disabled?: boolean
}[] = [
  {
    type: 'database',
    icon: Database,
    labelKey: 'databases.type_database',
    descKey: 'databases.type_database_desc',
    color: 'bg-blue-500/10 text-blue-600',
  },
  {
    type: 'fhir',
    icon: Globe,
    labelKey: 'databases.type_fhir',
    descKey: 'databases.type_fhir_desc',
    color: 'bg-teal-500/10 text-teal-600',
    disabled: true,  // FHIR server support comes much later
  },
]

const SIZE_WARNING_THRESHOLD = 500_000_000 // 500 MB
const SIZE_DANGER_THRESHOLD = 2_000_000_000 // 2 GB

function formatFileSize(bytes: number): string {
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(1)} GB`
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`
  if (bytes >= 1_000) return `${(bytes / 1_000).toFixed(1)} KB`
  return `${bytes} B`
}

export function AddDatabaseDialog({
  open,
  onOpenChange,
  projectUid,
  editingSource,
}: AddDatabaseDialogProps) {
  const { t } = useTranslation()
  const language = useAppStore((s) => s.language)
  const { wsUid } = useResolvedParams()
  const { addDataSource, updateDataSource, removeDataSource, retestDataSource, dataSources } = useDataSourceStore()
  const [step, setStep] = useState<1 | 2>(1)
  const [dbTab, setDbTab] = useState<DbTab>('general')
  const badgeCategories = useBadgeCategories()
  const badgeSuggestions = useBadgeSuggestions(
    dataSources.filter((ds) => ds.id !== editingSource?.id),
    wsUid,
  )
  const [badges, setBadges] = useState<ProjectBadge[]>([])
  const [version, setVersion] = useState('0.1.0')
  const [selectedType, setSelectedType] = useState<DataSourceType | null>(null)
  const [uploading, setUploading] = useState(false)
  const [customPresets, setCustomPresets] = useState<CustomSchemaPreset[]>([])

  const isEditMode = !!editingSource

  // Load custom presets from IDB
  useEffect(() => {
    const loader = wsUid
      ? getStorage().schemaPresets.getByWorkspace(wsUid)
      : getStorage().schemaPresets.getAll()
    loader.then(setCustomPresets).catch(() => {})
  }, [open, wsUid])

  // Pre-populate fields when editing
  useEffect(() => {
    if (open && editingSource) {
      setName(localizedRaw(editingSource.name, language))
      setBadges(editingSource.badges ?? [])
      setVersion(editingSource.version ?? '0.1.0')
      setAlias(editingSource.alias ?? '')
      setAliasManuallyEdited(true)
      setDescription(localizedRaw(editingSource.description, language))
      setSelectedType(editingSource.sourceType)
      setStep(2)
      setDbTab('general')
    setBadges([])
    setVersion('0.1.0')
      if (editingSource.sourceType === 'database') {
        const config = editingSource.connectionConfig as DatabaseConnectionConfig
        setDbEngine(config.engine)
        setImportMode(config.fileIds ? 'parquet' : 'duckdb')
        if (config.host) setDbHost(config.host)
        if (config.port) setDbPort(String(config.port))
        if (config.database) setDbDatabase(config.database)
        if (config.schema) setDbSchema(config.schema)
        if (config.username) setDbUsername(config.username)
        if (config.password) setDbPassword(config.password)
      } else if (editingSource.sourceType === 'fhir') {
        const config = editingSource.connectionConfig as FhirConnectionConfig
        setFhirBaseUrl(config.baseUrl)
      }
      setSchemaPresetId(editingSource.schemaMapping?.presetId as SchemaPresetId ?? '__none__')
    }
  }, [open, editingSource])

  // Common fields
  const [name, setName] = useState('')
  const [alias, setAlias] = useState('')
  const [aliasManuallyEdited, setAliasManuallyEdited] = useState(false)
  const [description, setDescription] = useState('')

  // Database import mode: 'duckdb' (single .duckdb file) or 'parquet' (folder of parquets)
  const [importMode, setImportMode] = useState<'duckdb' | 'parquet'>('duckdb')

  // Schema preset
  const [schemaPresetId, setSchemaPresetId] = useState<SchemaPresetId>('__none__')

  // File upload
  const [uploadedFiles, setUploadedFiles] = useState<File[]>([])
  /** File System Access API handles — stored alongside File objects for zero-copy. */
  const [fsHandles, setFsHandles] = useState<{ fileName: string; handle: FileSystemFileHandle; fileSize: number }[]>([])
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Database fields — default to PostgreSQL in server mode (external DBs are the
  // common case there), DuckDB in front-only (Postgres isn't offered).
  const defaultEngine: DatabaseEngine = isServerMode() ? 'postgresql' : 'duckdb'
  const [dbEngine, setDbEngine] = useState<DatabaseEngine>(defaultEngine)
  const [dbHost, setDbHost] = useState('')
  const [dbPort, setDbPort] = useState('')
  const [dbDatabase, setDbDatabase] = useState('')
  const [dbSchema, setDbSchema] = useState('')
  const [dbUsername, setDbUsername] = useState('')
  const [dbPassword, setDbPassword] = useState('')

  // FHIR fields
  const [fhirBaseUrl, setFhirBaseUrl] = useState('')

  const reset = () => {
    setStep(1)
    setDbTab('general')
    setBadges([])
    setVersion('0.1.0')
    setSelectedType(null)
    setUploading(false)
    setName('')
    setAlias('')
    setAliasManuallyEdited(false)
    setDescription('')
    setUploadedFiles([])
    setFsHandles([])
    setImportMode('duckdb')
    setSchemaPresetId('__none__')
    setDbEngine(defaultEngine)
    setDbHost('')
    setDbPort('')
    setDbDatabase('')
    setDbSchema('')
    setDbUsername('')
    setDbPassword('')
    setFhirBaseUrl('')
  }

  const handleClose = (open: boolean, force = false) => {
    // Block user-initiated closes mid-import (X / Escape / overlay): an upload in
    // flight has no resume, and closing would lose track of where it was. The
    // programmatic close on success/error passes force to bypass this.
    if (!open && uploading && !force) return
    if (!open) reset()
    onOpenChange(open)
  }

  const handleSelectType = (type: DataSourceType) => {
    setSelectedType(type)
    setStep(2)
    setDbTab('general')
    setBadges([])
    setVersion('0.1.0')
  }

  const handleFilesSelected = (e: React.ChangeEvent<HTMLInputElement>) => {
    let files = Array.from(e.target.files ?? [])
    // In folder mode, only keep .parquet files
    if (importMode === 'parquet') {
      files = files.filter((f) => f.name.toLowerCase().endsWith('.parquet'))
    }
    if (files.length > 0) {
      setUploadedFiles((prev) => [...prev, ...files])
    }
    // Reset input so the same file can be re-selected
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  const handleRemoveFile = (index: number) => {
    setUploadedFiles((prev) => prev.filter((_, i) => i !== index))
  }

  const handleSubmit = async () => {
    if (!selectedType || !name.trim()) return
    setUploading(true)

    try {
      if (isEditMode && editingSource) {
        // Edit mode — update metadata + optionally re-import files
        const mapping = resolveMapping()
        const hasNewFiles = uploadedFiles.length > 0 || fsHandles.length > 0

        if (hasNewFiles) {
          // User selected new files — remove old source and create new one with same name
          await removeDataSource(editingSource.id)

          if (selectedType === 'database') {
            const connectionConfig: DatabaseConnectionConfig = {
              engine: dbEngine,
              ...(dbEngine !== 'duckdb' && dbEngine !== 'sqlite'
                ? {
                    host: dbHost,
                    port: dbPort ? Number(dbPort) : undefined,
                    database: dbDatabase,
                    schema: dbSchema || undefined,
                    username: dbUsername || undefined,
                    password: dbPassword || undefined,
                  }
                : {}),
            }
            const newId = await addDataSource({
              name: setLocalized({}, language, name.trim()),
              description: setLocalized({}, language, description.trim()),
              sourceType: 'database',
              connectionConfig,
              schemaMapping: mapping,
              files: fsHandles.length > 0 ? undefined : (uploadedFiles.length > 0 ? uploadedFiles : undefined),
              fileHandles: fsHandles.length > 0 ? fsHandles : undefined,
              alias: alias.trim() || undefined,
            })
            if (projectUid) useAppStore.getState().linkDataSource(projectUid, newId)
          }
        } else {
          // No new files — update metadata. Include the connection config for
          // non-file engines so host/port/credentials edits are actually saved.
          const changes: Partial<DataSource> = {
            name: setLocalized(editingSource.name, language, name.trim()),
            alias: alias.trim() || editingSource.alias,
            description: setLocalized(editingSource.description, language, description.trim()),
            schemaMapping: mapping,
            badges,
            version: version.trim() || '0.1.0',
          }
          const isExternal =
            selectedType === 'database' && dbEngine !== 'duckdb' && dbEngine !== 'sqlite'
          if (isExternal) {
            const connectionConfig: DatabaseConnectionConfig = {
              engine: dbEngine,
              host: dbHost,
              port: dbPort ? Number(dbPort) : undefined,
              database: dbDatabase,
              schema: dbSchema || undefined,
              username: dbUsername || undefined,
              // Only send a password when the user typed one — an empty field
              // leaves the stored (encrypted) credential untouched server-side.
              ...(dbPassword ? { password: dbPassword } : {}),
            }
            changes.connectionConfig = connectionConfig
          }
          await updateDataSource(editingSource.id, changes)

          // Re-validate the connection so a corrected host/credential updates
          // status + stats instead of keeping the stale "connected" state. The
          // re-test runs server-side against the freshly-saved config (using the
          // stored encrypted password when the field was left blank).
          if (isExternal && isServerMode()) {
            await retestDataSource(editingSource.id)
          }
        }

        handleClose(false, true)
        return
      }

      if (selectedType === 'database') {
        const connectionConfig: DatabaseConnectionConfig = {
          engine: dbEngine,
          ...(dbEngine !== 'duckdb' && dbEngine !== 'sqlite'
            ? {
                host: dbHost,
                port: dbPort ? Number(dbPort) : undefined,
                database: dbDatabase,
                schema: dbSchema || undefined,
                username: dbUsername || undefined,
                password: dbPassword || undefined,
              }
            : {}),
        }

        const mapping = resolveMapping()

        const newId = await addDataSource({
          name: setLocalized({}, language, name.trim()),
          description: setLocalized({}, language, description.trim()),
          sourceType: 'database',
          connectionConfig,
          schemaMapping: mapping,
          files: fsHandles.length > 0 ? undefined : (uploadedFiles.length > 0 ? uploadedFiles : undefined),
          fileHandles: fsHandles.length > 0 ? fsHandles : undefined,
          alias: alias.trim() || undefined,
          badges,
          version: version.trim() || '0.1.0',
        })
        if (projectUid) useAppStore.getState().linkDataSource(projectUid, newId)
      } else {
        // FHIR
        const connectionConfig: FhirConnectionConfig = {
          baseUrl: fhirBaseUrl,
        }

        const newId = await addDataSource({
          name: setLocalized({}, language, name.trim()),
          description: setLocalized({}, language, description.trim()),
          sourceType: 'fhir',
          connectionConfig,
          alias: alias.trim() || undefined,
          badges,
          version: version.trim() || '0.1.0',
        })
        if (projectUid) useAppStore.getState().linkDataSource(projectUid, newId)
      }

      // force close: the guard would otherwise still see uploading=true (the
      // state update above hasn't flushed into this closure yet).
      handleClose(false, true)
    } finally {
      setUploading(false)
    }
  }

  const isLocalEngine = dbEngine === 'duckdb' || dbEngine === 'sqlite'
  const isParquetMode = selectedType === 'database' && dbEngine === 'duckdb' && importMode === 'parquet'

  const getFileAccept = (): string => {
    if (selectedType === 'database') {
      if (isParquetMode) return '.parquet'
      if (dbEngine === 'duckdb') return '.duckdb'
      if (dbEngine === 'sqlite') return '.sqlite,.db'
    }
    return '*'
  }

  // A database created from a schema owns its storage (a managed server file, or
  // the browser's own DuckDB): there is no file to upload and no host to reach,
  // so editing it must not demand either.
  const isCreatedFromSchema =
    isEditMode &&
    !!(editingSource?.connectionConfig as DatabaseConnectionConfig | undefined)?.managed
  const needsFileUpload = selectedType === 'database' && isLocalEngine && !isCreatedFromSchema
  const isMultiFile = isParquetMode

  const totalFileSize = uploadedFiles.reduce((s, f) => s + f.size, 0)
  const hasFileHandles = fsHandles.length > 0
  // Browser-storage size limits only apply in front-only mode. In server mode
  // files stream to the backend in chunks — no IndexedDB, no size ceiling.
  const isSizeBlocked =
    !isServerMode() && totalFileSize > SIZE_DANGER_THRESHOLD && !hasFileHandles

  // In edit mode, files are optional (keeps existing if none uploaded)
  const hasExistingFiles = isEditMode && editingSource?.sourceType === 'database' && (() => {
    const config = editingSource.connectionConfig as DatabaseConnectionConfig
    return !!(config.fileId || (config.fileIds && config.fileIds.length > 0))
  })()

  // Skipped while submitting: addDataSource inserts the row into the store
  // before the slow part (upload / WASM mount) finishes and this dialog closes,
  // so the check would match the row we just created and report the name we are
  // importing under as already taken.
  const nameIsDuplicate = !uploading && name.trim()
    && dataSources.some(ds => localized(ds.name, language).toLowerCase() === name.trim().toLowerCase() && ds.id !== editingSource?.id)

  const isNameValid = !!name.trim() && !nameIsDuplicate
  const isConnectionValid =
    (!needsFileUpload || uploadedFiles.length > 0 || hasExistingFiles) &&
    (selectedType !== 'fhir' || !!fhirBaseUrl.trim()) &&
    !isSizeBlocked

  const canSubmit = isNameValid && isConnectionValid

  // Cmd/Ctrl+S submits the dialog, matching the save shortcut used across the app.
  // A ref holds the latest submit intent so the listener stays stable across renders.
  const submitRef = useRef<() => void>(() => {})
  submitRef.current = () => {
    if (canSubmit && !uploading) void handleSubmit()
  }
  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault()
        submitRef.current()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [open])

  // Per-tab list of what's still missing — drives the red dot on each tab and
  // the tooltip on the disabled Create button.
  const generalMissing: string[] = []
  if (!isNameValid) generalMissing.push(t('databases.missing_name'))
  const connectionMissing: string[] = []
  if (!isConnectionValid) connectionMissing.push(t('databases.missing_connection'))
  const allMissing = [...generalMissing, ...connectionMissing]

  // Resolve schema mapping: built-in, custom, or none
  const resolveMapping = () => {
    if (schemaPresetId === '__none__') return undefined
    const builtin = getSchemaPreset(schemaPresetId)
    if (builtin) return builtin
    const custom = customPresets.find((p) => p.presetId === schemaPresetId)
    return custom?.mapping
  }

  // Group uploaded parquet files by table for preview
  const schemaMapping = resolveMapping()
  const parquetTables = isParquetMode && uploadedFiles.length > 0
    ? [...new Set(uploadedFiles.map((f) => {
        const path = (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name
        return extractTableName(path, schemaMapping?.knownTables)
      }))]
    : []

  // Browsers never expose the absolute path (neither webkitRelativePath nor the
  // FS Access picker), so the deepest shared directory is the most we can show.
  const parquetFolderPath = isParquetMode && uploadedFiles.length > 0
    ? commonDirPrefix(uploadedFiles.map(
        (f) => (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name,
      ))
    : ''

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent
        className="sm:max-w-lg"
        showCloseButton={!uploading}
        onEscapeKeyDown={(e) => { if (uploading) e.preventDefault() }}
        onPointerDownOutside={(e) => { if (uploading) e.preventDefault() }}
        onInteractOutside={(e) => { if (uploading) e.preventDefault() }}
      >
        <DialogHeader>
          <DialogTitle>
            {isEditMode ? t('databases.edit_dialog_title') : t('databases.add_dialog_title')}
          </DialogTitle>
          <DialogDescription>
            {isEditMode
              ? t('databases.edit_dialog_description')
              : step === 1
                ? t('databases.add_dialog_step1')
                : t('databases.add_dialog_step2')}
          </DialogDescription>
        </DialogHeader>

        {step === 1 && (
          <div className="mt-2 space-y-2">
            {sourceTypes.map((st) => {
              const Icon = st.icon
              return (
                <button
                  key={st.type}
                  onClick={() => handleSelectType(st.type)}
                  disabled={st.disabled}
                  className="flex w-full items-center gap-3 rounded-lg border p-3 text-left transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent"
                >
                  <div
                    className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${st.color}`}
                  >
                    <Icon size={18} />
                  </div>
                  <div>
                    <p className="flex items-center gap-2 text-sm font-medium">
                      {t(st.labelKey)}
                      {st.disabled && (
                        <span className="text-[10px] font-normal text-muted-foreground">
                          {t('databases.coming_soon')}
                        </span>
                      )}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {t(st.descKey)}
                    </p>
                  </div>
                </button>
              )
            })}
          </div>
        )}

        {step === 2 && selectedType && (
          <div className="mt-2">
            <Tabs value={dbTab} onValueChange={(v) => setDbTab(v as DbTab)}>
              <TabsList className="w-full">
                <TabsTrigger value="general" className="flex-1 gap-1.5">
                  {t('databases.tab_general')}
                  {generalMissing.length > 0 && <span className="size-1.5 rounded-full bg-destructive" />}
                </TabsTrigger>
                <TabsTrigger value="connection" className="flex-1 gap-1.5">
                  {t('databases.tab_connection')}
                  {connectionMissing.length > 0 && <span className="size-1.5 rounded-full bg-destructive" />}
                </TabsTrigger>
                <TabsTrigger value="metadata" className="flex-1">
                  {t('common.tab_metadata')}
                </TabsTrigger>
              </TabsList>

              <TabsContent value="general" className="space-y-4 pt-3">
            {/* Common fields */}
            <div className="space-y-2">
              <Label>{t('databases.field_name')}<RequiredMark /></Label>
              <Input
                value={name}
                onChange={(e) => {
                  setName(e.target.value)
                  if (!aliasManuallyEdited) setAlias(generateAlias(e.target.value))
                }}
                placeholder={t('databases.field_name_placeholder')}
                autoFocus
              />
              {nameIsDuplicate && (
                <p className="text-xs text-destructive">{t('common.name_already_exists')}</p>
              )}
            </div>
            <div className="space-y-2">
              <div className="flex items-center gap-1.5">
                <Label className="flex items-center gap-1.5">
                  {t('databases.field_identifier')}
                  <FieldInfo text={t('databases.field_alias_hint')} />
                </Label>
                <TooltipProvider>
                  <Tooltip delayDuration={200}>
                    <TooltipTrigger asChild>
                      <span className="text-muted-foreground">
                        <Info size={12} />
                      </span>
                    </TooltipTrigger>
                    <TooltipContent side="right" className="max-w-xs text-xs">
                      {t('databases.identifier_info')}
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </div>
              {/* Fixed after creation: the alias is the DuckDB schema name
                  (`ds_<alias>`), so changing it would orphan every script and
                  saved query that addresses this database. */}
              <Input
                value={alias}
                onChange={(e) => {
                  setAlias(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_'))
                  setAliasManuallyEdited(true)
                }}
                placeholder="mimic_iv_raw"
                className="font-mono text-xs"
                readOnly={isEditMode}
                disabled={isEditMode}
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
              </TabsContent>

              <TabsContent value="connection" className="space-y-4 pt-3">
            {/* Database-specific fields */}
            {selectedType === 'database' && (
              <>
                <div className="space-y-2">
                  <Label>{t('databases.field_engine')}</Label>
                  <Select value={dbEngine} onValueChange={(v) => { setDbEngine(v as DatabaseEngine); setUploadedFiles([]) }}>
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {/* Only engines the current deployment mode can actually run:
                          front-only (WASM) → file engines; server → + external DBs.
                          Order: network DBs first (server mode), then file engines. */}
                      {isServerMode() && (
                        <>
                          <SelectItem value="postgresql">PostgreSQL</SelectItem>
                          <SelectItem value="mysql">MySQL</SelectItem>
                        </>
                      )}
                      <SelectItem value="duckdb">DuckDB</SelectItem>
                      <SelectItem value="sqlite">SQLite</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                {/* Schema preset */}
                <div className="space-y-2">
                  <Label>{t('databases.schema_preset')}</Label>
                  <Select value={schemaPresetId} onValueChange={(v) => setSchemaPresetId(v as SchemaPresetId)}>
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none__">
                        {t('databases.no_schema')}
                      </SelectItem>
                      {customPresets.map((cp) => (
                        <SelectItem key={cp.presetId} value={cp.presetId}>
                          {localized(cp.mapping.presetLabel, language)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                {isCreatedFromSchema ? (
                  <p className="rounded-md border bg-muted/30 px-3 py-2.5 text-xs text-muted-foreground">
                    {t('databases.created_from_schema_note')}
                  </p>
                ) : isLocalEngine ? (
                  <>
                    {/* Import mode toggle (only for DuckDB) */}
                    {dbEngine === 'duckdb' && (
                      <div className="space-y-2">
                        <Label>{t('databases.import_mode_label')}</Label>
                        <div className="flex gap-2">
                          <button
                            type="button"
                            onClick={() => { setImportMode('duckdb'); setUploadedFiles([]) }}
                            className={`flex flex-1 items-center gap-2 rounded-lg border p-2.5 text-left text-xs transition-colors ${
                              importMode === 'duckdb'
                                ? 'border-primary bg-primary/5 text-primary'
                                : 'hover:bg-accent'
                            }`}
                          >
                            <HardDrive size={14} />
                            {t('databases.import_mode_duckdb')}
                          </button>
                          <button
                            type="button"
                            onClick={() => { setImportMode('parquet'); setUploadedFiles([]) }}
                            className={`flex flex-1 items-center gap-2 rounded-lg border p-2.5 text-left text-xs transition-colors ${
                              importMode === 'parquet'
                                ? 'border-primary bg-primary/5 text-primary'
                                : 'hover:bg-accent'
                            }`}
                          >
                            <FolderOpen size={14} />
                            {t('databases.import_mode_parquet')}
                          </button>
                        </div>
                      </div>
                    )}

                    {/* Current files info (edit mode) */}
                    {isEditMode && editingSource && uploadedFiles.length === 0 && (
                      <CurrentFilesInfo source={editingSource} t={t} />
                    )}

                    {isParquetMode ? (
                      <FolderUploadArea
                        files={uploadedFiles}
                        tables={parquetTables}
                        folderPath={parquetFolderPath}
                        inputRef={fileInputRef}
                        onFilesSelected={handleFilesSelected}
                        onFolderEntries={(entries) => {
                          setUploadedFiles(entries.map((e) => e.file))
                          // FS Access zero-copy handles are a front-only optimization
                          // (data stays in the browser). In server mode the bytes are
                          // uploaded, so we don't keep handles.
                          if (!isServerMode()) {
                            setFsHandles(entries.map((e) => ({
                              fileName: e.relativePath,
                              handle: e.handle,
                              fileSize: e.file.size,
                            })))
                          }
                        }}
                        onClear={() => { setUploadedFiles([]); setFsHandles([]) }}
                        t={t}
                      />
                    ) : (
                      <FileUploadArea
                        files={uploadedFiles}
                        accept={getFileAccept()}
                        multiple={isMultiFile}
                        inputRef={fileInputRef}
                        onFilesSelected={handleFilesSelected}
                        onRemoveFile={handleRemoveFile}
                        t={t}
                      />
                    )}
                  </>
                ) : (
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-2">
                      <Label>{t('databases.field_host')}</Label>
                      <Input value={dbHost} onChange={(e) => setDbHost(e.target.value)} placeholder="localhost" />
                    </div>
                    <div className="space-y-2">
                      <Label>{t('databases.field_port')}</Label>
                      <Input value={dbPort} onChange={(e) => setDbPort(e.target.value)} placeholder="5432" />
                    </div>
                    <div className="space-y-2">
                      <Label>{t('databases.field_database')}</Label>
                      <Input value={dbDatabase} onChange={(e) => setDbDatabase(e.target.value)} />
                    </div>
                    <div className="space-y-2">
                      <Label>{t('databases.field_schema')}</Label>
                      <Input value={dbSchema} onChange={(e) => setDbSchema(e.target.value)} placeholder="public" />
                    </div>
                    <div className="space-y-2">
                      <Label>{t('databases.field_username')}</Label>
                      <Input value={dbUsername} onChange={(e) => setDbUsername(e.target.value)} />
                    </div>
                    <div className="space-y-2">
                      <Label>{t('databases.field_password')}</Label>
                      <PasswordInput value={dbPassword} onChange={(e) => setDbPassword(e.target.value)} />
                    </div>
                  </div>
                )}
              </>
            )}

            {/* FHIR-specific fields */}
            {selectedType === 'fhir' && (
              <div className="space-y-2">
                <Label>{t('databases.field_base_url')}<RequiredMark /></Label>
                <Input
                  value={fhirBaseUrl}
                  onChange={(e) => setFhirBaseUrl(e.target.value)}
                  placeholder="https://fhir.example.com/r4"
                />
              </div>
            )}
              </TabsContent>

              <TabsContent value="metadata" className="space-y-4 pt-3">
                <BadgeEditor
                  categories={badgeCategories}
                  value={badges}
                  onChange={setBadges}
                  suggestions={badgeSuggestions}
                />
                <VersionField value={version} onChange={setVersion} />
              </TabsContent>
            </Tabs>
          </div>
        )}

        {step === 2 && (
          <DialogFooter className="mt-4">
            {!isEditMode && (
              <Button variant="outline" onClick={() => setStep(1)} disabled={uploading} className="gap-1.5">
                <ArrowLeft size={12} />
                {t('common.back')}
              </Button>
            )}
            {canSubmit || uploading ? (
              <Button onClick={handleSubmit} disabled={!canSubmit || uploading} className="gap-1.5">
                {uploading && <Loader2 size={14} className="animate-spin" />}
                {uploading
                  ? t('databases.uploading')
                  : isEditMode
                    ? t('common.save')
                    : t('common.create')}
              </Button>
            ) : (
              <TooltipProvider>
                <Tooltip delayDuration={150}>
                  <TooltipTrigger asChild>
                    {/* span wrapper: a disabled button doesn't emit the hover events the tooltip needs */}
                    <span tabIndex={0}>
                      <Button disabled className="pointer-events-none gap-1.5">
                        {isEditMode ? t('common.save') : t('common.create')}
                      </Button>
                    </span>
                  </TooltipTrigger>
                  <TooltipContent side="top" className="max-w-xs">
                    <p className="mb-1 font-medium">{t('databases.missing_fields_title')}</p>
                    <ul className="list-disc space-y-0.5 pl-4">
                      {allMissing.map((m) => (
                        <li key={m}>{m}</li>
                      ))}
                    </ul>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            )}
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  )
}

/** Shows info about currently imported files in edit mode. */
function CurrentFilesInfo({
  source,
  t,
}: {
  source: DataSource
  t: (key: string, opts?: Record<string, unknown>) => string
}) {
  const config = source.connectionConfig as DatabaseConnectionConfig
  const isZeroCopy = !!config.useFileHandles
  const fileCount = config.fileNames?.length ?? (config.fileId ? 1 : 0)
  const isParquet = !!(config.fileIds && config.fileIds.length > 0)

  if (fileCount === 0) return null

  return (
    <div className="rounded-lg border bg-muted/30 px-4 py-3 space-y-1.5">
      <div className="flex items-center gap-2 text-xs">
        {isParquet ? (
          <FolderOpen size={14} className="shrink-0 text-muted-foreground" />
        ) : (
          <HardDrive size={14} className="shrink-0 text-muted-foreground" />
        )}
        <span className="font-medium">
          {t('databases.current_files', { count: fileCount })}
        </span>
        <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium ${
          isServerMode()
            ? 'bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-400'
            : isZeroCopy
              ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400'
              : 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400'
        }`}>
          {isServerMode()
            ? t('databases.storage_server')
            : isZeroCopy
              ? t('databases.storage_link')
              : t('databases.storage_copy')}
        </span>
      </div>
      {config.fileNames && config.fileNames.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {config.fileNames.slice(0, 8).map((name) => (
            <span key={name} className="truncate max-w-[180px] text-[10px] text-muted-foreground font-mono">
              {name.split('/').pop()}
            </span>
          ))}
          {config.fileNames.length > 8 && (
            <span className="text-[10px] text-muted-foreground">
              +{config.fileNames.length - 8}
            </span>
          )}
        </div>
      )}
      <p className="text-[10px] text-muted-foreground">
        {t('databases.current_files_hint')}
      </p>
    </div>
  )
}

/** Reusable file upload area with drop zone and file list. */
function FileUploadArea({
  files,
  accept,
  multiple,
  inputRef,
  onFilesSelected,
  onRemoveFile,
  t,
}: {
  files: File[]
  accept: string
  multiple: boolean
  inputRef: React.RefObject<HTMLInputElement | null>
  onFilesSelected: (e: React.ChangeEvent<HTMLInputElement>) => void
  onRemoveFile: (index: number) => void
  t: (key: string) => string
}) {
  return (
    <div className="space-y-2">
      <Label>{multiple ? t('databases.upload_files') : t('databases.upload_file')}<RequiredMark /></Label>
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        className="flex w-full cursor-pointer flex-col items-center gap-2 rounded-lg border-2 border-dashed border-muted-foreground/25 bg-muted/30 px-4 py-6 transition-colors hover:border-muted-foreground/40 hover:bg-muted/50"
      >
        <Upload size={20} className="text-muted-foreground" />
        <p className="text-xs text-muted-foreground">
          {t('databases.upload_drop_hint')}
        </p>
        <p className="text-[11px] text-muted-foreground/60">
          {accept}
        </p>
      </button>
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        multiple={multiple}
        onChange={onFilesSelected}
        className="hidden"
      />
      {files.length > 0 && (
        <div className="space-y-1.5">
          {files.map((file, i) => (
            <div
              key={`${file.name}-${i}`}
              className="flex items-center gap-2 rounded-md bg-muted/50 px-3 py-2"
            >
              <FileIcon size={14} className="shrink-0 text-muted-foreground" />
              <span className="flex-1 truncate text-xs">{file.name}</span>
              <span className="shrink-0 text-[11px] text-muted-foreground">
                {formatFileSize(file.size)}
              </span>
              <button
                type="button"
                onClick={() => onRemoveFile(i)}
                className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground"
              >
                <X size={12} />
              </button>
            </div>
          ))}
        </div>
      )}
      <FileSizeWarning totalBytes={files.reduce((s, f) => s + f.size, 0)} hasHandles={false} t={t} />
    </div>
  )
}

interface ParquetFileEntry {
  file: File
  handle: FileSystemFileHandle
  relativePath: string
}

/** Read all .parquet files from a directory handle recursively, preserving handles. */
async function readParquetFiles(dirHandle: FileSystemDirectoryHandle, prefix = ''): Promise<ParquetFileEntry[]> {
  const entries: ParquetFileEntry[] = []
  const dirPath = prefix ? `${prefix}/${dirHandle.name}` : dirHandle.name
  for await (const entry of dirHandle.values()) {
    if (entry.kind === 'file' && entry.name.toLowerCase().endsWith('.parquet')) {
      const file = await (entry as FileSystemFileHandle).getFile()
      const relativePath = `${dirPath}/${file.name}`
      Object.defineProperty(file, 'webkitRelativePath', {
        value: relativePath,
        writable: false,
      })
      entries.push({ file, handle: entry as FileSystemFileHandle, relativePath })
    } else if (entry.kind === 'directory') {
      const subEntries = await readParquetFiles(entry as FileSystemDirectoryHandle, dirPath)
      entries.push(...subEntries)
    }
  }
  return entries
}

/** Folder upload area for Parquet imports with table summary. */
function FolderUploadArea({
  files,
  tables,
  folderPath,
  inputRef,
  onFilesSelected,
  onFolderEntries,
  onClear,
  t,
}: {
  files: File[]
  tables: string[]
  folderPath: string
  inputRef: React.RefObject<HTMLInputElement | null>
  onFilesSelected: (e: React.ChangeEvent<HTMLInputElement>) => void
  onFolderEntries: (entries: ParquetFileEntry[]) => void
  onClear: () => void
  t: (key: string, opts?: Record<string, unknown>) => string
}) {
  // In server mode the FS Access picker gives us nothing useful (bytes are
  // uploaded, not kept as handles) and it shows a scary "send all files"
  // permission prompt — so use the plain folder input to read real File bytes.
  const supportsDirectoryPicker = typeof window.showDirectoryPicker === 'function' && !isServerMode()

  const handlePickFolder = async () => {
    if (supportsDirectoryPicker) {
      try {
        const dirHandle = await window.showDirectoryPicker!()
        const entries = await readParquetFiles(dirHandle)
        if (entries.length > 0) {
          onFolderEntries(entries)
        }
      } catch {
        // User cancelled the picker
      }
    } else {
      // Fallback to webkitdirectory input (also the server-mode path)
      inputRef.current?.click()
    }
  }

  return (
    <div className="space-y-2">
      <Label>{t('databases.select_folder')}<RequiredMark /></Label>
      {files.length === 0 ? (
        <button
          type="button"
          onClick={handlePickFolder}
          className="flex w-full cursor-pointer flex-col items-center gap-2 rounded-lg border-2 border-dashed border-muted-foreground/25 bg-muted/30 px-4 py-6 transition-colors hover:border-muted-foreground/40 hover:bg-muted/50"
        >
          <FolderOpen size={20} className="text-muted-foreground" />
          <p className="text-xs text-muted-foreground">
            {t('databases.select_folder_hint')}
          </p>
        </button>
      ) : (
        <div className="rounded-lg border bg-muted/30 px-4 py-3">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0 flex-1">
              {folderPath && (
                <div className="flex items-center gap-2">
                  <FolderOpen size={14} className="shrink-0 text-muted-foreground" />
                  {/* Native title: the browser only surfaces it when the name is
                      actually clipped, so no tooltip on short folder names. */}
                  <span className="truncate text-xs font-medium" title={folderPath}>
                    {folderPath}
                  </span>
                </div>
              )}
              <div className="mt-1 text-[11px] text-muted-foreground">
                {t('databases.parquet_tables_found', { count: tables.length })}
                {' · '}
                {files.length} files, {formatFileSize(files.reduce((s, f) => s + f.size, 0))}
              </div>
            </div>
            <button
              type="button"
              onClick={onClear}
              className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground"
            >
              <X size={12} />
            </button>
          </div>
          {tables.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {tables.sort().map((table) => (
                <span
                  key={table}
                  className="inline-flex rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary"
                >
                  {table}
                </span>
              ))}
            </div>
          )}
        </div>
      )}
      <FileSizeWarning totalBytes={files.reduce((s, f) => s + f.size, 0)} hasHandles={supportsDirectoryPicker} t={t} />
      {/* Hidden input with webkitdirectory — fallback for browsers without showDirectoryPicker */}
      {!supportsDirectoryPicker && (
        <input
          ref={inputRef}
          type="file"
          // @ts-expect-error webkitdirectory is non-standard but widely supported
          webkitdirectory=""
          onChange={onFilesSelected}
          className="hidden"
        />
      )}
    </div>
  )
}

/** Displays a warning when files are large — stored in browser, can be slow. */
function FileSizeWarning({
  totalBytes,
  hasHandles,
  t,
}: {
  totalBytes: number
  /** True when File System Access handles are available (zero-copy). */
  hasHandles: boolean
  t: (key: string, opts?: Record<string, unknown>) => string
}) {
  // Server mode uploads to the backend in chunks — no browser-storage limit,
  // so the size warning doesn't apply.
  if (isServerMode()) return null

  if (totalBytes < SIZE_WARNING_THRESHOLD) return null

  // With FS Access handles, large files are fine — show a green info instead
  if (hasHandles) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-emerald-400/30 bg-emerald-50 px-3 py-2 text-xs text-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-300">
        <FolderOpen size={14} className="shrink-0" />
        <span>{t('databases.import_mode_direct')}</span>
      </div>
    )
  }

  const isDanger = totalBytes >= SIZE_DANGER_THRESHOLD

  return (
    <div
      className={`flex items-start gap-2 rounded-lg border px-3 py-2.5 text-xs ${
        isDanger
          ? 'border-destructive/30 bg-destructive/5 text-destructive'
          : 'border-amber-400/30 bg-amber-50 text-amber-800 dark:bg-amber-950/30 dark:text-amber-300'
      }`}
    >
      <AlertTriangle size={14} className="mt-0.5 shrink-0" />
      <div>
        <p className="font-medium">
          {isDanger
            ? t('databases.size_warning_danger', { size: formatFileSize(totalBytes) })
            : t('databases.size_warning', { size: formatFileSize(totalBytes) })}
        </p>
        <p className="mt-0.5 opacity-80">
          {isDanger
            ? t('databases.size_warning_blocked')
            : t('databases.size_warning_hint')}
        </p>
      </div>
    </div>
  )
}
