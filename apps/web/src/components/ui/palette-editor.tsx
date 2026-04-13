import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Plus, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { COLOR_PALETTE } from '@/components/ui/color-picker-popover'

// Default starter colors when creating a new custom palette
const STARTER_COLORS = ['#4e79a7', '#f28e2b', '#e15759', '#76b7b2', '#59a14f']

interface PaletteEditorProps {
  /** Comma-separated hex colors, e.g. "#e41a1c, #377eb8" */
  value: string
  onChange: (value: string) => void
  className?: string
}

function parseColors(value: string): string[] {
  if (!value.trim()) return [...STARTER_COLORS]
  return value.split(',').map(s => s.trim()).filter(s => /^#[0-9a-fA-F]{3,8}$/.test(s))
}

function serializeColors(colors: string[]): string {
  return colors.join(', ')
}

export function PaletteEditor({ value, onChange, className }: PaletteEditorProps) {
  const { t } = useTranslation()
  const colors = parseColors(value)
  const [editingIndex, setEditingIndex] = useState<number | null>(null)

  const updateColor = (index: number, hex: string) => {
    const next = [...colors]
    next[index] = hex
    onChange(serializeColors(next))
  }

  const addColor = () => {
    // Pick a color not yet in the palette
    const unused = COLOR_PALETTE.find(c => c.name !== 'none' && !colors.includes(c.hex))
    const next = [...colors, unused?.hex ?? '#6366f1']
    onChange(serializeColors(next))
  }

  const removeColor = (index: number) => {
    if (colors.length <= 1) return
    const next = colors.filter((_, i) => i !== index)
    onChange(serializeColors(next))
  }

  return (
    <div className={cn('space-y-2', className)}>
      <div className="flex flex-wrap items-center gap-1.5">
        {colors.map((hex, i) => (
          <ColorSwatch
            key={i}
            hex={hex}
            isEditing={editingIndex === i}
            onEdit={() => setEditingIndex(editingIndex === i ? null : i)}
            onChange={(newHex) => updateColor(i, newHex)}
            onRemove={colors.length > 1 ? () => removeColor(i) : undefined}
          />
        ))}
        {colors.length < 20 && (
          <button
            onClick={addColor}
            className="flex size-6 items-center justify-center rounded-full border border-dashed border-muted-foreground/40 text-muted-foreground/60 hover:border-foreground/40 hover:text-foreground/60 transition-colors"
          >
            <Plus size={12} />
          </button>
        )}
      </div>
    </div>
  )
}

function ColorSwatch({
  hex,
  isEditing,
  onEdit,
  onChange,
  onRemove,
}: {
  hex: string
  isEditing: boolean
  onEdit: () => void
  onChange: (hex: string) => void
  onRemove?: () => void
}) {
  return (
    <Popover open={isEditing} onOpenChange={(open) => { if (!open) onEdit() }}>
      <PopoverTrigger asChild>
        <button
          onClick={onEdit}
          className={cn(
            'size-6 rounded-full transition-all relative group',
            isEditing && 'ring-2 ring-foreground/50 ring-offset-1 ring-offset-background',
          )}
          style={{ backgroundColor: hex }}
        >
          {onRemove && (
            <span
              onClick={(e) => { e.stopPropagation(); onRemove() }}
              className="absolute -top-1 -right-1 hidden group-hover:flex size-3.5 items-center justify-center rounded-full bg-destructive text-white"
            >
              <X size={8} />
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-3" align="start" sideOffset={4}>
        <div className="space-y-2">
          {/* Preset grid */}
          <div className="grid grid-cols-5 gap-1.5">
            {COLOR_PALETTE.filter(c => c.name !== 'none').map(c => (
              <button
                key={c.name}
                onClick={() => { onChange(c.hex); onEdit() }}
                title={c.name}
                className={cn(
                  'size-5 rounded-full transition-all',
                  c.bg,
                  c.hex === hex && `ring-2 ${c.ring} ring-offset-1 ring-offset-background`,
                )}
              />
            ))}
          </div>
          {/* Custom hex picker */}
          <div className="flex items-center gap-2">
            <label className="relative size-5 rounded-full cursor-pointer overflow-hidden bg-[conic-gradient(red,yellow,lime,aqua,blue,magenta,red)]">
              <input
                type="color"
                value={hex}
                onChange={(e) => onChange(e.target.value)}
                className="absolute inset-0 opacity-0 cursor-pointer"
              />
            </label>
            <span className="text-[10px] text-muted-foreground font-mono">{hex}</span>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}
