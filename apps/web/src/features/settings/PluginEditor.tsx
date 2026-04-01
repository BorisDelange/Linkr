import { useState, useRef, useCallback, useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Allotment } from 'allotment'
import { ArrowLeft, Save, Copy, Trash2, X, ChevronLeft, ChevronRight, Settings, Plus, PanelLeft, Eye, EyeOff, MoreHorizontal, Download, History } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { CodeEditor } from '@/components/editor/CodeEditor'
import { cn } from '@/lib/utils'
import { getBadgeClasses, getBadgeStyle } from '@/features/projects/ProjectSettingsPage'
import { usePluginEditorStore } from '@/stores/plugin-editor-store'
import { useWorkspaceStore } from '@/stores/workspace-store'
import { EntityHistoryPanel } from '@/features/versioning/EntityHistoryPanel'
import { IconPicker } from '@/components/ui/icon-picker'
import { PluginFileList } from './PluginFileList'
import { PluginTestPanel } from './PluginTestPanel'
import { bumpVersion, type BumpType } from '@/lib/semver'
import { resolveTemplate } from '@/lib/plugins/template-resolver'
import { executeAnalysisCode, executeAnalysisCodeR } from '@/features/projects/lab/datasets/analysis-executor'
import { listPythonPackages, installPythonPackage } from '@/lib/runtimes/pyodide-engine'
import { listRPackages, installRPackage } from '@/lib/runtimes/webr-engine'
import { getStorage } from '@/lib/storage'
import type { PresetBadgeColor, BadgeColor, CatalogVisibility, DatasetColumn } from '@/types'
import type { PluginBadge, PluginConfigField } from '@/types/plugin'
import type { RuntimeOutput } from '@/lib/runtimes/types'
import { SYSTEM_WIDGET_TYPE_MAP } from '@/lib/plugins/builtin-widget-plugins'
import type { PatientWidgetType } from '@/stores/patient-chart-store'

const PRESET_COLORS: { value: PresetBadgeColor; swatch: string }[] = [
  { value: 'red', swatch: 'bg-red-400' },
  { value: 'blue', swatch: 'bg-blue-400' },
  { value: 'green', swatch: 'bg-green-400' },
  { value: 'violet', swatch: 'bg-violet-400' },
  { value: 'amber', swatch: 'bg-amber-400' },
  { value: 'rose', swatch: 'bg-rose-400' },
  { value: 'cyan', swatch: 'bg-cyan-400' },
  { value: 'slate', swatch: 'bg-slate-400' },
]

function isCustomColor(color: BadgeColor): boolean {
  return !PRESET_COLORS.some((pc) => pc.value === color)
}

const languageFromFilename = (filename: string): string => {
  if (filename.endsWith('.json')) return 'json'
  if (filename.endsWith('.py') || filename.endsWith('.py.template')) return 'python'
  if (filename.endsWith('.R') || filename.endsWith('.R.template')) return 'r'
  if (filename.endsWith('.ts') || filename.endsWith('.tsx')) return 'typescript'
  if (filename.endsWith('.js') || filename.endsWith('.jsx')) return 'javascript'
  if (filename.endsWith('.md')) return 'markdown'
  return 'plaintext'
}

export function PluginEditor() {
  const { t } = useTranslation()
  const {
    editingPluginId,
    isSystemPlugin,
    files,
    openFiles,
    activeFile,
    isDirty,
    originalFiles,
    closeEditor,
    savePlugin,
    duplicatePlugin,
    deletePlugin,
    openFile,
    closeFile,
    updateFileContent,
    reorderOpenFiles,
    testLanguage,
    testDatasetFileId,
    testDataSourceId,
    testPersonId,
    testVisitId,
    testVisitDetailId,
    testConfig,
    saveError,
  } = usePluginEditorStore()

  const [explorerVisible, setExplorerVisible] = useState(true)
  const [editorVisible, setEditorVisible] = useState(true)
  const [outputVisible, setOutputVisible] = useState(true)
  const [activeOutputTab, setActiveOutputTab] = useState<'config' | 'code' | 'results'>('config')

  // --- Test execution state ---
  const [isExecuting, setIsExecuting] = useState(false)
  const [testResult, setTestResult] = useState<RuntimeOutput | null>(null)
  const [testStatusMessage, setTestStatusMessage] = useState<string | null>(null)
  const [testColumns, setTestColumns] = useState<DatasetColumn[]>([])
  const [testInstalledDeps, setTestInstalledDeps] = useState<string[]>([])
  // System plugin preview: widget type to render live instead of code output
  const [systemWidgetPreview, setSystemWidgetPreview] = useState<PatientWidgetType | null>(null)

  // --- Drag reorder state ---
  const [dragFile, setDragFile] = useState<string | null>(null)
  const [dropInsert, setDropInsert] = useState<{ name: string; side: 'left' | 'right' } | null>(null)

  // --- Tab scroll with arrows ---
  const tabScrollRef = useRef<HTMLDivElement>(null)
  const [canScrollLeft, setCanScrollLeft] = useState(false)
  const [canScrollRight, setCanScrollRight] = useState(false)

  const updateTabScroll = useCallback(() => {
    const el = tabScrollRef.current
    if (!el) return
    setCanScrollLeft(el.scrollLeft > 0)
    setCanScrollRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 1)
  }, [])

  useEffect(() => {
    updateTabScroll()
    const el = tabScrollRef.current
    if (!el) return
    el.addEventListener('scroll', updateTabScroll)
    const ro = new ResizeObserver(updateTabScroll)
    ro.observe(el)
    return () => {
      el.removeEventListener('scroll', updateTabScroll)
      ro.disconnect()
    }
  }, [updateTabScroll, openFiles.length])

  const scrollTabs = useCallback((dir: 'left' | 'right') => {
    const el = tabScrollRef.current
    if (!el) return
    el.scrollBy({ left: dir === 'left' ? -120 : 120, behavior: 'smooth' })
  }, [])

  const handleSave = useCallback(() => {
    savePlugin()
  }, [savePlugin])

  const handleDuplicate = useCallback(() => {
    if (editingPluginId) duplicatePlugin(editingPluginId)
  }, [editingPluginId, duplicatePlugin])

  const handleDelete = useCallback(() => {
    if (editingPluginId) deletePlugin(editingPluginId)
  }, [editingPluginId, deletePlugin])

  // Parse manifest
  const manifest = useMemo(() => {
    try {
      return JSON.parse(files['plugin.json'] ?? '{}')
    } catch { return {} }
  }, [files])

  const pluginName = manifest.name?.en ?? manifest.id ?? editingPluginId ?? ''
  const pluginNameFr = manifest.name?.fr ?? ''
  const pluginDescEn = manifest.description?.en ?? ''
  const pluginDescFr = manifest.description?.fr ?? ''
  const pluginVersion = manifest.version ?? '1.0.0'
  const pluginScope = manifest.scope ?? 'lab'
  const pluginIcon: string = manifest.icon ?? 'Puzzle'
  const pluginIconColor: BadgeColor | undefined = manifest.iconColor
  const pluginBadges: PluginBadge[] = manifest.badges ?? []
  const pluginCatalogVisibility: CatalogVisibility | undefined = manifest.catalogVisibility
  const pluginPythonDeps: string = (manifest.dependencies?.python ?? []).join('\n')
  const pluginRDeps: string = (manifest.dependencies?.r ?? []).join('\n')

  const [historyOpen, setHistoryOpen] = useState(false)

  const handleExport = useCallback(async () => {
    if (!editingPluginId) return
    const JSZip = (await import('jszip')).default
    const zip = new JSZip()
    for (const [filename, content] of Object.entries(files)) {
      zip.file(filename, content)
    }
    const blob = await zip.generateAsync({ type: 'blob' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${manifest.id ?? editingPluginId}.zip`
    a.click()
    URL.revokeObjectURL(url)
  }, [editingPluginId, files, manifest])
  const pluginLanguages: ('python' | 'r')[] = manifest.languages ?? []

  // Helper to update a field in plugin.json
  const updateManifestField = useCallback((key: string, value: unknown) => {
    try {
      const m = JSON.parse(files['plugin.json'] ?? '{}')
      m[key] = value
      updateFileContent('plugin.json', JSON.stringify(m, null, 2))
    } catch { /* invalid json, skip */ }
  }, [files, updateFileContent])

  // Helper to update a nested field (e.g. 'name.en', 'dependencies.python')
  const updateManifestNested = useCallback((path: string, value: unknown) => {
    try {
      const m = JSON.parse(files['plugin.json'] ?? '{}')
      const parts = path.split('.')
      let obj = m as Record<string, unknown>
      for (let i = 0; i < parts.length - 1; i++) {
        if (obj[parts[i]] === undefined || typeof obj[parts[i]] !== 'object') obj[parts[i]] = {}
        obj = obj[parts[i]] as Record<string, unknown>
      }
      obj[parts[parts.length - 1]] = value
      updateFileContent('plugin.json', JSON.stringify(m, null, 2))
    } catch { /* invalid json, skip */ }
  }, [files, updateFileContent])

  // Badge management
  const [newBadgeLabel, setNewBadgeLabel] = useState('')
  const [newBadgeColor, setNewBadgeColor] = useState<BadgeColor>('blue')

  const handleAddBadge = useCallback(() => {
    const label = newBadgeLabel.trim()
    if (!label) return
    const badge: PluginBadge = { id: `b-${Date.now()}`, label, color: newBadgeColor }
    updateManifestField('badges', [...pluginBadges, badge])
    setNewBadgeLabel('')
  }, [newBadgeLabel, newBadgeColor, pluginBadges, updateManifestField])

  const handleRemoveBadge = useCallback((id: string) => {
    updateManifestField('badges', pluginBadges.filter(b => b.id !== id))
  }, [pluginBadges, updateManifestField])

  // Version bump
  const handleBumpVersion = useCallback((type: BumpType) => {
    updateManifestField('version', bumpVersion(pluginVersion, type))
  }, [pluginVersion, updateManifestField])

  // Parse configSchema for test execution
  const parsedSchema = useMemo(() => {
    try {
      const m = JSON.parse(files['plugin.json'] ?? '{}')
      return (m.configSchema ?? {}) as Record<string, PluginConfigField>
    } catch { return {} }
  }, [files])

  // Test execution
  const handleRunTest = useCallback(async () => {
    const isWarehouse = pluginScope === 'warehouse'
    if (isWarehouse ? !testDataSourceId : !testDatasetFileId) return
    setActiveOutputTab('results')
    if (!outputVisible) setOutputVisible(true)

    // System plugins: render live widget preview instead of executing code
    if (isSystemPlugin && editingPluginId) {
      const widgetType = SYSTEM_WIDGET_TYPE_MAP[editingPluginId]
      if (widgetType) {
        setTestResult(null)
        setSystemWidgetPreview(widgetType)
        return
      }
    }

    setSystemWidgetPreview(null)
    setIsExecuting(true)
    setTestResult(null)
    setTestStatusMessage(null)
    setTestInstalledDeps([])
    try {
      // Auto-install declared dependencies from plugin.json
      let manifestDeps: string[] = []
      try {
        const m = JSON.parse(files['plugin.json'] ?? '{}')
        manifestDeps = m.dependencies?.[testLanguage] ?? []
      } catch { /* invalid json */ }

      const newlyInstalled: string[] = []
      if (manifestDeps.length > 0) {
        const installed = testLanguage === 'python'
          ? await listPythonPackages()
          : await listRPackages()
        const installedNames = new Set(installed.map(p => p.name.toLowerCase()))
        const missing = manifestDeps.filter(d => !installedNames.has(d.toLowerCase()))
        for (const pkg of missing) {
          setTestStatusMessage(`Installing ${pkg}...`)
          if (testLanguage === 'python') {
            await installPythonPackage(pkg, (msg) => setTestStatusMessage(msg))
          } else {
            await installRPackage(pkg, (msg) => setTestStatusMessage(msg))
          }
          newlyInstalled.push(pkg)
        }
      }
      setTestInstalledDeps(newlyInstalled)
      setTestStatusMessage(null)

      // Find template
      let template = ''
      for (const [filename, content] of Object.entries(files)) {
        if (testLanguage === 'python' && filename.endsWith('.py.template')) { template = content; break }
        if (testLanguage === 'r' && filename.endsWith('.R.template')) { template = content; break }
      }

      if (isWarehouse) {
        // Warehouse mode: execute with patient context (null for test)
        const code = resolveTemplate(template, testConfig, [], parsedSchema, testLanguage)
        const { executeWarehousePluginPython, executeWarehousePluginR } = await import(
          '@/features/projects/warehouse/patient-data/warehouse-plugin-executor'
        )
        const exec = testLanguage === 'r' ? executeWarehousePluginR : executeWarehousePluginPython
        const output = await exec(code, testDataSourceId!, testPersonId, testVisitId, testVisitDetailId)
        setTestResult(output)
      } else {
        // Lab mode: execute with dataset
        const storage = getStorage()
        const dsFile = await storage.datasetFiles.getById(testDatasetFileId!)
        const cols = dsFile?.columns ?? []
        setTestColumns(cols)
        const datasetData = await storage.datasetData.get(testDatasetFileId!)
        const rows = datasetData?.rows ?? []

        const code = resolveTemplate(template, testConfig, cols, parsedSchema, testLanguage)
        const exec = testLanguage === 'r' ? executeAnalysisCodeR : executeAnalysisCode
        const output = await exec(code, rows, cols)
        setTestResult(output)
      }
    } catch (err) {
      setTestResult({
        stdout: '',
        stderr: err instanceof Error ? err.message : String(err),
        figures: [],
        table: null,
        html: null,
      })
    } finally {
      setIsExecuting(false)
      setTestStatusMessage(null)
    }
  }, [pluginScope, testDataSourceId, testPersonId, testVisitId, testVisitDetailId, testDatasetFileId, testLanguage, files, testConfig, parsedSchema, outputVisible, isSystemPlugin, editingPluginId])

  const activeContent = activeFile ? files[activeFile] ?? '' : ''
  const activeLanguage = activeFile ? languageFromFilename(activeFile) : 'plaintext'

  // Check if a specific file is dirty (content differs from original)
  const isFileDirtyFn = (filename: string) => {
    return files[filename] !== originalFiles[filename]
  }

  return (
    <div className="flex h-full flex-col">
      {/* Toolbar */}
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <Button variant="ghost" size="sm" onClick={closeEditor} className="gap-1 text-xs">
          <ArrowLeft size={14} />
          {t('plugins.back_to_list')}
        </Button>
        <span className="text-sm font-medium truncate">{pluginName}</span>
        <span className="text-[10px] text-muted-foreground">v{pluginVersion}</span>
        {pluginBadges.map((badge) => (
          <span
            key={badge.id}
            className={cn('shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium leading-tight', getBadgeClasses(badge.color))}
            style={getBadgeStyle(badge.color)}
          >
            {badge.label}
          </span>
        ))}
        {isSystemPlugin && (
          <Badge variant="outline" className="text-[10px] text-muted-foreground">
            {t('plugins.system_plugin')}
          </Badge>
        )}
        {isDirty && !isSystemPlugin && (
          <Badge variant="secondary" className="text-[10px]">
            {t('plugins.unsaved_changes')}
          </Badge>
        )}
        <div className="ml-auto flex items-center gap-1">
          {/* Settings popover (appearance, version, badges, publishing) */}
          {!isSystemPlugin && (
          <Popover>
              <PopoverTrigger asChild>
                <Button variant="ghost" size="sm" className="gap-1 text-xs">
                  <Settings size={12} />
                </Button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-[340px] max-h-[70vh] overflow-auto space-y-4">
                {/* Scope */}
                {!isSystemPlugin && (
                  <div className="space-y-2">
                    <Label className="text-xs font-medium">{t('plugins.scope')}</Label>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => updateManifestField('scope', 'warehouse')}
                        disabled={!originalFiles['plugin.json']?.includes('"scope"') ? false : undefined}
                        className={cn(
                          'rounded-md border px-2.5 py-1 text-xs transition-colors',
                          pluginScope === 'warehouse'
                            ? 'border-primary bg-primary/10 text-primary'
                            : 'border-border text-muted-foreground hover:bg-accent',
                        )}
                      >
                        {t('plugins.scope_warehouse')}
                      </button>
                      <button
                        type="button"
                        onClick={() => updateManifestField('scope', 'lab')}
                        className={cn(
                          'rounded-md border px-2.5 py-1 text-xs transition-colors',
                          pluginScope === 'lab'
                            ? 'border-primary bg-primary/10 text-primary'
                            : 'border-border text-muted-foreground hover:bg-accent',
                        )}
                      >
                        {t('plugins.scope_lab')}
                      </button>
                    </div>
                  </div>
                )}

                {/* Languages */}
                {!isSystemPlugin && (
                  <div className="space-y-2 border-t pt-3">
                    <Label className="text-xs font-medium">{t('plugins.languages')}</Label>
                    <div className="flex items-center gap-3">
                      <label className="flex items-center gap-1.5 text-xs cursor-pointer">
                        <input
                          type="checkbox"
                          checked={pluginLanguages.includes('python')}
                          onChange={(e) => {
                            const next = e.target.checked
                              ? [...new Set([...pluginLanguages, 'python' as const])]
                              : pluginLanguages.filter(l => l !== 'python')
                            updateManifestField('languages', next)
                          }}
                          className="h-3.5 w-3.5 rounded border-border"
                        />
                        Python
                      </label>
                      <label className="flex items-center gap-1.5 text-xs cursor-pointer">
                        <input
                          type="checkbox"
                          checked={pluginLanguages.includes('r')}
                          onChange={(e) => {
                            const next = e.target.checked
                              ? [...new Set([...pluginLanguages, 'r' as const])]
                              : pluginLanguages.filter(l => l !== 'r')
                            updateManifestField('languages', next)
                          }}
                          className="h-3.5 w-3.5 rounded border-border"
                        />
                        R
                      </label>
                    </div>
                  </div>
                )}

                {/* Name */}
                <div className={cn('space-y-2', !isSystemPlugin && 'border-t pt-3')}>
                  <Label className="text-xs font-medium">{t('plugins.name_label')}</Label>
                  <div className="space-y-1.5">
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] text-muted-foreground w-5 shrink-0">EN</span>
                      <Input
                        value={pluginName}
                        onChange={(e) => updateManifestNested('name.en', e.target.value)}
                        className="h-7 text-[11px]"
                      />
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] text-muted-foreground w-5 shrink-0">FR</span>
                      <Input
                        value={pluginNameFr}
                        onChange={(e) => updateManifestNested('name.fr', e.target.value)}
                        className="h-7 text-[11px]"
                      />
                    </div>
                  </div>
                </div>

                {/* Description */}
                <div className="space-y-2 border-t pt-3">
                  <Label className="text-xs font-medium">{t('plugins.description_label')}</Label>
                  <div className="space-y-1.5">
                    <div className="flex gap-2">
                      <span className="text-[10px] text-muted-foreground w-5 shrink-0 pt-1.5">EN</span>
                      <Textarea
                        value={pluginDescEn}
                        onChange={(e) => updateManifestNested('description.en', e.target.value)}
                        className="min-h-[36px] text-[11px] resize-none"
                        rows={2}
                      />
                    </div>
                    <div className="flex gap-2">
                      <span className="text-[10px] text-muted-foreground w-5 shrink-0 pt-1.5">FR</span>
                      <Textarea
                        value={pluginDescFr}
                        onChange={(e) => updateManifestNested('description.fr', e.target.value)}
                        className="min-h-[36px] text-[11px] resize-none"
                        rows={2}
                      />
                    </div>
                  </div>
                </div>

                {/* Appearance */}
                <div className="space-y-3 border-t pt-3">
                  <Label className="text-xs font-medium">{t('plugins.appearance')}</Label>
                  <IconPicker
                    value={pluginIcon}
                    onChange={(name) => updateManifestField('icon', name)}
                    iconColor={pluginIconColor && !PRESET_COLORS.some(c => c.value === pluginIconColor) ? pluginIconColor : undefined}
                  />
                  <div className="flex flex-wrap items-center gap-1 pt-1">
                    <button
                      type="button"
                      onClick={() => updateManifestField('iconColor', undefined)}
                      className={cn(
                        'flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 text-[8px] font-medium ring-offset-background transition-all',
                        !pluginIconColor
                          ? 'border-foreground/40 ring-2 ring-ring ring-offset-2'
                          : 'border-muted-foreground/30 hover:ring-1 hover:ring-ring hover:ring-offset-1',
                      )}
                    >
                      <X size={8} className="text-muted-foreground" />
                    </button>
                    {PRESET_COLORS.map((c) => (
                      <button
                        key={c.value}
                        type="button"
                        onClick={() => updateManifestField('iconColor', c.value)}
                        className={cn(
                          'h-5 w-5 shrink-0 rounded-full ring-offset-background transition-all',
                          c.swatch,
                          pluginIconColor === c.value
                            ? 'ring-2 ring-ring ring-offset-2'
                            : 'hover:ring-1 hover:ring-ring hover:ring-offset-1',
                        )}
                      />
                    ))}
                    <div className="relative shrink-0">
                      <input
                        type="color"
                        value={pluginIconColor && isCustomColor(pluginIconColor) ? pluginIconColor : '#6366f1'}
                        onChange={(e) => updateManifestField('iconColor', e.target.value)}
                        className="absolute inset-0 h-5 w-5 cursor-pointer opacity-0"
                      />
                      <div
                        className={cn(
                          'flex h-5 w-5 items-center justify-center rounded-full border-2 border-dashed border-muted-foreground/40 text-muted-foreground/60 ring-offset-background transition-all',
                          pluginIconColor && isCustomColor(pluginIconColor)
                            ? 'ring-2 ring-ring ring-offset-2'
                            : 'hover:border-muted-foreground/60',
                        )}
                        style={pluginIconColor && isCustomColor(pluginIconColor) ? { backgroundColor: pluginIconColor, borderStyle: 'solid', borderColor: pluginIconColor } : undefined}
                      >
                        {!(pluginIconColor && isCustomColor(pluginIconColor)) && <Plus size={8} />}
                      </div>
                    </div>
                  </div>
                </div>

                {/* Dependencies — only for non-system plugins */}
                {!isSystemPlugin && (
                  <div className="space-y-2 border-t pt-3">
                    <Label className="text-xs font-medium">{t('plugins.dependencies')}</Label>
                    <div className="space-y-1.5">
                      <div>
                        <span className="text-[10px] text-muted-foreground">{t('plugins.python_deps')}</span>
                        <Textarea
                          value={pluginPythonDeps}
                          onChange={(e) => updateManifestNested('dependencies.python', e.target.value.split('\n').filter(Boolean))}
                          placeholder="pandas&#10;numpy"
                          className="mt-0.5 min-h-[36px] text-[11px] font-mono resize-none"
                          rows={2}
                        />
                      </div>
                      <div>
                        <span className="text-[10px] text-muted-foreground">{t('plugins.r_deps')}</span>
                        <Textarea
                          value={pluginRDeps}
                          onChange={(e) => updateManifestNested('dependencies.r', e.target.value.split('\n').filter(Boolean))}
                          placeholder="dplyr&#10;ggplot2"
                          className="mt-0.5 min-h-[36px] text-[11px] font-mono resize-none"
                          rows={2}
                        />
                      </div>
                    </div>
                  </div>
                )}

                {/* Version */}
                {!isSystemPlugin && (
                <div className="space-y-2 border-t pt-3">
                  <div className="flex items-center justify-between gap-2">
                    <Label className="text-xs font-medium">{t('plugins.version')}</Label>
                    <Input
                      value={pluginVersion}
                      onChange={(e) => updateManifestField('version', e.target.value)}
                      className="h-6 w-24 text-right font-mono text-[11px]"
                    />
                  </div>
                  <div className="grid grid-cols-3 gap-1.5">
                    {(['patch', 'minor', 'major'] as BumpType[]).map((type) => {
                      const bumped = bumpVersion(pluginVersion, type)
                      return (
                        <Button
                          key={type}
                          variant="outline"
                          size="sm"
                          onClick={() => handleBumpVersion(type)}
                          className="h-auto flex-col gap-0 py-1.5 text-xs"
                        >
                          <span className="font-medium">{t(`plugins.bump_${type}`)}</span>
                          <span className="text-[10px] text-muted-foreground">{bumped}</span>
                        </Button>
                      )
                    })}
                  </div>
                </div>

                )}

                {/* Badges */}
                <div className="space-y-2.5 border-t pt-3">
                  <Label className="text-xs font-medium">{t('plugins.badges')}</Label>
                  {pluginBadges.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {pluginBadges.map((badge) => (
                        <span
                          key={badge.id}
                          className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium', getBadgeClasses(badge.color))}
                          style={getBadgeStyle(badge.color)}
                        >
                          {badge.label}
                          <button
                            type="button"
                            onClick={() => handleRemoveBadge(badge.id)}
                            className="rounded-full p-0.5 transition-colors hover:bg-black/10 dark:hover:bg-white/20"
                          >
                            <X size={10} />
                          </button>
                        </span>
                      ))}
                    </div>
                  )}
                  <Input
                    value={newBadgeLabel}
                    onChange={(e) => setNewBadgeLabel(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') handleAddBadge() }}
                    placeholder={t('plugins.badge_label_placeholder')}
                    className="h-7 text-[11px]"
                  />
                  <div className="flex items-center gap-1">
                    {PRESET_COLORS.map((c) => (
                      <button
                        key={c.value}
                        type="button"
                        onClick={() => setNewBadgeColor(c.value)}
                        className={cn(
                          'h-5 w-5 rounded-full ring-offset-background transition-all',
                          c.swatch,
                          newBadgeColor === c.value
                            ? 'ring-2 ring-ring ring-offset-2'
                            : 'hover:ring-1 hover:ring-ring hover:ring-offset-1',
                        )}
                      />
                    ))}
                    <div className="relative">
                      <input
                        type="color"
                        value={isCustomColor(newBadgeColor) ? newBadgeColor : '#6366f1'}
                        onChange={(e) => setNewBadgeColor(e.target.value)}
                        className="absolute inset-0 h-5 w-5 cursor-pointer opacity-0"
                      />
                      <div
                        className={cn(
                          'flex h-5 w-5 items-center justify-center rounded-full border-2 border-dashed border-muted-foreground/40 text-muted-foreground/60 ring-offset-background transition-all',
                          isCustomColor(newBadgeColor)
                            ? 'ring-2 ring-ring ring-offset-2'
                            : 'hover:border-muted-foreground/60',
                        )}
                        style={isCustomColor(newBadgeColor) ? { backgroundColor: newBadgeColor, borderStyle: 'solid', borderColor: newBadgeColor } : undefined}
                      >
                        {!isCustomColor(newBadgeColor) && <Plus size={8} />}
                      </div>
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={handleAddBadge}
                    disabled={!newBadgeLabel.trim()}
                    className="mt-0.5 h-7 gap-1 text-xs w-full"
                  >
                    <Plus size={12} />
                    {t('plugins.add_badge')}
                  </Button>
                </div>

                {/* Publishing — only for non-system plugins */}
                {!isSystemPlugin && (
                  <div className="space-y-2 border-t pt-3">
                    <Label className="text-xs font-medium">{t('plugins.publishing_section')}</Label>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => updateManifestField('catalogVisibility', 'unlisted')}
                        className={cn(
                          'rounded-md border px-2.5 py-1 text-xs transition-colors',
                          pluginCatalogVisibility !== 'listed'
                            ? 'border-primary bg-primary/10 text-primary'
                            : 'border-border text-muted-foreground hover:bg-accent',
                        )}
                      >
                        {t('catalog.unlisted')}
                      </button>
                      <button
                        type="button"
                        onClick={() => updateManifestField('catalogVisibility', 'listed')}
                        className={cn(
                          'rounded-md border px-2.5 py-1 text-xs transition-colors',
                          pluginCatalogVisibility === 'listed'
                            ? 'border-primary bg-primary/10 text-primary'
                            : 'border-border text-muted-foreground hover:bg-accent',
                        )}
                      >
                        {t('catalog.listed')}
                      </button>
                    </div>
                  </div>
                )}
              </PopoverContent>
            </Popover>
          )}
          {/* "..." dropdown: Export, History, Duplicate, Delete */}
          {!isSystemPlugin && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="sm">
                  <MoreHorizontal size={14} />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={handleExport}>
                  <Download size={14} />
                  {t('plugins.export')}
                </DropdownMenuItem>
                <DropdownMenuItem disabled>
                  <History size={14} />
                  {t('plugins.history')}
                  <span className="ml-auto inline-flex items-center rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground leading-none">{t('common.server_only')}</span>
                </DropdownMenuItem>
                <DropdownMenuItem onClick={handleDuplicate}>
                  <Copy size={14} />
                  {t('plugins.duplicate')}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onClick={handleDelete}>
                  <Trash2 size={14} />
                  {t('common.delete')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          {/* Save — rightmost */}
          {!isSystemPlugin && saveError && (
            <span className="text-[10px] text-destructive">{t(`plugins.${saveError}`)}</span>
          )}
          {!isSystemPlugin && (
            <Button size="sm" onClick={handleSave} disabled={!isDirty} className="gap-1 text-xs">
              <Save size={12} />
              {t('plugins.save')}
            </Button>
          )}
        </div>
      </div>

      {/* Main area: file sidebar | (tab bar + editor/output) */}
      <div className="min-h-0 flex-1">
        <Allotment>
          {/* File list sidebar */}
          <Allotment.Pane preferredSize={180} minSize={120} maxSize={300} visible={explorerVisible}>
            <PluginFileList
              onCollapse={() => setExplorerVisible(false)}
              isRunning={isExecuting}
              onRun={handleRunTest}
              readOnly={isSystemPlugin}
              scope={pluginScope as 'lab' | 'warehouse'}
              manifestLanguages={pluginLanguages.length > 0 ? pluginLanguages : undefined}
            />
          </Allotment.Pane>

          {/* Editor + Output column */}
          <Allotment.Pane minSize={200}>
            <div className="flex h-full flex-col">
              {/* Unified tab bar — same level as file sidebar header */}
              <TooltipProvider delayDuration={300}>
              {/* Toolbar: icon buttons */}
              <div className="flex items-center gap-1 border-b px-2 py-1.5">
                {!explorerVisible && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button variant="ghost" size="icon-xs" onClick={() => setExplorerVisible(true)}>
                        <PanelLeft size={14} />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>{t('plugins.files')}</TooltipContent>
                  </Tooltip>
                )}
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant={editorVisible ? 'secondary' : 'ghost'}
                      size="icon-xs"
                      onClick={() => setEditorVisible(!editorVisible)}
                    >
                      {editorVisible ? <Eye size={14} /> : <EyeOff size={14} />}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>{t('plugins.toggle_editor')}</TooltipContent>
                </Tooltip>
                <div className="flex-1" />
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant={outputVisible ? 'secondary' : 'ghost'}
                      size="icon-xs"
                      onClick={() => setOutputVisible(!outputVisible)}
                    >
                      {outputVisible ? <Eye size={14} /> : <EyeOff size={14} />}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>{t('plugins.toggle_output')}</TooltipContent>
                </Tooltip>
              </div>

              {/* Unified tab bar: file tabs | separator | output tabs */}
              <div className="flex items-center border-b bg-muted/30">
                {/* File tabs with scroll arrows */}
                {openFiles.length > 0 && (
                  <button
                    type="button"
                    onClick={() => scrollTabs('left')}
                    disabled={!canScrollLeft}
                    className={cn(
                      'shrink-0 px-0.5 py-1.5 transition-colors',
                      canScrollLeft
                        ? 'text-muted-foreground hover:text-foreground'
                        : 'text-muted-foreground/25 cursor-default',
                    )}
                  >
                    <ChevronLeft size={12} />
                  </button>
                )}
                <div
                  ref={tabScrollRef}
                  className="flex items-center overflow-x-auto scrollbar-none"
                >
                  {openFiles.map((filename) => {
                    const isActive = activeFile === filename && editorVisible
                    const fileDirty = isFileDirtyFn(filename)
                    return (
                      <button
                        key={filename}
                        type="button"
                        draggable
                        onDragStart={(e) => {
                          e.dataTransfer.setData('plugin-tab', filename)
                          e.dataTransfer.effectAllowed = 'move'
                          setDragFile(filename)
                        }}
                        onDragOver={(e) => {
                          if (!e.dataTransfer.types.includes('plugin-tab')) return
                          e.preventDefault()
                          e.dataTransfer.dropEffect = 'move'
                          const rect = e.currentTarget.getBoundingClientRect()
                          const side = e.clientX < rect.left + rect.width / 2 ? 'left' : 'right'
                          setDropInsert({ name: filename, side })
                        }}
                        onDragLeave={() => setDropInsert(null)}
                        onDrop={(e) => {
                          e.preventDefault()
                          const side = dropInsert?.side ?? 'right'
                          setDropInsert(null)
                          setDragFile(null)
                          const draggedName = e.dataTransfer.getData('plugin-tab')
                          if (!draggedName || draggedName === filename) return
                          const fromIdx = openFiles.indexOf(draggedName)
                          let toIdx = openFiles.indexOf(filename)
                          if (side === 'right') toIdx++
                          if (fromIdx < toIdx) toIdx--
                          if (fromIdx !== -1 && toIdx >= 0 && fromIdx !== toIdx) {
                            reorderOpenFiles(fromIdx, toIdx)
                          }
                        }}
                        onDragEnd={() => { setDragFile(null); setDropInsert(null) }}
                        onClick={() => {
                          openFile(filename)
                          if (!editorVisible) setEditorVisible(true)
                        }}
                        className={cn(
                          'relative group flex items-center gap-1.5 border-r px-3 py-1.5 text-xs transition-colors whitespace-nowrap shrink-0',
                          isActive
                            ? 'bg-background text-foreground'
                            : 'text-muted-foreground hover:bg-accent/50',
                          dragFile === filename && 'opacity-40',
                        )}
                      >
                        {dropInsert?.name === filename && dropInsert.side === 'left' && dragFile !== filename && (
                          <div className="absolute left-0 top-1 bottom-1 w-0.5 bg-primary rounded-full" />
                        )}
                        {dropInsert?.name === filename && dropInsert.side === 'right' && dragFile !== filename && (
                          <div className="absolute right-0 top-1 bottom-1 w-0.5 bg-primary rounded-full" />
                        )}
                        <span className="max-w-[140px] truncate" title={filename}>{filename}</span>
                        {fileDirty && (
                          <span className="ml-0.5 size-1.5 shrink-0 rounded-full bg-orange-400" />
                        )}
                        <span
                          role="button"
                          tabIndex={0}
                          onClick={(e) => { e.stopPropagation(); closeFile(filename) }}
                          onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); closeFile(filename) } }}
                          className="ml-0.5 rounded p-0.5 opacity-0 hover:bg-accent group-hover:opacity-100"
                        >
                          <X size={10} />
                        </span>
                      </button>
                    )
                  })}
                </div>
                {openFiles.length > 0 && (
                  <button
                    type="button"
                    onClick={() => scrollTabs('right')}
                    disabled={!canScrollRight}
                    className={cn(
                      'shrink-0 px-0.5 py-1.5 transition-colors',
                      canScrollRight
                        ? 'text-muted-foreground hover:text-foreground'
                        : 'text-muted-foreground/25 cursor-default',
                    )}
                  >
                    <ChevronRight size={12} />
                  </button>
                )}

                {/* Separator */}
                {openFiles.length > 0 && (
                  <div className="mx-0.5 h-4 w-px shrink-0 bg-border" />
                )}

                {/* Output tabs: Config / Code / Results */}
                {(['config', 'code', 'results'] as const).map((tab) => (
                  <button
                    key={tab}
                    type="button"
                    onClick={() => {
                      setActiveOutputTab(tab)
                      if (!outputVisible) setOutputVisible(true)
                    }}
                    className={cn(
                      'shrink-0 border-r px-3 py-1.5 text-xs transition-colors whitespace-nowrap',
                      activeOutputTab === tab && outputVisible
                        ? 'bg-background text-foreground font-medium'
                        : 'text-muted-foreground hover:bg-accent/50',
                    )}
                  >
                    {t(`plugins.tab_${tab}`)}
                  </button>
                ))}
              </div>
              </TooltipProvider>

              {/* Editor + Output split */}
              <div className="min-h-0 flex-1">
                <Allotment>
                  {/* Editor */}
                  <Allotment.Pane minSize={editorVisible ? 200 : 0} visible={editorVisible}>
                    <div className="h-full">
                      {activeFile ? (
                        <CodeEditor
                          value={activeContent}
                          language={activeLanguage}
                          onChange={(val) => {
                            if (activeFile && val !== undefined && !isSystemPlugin) {
                              updateFileContent(activeFile, val)
                            }
                          }}
                          onSave={isSystemPlugin ? undefined : handleSave}
                          readOnly={isSystemPlugin}
                        />
                      ) : (
                        <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                          {t('plugins.select_file')}
                        </div>
                      )}
                    </div>
                  </Allotment.Pane>

                  {/* Output panel: Config / Code / Results */}
                  <Allotment.Pane preferredSize={320} minSize={outputVisible ? 200 : 0} visible={outputVisible}>
                    <PluginTestPanel
                      activeTab={activeOutputTab}
                      isExecuting={isExecuting}
                      result={testResult}
                      statusMessage={testStatusMessage}
                      columns={testColumns}
                      installedDeps={testInstalledDeps}
                      onRerun={handleRunTest}
                      systemWidgetPreview={systemWidgetPreview}
                    />
                  </Allotment.Pane>
                </Allotment>
              </div>
            </div>
          </Allotment.Pane>
        </Allotment>
      </div>

      {/* Entity history dialog */}
      {editingPluginId && (
        <Dialog open={historyOpen} onOpenChange={setHistoryOpen}>
          <DialogContent className="sm:max-w-4xl h-[80vh] flex flex-col p-0 gap-0" showCloseButton>
            <DialogHeader className="px-4 py-3 border-b shrink-0">
              <DialogTitle>{t('plugins.history')} — {pluginName}</DialogTitle>
            </DialogHeader>
            <div className="flex-1 min-h-0 overflow-auto">
              <EntityHistoryPanel
                workspaceId={useWorkspaceStore.getState().activeWorkspaceId!}
                entityType="plugin"
                entityId={editingPluginId}
                entityName={pluginName}
                onRestored={() => {
                  usePluginEditorStore.getState().openPlugin(editingPluginId)
                  setHistoryOpen(false)
                }}
              />
            </div>
          </DialogContent>
        </Dialog>
      )}
    </div>
  )
}
