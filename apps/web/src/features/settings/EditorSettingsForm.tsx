import { useTranslation } from 'react-i18next'
import { useAppStore } from '@/stores/app-store'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

export function EditorSettingsForm() {
  const { t } = useTranslation()
  const { editorSettings, updateEditorSettings } = useAppStore()

  return (
    <div className="space-y-4">
      {/* Theme */}
      <div className="flex items-center justify-between">
        <Label className="text-sm">{t('editor.theme')}</Label>
        <Select
          value={editorSettings.theme}
          onValueChange={(v) =>
            updateEditorSettings({ theme: v as 'auto' | 'vs' | 'vs-dark' })
          }
        >
          <SelectTrigger className="w-24">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="auto">{t('editor.theme_auto')}</SelectItem>
            <SelectItem value="vs">{t('editor.theme_light')}</SelectItem>
            <SelectItem value="vs-dark">{t('editor.theme_dark')}</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Font size */}
      <div className="flex items-center justify-between">
        <Label className="text-sm">{t('editor.font_size')}</Label>
        <Select
          value={String(editorSettings.fontSize)}
          onValueChange={(v) =>
            updateEditorSettings({ fontSize: Number(v) })
          }
        >
          <SelectTrigger className="w-24">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {[11, 12, 13, 14, 15, 16, 18, 20].map((size) => (
              <SelectItem key={size} value={String(size)}>
                {size}px
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Tab size */}
      <div className="flex items-center justify-between">
        <Label className="text-sm">{t('editor.tab_size')}</Label>
        <Select
          value={String(editorSettings.tabSize)}
          onValueChange={(v) =>
            updateEditorSettings({ tabSize: Number(v) })
          }
        >
          <SelectTrigger className="w-24">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {[2, 4, 8].map((size) => (
              <SelectItem key={size} value={String(size)}>
                {size}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Line numbers */}
      <div className="flex items-center justify-between">
        <Label className="text-sm">{t('editor.line_numbers')}</Label>
        <Select
          value={editorSettings.lineNumbers}
          onValueChange={(v) =>
            updateEditorSettings({
              lineNumbers: v as 'on' | 'off' | 'relative',
            })
          }
        >
          <SelectTrigger className="w-24">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="on">
              {t('editor.line_numbers_on')}
            </SelectItem>
            <SelectItem value="off">
              {t('editor.line_numbers_off')}
            </SelectItem>
            <SelectItem value="relative">
              {t('editor.line_numbers_relative')}
            </SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Word wrap */}
      <div className="flex items-center justify-between">
        <Label className="text-sm">{t('editor.word_wrap')}</Label>
        <Switch
          checked={editorSettings.wordWrap === 'on'}
          onCheckedChange={(checked) =>
            updateEditorSettings({ wordWrap: checked ? 'on' : 'off' })
          }
        />
      </div>

      {/* Minimap */}
      <div className="flex items-center justify-between">
        <Label className="text-sm">{t('editor.minimap')}</Label>
        <Switch
          checked={editorSettings.minimap}
          onCheckedChange={(checked) =>
            updateEditorSettings({ minimap: checked })
          }
        />
      </div>

      {/* Auto-save */}
      <div className="flex items-center justify-between">
        <Label className="text-sm">{t('editor.auto_save')}</Label>
        <Switch
          checked={editorSettings.autoSave}
          onCheckedChange={(checked) =>
            updateEditorSettings({ autoSave: checked })
          }
        />
      </div>

      {/* Auto-save delay (only visible when autoSave is on) */}
      {editorSettings.autoSave && (
        <div className="flex items-center justify-between">
          <Label className="text-sm">{t('editor.auto_save_delay')}</Label>
          <Select
            value={String(editorSettings.autoSaveDelay)}
            onValueChange={(v) =>
              updateEditorSettings({ autoSaveDelay: Number(v) })
            }
          >
            <SelectTrigger className="w-24">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="500">0.5s</SelectItem>
              <SelectItem value="1000">1s</SelectItem>
              <SelectItem value="2000">2s</SelectItem>
              <SelectItem value="5000">5s</SelectItem>
            </SelectContent>
          </Select>
        </div>
      )}
    </div>
  )
}
