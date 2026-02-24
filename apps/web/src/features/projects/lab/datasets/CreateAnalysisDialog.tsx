import { useState, useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
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
import { PluginPicker } from '@/components/PluginPicker'
import { useDatasetStore } from '@/stores/dataset-store'
import { getLabPlugins } from '@/lib/plugins/registry'
import type { Plugin } from '@/types/plugin'
import type { AnalysisLanguage } from '@/types'

interface CreateAnalysisDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  datasetFileId: string
}

// ---------------------------------------------------------------------------
// Language helpers
// ---------------------------------------------------------------------------

const LANGUAGE_LABELS: Record<AnalysisLanguage, { en: string; fr: string }> = {
  python: { en: 'Python', fr: 'Python' },
  r: { en: 'R', fr: 'R' },
}

function getAvailableLanguages(plugin: Plugin): AnalysisLanguage[] {
  const langs: AnalysisLanguage[] = []
  for (const l of plugin.manifest.languages) langs.push(l)
  return langs
}

// ---------------------------------------------------------------------------
// Dialog
// ---------------------------------------------------------------------------

export function CreateAnalysisDialog({ open, onOpenChange, datasetFileId }: CreateAnalysisDialogProps) {
  const { t, i18n } = useTranslation()
  const lang = i18n.language as 'en' | 'fr'
  const { analyses, createAnalysis } = useDatasetStore()

  const plugins = useMemo(() => getLabPlugins(), [])
  const [selectedPluginId, setSelectedPluginId] = useState<string>('')
  const [selectedLanguage, setSelectedLanguage] = useState<AnalysisLanguage>('python')
  const [name, setName] = useState('')

  const selectedPlugin = plugins.find(p => p.manifest.id === selectedPluginId)
  const availableLanguages = selectedPlugin ? getAvailableLanguages(selectedPlugin) : []

  // Set defaults when dialog opens
  useEffect(() => {
    if (open && plugins.length > 0) {
      const first = plugins[0]
      setSelectedPluginId(first.manifest.id)
      const langs = getAvailableLanguages(first)
      setSelectedLanguage(langs[0] ?? 'python')
      setName(first.manifest.name[lang] ?? first.manifest.name.en)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const handleSelectPlugin = (plugin: Plugin) => {
    const prevPlugin = plugins.find(p => p.manifest.id === selectedPluginId)
    const isDefaultName =
      !name.trim() ||
      (prevPlugin && (name.trim() === (prevPlugin.manifest.name[lang] ?? prevPlugin.manifest.name.en)))

    setSelectedPluginId(plugin.manifest.id)
    const langs = getAvailableLanguages(plugin)
    if (!langs.includes(selectedLanguage)) {
      setSelectedLanguage(langs[0] ?? 'python')
    }
    if (isDefaultName) {
      setName(plugin.manifest.name[lang] ?? plugin.manifest.name.en)
    }
  }

  const nameExists = analyses.some(
    (a) => a.datasetFileId === datasetFileId && a.name.toLowerCase() === name.trim().toLowerCase(),
  )

  const handleCreate = () => {
    const trimmed = name.trim()
    if (!trimmed || nameExists || !selectedPlugin) return
    const isComponent = selectedPlugin.manifest.runtime.includes('component')
    const initialConfig = isComponent ? {} : { language: selectedLanguage }
    createAnalysis(datasetFileId, trimmed, selectedPlugin.manifest.id, initialConfig)
    setName('')
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-5xl h-[85vh] max-h-[85vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle>{t('datasets.new_analysis')}</DialogTitle>
          <DialogDescription>{t('datasets.new_analysis_description')}</DialogDescription>
        </DialogHeader>

        <PluginPicker
          plugins={plugins}
          selectedPluginId={selectedPluginId}
          onSelectPlugin={handleSelectPlugin}
          lang={lang}
          fillHeight
        />

        {/* Language selector (only shown if plugin supports multiple modes) */}
        {availableLanguages.length > 1 && (
          <div className="space-y-1.5">
            <Label>{t('datasets.select_runtime')}</Label>
            <Select
              value={selectedLanguage}
              onValueChange={v => setSelectedLanguage(v as AnalysisLanguage)}
            >
              <SelectTrigger className="h-8 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {availableLanguages.map(l => (
                  <SelectItem key={l} value={l}>
                    {LANGUAGE_LABELS[l]?.[lang] ?? l}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        {/* Name input */}
        <div className="space-y-1.5">
          <Label htmlFor="analysis-name">{t('datasets.name')}</Label>
          <Input
            id="analysis-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={selectedPlugin?.manifest.name[lang] ?? ''}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleCreate()
            }}
          />
          {nameExists && (
            <p className="text-xs text-destructive">{t('datasets.analysis_name_exists')}</p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('common.cancel')}
          </Button>
          <Button onClick={handleCreate} disabled={!name.trim() || nameExists}>
            {t('common.create')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
