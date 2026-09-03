import { useState, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { BookOpen, Puzzle, Search } from 'lucide-react'
import { getPluginIcon, getPluginIconColorProps } from '@/features/settings/plugin-icon'
import { PluginReadmeSheet } from '@/components/PluginReadme'
import { hasPluginReadme } from '@/lib/plugins/plugin-readme'
import { LANG_BADGE, PLUGIN_CHIP_CLASS } from '@/lib/plugins/plugin-badges'
import { isBuiltinPluginId } from '@/lib/plugins/default-plugins'
import { Input } from '@/components/ui/input'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { localized } from '@/lib/localized'
import { getBadgeClasses, getBadgeStyle } from '@/features/projects/ProjectSettingsPage'
import { BadgeStrip } from '@/components/ui/badge-strip'
import type { Plugin, PluginBadge } from '@/types/plugin'

// ---------------------------------------------------------------------------
// Language badge constants
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// Fuzzy match helper
// ---------------------------------------------------------------------------

function fuzzyMatch(text: string, query: string): boolean {
  const lower = text.toLowerCase()
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  return words.every((w) => lower.includes(w))
}

// ---------------------------------------------------------------------------
// PluginPicker
// ---------------------------------------------------------------------------

interface PluginPickerProps {
  plugins: Plugin[]
  selectedPluginId: string
  onSelectPlugin: (plugin: Plugin) => void
  lang: 'en' | 'fr'
  /** Max height for the scrollable area. Default: "max-h-80" */
  maxHeight?: string
  /** When true, the picker stretches to fill available space in a flex parent. */
  fillHeight?: boolean
}

export function PluginPicker({
  plugins,
  selectedPluginId,
  onSelectPlugin,
  lang,
  maxHeight = 'max-h-80',
  fillHeight,
}: PluginPickerProps) {
  const { t } = useTranslation()
  const [searchQuery, setSearchQuery] = useState('')
  const [activeBadgeFilters, setActiveBadgeFilters] = useState<Set<string>>(new Set())
  const [readmePlugin, setReadmePlugin] = useState<Plugin | null>(null)

  // Collect all unique badges across plugins
  const allBadges = useMemo(() => {
    const map = new Map<string, PluginBadge>()
    for (const p of plugins) {
      for (const b of p.manifest.badges ?? []) {
        const key = localized(b.label, lang)
        if (!map.has(key)) map.set(key, b)
      }
    }
    return Array.from(map.values())
  }, [plugins, lang])

  // Filter plugins by search query and badge filters
  const filteredPlugins = useMemo(() => {
    return plugins.filter((p) => {
      const m = p.manifest
      if (activeBadgeFilters.size > 0) {
        const pluginBadgeLabels = new Set((m.badges ?? []).map(b => localized(b.label, lang)))
        const hasMatchingBadge = Array.from(activeBadgeFilters).some(f => pluginBadgeLabels.has(f))
        if (!hasMatchingBadge) return false
      }
      if (searchQuery.trim()) {
        const nameStr = m.name[lang] ?? m.name.en ?? ''
        const descStr = m.description[lang] ?? m.description.en ?? ''
        if (!fuzzyMatch(nameStr, searchQuery) && !fuzzyMatch(descStr, searchQuery)) return false
      }
      return true
    })
  }, [plugins, searchQuery, activeBadgeFilters, lang])

  const toggleBadgeFilter = (label: string) => {
    setActiveBadgeFilters((prev) => {
      const next = new Set(prev)
      if (next.has(label)) next.delete(label)
      else next.add(label)
      return next
    })
  }

  return (
    <div className={cn('flex flex-col gap-2', fillHeight && 'min-h-0 flex-1')}>
      {/* Search + Badge filters */}
      <div className="relative shrink-0">
        <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder={t('datasets.search_plugins')}
          className="h-8 pl-8 text-xs"
        />
      </div>
      {allBadges.length > 0 && (
        <div className="flex flex-wrap gap-1 shrink-0">
          {allBadges.map((badge) => {
            const badgeLabel = localized(badge.label, lang)
            return (
            <button
              key={badgeLabel}
              type="button"
              onClick={() => toggleBadgeFilter(badgeLabel)}
              className={cn(
                'shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium transition-all',
                activeBadgeFilters.has(badgeLabel)
                  ? 'ring-1 ring-ring ring-offset-1 ring-offset-background'
                  : 'opacity-70 hover:opacity-100',
                getBadgeClasses(badge.color),
              )}
              style={getBadgeStyle(badge.color)}
            >
              {badgeLabel}
            </button>
            )
          })}
        </div>
      )}

      {/* Plugin cards. `pr-2` keeps the last column clear of the overlay
          scrollbar, which paints over the cards rather than beside them. */}
      <div className={cn('pr-3', fillHeight ? 'min-h-0 flex-1 overflow-auto' : maxHeight, !fillHeight && 'overflow-auto')}>
        <div className="grid grid-cols-1 gap-3 p-0.5 sm:grid-cols-2 lg:grid-cols-3">
          {filteredPlugins.map((plugin) => {
            const m = plugin.manifest
            const Icon = getPluginIcon(m.icon)
            const iconColorProps = getPluginIconColorProps(m.iconColor)
            const isSelected = selectedPluginId === m.id
            const fullDesc = m.description[lang] ?? m.description.en ?? ''
            const hasReadme = hasPluginReadme(plugin)
            const isBuiltIn = isBuiltinPluginId(m.id)
            return (
              <button
                key={m.id}
                type="button"
                onClick={() => onSelectPlugin(plugin)}
                className={cn(
                  'flex flex-col gap-2 rounded-lg border bg-card p-4 text-left transition-all hover:bg-accent/50',
                  isSelected && 'border-primary ring-1 ring-primary bg-primary/5',
                )}
              >
                <div className="flex items-center gap-2">
                  <Icon size={18} className={cn('shrink-0', iconColorProps.className ?? 'text-muted-foreground')} style={iconColorProps.style} />
                  <span className="text-sm font-medium truncate flex-1">
                    {m.name[lang] ?? m.name.en}
                  </span>
                  {/* Same chips, same place, same height as the Plugins page. */}
                  {m.languages?.map((l) => {
                    const lb = LANG_BADGE[l]
                    if (!lb) return null
                    return (
                      <span key={l} className={cn(PLUGIN_CHIP_CLASS, lb.color)}>
                        {lb.label}
                      </span>
                    )
                  })}
                  {/* Only the way into the README. The old info tooltip repeated
                      the description, version and badges the card already shows. */}
                  {hasReadme && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span
                          role="button"
                          tabIndex={0}
                          aria-label={t('plugins.read_docs')}
                          className="shrink-0 cursor-pointer text-muted-foreground/60 transition-colors hover:text-foreground"
                          onClick={(e) => {
                            e.stopPropagation()
                            setReadmePlugin(plugin)
                          }}
                          onKeyDown={(e) => {
                            if (e.key !== 'Enter' && e.key !== ' ') return
                            e.preventDefault()
                            e.stopPropagation()
                            setReadmePlugin(plugin)
                          }}
                        >
                          <BookOpen size={14} />
                        </span>
                      </TooltipTrigger>
                      <TooltipContent side="right">{t('plugins.read_docs')}</TooltipContent>
                    </Tooltip>
                  )}
                </div>
                <p className="text-xs text-muted-foreground line-clamp-2">
                  {fullDesc}
                </p>
                {/* The author's own badges stay here; what the plugin *is* has
                    moved up beside the title. `isBuiltIn` reads the registry,
                    not `runtime`: a user plugin can be a component too, and used
                    to be mislabelled built-in. */}
                <div className="mt-auto flex items-center gap-1.5 pt-1">
                  {isBuiltIn && (
                    <span className={cn(PLUGIN_CHIP_CLASS, 'text-muted-foreground bg-muted')}>
                      {t('plugins.builtin_badge')}
                    </span>
                  )}
                  <BadgeStrip badges={m.badges ?? []} className="h-5 min-w-0 flex-1" />
                  <span className="shrink-0 text-[10px] text-muted-foreground">
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

      <PluginReadmeSheet
        plugin={readmePlugin}
        open={readmePlugin !== null}
        onOpenChange={(open) => { if (!open) setReadmePlugin(null) }}
      />
    </div>
  )
}
