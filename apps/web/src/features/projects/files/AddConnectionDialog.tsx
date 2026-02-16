import { useState, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import {
  ArrowLeft,
  Upload,
  File as FileIcon,
  X,
  Loader2,
  HardDrive,
  FolderOpen,
  AlertTriangle,
} from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useConnectionStore } from '@/stores/connection-store'
import type { DatabaseEngine } from '@/types'

interface AddConnectionDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  projectUid: string
}

const SIZE_WARNING_THRESHOLD = 500_000_000 // 500 MB
const SIZE_DANGER_THRESHOLD = 2_000_000_000 // 2 GB

function formatFileSize(bytes: number): string {
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(1)} GB`
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`
  if (bytes >= 1_000) return `${(bytes / 1_000).toFixed(1)} KB`
  return `${bytes} B`
}

export function AddConnectionDialog({ open, onOpenChange, projectUid }: AddConnectionDialogProps) {
  const { t } = useTranslation()
  const { addCustomConnection } = useConnectionStore()

  // Form state
  const [name, setName] = useState('')
  const [engine, setEngine] = useState<DatabaseEngine>('duckdb')
  const [importMode, setImportMode] = useState<'duckdb' | 'parquet'>('duckdb')
  const [uploading, setUploading] = useState(false)

  // File upload
  const [uploadedFiles, setUploadedFiles] = useState<File[]>([])
  const [fsHandles, setFsHandles] = useState<{ fileName: string; handle: FileSystemFileHandle; fileSize: number }[]>([])
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Remote connection fields
  const [dbHost, setDbHost] = useState('')
  const [dbPort, setDbPort] = useState('')
  const [dbDatabase, setDbDatabase] = useState('')
  const [dbSchema, setDbSchema] = useState('')
  const [dbUsername, setDbUsername] = useState('')
  const [dbPassword, setDbPassword] = useState('')

  const isLocalEngine = engine === 'duckdb' || engine === 'sqlite'
  const isParquetMode = engine === 'duckdb' && importMode === 'parquet'

  const reset = () => {
    setName('')
    setEngine('duckdb')
    setImportMode('duckdb')
    setUploading(false)
    setUploadedFiles([])
    setFsHandles([])
    setDbHost('')
    setDbPort('')
    setDbDatabase('')
    setDbSchema('')
    setDbUsername('')
    setDbPassword('')
  }

  const handleClose = (open: boolean) => {
    if (!open) reset()
    onOpenChange(open)
  }

  const handleEngineChange = (value: string) => {
    setEngine(value as DatabaseEngine)
    setUploadedFiles([])
    setFsHandles([])
    setImportMode('duckdb')
  }

  const handleFilesSelected = (e: React.ChangeEvent<HTMLInputElement>) => {
    let files = Array.from(e.target.files ?? [])
    if (isParquetMode) {
      files = files.filter((f) => f.name.toLowerCase().endsWith('.parquet'))
    }
    if (files.length > 0) {
      setUploadedFiles((prev) => [...prev, ...files])
      // Auto-fill name from first file if empty
      if (!name && files.length > 0) {
        const baseName = files[0].name.replace(/\.[^.]+$/, '')
        setName(baseName)
      }
    }
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  const handleRemoveFile = (index: number) => {
    setUploadedFiles((prev) => prev.filter((_, i) => i !== index))
  }

  const getFileAccept = (): string => {
    if (isParquetMode) return '.parquet'
    if (engine === 'duckdb') return '.duckdb'
    if (engine === 'sqlite') return '.sqlite,.db'
    return '*'
  }

  const totalFileSize = uploadedFiles.reduce((s, f) => s + f.size, 0)
  const hasFileHandles = fsHandles.length > 0
  const isSizeBlocked = totalFileSize > SIZE_DANGER_THRESHOLD && !hasFileHandles

  const canSubmit =
    name.trim() &&
    !isSizeBlocked &&
    (isLocalEngine
      ? uploadedFiles.length > 0
      : dbHost.trim())

  const handleSubmit = async () => {
    if (!canSubmit) return
    setUploading(true)

    try {
      if (isLocalEngine) {
        await addCustomConnection({
          projectUid,
          name: name.trim(),
          engine,
          files: fsHandles.length > 0 ? undefined : (uploadedFiles.length > 0 ? uploadedFiles : undefined),
          fileHandles: fsHandles.length > 0 ? fsHandles : undefined,
        })
      } else {
        await addCustomConnection({
          projectUid,
          name: name.trim(),
          engine,
          remoteConfig: {
            host: dbHost.trim(),
            port: dbPort ? Number(dbPort) : undefined,
            database: dbDatabase.trim() || undefined,
            schema: dbSchema.trim() || undefined,
            username: dbUsername.trim() || undefined,
            password: dbPassword || undefined,
          },
        })
      }
      handleClose(false)
    } catch (err) {
      console.error('Failed to add connection:', err)
    } finally {
      setUploading(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('connections.add_connection')}</DialogTitle>
          <DialogDescription>
            {t('connections.add_description')}
          </DialogDescription>
        </DialogHeader>

        <div className="mt-2 space-y-4">
          {/* Connection name */}
          <div className="space-y-2">
            <Label>{t('connections.field_name')}</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('connections.name_placeholder')}
              autoFocus
            />
          </div>

          {/* Engine selector */}
          <div className="space-y-2">
            <Label>{t('connections.field_engine')}</Label>
            <Select value={engine} onValueChange={handleEngineChange}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="duckdb">DuckDB</SelectItem>
                <SelectItem value="sqlite">SQLite</SelectItem>
                <SelectItem value="postgresql">PostgreSQL</SelectItem>
                <SelectItem value="mysql">MySQL</SelectItem>
                <SelectItem value="sqlserver">SQL Server</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Local engine: file upload */}
          {isLocalEngine && (
            <>
              {/* Import mode toggle (DuckDB only) */}
              {engine === 'duckdb' && (
                <div className="space-y-2">
                  <Label>{t('connections.import_mode_label')}</Label>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => { setImportMode('duckdb'); setUploadedFiles([]); setFsHandles([]) }}
                      className={`flex flex-1 items-center gap-2 rounded-lg border p-2.5 text-left text-xs transition-colors ${
                        importMode === 'duckdb'
                          ? 'border-primary bg-primary/5 text-primary'
                          : 'hover:bg-accent'
                      }`}
                    >
                      <HardDrive size={14} />
                      {t('connections.import_mode_duckdb')}
                    </button>
                    <button
                      type="button"
                      onClick={() => { setImportMode('parquet'); setUploadedFiles([]); setFsHandles([]) }}
                      className={`flex flex-1 items-center gap-2 rounded-lg border p-2.5 text-left text-xs transition-colors ${
                        importMode === 'parquet'
                          ? 'border-primary bg-primary/5 text-primary'
                          : 'hover:bg-accent'
                      }`}
                    >
                      <FolderOpen size={14} />
                      {t('connections.import_mode_parquet')}
                    </button>
                  </div>
                </div>
              )}

              {isParquetMode ? (
                <FolderUploadArea
                  files={uploadedFiles}
                  inputRef={fileInputRef}
                  onFilesSelected={handleFilesSelected}
                  onFolderEntries={(entries) => {
                    setUploadedFiles(entries.map((e) => e.file))
                    setFsHandles(entries.map((e) => ({
                      fileName: e.relativePath,
                      handle: e.handle,
                      fileSize: e.file.size,
                    })))
                    // Auto-fill name
                    if (!name && entries.length > 0) {
                      const dirName = entries[0].relativePath.split('/')[0] || 'parquet-data'
                      setName(dirName)
                    }
                  }}
                  onClear={() => { setUploadedFiles([]); setFsHandles([]) }}
                  t={t}
                />
              ) : (
                <FileUploadArea
                  files={uploadedFiles}
                  accept={getFileAccept()}
                  multiple={isParquetMode}
                  inputRef={fileInputRef}
                  onFilesSelected={handleFilesSelected}
                  onRemoveFile={handleRemoveFile}
                  t={t}
                />
              )}
            </>
          )}

          {/* Remote engine: host/port/credentials */}
          {!isLocalEngine && (
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label>{t('connections.field_host')}</Label>
                <Input value={dbHost} onChange={(e) => setDbHost(e.target.value)} placeholder="localhost" />
              </div>
              <div className="space-y-2">
                <Label>{t('connections.field_port')}</Label>
                <Input
                  value={dbPort}
                  onChange={(e) => setDbPort(e.target.value)}
                  placeholder={engine === 'postgresql' ? '5432' : engine === 'mysql' ? '3306' : '1433'}
                />
              </div>
              <div className="space-y-2">
                <Label>{t('connections.field_database')}</Label>
                <Input value={dbDatabase} onChange={(e) => setDbDatabase(e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label>{t('connections.field_schema')}</Label>
                <Input value={dbSchema} onChange={(e) => setDbSchema(e.target.value)} placeholder="public" />
              </div>
              <div className="space-y-2">
                <Label>{t('connections.field_username')}</Label>
                <Input value={dbUsername} onChange={(e) => setDbUsername(e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label>{t('connections.field_password')}</Label>
                <Input type="password" value={dbPassword} onChange={(e) => setDbPassword(e.target.value)} />
              </div>
            </div>
          )}
        </div>

        <DialogFooter className="mt-4">
          <Button variant="outline" onClick={() => handleClose(false)} disabled={uploading}>
            {t('common.cancel')}
          </Button>
          <Button onClick={handleSubmit} disabled={!canSubmit || uploading} className="gap-1.5">
            {uploading && <Loader2 size={14} className="animate-spin" />}
            {uploading ? t('connections.adding') : t('connections.add_connection')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/* ─────────── File Upload Area ─────────── */

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
      <Label>{multiple ? t('connections.upload_files') : t('connections.upload_file')}</Label>
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        className="flex w-full cursor-pointer flex-col items-center gap-2 rounded-lg border-2 border-dashed border-muted-foreground/25 bg-muted/30 px-4 py-6 transition-colors hover:border-muted-foreground/40 hover:bg-muted/50"
      >
        <Upload size={20} className="text-muted-foreground" />
        <p className="text-xs text-muted-foreground">
          {t('connections.upload_drop_hint')}
        </p>
        <p className="text-[11px] text-muted-foreground/60">{accept}</p>
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

/* ─────────── Folder Upload Area (Parquet) ─────────── */

interface ParquetFileEntry {
  file: File
  handle: FileSystemFileHandle
  relativePath: string
}

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

function FolderUploadArea({
  files,
  inputRef,
  onFilesSelected,
  onFolderEntries,
  onClear,
  t,
}: {
  files: File[]
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
      inputRef.current?.click()
    }
  }

  return (
    <div className="space-y-2">
      <Label>{t('connections.select_folder')}</Label>
      {files.length === 0 ? (
        <button
          type="button"
          onClick={handlePickFolder}
          className="flex w-full cursor-pointer flex-col items-center gap-2 rounded-lg border-2 border-dashed border-muted-foreground/25 bg-muted/30 px-4 py-6 transition-colors hover:border-muted-foreground/40 hover:bg-muted/50"
        >
          <FolderOpen size={20} className="text-muted-foreground" />
          <p className="text-xs text-muted-foreground">
            {t('connections.select_folder_hint')}
          </p>
        </button>
      ) : (
        <div className="rounded-lg border bg-muted/30 px-4 py-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <FolderOpen size={14} className="text-muted-foreground" />
              <span className="text-xs font-medium">
                {files.length} {t('connections.parquet_files')}
              </span>
              <span className="text-[11px] text-muted-foreground">
                ({formatFileSize(files.reduce((s, f) => s + f.size, 0))})
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
        </div>
      )}
      <FileSizeWarning totalBytes={files.reduce((s, f) => s + f.size, 0)} hasHandles={supportsDirectoryPicker} t={t} />
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

/* ─────────── File Size Warning ─────────── */

function FileSizeWarning({
  totalBytes,
  hasHandles,
  t,
}: {
  totalBytes: number
  hasHandles: boolean
  t: (key: string, opts?: Record<string, unknown>) => string
}) {
  if (totalBytes < SIZE_WARNING_THRESHOLD) return null

  if (hasHandles) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-emerald-400/30 bg-emerald-50 px-3 py-2 text-xs text-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-300">
        <FolderOpen size={14} className="shrink-0" />
        <span>{t('connections.import_mode_direct')}</span>
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
            ? t('connections.size_warning_danger', { size: formatFileSize(totalBytes) })
            : t('connections.size_warning', { size: formatFileSize(totalBytes) })}
        </p>
        <p className="mt-0.5 opacity-80">
          {isDanger
            ? t('connections.size_warning_blocked')
            : t('connections.size_warning_hint')}
        </p>
      </div>
    </div>
  )
}
