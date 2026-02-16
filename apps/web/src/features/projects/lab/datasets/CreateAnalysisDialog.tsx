import { useState, useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import {
  TableIcon, BarChart3, FileText, GitCompareArrows, Grid3X3,
  type LucideIcon, Puzzle,
} from 'lucide-react'
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
import { cn } from '@/lib/utils'
import { useDatasetStore } from '@/stores/dataset-store'
import { getAllAnalysisPlugins } from '@/lib/analysis-plugins/registry'
import type { AnalysisPlugin } from '@/types/analysis-plugin'
import type { AnalysisLanguage } from '@/types'

interface CreateAnalysisDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  datasetFileId: string
}

// ---------------------------------------------------------------------------
// Icon mapping: plugin manifest icon string → Lucide component
// ---------------------------------------------------------------------------

const ICON_MAP: Record<string, LucideIcon> = {
  TableIcon,
  BarChart3,
  FileText,
  GitCompareArrows,
  Grid3X3,
}

function getPluginIcon(iconName: string): LucideIcon {
  return ICON_MAP[iconName] ?? Puzzle
}

// ---------------------------------------------------------------------------
// Mini preview illustrations (keyed by plugin ID for the default plugins)
// ---------------------------------------------------------------------------

function Table1Preview() {
  return (
    <div className="w-full text-[8px] leading-tight">
      <div className="grid grid-cols-3 gap-px">
        <div className="bg-muted px-1 py-0.5 font-medium">Variable</div>
        <div className="bg-muted px-1 py-0.5 font-medium text-center">n (%)</div>
        <div className="bg-muted px-1 py-0.5 font-medium text-center">Mean ± SD</div>
        <div className="px-1 py-0.5 text-muted-foreground">Age</div>
        <div className="px-1 py-0.5 text-center text-muted-foreground">—</div>
        <div className="px-1 py-0.5 text-center text-muted-foreground">63.2 ± 15.1</div>
        <div className="px-1 py-0.5 text-muted-foreground">Sex (M)</div>
        <div className="px-1 py-0.5 text-center text-muted-foreground">54 (62%)</div>
        <div className="px-1 py-0.5 text-center text-muted-foreground">—</div>
      </div>
    </div>
  )
}

function DistributionPreview() {
  const bars = [3, 5, 8, 12, 15, 11, 7, 4, 2]
  const max = Math.max(...bars)
  return (
    <div className="flex h-10 w-full items-end gap-px">
      {bars.map((h, i) => (
        <div
          key={i}
          className="flex-1 rounded-t-sm bg-primary/40"
          style={{ height: `${(h / max) * 100}%` }}
        />
      ))}
    </div>
  )
}

function SummaryPreview() {
  return (
    <div className="w-full space-y-0.5 text-[8px] leading-tight">
      <div className="flex justify-between text-muted-foreground"><span>Rows</span><span>100</span></div>
      <div className="flex justify-between text-muted-foreground"><span>Columns</span><span>14</span></div>
      <div className="flex justify-between text-muted-foreground"><span>Numeric</span><span>9</span></div>
      <div className="flex justify-between text-muted-foreground"><span>Missing</span><span>0.2%</span></div>
    </div>
  )
}

function CorrelationPreview() {
  const cells = [
    [1.00, 0.85, -0.12],
    [0.85, 1.00, -0.34],
    [-0.12, -0.34, 1.00],
  ]
  return (
    <div className="w-full text-[8px] leading-tight">
      <div className="grid grid-cols-4 gap-px">
        <div />
        <div className="text-center text-muted-foreground">x</div>
        <div className="text-center text-muted-foreground">y</div>
        <div className="text-center text-muted-foreground">z</div>
        {['x', 'y', 'z'].map((label, i) => (
          <div key={label} className="contents">
            <div className="text-muted-foreground">{label}</div>
            {cells[i].map((v, j) => (
              <div
                key={j}
                className="text-center"
                style={{ color: v > 0.5 ? 'rgb(59,130,246)' : v < -0.2 ? 'rgb(239,68,68)' : undefined }}
              >
                {v.toFixed(2)}
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}

function CrossTabPreview() {
  return (
    <div className="w-full text-[8px] leading-tight">
      <div className="grid grid-cols-4 gap-px">
        <div />
        <div className="bg-muted px-1 py-0.5 text-center font-medium">M</div>
        <div className="bg-muted px-1 py-0.5 text-center font-medium">F</div>
        <div className="bg-muted px-1 py-0.5 text-center font-medium">Total</div>
        <div className="px-1 py-0.5 text-muted-foreground">ICU</div>
        <div className="px-1 py-0.5 text-center text-muted-foreground">24</div>
        <div className="px-1 py-0.5 text-center text-muted-foreground">18</div>
        <div className="px-1 py-0.5 text-center font-medium">42</div>
        <div className="px-1 py-0.5 text-muted-foreground">Ward</div>
        <div className="px-1 py-0.5 text-center text-muted-foreground">30</div>
        <div className="px-1 py-0.5 text-center text-muted-foreground">28</div>
        <div className="px-1 py-0.5 text-center font-medium">58</div>
      </div>
    </div>
  )
}

const PREVIEW_MAP: Record<string, React.ReactNode> = {
  'linkr-analysis-table1': <Table1Preview />,
  'linkr-analysis-distribution': <DistributionPreview />,
  'linkr-analysis-summary': <SummaryPreview />,
  'linkr-analysis-correlation': <CorrelationPreview />,
  'linkr-analysis-crosstab': <CrossTabPreview />,
}

// ---------------------------------------------------------------------------
// Language options for the selector
// ---------------------------------------------------------------------------

const LANGUAGE_LABELS: Record<AnalysisLanguage, { en: string; fr: string }> = {
  python: { en: 'Python', fr: 'Python' },
  r: { en: 'R', fr: 'R' },
  'js-widget': { en: 'JS Widget', fr: 'Widget JS' },
}

function getAvailableLanguages(plugin: AnalysisPlugin): AnalysisLanguage[] {
  const langs: AnalysisLanguage[] = []
  if (plugin.manifest.runtime.includes('script')) {
    for (const l of plugin.manifest.languages) {
      langs.push(l)
    }
  }
  if (plugin.manifest.runtime.includes('js-widget')) {
    langs.push('js-widget')
  }
  return langs
}

// ---------------------------------------------------------------------------
// Dialog
// ---------------------------------------------------------------------------

export function CreateAnalysisDialog({ open, onOpenChange, datasetFileId }: CreateAnalysisDialogProps) {
  const { t, i18n } = useTranslation()
  const lang = i18n.language as 'en' | 'fr'
  const { analyses, createAnalysis } = useDatasetStore()

  const plugins = useMemo(() => getAllAnalysisPlugins(), [])
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

  // Update language and name when plugin changes
  const handleSelectPlugin = (plugin: AnalysisPlugin) => {
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
    createAnalysis(datasetFileId, trimmed, selectedPlugin.manifest.id, { language: selectedLanguage })
    setName('')
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{t('datasets.new_analysis')}</DialogTitle>
          <DialogDescription>{t('datasets.new_analysis_description')}</DialogDescription>
        </DialogHeader>

        {/* Type selection cards */}
        <div className="grid grid-cols-3 gap-2 py-2 sm:grid-cols-5">
          {plugins.map((plugin) => {
            const m = plugin.manifest
            const Icon = getPluginIcon(m.icon)
            const preview = PREVIEW_MAP[m.id]
            return (
              <button
                key={m.id}
                onClick={() => handleSelectPlugin(plugin)}
                className={cn(
                  'flex flex-col rounded-lg border p-3 text-left transition-all hover:bg-accent/50',
                  selectedPluginId === m.id && 'border-primary ring-1 ring-primary bg-primary/5',
                )}
              >
                <div className="mb-2 flex items-center gap-2">
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-muted">
                    <Icon size={20} />
                  </div>
                  <div className="min-w-0">
                    <p className="text-xs font-medium">{m.name[lang] ?? m.name.en}</p>
                  </div>
                </div>
                <p className="mb-2 text-[10px] text-muted-foreground">
                  {m.description[lang] ?? m.description.en}
                </p>
                {preview && (
                  <div className="rounded border bg-muted/30 p-1.5">{preview}</div>
                )}
              </button>
            )
          })}
        </div>

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
