import { useState, useRef, useCallback, useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Allotment } from 'allotment'
import 'allotment/dist/style.css'
import { Save, X, ChevronLeft, ChevronRight, PanelLeft, Eye, EyeOff, Keyboard, Play, Loader2, Info, FileCode } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  EntitySecondaryTabsTrigger,
  ENTITY_SECONDARY_TABS,
} from '@/components/ui/entity-secondary-tabs'
import { EntityLicensePanel, EntityReadmePanel } from '@/components/ui/entity-docs-panels'
import { GitRepositoryTab } from '@/components/versioning/GitRepositoryTab'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { CodeEditor } from '@/components/editor/CodeEditor'
import { cn } from '@/lib/utils'
import { usePluginEditorStore } from '@/stores/plugin-editor-store'
import { useWorkspaceStore } from '@/stores/workspace-store'
import { useOrganizationStore } from '@/stores/organization-store'
import { useMyWorkspaceRole } from '@/hooks/use-context-role'
import { useUrlTab } from '@/hooks/use-url-tab'
import { localized } from '@/lib/localized'
import { PluginFileList } from './PluginFileList'
import { PluginOverviewTab } from './PluginOverviewTab'
import { PluginTestConfig } from './PluginTestConfig'
import { usePluginActions } from './use-plugin-actions'
import { PluginTestPanel } from './PluginTestPanel'
import { KeyboardShortcutsDialog } from '@/features/projects/files/KeyboardShortcutsDialog'
import { useGlobalShortcuts, matchesCombo, type ShortcutHandlers } from '@/hooks/use-shortcuts'
import { useShortcutStore } from '@/stores/shortcut-store'
import { resolveTemplate } from '@/lib/plugins/template-resolver'
import { executeAnalysisCode, executeAnalysisCodeR } from '@/features/projects/lab/datasets/analysis-executor'
import { isServerMode } from '@/lib/api-client'
import { executeOnServer } from '@/lib/api/execution'
import { listPythonPackages, installPythonPackage } from '@/lib/runtimes/pyodide-engine'
import { listRPackages, installRPackage } from '@/lib/runtimes/webr-engine'
import { getStorage } from '@/lib/storage'
import type { DatasetColumn } from '@/types'
import type { PluginConfigField } from '@/types/plugin'
import type { RuntimeOutput } from '@/lib/runtimes/types'

const languageFromFilename = (filename: string): string => {
  if (filename.endsWith('.json')) return 'json'
  if (filename.endsWith('.py') || filename.endsWith('.py.template')) return 'python'
  if (filename.endsWith('.R') || filename.endsWith('.R.template')) return 'r'
  if (filename.endsWith('.ts') || filename.endsWith('.tsx')) return 'typescript'
  if (filename.endsWith('.js') || filename.endsWith('.jsx')) return 'javascript'
  if (filename.endsWith('.md')) return 'markdown'
  return 'plaintext'
}

const PLUGIN_TAB_IDS = ['overview', 'code', ...ENTITY_SECONDARY_TABS] as const
type PluginTabId = (typeof PLUGIN_TAB_IDS)[number]

export function PluginEditor() {
  const { t, i18n } = useTranslation()
  const {
    editingPluginId,
    isSystemPlugin,
    pluginList,
    files,
    openFiles,
    activeFile,
    originalFiles,
    savePlugin,
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

  const [activeTab, setActiveTab] = useUrlTab<PluginTabId>({
    key: `plugin:${editingPluginId ?? ''}`,
    tabs: PLUGIN_TAB_IDS,
    // Code, not overview: the editor is what someone opening a plugin came for.
    defaultTab: 'code',
  })

  // Set by the overview's Edit button so the Readme tab opens in edit mode.
  const [readmeEditing, setReadmeEditing] = useState(false)
  // Cleared only once the Readme tab has actually been left. Checking
  // `activeTab !== 'readme'` during render would fire immediately instead:
  // setActiveTab writes the URL, so activeTab is still the previous tab on the
  // render right after the Edit click, and the flag died before it was read.
  const wasOnReadme = useRef(false)
  useEffect(() => {
    if (activeTab === 'readme') wasOnReadme.current = true
    else if (wasOnReadme.current) {
      wasOnReadme.current = false
      setReadmeEditing(false)
    }
  }, [activeTab])

  const [explorerVisible, setExplorerVisible] = useState(true)
  const [editorVisible, setEditorVisible] = useState(true)
  const [outputVisible, setOutputVisible] = useState(true)
  const [activeOutputTab, setActiveOutputTab] = useState<'config' | 'code' | 'results'>('config')
  const [shortcutsOpen, setShortcutsOpen] = useState(false)

  // --- Test execution state ---
  const [isExecuting, setIsExecuting] = useState(false)
  const [testResult, setTestResult] = useState<RuntimeOutput | null>(null)
  const [testStatusMessage, setTestStatusMessage] = useState<string | null>(null)
  const [testColumns, setTestColumns] = useState<DatasetColumn[]>([])
  const [testInstalledDeps, setTestInstalledDeps] = useState<string[]>([])
  // System plugin preview: widget type to render live instead of code output
  const [systemWidgetPreview, setSystemWidgetPreview] = useState<string | null>(null)

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

  // Save/Cmd+S applies to the currently open file only: enabled when the active
  // file has unsaved edits (not merely when some other file in the plugin does).
  const activeFileDirty = !!activeFile && files[activeFile] !== originalFiles[activeFile]
  const handleSave = useCallback(() => {
    if (activeFileDirty && !isSystemPlugin) savePlugin()
  }, [activeFileDirty, isSystemPlugin, savePlugin])

  // Parse manifest
  const manifest = useMemo(() => {
    try {
      return JSON.parse(files['plugin.json'] ?? '{}')
    } catch { return {} }
  }, [files])

  const pluginScope = manifest.scope ?? 'lab'
  const canRunTest = pluginScope === 'warehouse' ? !!testDataSourceId : !!testDatasetFileId
  const pluginLanguages: ('python' | 'r')[] = manifest.languages ?? []

  // --- Entity tabs (overview / readme / licence / versioning) ---
  const canWritePlugins = useMyWorkspaceRole().can('plugins:write')
  const pluginActions = usePluginActions()
  const currentPlugin = pluginList.find((p) => p.id === editingPluginId)
  // The actions hook takes the minimal item shape, built from what the open
  // editor knows rather than from a list row that may not exist yet.
  const pluginItem = useMemo(
    () => ({
      id: editingPluginId ?? '',
      name: manifest.name ?? '',
      gitRemoteConfig: currentPlugin?.gitRemoteConfig,
    }),
    [editingPluginId, manifest.name, currentPlugin?.gitRemoteConfig],
  )
  const pluginDocs = {
    readme: pluginActions.docs.getReadme?.(pluginItem),
    license: pluginActions.docs.getLicense?.(pluginItem) ?? null,
  }
  // The plugin's frozen provenance wins; otherwise the workspace's live
  // organization — the rule every other licence tab follows.
  const workspace = useWorkspaceStore((s) =>
    s._workspacesRaw.find((w) => w.id === s.activeWorkspaceId),
  )
  const org = useOrganizationStore((s) =>
    workspace?.organizationId ? s.getOrganization(workspace.organizationId) : undefined,
  )
  const holder = currentPlugin?.organization?.name ?? org?.name
  const licenseHolder = holder ? localized(holder, i18n.language) : undefined

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
      setTestResult(null)
      setSystemWidgetPreview(editingPluginId)
      return
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
      // Server mode: deps are provisioned in the server runtime image; installing
      // them in the browser WASM engine would boot Pyodide/WebR for nothing.
      if (manifestDeps.length > 0 && !isServerMode()) {
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
        // Warehouse mode: execute with patient context (null for test). The
        // executor routes to the server in full-stack mode (no WASM) and to the
        // browser engine front-only — same as the real patient-data renderers.
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

        const code = resolveTemplate(template, testConfig, cols, parsedSchema, testLanguage)
        if (isServerMode()) {
          // Server mode: backend injects the dataset Parquet as `dataset`; no rows shipped.
          const output = await executeOnServer(testLanguage, code, {
            projectUid: dsFile?.projectUid,
            datasetFileId: testDatasetFileId!,
          })
          setTestResult(output)
        } else {
          const datasetData = await storage.datasetData.get(testDatasetFileId!)
          const rows = datasetData?.rows ?? []
          const exec = testLanguage === 'r' ? executeAnalysisCodeR : executeAnalysisCode
          const output = await exec(code, rows, cols)
          setTestResult(output)
        }
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

  const isFileDirtyFn = (filename: string) => {
    return files[filename] !== originalFiles[filename]
  }

  // Global save shortcut — mirrors the IDE. Monaco already binds save_file
  // inside the editor (via CodeEditor.onSave); this covers the case where focus
  // is elsewhere (file sidebar, toolbar). new_file scaffolds a new plugin file.
  const globalHandlers: ShortcutHandlers = useMemo(
    () => ({ new_file: () => { if (!isSystemPlugin) usePluginEditorStore.getState().createFile(t('plugins.new_file')) } }),
    [isSystemPlugin, t],
  )
  useGlobalShortcuts(globalHandlers)

  const saveBinding = useShortcutStore((s) => s.shortcuts.save_file.binding)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement
      const inMonaco = target.closest?.('.monaco-editor')
      if (inMonaco) return // Monaco handles save_file itself
      if (matchesCombo(e, saveBinding)) {
        e.preventDefault()
        handleSave()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [saveBinding, handleSave])

  // Force CodeEditor remount when editor-scoped bindings change (same as the IDE).
  const shortcutVersion = useShortcutStore((s) =>
    JSON.stringify([s.shortcuts.save_file.binding, s.shortcuts.run_file.binding])
  )

  return (
    <TooltipProvider delayDuration={300}>
    <div className="flex h-full flex-col">
      <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as PluginTabId)}>
        <div className="flex shrink-0 items-center justify-center px-6 py-3">
          <TabsList>
            <TabsTrigger value="overview">
              <Info size={14} />
              {t('databases.detail_overview')}
            </TabsTrigger>
            <TabsTrigger value="code">
              <FileCode size={14} />
              {t('plugins.tab_code')}
            </TabsTrigger>
            <EntitySecondaryTabsTrigger
              activeTab={activeTab}
              onSelect={setActiveTab}
              onExport={() => void pluginActions.onExport(pluginItem)}
            />
          </TabsList>
        </div>
      </Tabs>

      {activeTab === 'overview' && currentPlugin && (
        <div className="flex min-h-0 flex-1 flex-col px-6 pb-1.5">
          <PluginOverviewTab
            plugin={currentPlugin}
            readme={pluginDocs.readme}
            license={pluginDocs.license}
            onEditReadme={() => { setReadmeEditing(true); setActiveTab('readme') }}
            onSeeLicense={() => setActiveTab('license')}
          />
        </div>
      )}

      {activeTab === 'readme' && (
        <div className="min-h-0 flex-1 overflow-auto px-6 pb-1.5">
          <EntityReadmePanel
            // Remounted when arriving from the overview's Edit button, so the
            // editor picks up the requested mode — initialMode only applies on mount.
            key={readmeEditing ? 'edit' : 'view'}
            initialMode={readmeEditing ? 'edit' : 'view'}
            readme={pluginDocs.readme}
            onSave={(readme) => void pluginActions.docs.onSaveReadme?.(pluginItem, readme)}
            canEdit={canWritePlugins && !isSystemPlugin}
            attachmentOwner={{ type: 'user-plugin', id: editingPluginId ?? '' }}
            // The tab already says "Readme".
            showTitle={false}
          />
        </div>
      )}

      {activeTab === 'license' && (
        <div className="min-h-0 flex-1 overflow-auto px-6 pb-1.5">
          <EntityLicensePanel
            license={pluginDocs.license}
            onSave={(license) => void pluginActions.docs.onSaveLicense?.(pluginItem, license)}
            canEdit={canWritePlugins && !isSystemPlugin}
            copyrightHolder={licenseHolder}
            showTitle={false}
          />
        </div>
      )}

      {activeTab === 'versioning' && (
        <div className="min-h-0 flex-1 overflow-auto px-6 pb-1.5">
          <div className="mx-auto w-full max-w-3xl">
            <GitRepositoryTab
              gitRemote={currentPlugin?.gitRemoteConfig ?? null}
              onSave={(config) => pluginActions.onSaveGitRemote(pluginItem, config)}
              syncScope="user-plugins"
              syncId={editingPluginId ?? undefined}
            />
          </div>
        </div>
      )}

      {/* Main area: file sidebar | (tab bar + editor/output). It keeps its own
          mount across tab switches: Monaco, the open files and the test output
          are expensive to rebuild, and coming back to a re-initialised editor
          would lose the session. */}
      {/* `border-t` closes the block off from the tab bar, which otherwise runs
          straight into the sidebar and toolbar with no edge between them. */}
      <div className={cn('min-h-0 flex-1 border-t', activeTab === 'code' ? '' : 'hidden')}>
        <Allotment>
          {/* File list sidebar */}
          {/* Same width band as the IDE file explorer, so file sidebars all
              open at the same size. */}
          <Allotment.Pane preferredSize={240} minSize={140} maxSize={400} visible={explorerVisible}>
            <PluginFileList
              onCollapse={() => setExplorerVisible(false)}
              readOnly={isSystemPlugin}
            />
          </Allotment.Pane>

          {/* Editor + Output column */}
          <Allotment.Pane minSize={200}>
            <div className="flex h-full flex-col">
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

                <div className="mx-1 h-4 w-px bg-border" />

                {/* What the run executes against, next to the button it feeds. */}
                <PluginTestConfig
                  scope={pluginScope as 'lab' | 'warehouse'}
                  manifestLanguages={pluginLanguages.length > 0 ? pluginLanguages : undefined}
                  readOnly={isSystemPlugin}
                />

                {/* Run test — same button style as SQL script collections */}
                <Button
                  size="xs"
                  className="gap-1"
                  onClick={handleRunTest}
                  disabled={isExecuting || !canRunTest}
                >
                  {isExecuting ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />}
                  {t('plugins.test_run')}
                </Button>

                {/* Save (Cmd+S) */}
                {!isSystemPlugin && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button variant="ghost" size="icon-xs" onClick={handleSave} disabled={!activeFileDirty}>
                        <Save size={14} />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>{t('plugins.save')} (⌘S)</TooltipContent>
                  </Tooltip>
                )}

                {saveError && (
                  <span className="text-[10px] text-destructive">{t(`plugins.${saveError}`)}</span>
                )}

                <div className="flex-1" />

                {/* Keyboard shortcuts */}
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button variant="ghost" size="icon-xs" onClick={() => setShortcutsOpen(true)}>
                      <Keyboard size={14} />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>{t('plugins.shortcuts')}</TooltipContent>
                </Tooltip>

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

              {/* Editor + Output split */}
              <div className="min-h-0 flex-1">
                <Allotment>
                  {/* Editor */}
                  <Allotment.Pane minSize={editorVisible ? 200 : 0} visible={editorVisible}>
                    <div className="h-full">
                      {activeFile ? (
                        <CodeEditor
                          key={shortcutVersion}
                          value={activeContent}
                          language={activeLanguage}
                          onChange={(val) => {
                            if (activeFile && val !== undefined && !isSystemPlugin) {
                              updateFileContent(activeFile, val)
                            }
                          }}
                          onSave={isSystemPlugin ? undefined : handleSave}
                          onRunFile={handleRunTest}
                          onRunSelectionOrLine={handleRunTest}
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

      {/* Keyboard shortcuts — reuse the IDE dialog, editor-relevant actions only */}
      <KeyboardShortcutsDialog
        open={shortcutsOpen}
        onOpenChange={setShortcutsOpen}
        actionIds={['new_file', 'save_file', 'run_file', 'run_selection_or_line', 'toggle_comment', 'find', 'replace', 'undo', 'redo']}
      />
    </div>
    </TooltipProvider>
  )
}
