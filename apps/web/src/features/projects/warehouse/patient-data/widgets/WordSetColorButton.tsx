import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { WORD_SET_COLORS, wordSetColorIndex } from './word-set-colors'

interface WordSetColorButtonProps {
  /** Position in the list, used while the set has no colour of its own. */
  setIndex: number
  value: string | undefined
  onChange: (color: string) => void
}

/**
 * Colour picker for a word set: the same swatch-opens-a-popover shape as
 * `BadgeColorButton`, over the highlight palette instead of the badge presets.
 *
 * It cannot be `BadgeColorButton` itself: that one offers an arbitrary hex, and
 * a highlight needs a light AND a dark rendering to sit behind note text in
 * either theme. The palette supplies both; a hex supplies neither.
 */
export function WordSetColorButton({ setIndex, value, onChange }: WordSetColorButtonProps) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const current = wordSetColorIndex(setIndex, value)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={t('patient_data.notes_set_color')}
          title={t('patient_data.notes_set_color')}
          className="flex size-7 shrink-0 items-center justify-center rounded-md border transition-colors hover:bg-accent/50"
        >
          <span className={cn('size-4 rounded-sm', WORD_SET_COLORS[current].bg)} />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" sideOffset={4} className="w-auto p-2">
        <div className="flex items-center gap-1.5">
          {WORD_SET_COLORS.map((c, i) => (
            <button
              key={c.name}
              type="button"
              title={c.name}
              onClick={() => { onChange(c.name); setOpen(false) }}
              className={cn(
                'flex size-6 items-center justify-center rounded-full ring-offset-background transition-all',
                c.bg,
                i === current
                  ? 'ring-2 ring-ring ring-offset-2'
                  : 'hover:ring-1 hover:ring-ring hover:ring-offset-1',
              )}
            >
              {i === current && <Check size={12} className="text-foreground/70" />}
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  )
}
