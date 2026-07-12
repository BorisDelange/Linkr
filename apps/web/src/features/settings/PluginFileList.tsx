import { useState, useCallback, useEffect, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import {
  File,
  FileCode,
  FileJson,
  FileText,
  FilePlus,
  PanelLeft,
  Trash2,
  Pencil,
  Settings2,
  Upload,
  Check,
  X,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'
import { cn } from '@/lib/utils'
import { usePluginEditorStore } from '@/stores/plugin-editor-store'
import { useAppStore } from '@/stores/app-store'
import { useDataSourceStore } from '@/stores/data-source-store'
import { getStorage } from '@/lib/storage'
import { queryDataSource } from '@/lib/duckdb/engine'
import { buildPatientListQuery, buildVisitListQuery, buildVisitDetailListQuery } from '@/lib/duckdb/patient-data-queries'
import type { DatasetColumn } from '@/types'

function getFileIcon(filename: string) {
  const ext = filename.split('.').pop()?.toLowerCase()
  if (filename.endsWith('.py.template') || ext === 'py')
    return <FileCode size={14} className="shrink-0 text-yellow-500" />
  if (filename.endsWith('.R.template') || ext === 'r' || ext === 'rmd')
    return <FileCode size={14} className="shrink-0 text-blue-500" />
  if (ext === 'json')
    return <FileJson size={14} className="shrink-0 text-green-400" />
  if (ext === 'md')
    return <FileText size={14} className="shrink-0 text-muted-foreground" />
  if (ext === 'js' || ext === 'jsx' || ext === 'ts' || ext === 'tsx')
    return <FileCode size={14} className="shrink-0 text-amber-500" />
  if (ext === 'sql')
    return <FileCode size={14} className="shrink-0 text-orange-400" />
  return <File size={14} className="shrink-0 text-muted-foreground" />
}

/** File types offered by the New file modal (mirrors the ETL editor's picker). */
const PLUGIN_FILE_TYPES = [
  { id: 'python', ext: '.py', labelKey: 'plugins.file_type_python' },
  { id: 'r', ext: '.R', labelKey: 'plugins.file_type_r' },
  { id: 'py_template', ext: '.py.template', labelKey: 'plugins.file_type_py_template' },
  { id: 'r_template', ext: '.R.template', labelKey: 'plugins.file_type_r_template' },
  { id: 'markdown', ext: '.md', labelKey: 'plugins.file_type_markdown' },
  { id: 'json', ext: '.json', labelKey: 'plugins.file_type_json' },
] as const

interface PluginFileListProps {
  onCollapse?: () => void
  /** When true, hide add/delete/rename file actions and test buttons (system plugins). */
  readOnly?: boolean
  /** Plugin scope — determines test config UI (lab: project+dataset, warehouse: database). */
  scope?: 'lab' | 'warehouse'
  /** Languages declared in the plugin manifest — constrains the language selector. */
  manifestLanguages?: ('python' | 'r')[]
}

export function PluginFileList({ onCollapse, readOnly, scope = 'lab', manifestLanguages }: PluginFileListProps) {
  const { t } = useTranslation()
  const projects = useAppStore((s) => s.projects)
  const dataSources = useDataSourceStore((s) => s.dataSources)
  const {
    files,
    activeFile,
    openFile,
    createFile,
    deleteFile,
    renameFile,
    testLanguage,
    testProjectUid,
    testDatasetFileId,
    testDataSourceId,
    testPersonId,
    testVisitId,
    testVisitDetailId,
    setTestLanguage,
    setTestProject,
    setTestDataset,
    setTestDataSource,
    setTestPersonId,
    setTestVisitId,
    setTestVisitDetailId,
  } = usePluginEditorStore()

  const [createFileOpen, setCreateFileOpen] = useState(false)
  const [newFileName, setNewFileName] = useState('')
  const [newFileType, setNewFileType] = useState<string>('python')
  const [renamingFile, setRenamingFile] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const renameInputRef = useRef<HTMLInputElement>(null)
  const uploadInputRef = useRef<HTMLInputElement>(null)
  const [datasets, setDatasets] = useState<{ id: string; name: string; columns: DatasetColumn[] }[]>([])

  // Warehouse test context — patients, visits, visit details loaded from DB
  const [patients, setPatients] = useState<{ id: string; label: string }[]>([])
  const [visits, setVisits] = useState<{ id: string; label: string }[]>([])
  const [visitDetails, setVisitDetails] = useState<{ id: string; label: string }[]>([])

  // Available languages: either from manifest or all
  const availableLanguages = useMemo(() => {
    if (manifestLanguages && manifestLanguages.length > 0) return manifestLanguages
    return ['python', 'r'] as ('python' | 'r')[]
  }, [manifestLanguages])

  // Connected data sources for warehouse mode (exclude vocabulary references, require schema mapping with patient table)
  const connectedSources = useMemo(
    () => dataSources.filter((ds) => ds.status === 'connected' && !ds.isVocabularyReference && !!ds.schemaMapping?.patientTable),
    [dataSources],
  )

  // Schema mapping for the selected data source
  const selectedSourceMapping = useMemo(
    () => dataSources.find((ds) => ds.id === testDataSourceId)?.schemaMapping,
    [dataSources, testDataSourceId],
  )


  // --- Lab: load datasets ---
  const loadDatasets = useCallback(async (uid: string) => {
    try {
      const storage = getStorage()
      const dsFiles = await storage.datasetFiles.getByProject(uid)
      const fileDatasets = dsFiles
        .filter((f) => f.type === 'file' && f.columns && f.columns.length > 0)
        .map((f) => ({ id: f.id, name: f.name, columns: f.columns! }))
      setDatasets(fileDatasets)
    } catch {
      setDatasets([])
    }
  }, [])

  const handleProjectChange = useCallback(async (uid: string) => {
    setTestProject(uid)
    await loadDatasets(uid)
  }, [setTestProject, loadDatasets])

  // Load datasets on mount if a project is already selected (e.g. switching plugins)
  useEffect(() => {
    if (testProjectUid) loadDatasets(testProjectUid)
  }, [testProjectUid, loadDatasets])

  const ensureMounted = useDataSourceStore((s) => s.ensureMounted)

  // --- Warehouse: load patients when data source changes ---
  useEffect(() => {
    if (!testDataSourceId || !selectedSourceMapping) {
      setPatients([])
      return
    }
    let cancelled = false
    const sql = buildPatientListQuery(selectedSourceMapping, null, 200, 0)
    if (!sql) { setPatients([]); return }
    ensureMounted(testDataSourceId)
      .then(() => queryDataSource(testDataSourceId, sql))
      .then((rows) => {
        if (!cancelled) {
          setPatients(rows.map((r) => ({
            id: String(r.patient_id),
            label: String(r.patient_id),
          })))
        }
      })
      .catch(() => { if (!cancelled) setPatients([]) })
    return () => { cancelled = true }
  }, [testDataSourceId, selectedSourceMapping, ensureMounted])

  // --- Warehouse: load visits when patient changes ---
  useEffect(() => {
    if (!testDataSourceId || !selectedSourceMapping || !testPersonId) {
      setVisits([])
      return
    }
    let cancelled = false
    const sql = buildVisitListQuery(selectedSourceMapping, testPersonId)
    if (!sql) { setVisits([]); return }
    ensureMounted(testDataSourceId)
      .then(() => queryDataSource(testDataSourceId, sql))
      .then((rows) => {
        if (!cancelled) {
          setVisits(rows.map((r) => {
            const id = String(r.visit_id)
            const date = r.start_date ? ` (${String(r.start_date).slice(0, 10)})` : ''
            return { id, label: `${id}${date}` }
          }))
        }
      })
      .catch(() => { if (!cancelled) setVisits([]) })
    return () => { cancelled = true }
  }, [testDataSourceId, selectedSourceMapping, testPersonId, ensureMounted])

  // --- Warehouse: load visit details when visit changes ---
  useEffect(() => {
    if (!testDataSourceId || !selectedSourceMapping || !testVisitId) {
      setVisitDetails([])
      return
    }
    let cancelled = false
    const sql = buildVisitDetailListQuery(selectedSourceMapping, testVisitId)
    if (!sql) { setVisitDetails([]); return }
    ensureMounted(testDataSourceId)
      .then(() => queryDataSource(testDataSourceId, sql))
      .then((rows) => {
        if (!cancelled) {
          setVisitDetails(rows.map((r) => {
            const id = String(r.visit_detail_id)
            const unit = r.unit ? ` – ${String(r.unit)}` : ''
            const date = r.start_date ? ` (${String(r.start_date).slice(0, 10)})` : ''
            return { id, label: `${id}${unit}${date}` }
          }))
        }
      })
      .catch(() => { if (!cancelled) setVisitDetails([]) })
    return () => { cancelled = true }
  }, [testDataSourceId, selectedSourceMapping, testVisitId, ensureMounted])

  const filenames = Object.keys(files).sort((a, b) => {
    if (a === 'plugin.json') return -1
    if (b === 'plugin.json') return 1
    return a.localeCompare(b)
  })

  const openCreateFile = () => {
    setNewFileName('')
    setNewFileType('python')
    setCreateFileOpen(true)
  }

  // Upload one or more files into the plugin (text content read client-side).
  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const list = e.target.files
    e.target.value = ''
    if (!list || list.length === 0) return
    for (const file of Array.from(list)) {
      if (files[file.name] !== undefined) continue  // skip existing
      const content = await file.text()
      createFile(file.name, content)
    }
  }

  const handleCreate = () => {
    const ext = PLUGIN_FILE_TYPES.find((ft) => ft.id === newFileType)?.ext ?? ''
    const raw = newFileName.trim()
    if (!raw) return
    // Append the type extension unless the user already typed one.
    const name = raw.includes('.') ? raw : `${raw}${ext}`
    if (files[name]) return
    createFile(name)
    setNewFileName('')
    setCreateFileOpen(false)
  }

  const trimmedRename = renameValue.trim()
  const renameClashes =
    !!renamingFile &&
    !!trimmedRename &&
    trimmedRename.toLowerCase() !== renamingFile.toLowerCase() &&
    files[trimmedRename] !== undefined

  const handleRename = (oldName: string) => {
    if (!trimmedRename || renameClashes) { setRenamingFile(null); return }
    if (trimmedRename !== oldName) renameFile(oldName, trimmedRename)
    setRenamingFile(null)
    setRenameValue('')
  }

  // Focus the rename input and select the base name (before extension) once the
  // context menu closes and restores focus — same behaviour as the IDE tree.
  useEffect(() => {
    if (!renamingFile) return
    let tries = 0
    let raf = 0
    const tick = () => {
      const el = renameInputRef.current
      if (el) {
        if (document.activeElement !== el) el.focus()
        if (document.activeElement === el) {
          const dot = renamingFile.lastIndexOf('.')
          if (dot > 0) el.setSelectionRange(0, dot)
          else el.select()
          return
        }
      }
      if (tries++ < 10) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [renamingFile])

  return (
    <TooltipProvider delayDuration={300}>
    <div className="flex h-full flex-col border-r">
      <div className="flex items-center justify-between border-b px-2 py-1.5">
        <div className="flex items-center gap-0.5">
          {!readOnly && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={openCreateFile}
                >
                  <FilePlus size={14} />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t('plugins.new_file_tooltip')}</TooltipContent>
            </Tooltip>
          )}
          {!readOnly && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon-xs" onClick={() => uploadInputRef.current?.click()}>
                  <Upload size={14} />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t('plugins.upload_file')}</TooltipContent>
            </Tooltip>
          )}
          <input
            ref={uploadInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={handleUpload}
          />
          {/* Test config popover */}
          {(
            <Popover>
              <Tooltip>
                <TooltipTrigger asChild>
                  <PopoverTrigger asChild>
                    <Button variant="ghost" size="icon-xs">
                      <Settings2 size={14} />
                    </Button>
                  </PopoverTrigger>
                </TooltipTrigger>
                <TooltipContent>{t('plugins.test_config')}</TooltipContent>
              </Tooltip>
              <PopoverContent align="start" className="w-[240px] space-y-3">
                <Label className="text-xs font-medium">{t('plugins.test_config')}</Label>

                {/* Lab mode: project + dataset */}
                {scope === 'lab' && (
                  <>
                    <div className="space-y-1">
                      <Label className="text-[10px] text-muted-foreground">{t('plugins.test_select_project')}</Label>
                      <Select value={testProjectUid ?? ''} onValueChange={handleProjectChange}>
                        <SelectTrigger className="text-[10px]">
                          <SelectValue placeholder={t('plugins.test_select_project')} />
                        </SelectTrigger>
                        <SelectContent>
                          {projects.map((p) => (
                            <SelectItem key={p.uid} value={p.uid} className="text-xs py-1">
                              {p.name || p.uid}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    {testProjectUid && (
                      <div className="space-y-1">
                        <Label className="text-[10px] text-muted-foreground">{t('plugins.test_select_dataset')}</Label>
                        <Select value={testDatasetFileId ?? ''} onValueChange={setTestDataset}>
                          <SelectTrigger className="text-[10px]">
                            <SelectValue placeholder={t('plugins.test_select_dataset')} />
                          </SelectTrigger>
                          <SelectContent>
                            {datasets.map((d) => (
                              <SelectItem key={d.id} value={d.id} className="text-xs py-1">
                                {d.name}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    )}
                  </>
                )}

                {/* Warehouse mode: database + patient context */}
                {scope === 'warehouse' && (
                  <>
                    <div className="space-y-1">
                      <Label className="text-[10px] text-muted-foreground">{t('plugins.test_select_database')}</Label>
                      <Select value={testDataSourceId ?? ''} onValueChange={setTestDataSource}>
                        <SelectTrigger className="text-[10px]">
                          <SelectValue placeholder={t('plugins.test_select_database')} />
                        </SelectTrigger>
                        <SelectContent>
                          {connectedSources.map((ds) => (
                            <SelectItem key={ds.id} value={ds.id} className="text-xs py-1">
                              {ds.name || ds.id}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    {patients.length > 0 && (
                      <div className="space-y-1">
                        <Label className="text-[10px] text-muted-foreground">{t('plugins.test_patient')}</Label>
                        <Select value={testPersonId ?? ''} onValueChange={setTestPersonId}>
                          <SelectTrigger className="text-[10px] font-mono">
                            <SelectValue placeholder={t('plugins.test_patient')} />
                          </SelectTrigger>
                          <SelectContent>
                            {patients.map((p) => (
                              <SelectItem key={p.id} value={p.id} className="text-xs py-1 font-mono">
                                {p.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    )}
                    {testPersonId && visits.length > 0 && (
                      <div className="space-y-1">
                        <Label className="text-[10px] text-muted-foreground">{t('plugins.test_hospitalization')}</Label>
                        <Select value={testVisitId ?? ''} onValueChange={setTestVisitId}>
                          <SelectTrigger className="text-[10px] font-mono">
                            <SelectValue placeholder={t('common.optional')} />
                          </SelectTrigger>
                          <SelectContent>
                            {visits.map((v) => (
                              <SelectItem key={v.id} value={v.id} className="text-xs py-1 font-mono">
                                {v.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    )}
                    {testVisitId && visitDetails.length > 0 && (
                      <div className="space-y-1">
                        <Label className="text-[10px] text-muted-foreground">{t('plugins.test_unit_stay')}</Label>
                        <Select value={testVisitDetailId ?? ''} onValueChange={setTestVisitDetailId}>
                          <SelectTrigger className="text-[10px] font-mono">
                            <SelectValue placeholder={t('common.optional')} />
                          </SelectTrigger>
                          <SelectContent>
                            {visitDetails.map((vd) => (
                              <SelectItem key={vd.id} value={vd.id} className="text-xs py-1 font-mono">
                                {vd.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    )}
                  </>
                )}

                {/* Language selector (hidden for system plugins) */}
                {!readOnly && (
                  <div className="space-y-1">
                    <Label className="text-[10px] text-muted-foreground">{t('plugins.test_language')}</Label>
                    <Select value={testLanguage} onValueChange={(v) => setTestLanguage(v as 'python' | 'r')}>
                      <SelectTrigger className="text-[10px]">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {availableLanguages.includes('python') && (
                          <SelectItem value="python" className="text-xs py-1">Python</SelectItem>
                        )}
                        {availableLanguages.includes('r') && (
                          <SelectItem value="r" className="text-xs py-1">R</SelectItem>
                        )}
                      </SelectContent>
                    </Select>
                  </div>
                )}
              </PopoverContent>
            </Popover>
          )}
        </div>
        {onCollapse && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-xs" onClick={onCollapse}>
                <PanelLeft size={14} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t('plugins.collapse_files')}</TooltipContent>
          </Tooltip>
        )}
      </div>
      <div className="flex-1 overflow-auto py-1">
        {filenames.map((filename) => (
          <ContextMenu key={filename}>
            <ContextMenuTrigger>
              {renamingFile === filename ? (
                <div className="flex w-full items-center gap-1.5 px-3 py-1 text-xs">
                  {getFileIcon(filename)}
                  <span className={cn(
                    'flex min-w-0 flex-1 items-center rounded border bg-background',
                    renameClashes ? 'border-destructive' : 'border-primary',
                  )}>
                    <input
                      ref={renameInputRef}
                      value={renameValue}
                      onChange={(e) => setRenameValue(e.target.value)}
                      title={renameClashes ? t('plugins.name_exists', { name: trimmedRename }) : undefined}
                      onKeyDown={(e) => {
                        e.stopPropagation()
                        if (e.key === 'Enter') handleRename(filename)
                        else if (e.key === 'Escape') { e.preventDefault(); setRenamingFile(null) }
                      }}
                      className="w-0 min-w-0 flex-1 bg-transparent px-1 py-0.5 text-xs outline-none"
                    />
                    <button
                      type="button"
                      tabIndex={-1}
                      aria-label={t('common.cancel')}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => setRenamingFile(null)}
                      className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-destructive"
                    >
                      <X size={12} />
                    </button>
                    <button
                      type="button"
                      tabIndex={-1}
                      disabled={renameClashes || !trimmedRename}
                      aria-label={t('common.save')}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => handleRename(filename)}
                      className="mr-0.5 flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-green-600 disabled:pointer-events-none disabled:opacity-40"
                    >
                      <Check size={12} />
                    </button>
                  </span>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => openFile(filename)}
                  className={cn(
                    'flex w-full items-center gap-1.5 rounded-sm px-3 py-1 text-xs transition-colors',
                    activeFile === filename
                      ? 'bg-accent text-accent-foreground'
                      : 'text-foreground/80 hover:bg-accent/50',
                  )}
                >
                  {getFileIcon(filename)}
                  <span className="truncate">{filename}</span>
                </button>
              )}
            </ContextMenuTrigger>
            {filename !== 'plugin.json' && !readOnly && (
              <ContextMenuContent>
                <ContextMenuItem onClick={() => { setRenamingFile(filename); setRenameValue(filename) }}>
                  <Pencil size={12} className="mr-2" />
                  {t('plugins.rename_file')}
                </ContextMenuItem>
                <ContextMenuItem onClick={() => deleteFile(filename)} className="text-destructive">
                  <Trash2 size={12} className="mr-2" />
                  {t('plugins.delete_file')}
                </ContextMenuItem>
              </ContextMenuContent>
            )}
          </ContextMenu>
        ))}
      </div>

      {/* New file modal — same shape as the ETL editor's picker */}
      <Dialog open={createFileOpen} onOpenChange={setCreateFileOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{t('plugins.new_file_tooltip')}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label>{t('files.file_type')}</Label>
              <Select value={newFileType} onValueChange={setNewFileType}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PLUGIN_FILE_TYPES.map((ft) => (
                    <SelectItem key={ft.id} value={ft.id}>
                      {getFileIcon(`x${ft.ext}`)}
                      <span className="ml-2">
                        {t(ft.labelKey)} <span className="text-muted-foreground">({ft.ext})</span>
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>{t('plugins.file_name')}</Label>
              <Input
                value={newFileName}
                onChange={(e) => setNewFileName(e.target.value)}
                placeholder={`analysis${PLUGIN_FILE_TYPES.find((ft) => ft.id === newFileType)?.ext ?? ''}`}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleCreate() } }}
                autoFocus
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateFileOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button onClick={handleCreate} disabled={!newFileName.trim()}>
              {t('common.create')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
    </TooltipProvider>
  )
}
