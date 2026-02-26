import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { FilePlus, FileMinus, FileEdit, Loader2, X } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { DiffEditor, type BeforeMount } from '@monaco-editor/react'
import { useAppStore } from '@/stores/app-store'
import { linkrDark, linkrLight } from '@/components/editor/monaco-themes'

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

export function formatRelativeTime(timestamp: number): string {
  const now = Date.now() / 1000
  const diff = now - timestamp
  if (diff < 60) return 'just now'
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
  if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`
  return new Date(timestamp * 1000).toLocaleDateString()
}

export function formatFullDateTime(timestamp: number): string {
  return new Date(timestamp * 1000).toLocaleString(undefined, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

export function fileChangeIcon(type: string) {
  switch (type) {
    case 'added': return <FilePlus size={14} className="text-emerald-600 dark:text-emerald-400" />
    case 'deleted': return <FileMinus size={14} className="text-red-600 dark:text-red-400" />
    default: return <FileEdit size={14} className="text-amber-600 dark:text-amber-400" />
  }
}

export function getLanguageFromPath(filepath: string): string {
  if (filepath.endsWith('.json')) return 'json'
  if (filepath.endsWith('.md'))   return 'markdown'
  if (filepath.endsWith('.tsx') || filepath.endsWith('.ts')) return 'typescript'
  if (filepath.endsWith('.jsx') || filepath.endsWith('.js')) return 'javascript'
  if (filepath.endsWith('.py'))   return 'python'
  if (filepath.endsWith('.r') || filepath.endsWith('.R')) return 'r'
  if (filepath.endsWith('.css'))  return 'css'
  if (filepath.endsWith('.html')) return 'html'
  return 'text'
}

// ---------------------------------------------------------------------------
// DiffModal
// ---------------------------------------------------------------------------

export interface DiffModalProps {
  open: boolean
  onClose: () => void
  filepath: string
  oldContent: string
  newContent: string
  changeType: string
  loading: boolean
}

export function DiffModal({ open, onClose, filepath, oldContent, newContent, changeType, loading }: DiffModalProps) {
  const { t } = useTranslation()
  const lang = getLanguageFromPath(filepath)
  const { editorSettings, darkMode } = useAppStore()

  const resolvedTheme =
    editorSettings.theme === 'auto'
      ? darkMode ? 'linkr-dark' : 'linkr-light'
      : editorSettings.theme

  const handleBeforeMount: BeforeMount = useCallback((monaco) => {
    monaco.editor.defineTheme('linkr-dark', linkrDark)
    monaco.editor.defineTheme('linkr-light', linkrLight)
  }, [])

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose() }}>
      <DialogContent className="sm:max-w-[95vw] h-[95vh] flex flex-col p-0 gap-0" showCloseButton={false}>
        <DialogHeader className="px-4 py-3 border-b shrink-0">
          <div className="flex items-center justify-between">
            <DialogTitle className="text-sm font-mono flex items-center gap-2">
              {fileChangeIcon(changeType)}
              {filepath}
            </DialogTitle>
            <button type="button" onClick={onClose} className="rounded-md p-1 hover:bg-muted">
              <X size={16} />
            </button>
          </div>
        </DialogHeader>

        <div className="flex-1 min-h-0">
          {loading ? (
            <div className="flex items-center justify-center h-full gap-2 text-sm text-muted-foreground">
              <Loader2 size={16} className="animate-spin" />
              {t('app_versioning.loading_diff')}
            </div>
          ) : (
            <DiffEditor
              original={oldContent}
              modified={newContent}
              language={lang}
              theme={resolvedTheme}
              beforeMount={handleBeforeMount}
              options={{
                readOnly: true,
                domReadOnly: true,
                renderSideBySide: true,
                minimap: { enabled: false },
                fontSize: editorSettings.fontSize,
                fontFamily: "'Menlo', 'Monaco', 'Courier New', monospace",
                lineNumbers: 'on',
                scrollBeyondLastLine: false,
                automaticLayout: true,
                padding: { top: 8 },
              }}
            />
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
