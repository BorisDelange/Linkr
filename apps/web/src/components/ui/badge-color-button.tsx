import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { PRESET_COLORS, isCustomColor } from '@/lib/badge-colors'
import type { BadgeColor } from '@/types'
import { cn } from '@/lib/utils'

interface BadgeColorButtonProps {
  value: BadgeColor
  onChange: (color: BadgeColor) => void
  className?: string
}

/**
 * Compact color selector for badges: a single swatch button that opens a popover
 * with the preset palette + a custom hex picker. Keeps the badge-add row on one
 * line instead of spreading every swatch across it.
 */
export function BadgeColorButton({ value, onChange, className }: BadgeColorButtonProps) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const custom = isCustomColor(value)
  const preset = PRESET_COLORS.find((c) => c.value === value)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={t('project_settings.badge_color', { defaultValue: 'Badge color' })}
          title={t('project_settings.badge_color', { defaultValue: 'Badge color' })}
          className={cn(
            'flex size-8 shrink-0 items-center justify-center rounded-md border transition-colors hover:bg-accent/50',
            className,
          )}
        >
          <span
            className={cn('size-4 rounded-full', preset?.swatch)}
            style={custom ? { backgroundColor: value } : undefined}
          />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" sideOffset={4} className="w-auto p-2">
        <div className="flex items-center gap-1.5">
          {PRESET_COLORS.map((c) => (
            <button
              key={c.value}
              type="button"
              title={c.value}
              onClick={() => { onChange(c.value); setOpen(false) }}
              className={cn(
                'flex size-6 items-center justify-center rounded-full ring-offset-background transition-all',
                c.swatch,
                value === c.value ? 'ring-2 ring-ring ring-offset-2' : 'hover:ring-1 hover:ring-ring hover:ring-offset-1',
              )}
            >
              {value === c.value && <Check size={12} className="text-white drop-shadow" />}
            </button>
          ))}
          {/* Custom hex picker */}
          <label
            title={t('common.auto', { defaultValue: 'Custom' })}
            className={cn(
              'relative size-6 cursor-pointer overflow-hidden rounded-full ring-offset-background transition-all',
              'bg-[conic-gradient(red,yellow,lime,aqua,blue,magenta,red)]',
              custom ? 'ring-2 ring-ring ring-offset-2' : 'hover:ring-1 hover:ring-ring hover:ring-offset-1',
            )}
          >
            <input
              type="color"
              value={custom ? value : '#6366f1'}
              onChange={(e) => onChange(e.target.value)}
              className="absolute inset-0 cursor-pointer opacity-0"
            />
          </label>
        </div>
      </PopoverContent>
    </Popover>
  )
}
