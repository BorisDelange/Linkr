import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'

// ---------------------------------------------------------------------------
// Shared color palette — exported so other components can reuse it
// ---------------------------------------------------------------------------

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

// 19 presets + 1 custom picker = 20 items → 5 columns × 4 rows (perfect rectangle)
export const COLOR_PALETTE = [
  // Row 1: neutral + warm reds
  { name: 'none', bg: 'bg-foreground/10 border border-border', ring: 'ring-foreground/30', hex: '#000000' },
  { name: 'slate', bg: 'bg-slate-500', ring: 'ring-slate-500', hex: '#64748b' },
  { name: 'red', bg: 'bg-red-500', ring: 'ring-red-500', hex: '#ef4444' },
  { name: 'rose', bg: 'bg-rose-500', ring: 'ring-rose-500', hex: '#f43f5e' },
  { name: 'pink', bg: 'bg-pink-500', ring: 'ring-pink-500', hex: '#ec4899' },
  // Row 2: warm → yellow
  { name: 'fuchsia', bg: 'bg-fuchsia-500', ring: 'ring-fuchsia-500', hex: '#d946ef' },
  { name: 'orange', bg: 'bg-orange-500', ring: 'ring-orange-500', hex: '#f97316' },
  { name: 'amber', bg: 'bg-amber-500', ring: 'ring-amber-500', hex: '#f59e0b' },
  { name: 'yellow', bg: 'bg-yellow-500', ring: 'ring-yellow-500', hex: '#eab308' },
  { name: 'lime', bg: 'bg-lime-500', ring: 'ring-lime-500', hex: '#84cc16' },
  // Row 3: greens → cyan
  { name: 'green', bg: 'bg-green-500', ring: 'ring-green-500', hex: '#22c55e' },
  { name: 'emerald', bg: 'bg-emerald-500', ring: 'ring-emerald-500', hex: '#10b981' },
  { name: 'teal', bg: 'bg-teal-500', ring: 'ring-teal-500', hex: '#14b8a6' },
  { name: 'cyan', bg: 'bg-cyan-500', ring: 'ring-cyan-500', hex: '#06b6d4' },
  { name: 'sky', bg: 'bg-sky-500', ring: 'ring-sky-500', hex: '#0ea5e9' },
  // Row 4: blues → purples (custom picker fills the 20th slot)
  { name: 'blue', bg: 'bg-blue-500', ring: 'ring-blue-500', hex: '#3b82f6' },
  { name: 'indigo', bg: 'bg-indigo-500', ring: 'ring-indigo-500', hex: '#6366f1' },
  { name: 'violet', bg: 'bg-violet-500', ring: 'ring-violet-500', hex: '#8b5cf6' },
  { name: 'purple', bg: 'bg-purple-500', ring: 'ring-purple-500', hex: '#a855f7' },
]

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ColorPickerSpecialOption {
  value: string
  label: { en: string; fr: string } | string
}

interface ColorPickerPopoverProps {
  value: string
  onChange: (value: string) => void
  /** Special options shown before the palette (e.g. "auto", "none") */
  specialOptions?: ColorPickerSpecialOption[]
  /** Label shown above the trigger */
  label?: string
  className?: string
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ColorPickerPopover({
  value,
  onChange,
  specialOptions,
  label,
  className,
}: ColorPickerPopoverProps) {
  const { i18n } = useTranslation()
  const lang = i18n.language as 'en' | 'fr'
  const [open, setOpen] = useState(false)

  const isCustomHex = value.startsWith('#')
  const isSpecial = specialOptions?.some(o => o.value === value) ?? false
  const paletteEntry = COLOR_PALETTE.find(c => c.name === value)

  // Resolve display for the trigger button
  const triggerBg = isCustomHex
    ? undefined
    : paletteEntry
      ? paletteEntry.bg
      : isSpecial
        ? 'bg-foreground/10 border border-dashed border-border'
        : 'bg-foreground/10 border border-border'

  const triggerStyle: React.CSSProperties = isCustomHex ? { backgroundColor: value } : {}

  const specialLabel = isSpecial
    ? (() => {
        const opt = specialOptions!.find(o => o.value === value)!
        return typeof opt.label === 'string' ? opt.label : opt.label[lang] ?? opt.label.en
      })()
    : null

  return (
    <div className={cn('space-y-1', className)}>
      {label && <span className="text-xs text-muted-foreground">{label}</span>}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            className={cn(
              'flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs transition-colors hover:bg-accent/50',
              'h-7 min-w-0',
            )}
          >
            <span
              className={cn('size-4 shrink-0 rounded-full', triggerBg)}
              style={triggerStyle}
            />
            <span className="truncate text-muted-foreground">
              {specialLabel ?? (isCustomHex ? value : capitalize(paletteEntry?.name ?? value))}
            </span>
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-auto p-3" align="start" sideOffset={4}>
          <div className="space-y-2">
            {/* Special options */}
            {specialOptions && specialOptions.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {specialOptions.map(opt => {
                  const optLabel = typeof opt.label === 'string' ? opt.label : opt.label[lang] ?? opt.label.en
                  const isSelected = value === opt.value
                  return (
                    <button
                      key={opt.value}
                      onClick={() => { onChange(opt.value); setOpen(false) }}
                      className={cn(
                        'rounded-md border px-2 py-0.5 text-[10px] transition-colors',
                        isSelected
                          ? 'bg-accent text-accent-foreground font-medium border-accent-foreground/20'
                          : 'text-muted-foreground hover:bg-accent/50',
                      )}
                    >
                      {optLabel}
                    </button>
                  )
                })}
              </div>
            )}

            {/* Color palette grid — 5 columns × 4 rows */}
            <div className="grid grid-cols-5 gap-1.5">
              {COLOR_PALETTE.map(c => {
                const isSelected = c.name === value
                return (
                  <button
                    key={c.name}
                    onClick={() => { onChange(c.name); setOpen(false) }}
                    title={c.name}
                    className={cn(
                      'size-5 rounded-full transition-all',
                      c.bg,
                      isSelected && `ring-2 ${c.ring} ring-offset-1 ring-offset-background`,
                    )}
                  />
                )
              })}
              {/* Custom color picker */}
              <label
                title="Custom"
                className={cn(
                  'relative size-5 rounded-full cursor-pointer transition-all overflow-hidden',
                  'bg-[conic-gradient(red,yellow,lime,aqua,blue,magenta,red)]',
                  isCustomHex && 'ring-2 ring-foreground/50 ring-offset-1 ring-offset-background',
                )}
              >
                <input
                  type="color"
                  value={isCustomHex ? value : '#2563eb'}
                  onChange={e => { onChange(e.target.value) }}
                  className="absolute inset-0 opacity-0 cursor-pointer"
                />
              </label>
            </div>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  )
}
