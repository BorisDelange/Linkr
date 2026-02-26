import { useState, useRef, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useParams } from 'react-router'
import { useDataSourceStore } from '@/stores/data-source-store'
import { useAppStore } from '@/stores/app-store'
import { extractTableName, generateAlias } from '@/lib/duckdb/engine'
import { getSchemaPreset, BUILTIN_PRESET_IDS, SCHEMA_PRESETS } from '@/lib/schema-presets'
import { getStorage } from '@/lib/storage'
import type {
  DataSource,
  DataSourceType,
  FhirConnectionConfig,
  DatabaseConnectionConfig,
  DatabaseEngine,
  SchemaPresetId,
  CustomSchemaPreset,
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
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

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
  const { wsUid } = useParams<{ wsUid: string }>()
  const { addDataSource, updateDataSource, removeDataSource, dataSources } = useDataSourceStore()
  const [step, setStep] = useState<1 | 2>(1)
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
      setName(editingSource.name)
      setAlias(editingSource.alias ?? '')
      setAliasManuallyEdited(true)
      setDescription(editingSource.description)
      setSelectedType(editingSource.sourceType)
      setStep(2)
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
  const [schemaPresetId, setSchemaPresetId] = useState<SchemaPresetId>('omop-5.4')

  // File upload
  const [uploadedFiles, setUploadedFiles] = useState<File[]>([])
  /** File System Access API handles — stored alongside File objects for zero-copy. */
  const [fsHandles, setFsHandles] = useState<{ fileName: string; handle: FileSystemFileHandle; fileSize: number }[]>([])
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Database fields
  const [dbEngine, setDbEngine] = useState<DatabaseEngine>('duckdb')
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
    setSelectedType(null)
    setUploading(false)
    setName('')
    setAlias('')
    setAliasManuallyEdited(false)
    setDescription('')
    setUploadedFiles([])
    setFsHandles([])
    setImportMode('duckdb')
    setSchemaPresetId('omop-5.4')
    setDbEngine('duckdb')
    setDbHost('')
    setDbPort('')
    setDbDatabase('')
    setDbSchema('')
    setDbUsername('')
    setDbPassword('')
    setFhirBaseUrl('')
  }

  const handleClose = (open: boolean) => {
    if (!open) reset()
    onOpenChange(open)
  }

  const handleSelectType = (type: DataSourceType) => {
    setSelectedType(type)
    setStep(2)
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
              name: name.trim(),
              description: description.trim(),
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
          // No new files — update metadata only
          updateDataSource(editingSource.id, {
            name: name.trim(),
            alias: alias.trim() || editingSource.alias,
            description: description.trim(),
            schemaMapping: mapping,
          })
        }

        handleClose(false)
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
          name: name.trim(),
          description: description.trim(),
          sourceType: 'database',
          connectionConfig,
          schemaMapping: mapping,
          files: fsHandles.length > 0 ? undefined : (uploadedFiles.length > 0 ? uploadedFiles : undefined),
          fileHandles: fsHandles.length > 0 ? fsHandles : undefined,
          alias: alias.trim() || undefined,
        })
        if (projectUid) useAppStore.getState().linkDataSource(projectUid, newId)
      } else {
        // FHIR
        const connectionConfig: FhirConnectionConfig = {
          baseUrl: fhirBaseUrl,
        }

        const newId = await addDataSource({
          name: name.trim(),
          description: description.trim(),
          sourceType: 'fhir',
          connectionConfig,
          alias: alias.trim() || undefined,
        })
        if (projectUid) useAppStore.getState().linkDataSource(projectUid, newId)
      }

      handleClose(false)
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

  const needsFileUpload = selectedType === 'database' && isLocalEngine
  const isMultiFile = isParquetMode

  const totalFileSize = uploadedFiles.reduce((s, f) => s + f.size, 0)
  const hasFileHandles = fsHandles.length > 0
  const isSizeBlocked = totalFileSize > SIZE_DANGER_THRESHOLD && !hasFileHandles

  // In edit mode, files are optional (keeps existing if none uploaded)
  const hasExistingFiles = isEditMode && editingSource?.sourceType === 'database' && (() => {
    const config = editingSource.connectionConfig as DatabaseConnectionConfig
    return !!(config.fileId || (config.fileIds && config.fileIds.length > 0))
  })()

  const nameIsDuplicate = name.trim() && dataSources.some(ds => ds.name.toLowerCase() === name.trim().toLowerCase() && ds.id !== editingSource?.id)

  const canSubmit = name.trim() &&
    !nameIsDuplicate &&
    (!needsFileUpload || uploadedFiles.length > 0 || hasExistingFiles) &&
    (selectedType !== 'fhir' || fhirBaseUrl.trim()) &&
    !isSizeBlocked

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

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-lg">
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
                  className="flex w-full items-center gap-3 rounded-lg border p-3 text-left transition-colors hover:bg-accent"
                >
                  <div
                    className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${st.color}`}
                  >
                    <Icon size={18} />
                  </div>
                  <div>
                    <p className="text-sm font-medium">{t(st.labelKey)}</p>
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
          <div className="mt-2 space-y-4">
            {/* Common fields */}
            <div className="space-y-2">
              <Label>{t('databases.field_name')}</Label>
              <Input
                value={name}
                onChange={(e) => {
                  setName(e.target.value)
                  if (!aliasManuallyEdited) setAlias(generateAlias(e.target.value))
                }}
                placeholder={t('databases.field_name_placeholder')}
                autoFocus
              />
              {name.trim() && dataSources.some(ds => ds.name.toLowerCase() === name.trim().toLowerCase() && ds.id !== editingSource?.id) && (
                <p className="text-xs text-destructive">{t('common.name_already_exists')}</p>
              )}
            </div>
            <div className="space-y-2">
              <Label>{t('databases.field_alias')}</Label>
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
              <Textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder={t('databases.field_description_placeholder')}
                rows={2}
              />
            </div>

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
                      <SelectGroup>
                        <SelectLabel>{t('databases.engine_group_local')}</SelectLabel>
                        <SelectItem value="duckdb">DuckDB</SelectItem>
                        <SelectItem value="sqlite">SQLite</SelectItem>
                      </SelectGroup>
                      <SelectGroup>
                        <SelectLabel>{t('databases.engine_group_server')}</SelectLabel>
                        <SelectItem value="postgresql" disabled>
                          <span className="flex items-center gap-2">
                            PostgreSQL
                            <span className="text-[10px] text-muted-foreground">{t('databases.engine_requires_server')}</span>
                          </span>
                        </SelectItem>
                        <SelectItem value="mysql" disabled>
                          <span className="flex items-center gap-2">
                            MySQL
                            <span className="text-[10px] text-muted-foreground">{t('databases.engine_requires_server')}</span>
                          </span>
                        </SelectItem>
                        <SelectItem value="sqlserver" disabled>
                          <span className="flex items-center gap-2">
                            SQL Server
                            <span className="text-[10px] text-muted-foreground">{t('databases.engine_via_odbc')}</span>
                          </span>
                        </SelectItem>
                        <SelectItem value="oracle" disabled>
                          <span className="flex items-center gap-2">
                            Oracle
                            <span className="text-[10px] text-muted-foreground">{t('databases.engine_via_odbc')}</span>
                          </span>
                        </SelectItem>
                      </SelectGroup>
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
                      {BUILTIN_PRESET_IDS.map((id) => {
                        const preset = SCHEMA_PRESETS[id]
                        if (!preset) return null
                        return (
                          <SelectItem key={id} value={id}>
                            {preset.presetLabel}
                          </SelectItem>
                        )
                      })}
                      {customPresets.map((cp) => (
                        <SelectItem key={cp.presetId} value={cp.presetId}>
                          {cp.mapping.presetLabel}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                {isLocalEngine ? (
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
                        inputRef={fileInputRef}
                        onFilesSelected={handleFilesSelected}
                        onFolderEntries={(entries) => {
                          setUploadedFiles(entries.map((e) => e.file))
                          setFsHandles(entries.map((e) => ({
                            fileName: e.relativePath,
                            handle: e.handle,
                            fileSize: e.file.size,
                          })))
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
                      <Input type="password" value={dbPassword} onChange={(e) => setDbPassword(e.target.value)} />
                    </div>
                  </div>
                )}
              </>
            )}

            {/* FHIR-specific fields */}
            {selectedType === 'fhir' && (
              <div className="space-y-2">
                <Label>{t('databases.field_base_url')}</Label>
                <Input
                  value={fhirBaseUrl}
                  onChange={(e) => setFhirBaseUrl(e.target.value)}
                  placeholder="https://fhir.example.com/r4"
                />
              </div>
            )}
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
            <Button onClick={handleSubmit} disabled={!canSubmit || uploading} className="gap-1.5">
              {uploading && <Loader2 size={14} className="animate-spin" />}
              {uploading
                ? t('databases.uploading')
                : isEditMode
                  ? t('common.save')
                  : t('common.create')}
            </Button>
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
          isZeroCopy
            ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400'
            : 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400'
        }`}>
          {isZeroCopy ? t('databases.storage_link') : t('databases.storage_copy')}
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
      <Label>{multiple ? t('databases.upload_files') : t('databases.upload_file')}</Label>
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
  inputRef,
  onFilesSelected,
  onFolderEntries,
  onClear,
  t,
}: {
  files: File[]
  tables: string[]
  inputRef: React.RefObject<HTMLInputElement | null>
  onFilesSelected: (e: React.ChangeEvent<HTMLInputElement>) => void
  onFolderEntries: (entries: ParquetFileEntry[]) => void
  onClear: () => void
  t: (key: string, opts?: Record<string, unknown>) => string
}) {
  const supportsDirectoryPicker = typeof window.showDirectoryPicker === 'function'

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
      // Fallback to webkitdirectory input
      inputRef.current?.click()
    }
  }

  return (
    <div className="space-y-2">
      <Label>{t('databases.select_folder')}</Label>
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
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <FolderOpen size={14} className="text-muted-foreground" />
              <span className="text-xs font-medium">
                {t('databases.parquet_tables_found', { count: tables.length })}
              </span>
              <span className="text-[11px] text-muted-foreground">
                ({files.length} files, {formatFileSize(files.reduce((s, f) => s + f.size, 0))})
              </span>
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
