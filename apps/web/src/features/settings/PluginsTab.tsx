import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Plus, Puzzle, Trash2 } from 'lucide-react'
import * as LucideIcons from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
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
import { usePluginEditorStore } from '@/stores/plugin-editor-store'
import { PluginEditor } from './PluginEditor'

function getIcon(iconName: string): LucideIcons.LucideIcon {
  const icon = (LucideIcons as Record<string, unknown>)[iconName]
  if (typeof icon === 'object' && icon !== null) return icon as LucideIcons.LucideIcon
  return Puzzle
}

export function PluginsTab() {
  const { t, i18n } = useTranslation()
  const lang = i18n.language as 'en' | 'fr'
  const {
    pluginList,
    refreshPluginList,
    editingPluginId,
    openPlugin,
    createPlugin,
    deletePlugin,
  } = usePluginEditorStore()

  const [deleteId, setDeleteId] = useState<string | null>(null)

  useEffect(() => {
    refreshPluginList()
  }, [refreshPluginList])

  // If editing a plugin, show the editor instead of the list
  if (editingPluginId) {
    return <PluginEditor />
  }

  return (
    <div className="mt-4 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">{t('plugins.title')}</h2>
          <p className="text-sm text-muted-foreground">{t('plugins.description')}</p>
        </div>
        <Button size="sm" onClick={() => createPlugin()} className="gap-1">
          <Plus size={14} />
          {t('plugins.new_plugin')}
        </Button>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {pluginList.map((plugin) => {
          const Icon = getIcon(plugin.manifest.icon)
          return (
            <button
              key={plugin.id}
              type="button"
              onClick={() => openPlugin(plugin.id)}
              className="group relative flex flex-col gap-2 rounded-lg border bg-card p-4 text-left transition-colors hover:bg-accent/50"
            >
              <div className="flex items-center gap-2">
                <Icon size={18} className="shrink-0 text-muted-foreground" />
                <span className="text-sm font-medium truncate">
                  {plugin.manifest.name?.[lang] ?? plugin.manifest.name?.en ?? plugin.id}
                </span>
                <Badge variant="outline" className="ml-auto text-[10px] shrink-0">
                  {plugin.isBuiltIn ? t('plugins.built_in') : t('plugins.custom')}
                </Badge>
              </div>
              <p className="text-xs text-muted-foreground line-clamp-2">
                {plugin.manifest.description?.[lang] ?? plugin.manifest.description?.en ?? ''}
              </p>
              <div className="flex items-center gap-1">
                {plugin.manifest.languages?.map((l) => (
                  <Badge key={l} variant="secondary" className="text-[10px] px-1.5 py-0">
                    {l === 'python' ? 'Python' : 'R'}
                  </Badge>
                ))}
                {plugin.manifest.runtime?.includes('js-widget') && (
                  <Badge variant="secondary" className="text-[10px] px-1.5 py-0">JS</Badge>
                )}
                <span className="ml-auto text-[10px] text-muted-foreground">
                  v{plugin.manifest.version ?? '1.0.0'}
                </span>
              </div>

              {/* Delete button for custom plugins */}
              {!plugin.isBuiltIn && (
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); setDeleteId(plugin.id) }}
                  className="absolute right-2 top-2 rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100"
                >
                  <Trash2 size={12} />
                </button>
              )}
            </button>
          )
        })}
      </div>

      {pluginList.length === 0 && (
        <div className="flex flex-col items-center justify-center py-12 text-center">
          <Puzzle size={32} className="text-muted-foreground/30" />
          <p className="mt-2 text-sm text-muted-foreground">{t('plugins.no_plugins')}</p>
        </div>
      )}

      {/* Delete confirmation */}
      <AlertDialog open={deleteId !== null} onOpenChange={(open) => { if (!open) setDeleteId(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('plugins.delete')}</AlertDialogTitle>
            <AlertDialogDescription>{t('plugins.delete_confirm')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => { if (deleteId) { deletePlugin(deleteId); setDeleteId(null) } }}
            >
              {t('common.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
