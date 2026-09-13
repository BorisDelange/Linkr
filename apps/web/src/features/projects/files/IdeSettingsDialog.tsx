import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { ExternalLink } from 'lucide-react'
import { DialogShell } from '@/components/ui/dialog-shell'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { useAppStore } from '@/stores/app-store'

interface IdeSettingsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

/**
 * Settings specific to the IDE. The editor's own settings (theme, font, auto-save)
 * are user-wide and live in the profile page — duplicating them here would give
 * the same preference two homes.
 */
export function IdeSettingsDialog({ open, onOpenChange }: IdeSettingsDialogProps) {
  const { t } = useTranslation()
  const reuseOutputTabs = useAppStore((s) => s.editorSettings.reuseOutputTabs)
  const updateEditorSettings = useAppStore((s) => s.updateEditorSettings)

  return (
    <DialogShell
      open={open}
      onOpenChange={onOpenChange}
      kind="settings"
      title={t('files.settings')}
      description={t('files.settings_description')}
      hideFooter
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <Label>{t('files.reuse_output_tabs')}</Label>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {t('files.reuse_output_tabs_hint')}
          </p>
        </div>
        <Switch
          checked={reuseOutputTabs}
          onCheckedChange={(checked) => updateEditorSettings({ reuseOutputTabs: checked })}
          className="mt-0.5 shrink-0"
        />
      </div>

      <Link
        to="/profile?tab=editor"
        onClick={() => onOpenChange(false)}
        className="flex items-center gap-1.5 border-t pt-3 text-xs text-muted-foreground hover:text-foreground"
      >
        <ExternalLink size={12} className="shrink-0" />
        {t('files.editor_settings_link')}
      </Link>
    </DialogShell>
  )
}
