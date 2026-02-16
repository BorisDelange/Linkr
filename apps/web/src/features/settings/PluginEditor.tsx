import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Allotment } from 'allotment'
import { ArrowLeft, Save, Copy, Trash2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { CodeEditor } from '@/components/editor/CodeEditor'
import { usePluginEditorStore } from '@/stores/plugin-editor-store'
import { PluginFileList } from './PluginFileList'
import { PluginTestPanel } from './PluginTestPanel'

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
    isBuiltIn,
    files,
    openFiles,
    activeFile,
    isDirty,
    closeEditor,
    savePlugin,
    duplicatePlugin,
    deletePlugin,
    openFile,
    closeFile,
    updateFileContent,
  } = usePluginEditorStore()

  const handleSave = useCallback(() => {
    savePlugin()
  }, [savePlugin])

  const handleDuplicate = useCallback(() => {
    if (editingPluginId) duplicatePlugin(editingPluginId)
  }, [editingPluginId, duplicatePlugin])

  const handleDelete = useCallback(() => {
    if (editingPluginId) deletePlugin(editingPluginId)
  }, [editingPluginId, deletePlugin])

  // Resolve plugin name for toolbar
  let pluginName = editingPluginId ?? ''
  try {
    const manifest = JSON.parse(files['plugin.json'] ?? '{}')
    pluginName = manifest.name?.en ?? manifest.id ?? editingPluginId ?? ''
  } catch { /* use fallback */ }

  const activeContent = activeFile ? files[activeFile] ?? '' : ''
  const activeLanguage = activeFile ? languageFromFilename(activeFile) : 'plaintext'

  return (
    <div className="flex h-[calc(100vh-12rem)] flex-col">
      {/* Toolbar */}
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <Button variant="ghost" size="sm" onClick={closeEditor} className="gap-1 text-xs">
          <ArrowLeft size={14} />
          {t('plugins.back_to_list')}
        </Button>
        <span className="text-sm font-medium truncate">{pluginName}</span>
        {isBuiltIn && (
          <Badge variant="outline" className="text-[10px]">
            {t('plugins.built_in')}
          </Badge>
        )}
        {isDirty && (
          <Badge variant="secondary" className="text-[10px]">
            {t('plugins.unsaved_changes')}
          </Badge>
        )}
        <div className="ml-auto flex items-center gap-1">
          {!isBuiltIn && (
            <Button size="sm" onClick={handleSave} disabled={!isDirty} className="gap-1 text-xs">
              <Save size={12} />
              {t('plugins.save')}
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={handleDuplicate} className="gap-1 text-xs">
            <Copy size={12} />
            {t('plugins.duplicate')}
          </Button>
          {!isBuiltIn && (
            <Button variant="ghost" size="sm" onClick={handleDelete} className="gap-1 text-xs text-destructive hover:text-destructive">
              <Trash2 size={12} />
            </Button>
          )}
        </div>
      </div>

      {/* 3-panel layout */}
      <div className="min-h-0 flex-1">
        <Allotment>
          {/* File list */}
          <Allotment.Pane preferredSize={180} minSize={120} maxSize={300}>
            <PluginFileList />
          </Allotment.Pane>

          {/* Editor area */}
          <Allotment.Pane>
            <div className="flex h-full flex-col">
              {/* Tab bar */}
              {openFiles.length > 0 && (
                <div className="flex items-center border-b bg-muted/30">
                  {openFiles.map((filename) => (
                    <button
                      key={filename}
                      type="button"
                      onClick={() => openFile(filename)}
                      className={`group flex items-center gap-1 border-r px-3 py-1.5 text-xs transition-colors ${
                        activeFile === filename
                          ? 'bg-background text-foreground'
                          : 'text-muted-foreground hover:bg-background/50'
                      }`}
                    >
                      <span className="truncate max-w-[120px]">{filename}</span>
                      {!isBuiltIn && (
                        <span
                          role="button"
                          tabIndex={0}
                          onClick={(e) => { e.stopPropagation(); closeFile(filename) }}
                          onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); closeFile(filename) } }}
                          className="ml-1 rounded p-0.5 opacity-0 transition-opacity hover:bg-muted group-hover:opacity-100"
                        >
                          <X size={10} />
                        </span>
                      )}
                    </button>
                  ))}
                </div>
              )}

              {/* Monaco editor */}
              <div className="min-h-0 flex-1">
                {activeFile ? (
                  <CodeEditor
                    value={activeContent}
                    language={activeLanguage}
                    onChange={(val) => {
                      if (activeFile && val !== undefined) {
                        updateFileContent(activeFile, val)
                      }
                    }}
                    readOnly={isBuiltIn}
                    onSave={handleSave}
                  />
                ) : (
                  <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                    {t('plugins.select_file')}
                  </div>
                )}
              </div>
            </div>
          </Allotment.Pane>

          {/* Preview / Test panel */}
          <Allotment.Pane preferredSize={320} minSize={200} maxSize={500}>
            <PluginTestPanel />
          </Allotment.Pane>
        </Allotment>
      </div>
    </div>
  )
}
