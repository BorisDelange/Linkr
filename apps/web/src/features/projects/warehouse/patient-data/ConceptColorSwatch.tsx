import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Popover, PopoverContent, PopoverTrigger,
} from '@/components/ui/popover'
import { COLOR_PALETTE } from '@/components/ui/color-picker-popover'
import { defaultConceptColorName } from '@/lib/concept-colors'
import { cn } from '@/lib/utils'

/**
 * Compact swatch-only color picker for one picked series.
 *
 * Reuses the shared COLOR_PALETTE so a concept and a dataset series picked side by
 * side offer the same colours the dashboard plugins do. `value` is a palette name
 * or a hex; `undefined` means "auto" — the rotating default palette.
 */
export function ConceptColorSwatch({
  value,
  index,
  onChange,
}: {
  value: string | undefined
  /** Position in the selection: drives the auto colour when none is set. */
  index: number
  onChange: (color: string | undefined) => void
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  // With no explicit choice the swatch shows the colour the chart will actually
  // use, not an empty grey circle that reads as "no colour".
  const effective = value ?? defaultConceptColorName(index)
  const entry = COLOR_PALETTE.find((c) => c.name === effective)
  const isHex = effective.startsWith('#')

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="size-4 shrink-0 rounded-full border border-border"
          style={isHex ? { backgroundColor: effective } : undefined}
          title={t('patient_data.concept_color')}
          onClick={(e) => e.stopPropagation()}
        >
          {!isHex && (
            <span
              className={cn(
                'block size-full rounded-full',
                entry ? entry.bg : 'bg-foreground/15',
              )}
            />
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent
        className="w-auto p-2"
        align="end"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="grid grid-cols-5 gap-1">
          <button
            type="button"
            className="flex size-5 items-center justify-center rounded-full border border-dashed border-border text-[8px] text-muted-foreground"
            title={t('common.auto')}
            onClick={() => { onChange(undefined); setOpen(false) }}
          >
            A
          </button>
          {COLOR_PALETTE.filter((c) => c.name !== 'none').map((c) => (
            <button
              key={c.name}
              type="button"
              className={cn('size-5 rounded-full', c.bg, value === c.name && 'ring-2 ring-offset-1 ring-offset-popover', value === c.name && c.ring)}
              title={c.name}
              onClick={() => { onChange(c.name); setOpen(false) }}
            />
          ))}
        </div>
        {/* Custom hex picker */}
        <label className="mt-2 flex items-center gap-1.5 border-t pt-2 text-[10px] text-muted-foreground">
          <span
            className="size-4 shrink-0 rounded-full border border-border"
            style={{ backgroundColor: isHex ? value : 'transparent' }}
          />
          <span className="flex-1">{t('patient_data.custom_color')}</span>
          <input
            type="color"
            value={isHex ? (value as string) : '#3b82f6'}
            onChange={(e) => onChange(e.target.value)}
            className="h-5 w-6 cursor-pointer rounded border-0 bg-transparent p-0"
          />
        </label>
      </PopoverContent>
    </Popover>
  )
}
