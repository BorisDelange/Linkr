import { useTranslation } from 'react-i18next'
import { useAppStore, type EditorSettings } from '@/stores/app-store'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

const FONT_SIZE_MIN = 8
const FONT_SIZE_MAX = 32
const TAB_SIZE_MIN = 1
const TAB_SIZE_MAX = 16
const AUTO_SAVE_DELAY_MIN_S = 0.5
const AUTO_SAVE_DELAY_MAX_S = 30

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
            updateEditorSettings({ theme: v as EditorSettings['theme'] })
          }
        >
          <SelectTrigger className="w-48">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="linkr-auto">{t('editor.theme_linkr_auto')}</SelectItem>
            <SelectItem value="vs-auto">{t('editor.theme_vs_auto')}</SelectItem>
            <SelectItem value="linkr-light">{t('editor.theme_linkr_light')}</SelectItem>
            <SelectItem value="linkr-dark">{t('editor.theme_linkr_dark')}</SelectItem>
            <SelectItem value="vs">{t('editor.theme_vs_light')}</SelectItem>
            <SelectItem value="vs-dark">{t('editor.theme_vs_dark')}</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Font size */}
      <div className="flex items-center justify-between">
        <Label className="text-sm">{t('editor.font_size')}</Label>
        <Input
          type="number"
          min={FONT_SIZE_MIN}
          max={FONT_SIZE_MAX}
          value={editorSettings.fontSize}
          onChange={(e) => {
            const n = Number(e.target.value)
            if (Number.isFinite(n)) {
              updateEditorSettings({ fontSize: Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, n)) })
            }
          }}
          className="w-24"
        />
      </div>

      {/* Tab size */}
      <div className="flex items-center justify-between">
        <Label className="text-sm">{t('editor.tab_size')}</Label>
        <Input
          type="number"
          min={TAB_SIZE_MIN}
          max={TAB_SIZE_MAX}
          value={editorSettings.tabSize}
          onChange={(e) => {
            const n = Number(e.target.value)
            if (Number.isFinite(n)) {
              updateEditorSettings({ tabSize: Math.min(TAB_SIZE_MAX, Math.max(TAB_SIZE_MIN, n)) })
            }
          }}
          className="w-24"
        />
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

      {/* Auto-save delay (only visible when autoSave is on) — stored in ms, edited in seconds */}
      {editorSettings.autoSave && (
        <div className="flex items-center justify-between">
          <Label className="text-sm">{t('editor.auto_save_delay')}</Label>
          <Input
            type="number"
            min={AUTO_SAVE_DELAY_MIN_S}
            max={AUTO_SAVE_DELAY_MAX_S}
            step={0.5}
            value={editorSettings.autoSaveDelay / 1000}
            onChange={(e) => {
              const n = Number(e.target.value)
              if (Number.isFinite(n)) {
                const clamped = Math.min(AUTO_SAVE_DELAY_MAX_S, Math.max(AUTO_SAVE_DELAY_MIN_S, n))
                updateEditorSettings({ autoSaveDelay: Math.round(clamped * 1000) })
              }
            }}
            className="w-24"
          />
        </div>
      )}
    </div>
  )
}
