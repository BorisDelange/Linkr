import { useState, useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import * as LucideIcons from 'lucide-react'
import { Puzzle, Search } from 'lucide-react'
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
import { getBadgeClasses, getBadgeStyle } from '@/features/projects/ProjectSettingsPage'
import { useDatasetStore } from '@/stores/dataset-store'
import { getAllAnalysisPlugins } from '@/lib/analysis-plugins/registry'
import type { AnalysisPlugin, PluginBadge } from '@/types/analysis-plugin'
import type { AnalysisLanguage, BadgeColor } from '@/types'

interface CreateAnalysisDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  datasetFileId: string
}

// ---------------------------------------------------------------------------
// Icon helpers
// ---------------------------------------------------------------------------

function getPluginIcon(iconName: string): LucideIcons.LucideIcon {
  const icon = (LucideIcons as Record<string, unknown>)[iconName]
  if (typeof icon === 'object' && icon !== null) return icon as LucideIcons.LucideIcon
  return Puzzle
}

const ICON_COLOR_CLASS: Record<string, string> = {
  red: 'text-red-500', blue: 'text-blue-500', green: 'text-green-500',
  violet: 'text-violet-500', amber: 'text-amber-500', rose: 'text-rose-500',
  cyan: 'text-cyan-500', slate: 'text-slate-500',
}

function getIconColorProps(iconColor?: BadgeColor): { className?: string; style?: React.CSSProperties } {
  if (!iconColor) return {}
  const tw = ICON_COLOR_CLASS[iconColor]
  if (tw) return { className: tw }
  return { style: { color: iconColor } }
}

// ---------------------------------------------------------------------------
// Language options
// ---------------------------------------------------------------------------

const LANG_BADGE: Record<string, { label: string; color: string }> = {
  python: { label: 'PY', color: 'text-yellow-500 bg-yellow-500/10' },
  r: { label: 'R', color: 'text-blue-500 bg-blue-500/10' },
  'js-widget': { label: 'JS', color: 'text-amber-500 bg-amber-500/10' },
}

const LANGUAGE_LABELS: Record<AnalysisLanguage, { en: string; fr: string }> = {
  python: { en: 'Python', fr: 'Python' },
  r: { en: 'R', fr: 'R' },
  'js-widget': { en: 'JS Widget', fr: 'Widget JS' },
}

function getAvailableLanguages(plugin: AnalysisPlugin): AnalysisLanguage[] {
  const langs: AnalysisLanguage[] = []
  if (plugin.manifest.runtime.includes('script')) {
    for (const l of plugin.manifest.languages) langs.push(l)
  }
  if (plugin.manifest.runtime.includes('js-widget')) langs.push('js-widget')
  return langs
}

// ---------------------------------------------------------------------------
// Fuzzy match helper
// ---------------------------------------------------------------------------

function fuzzyMatch(text: string, query: string): boolean {
  const lower = text.toLowerCase()
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  return words.every((w) => lower.includes(w))
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
  const [searchQuery, setSearchQuery] = useState('')
  const [activeBadgeFilters, setActiveBadgeFilters] = useState<Set<string>>(new Set())

  const selectedPlugin = plugins.find(p => p.manifest.id === selectedPluginId)
  const availableLanguages = selectedPlugin ? getAvailableLanguages(selectedPlugin) : []

  // Collect all unique badges across plugins
  const allBadges = useMemo(() => {
    const map = new Map<string, PluginBadge>()
    for (const p of plugins) {
      for (const b of p.manifest.badges ?? []) {
        if (!map.has(b.label)) map.set(b.label, b)
      }
    }
    return Array.from(map.values())
  }, [plugins])

  // Filter plugins by search query and badge filters
  const filteredPlugins = useMemo(() => {
    return plugins.filter((p) => {
      const m = p.manifest
      // Badge filter
      if (activeBadgeFilters.size > 0) {
        const pluginBadgeLabels = new Set((m.badges ?? []).map(b => b.label))
        const hasMatchingBadge = Array.from(activeBadgeFilters).some(f => pluginBadgeLabels.has(f))
        if (!hasMatchingBadge) return false
      }
      // Text filter (fuzzy on name and description)
      if (searchQuery.trim()) {
        const nameStr = m.name[lang] ?? m.name.en ?? ''
        const descStr = m.description[lang] ?? m.description.en ?? ''
        if (!fuzzyMatch(nameStr, searchQuery) && !fuzzyMatch(descStr, searchQuery)) return false
      }
      return true
    })
  }, [plugins, searchQuery, activeBadgeFilters, lang])

  // Set defaults when dialog opens
  useEffect(() => {
    if (open && plugins.length > 0) {
      const first = plugins[0]
      setSelectedPluginId(first.manifest.id)
      const langs = getAvailableLanguages(first)
      setSelectedLanguage(langs[0] ?? 'python')
      setName(first.manifest.name[lang] ?? first.manifest.name.en)
      setSearchQuery('')
      setActiveBadgeFilters(new Set())
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

  const toggleBadgeFilter = (label: string) => {
    setActiveBadgeFilters((prev) => {
      const next = new Set(prev)
      if (next.has(label)) next.delete(label)
      else next.add(label)
      return next
    })
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

        {/* Search + Badge filters */}
        <div className="space-y-2">
          <div className="relative">
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={t('datasets.search_plugins')}
              className="h-8 pl-8 text-xs"
            />
          </div>
          {allBadges.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {allBadges.map((badge) => (
                <button
                  key={badge.label}
                  type="button"
                  onClick={() => toggleBadgeFilter(badge.label)}
                  className={cn(
                    'shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium transition-all',
                    activeBadgeFilters.has(badge.label)
                      ? 'ring-1 ring-ring ring-offset-1 ring-offset-background'
                      : 'opacity-70 hover:opacity-100',
                    getBadgeClasses(badge.color),
                  )}
                  style={getBadgeStyle(badge.color)}
                >
                  {badge.label}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Plugin cards — same layout as PluginsTab */}
        <div className="max-h-72 overflow-auto">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {filteredPlugins.map((plugin) => {
              const m = plugin.manifest
              const Icon = getPluginIcon(m.icon)
              const iconColorProps = getIconColorProps(m.iconColor)
              const isSelected = selectedPluginId === m.id
              return (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => handleSelectPlugin(plugin)}
                  className={cn(
                    'flex flex-col gap-2 rounded-lg border bg-card p-4 text-left transition-all hover:bg-accent/50',
                    isSelected && 'border-primary ring-1 ring-primary bg-primary/5',
                  )}
                >
                  <div className="flex items-center gap-2">
                    <Icon size={18} className={cn('shrink-0', iconColorProps.className ?? 'text-muted-foreground')} style={iconColorProps.style} />
                    <span className="text-sm font-medium truncate">
                      {m.name[lang] ?? m.name.en}
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground line-clamp-2">
                    {m.description[lang] ?? m.description.en}
                  </p>
                  <div className="flex items-center gap-1 flex-wrap">
                    {m.languages?.map((l) => {
                      const lb = LANG_BADGE[l]
                      if (!lb) return null
                      return (
                        <span key={l} className={cn('shrink-0 rounded px-1 py-px text-[9px] font-medium leading-none', lb.color)}>
                          {lb.label}
                        </span>
                      )
                    })}
                    {m.runtime?.includes('js-widget') && (
                      <span className={cn('shrink-0 rounded px-1 py-px text-[9px] font-medium leading-none', LANG_BADGE['js-widget'].color)}>
                        {LANG_BADGE['js-widget'].label}
                      </span>
                    )}
                    {m.badges?.map((badge) => (
                      <span
                        key={badge.id}
                        className={cn('shrink-0 rounded-full px-1.5 py-px text-[9px] font-medium leading-none', getBadgeClasses(badge.color))}
                        style={getBadgeStyle(badge.color)}
                      >
                        {badge.label}
                      </span>
                    ))}
                    <span className="ml-auto text-[10px] text-muted-foreground shrink-0">
                      v{m.version ?? '1.0.0'}
                    </span>
                  </div>
                </button>
              )
            })}
          </div>
          {filteredPlugins.length === 0 && (
            <div className="flex flex-col items-center justify-center py-8 text-center">
              <Puzzle size={28} className="text-muted-foreground/30" />
              <p className="mt-2 text-sm text-muted-foreground">{t('datasets.no_plugins_match')}</p>
            </div>
          )}
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
