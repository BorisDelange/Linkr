import { Info } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'
import type { DatasetColumn } from '@/types'
import type { PluginConfigField } from '@/types/plugin'

// ---------------------------------------------------------------------------
// Hint resolver — shows contextual badges (e.g. "required", "optional") next to labels
// ---------------------------------------------------------------------------

function resolveHint(
  field: PluginConfigField,
  config: Record<string, unknown>,
  lang: 'en' | 'fr',
): string | null {
  if (field.hintWhen) {
    const depValue = String(config[field.hintWhen.field] ?? '')
    // An override swaps specific hints when a second field matches (e.g. flip X/Y by orientation).
    // Override keys take precedence; missing keys fall back to the base map.
    const overrides = [field.hintWhen.override ?? []].flat()
    const values = overrides.reduce(
      (acc, ov) => (config[ov.field] === ov.value ? { ...acc, ...ov.values } : acc),
      field.hintWhen.values,
    )
    const label = values[depValue]
    if (label) return label[lang] ?? label.en
    return null
  }
  if (field.hint) return field.hint[lang] ?? field.hint.en
  return null
}

function HintBadge({ text }: { text: string }) {
  const isRequired = /required|requis/i.test(text)
  return (
    <span
      className={cn(
        'ml-1 shrink-0 rounded px-1 py-px text-[9px] font-medium leading-tight',
        isRequired
          ? 'bg-amber-500/15 text-amber-600 dark:text-amber-400'
          : 'bg-muted text-muted-foreground',
      )}
    >
      {text}
    </span>
  )
}

export function FieldLabel({ field, config, lang }: { field: PluginConfigField; config: Record<string, unknown>; lang: 'en' | 'fr' }) {
  const hint = resolveHint(field, config, lang)
  const desc = field.description ? (field.description[lang] ?? field.description.en) : null
  return (
    <Label className="text-xs flex items-center">
      {field.label[lang] ?? field.label.en}
      {hint && <HintBadge text={hint} />}
      {desc && (
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <Info size={12} className="ml-1 shrink-0 text-muted-foreground cursor-help" />
            </TooltipTrigger>
            <TooltipContent side="top" className="max-w-56 whitespace-pre-line">
              {desc}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      )}
    </Label>
  )
}

// ---------------------------------------------------------------------------

export interface FieldRendererProps {
  fieldKey: string
  field: PluginConfigField
  value: unknown
  columns: DatasetColumn[]
  lang: 'en' | 'fr'
  config: Record<string, unknown>
  onConfigChange: (changes: Record<string, unknown>) => void
  rows?: Record<string, unknown>[]
  datasetFileId?: string
  renderConceptField?: (fieldKey: string, field: PluginConfigField) => React.ReactNode
  renderDatasetField?: (fieldKey: string, field: PluginConfigField) => React.ReactNode
}
