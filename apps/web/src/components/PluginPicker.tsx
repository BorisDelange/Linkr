import { useState, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import * as LucideIcons from 'lucide-react'
import { Info, Puzzle, Search } from 'lucide-react'
import { Input } from '@/components/ui/input'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { getBadgeClasses, getBadgeStyle } from '@/features/projects/ProjectSettingsPage'
import type { Plugin, PluginBadge } from '@/types/plugin'
import type { BadgeColor } from '@/types'

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
// Language badge constants
// ---------------------------------------------------------------------------

export const LANG_BADGE: Record<string, { label: string; color: string }> = {
  python: { label: 'PY', color: 'text-yellow-500 bg-yellow-500/10' },
  r: { label: 'R', color: 'text-blue-500 bg-blue-500/10' },
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
// PluginPicker
// ---------------------------------------------------------------------------

interface PluginPickerProps {
  plugins: Plugin[]
  selectedPluginId: string
  onSelectPlugin: (plugin: Plugin) => void
  lang: 'en' | 'fr'
  /** Max height for the scrollable area. Default: "max-h-80" */
  maxHeight?: string
}

export function PluginPicker({
  plugins,
  selectedPluginId,
  onSelectPlugin,
  lang,
  maxHeight = 'max-h-80',
}: PluginPickerProps) {
  const { t } = useTranslation()
  const [searchQuery, setSearchQuery] = useState('')
  const [activeBadgeFilters, setActiveBadgeFilters] = useState<Set<string>>(new Set())

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
      if (activeBadgeFilters.size > 0) {
        const pluginBadgeLabels = new Set((m.badges ?? []).map(b => b.label))
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
    <div className="space-y-2">
      {/* Search + Badge filters */}
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

      {/* Plugin cards */}
      <div className={cn(maxHeight, 'overflow-auto')}>
        <div className="grid grid-cols-1 gap-3 p-0.5 sm:grid-cols-2 lg:grid-cols-3">
          {filteredPlugins.map((plugin) => {
            const m = plugin.manifest
            const Icon = getPluginIcon(m.icon)
            const iconColorProps = getIconColorProps(m.iconColor)
            const isSelected = selectedPluginId === m.id
            const fullDesc = m.description[lang] ?? m.description.en ?? ''
            const deps = m.dependencies
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
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span
                        className="shrink-0 text-muted-foreground/50 hover:text-muted-foreground transition-colors"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <Info size={13} />
                      </span>
                    </TooltipTrigger>
                    <TooltipContent side="right" className="max-w-xs text-xs space-y-1.5 p-3">
                      <p className="font-medium">{m.name[lang] ?? m.name.en}</p>
                      <p className="text-muted-foreground">{fullDesc}</p>
                      <div className="flex items-center gap-2 text-muted-foreground">
                        <span>v{m.version ?? '1.0.0'}</span>
                        {m.category && <span>· {m.category}</span>}
                      </div>
                      {deps && Object.keys(deps).length > 0 && (
                        <p className="text-muted-foreground">
                          Deps: {Object.entries(deps).map(([k, v]) => `${k}${v ? `@${v}` : ''}`).join(', ')}
                        </p>
                      )}
                    </TooltipContent>
                  </Tooltip>
                </div>
                <p className="text-xs text-muted-foreground line-clamp-2">
                  {fullDesc}
                </p>
                <div className="flex items-center gap-1 flex-wrap">
                  {m.runtime?.includes('component') && (
                    <span className="shrink-0 rounded px-1 py-px text-[9px] font-medium leading-none text-emerald-500 bg-emerald-500/10">
                      REACT
                    </span>
                  )}
                  {m.languages?.map((l) => {
                    const lb = LANG_BADGE[l]
                    if (!lb) return null
                    return (
                      <span key={l} className={cn('shrink-0 rounded px-1 py-px text-[9px] font-medium leading-none', lb.color)}>
                        {lb.label}
                      </span>
                    )
                  })}
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
    </div>
  )
}
