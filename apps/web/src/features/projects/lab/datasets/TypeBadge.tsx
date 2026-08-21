import { useTranslation } from 'react-i18next'
import { Clock, ToggleLeft } from 'lucide-react'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { COLUMN_TYPES } from '@/lib/dataset-utils'
import type { DatasetColumn } from '@/types'

/**
 * `icon` is text for the types a character says best ('#', 'Aa'); the rest use a
 * Lucide component, because the equivalent glyphs (◷, ⊘) are drawn much smaller
 * than plain characters at the same font size and enlarging them grew the badge.
 * Same trade-off — and same icons — as `components/ui/type-badge.tsx`.
 */
const TYPE_CONFIG: Record<string, {
  icon?: string
  Icon?: React.ComponentType<{ size?: number; className?: string }>
  /** Shrinks this icon relative to the badge's base icon size. */
  iconScale?: number
  color: string
}> = {
  number:  { icon: '#',  color: 'bg-blue-500/15 text-blue-700 dark:text-blue-400' },
  string:  { icon: 'Aa', color: 'bg-green-500/15 text-green-700 dark:text-green-400' },
  boolean: { Icon: ToggleLeft, color: 'bg-purple-500/15 text-purple-700 dark:text-purple-400' },
  // Clock's circular outline reads heavier than ToggleLeft's at the same size.
  date:    { Icon: Clock, iconScale: 0.85, color: 'bg-orange-500/15 text-orange-700 dark:text-orange-400' },
  unknown: { icon: '?',  color: 'bg-gray-500/15 text-gray-700 dark:text-gray-400' },
}

/** Literal class names per pixel size — Tailwind only emits classes it can see
 *  written out, so these can't be built by interpolation. */
const ICON_SIZE_CLASS: Record<number, string> = {
  10: 'size-[10px]',
  12: 'size-[12px]',
  14: 'size-[14px]',
}

interface TypeBadgeProps {
  type: string
  size?: 'sm' | 'md'
  showLabel?: boolean
  /** Drop the tooltip where the surrounding text already names the type
   *  (menu entries like "Treat as date"). */
  noTooltip?: boolean
}

export function TypeBadge({ type, size = 'md', showLabel = false, noTooltip = false }: TypeBadgeProps) {
  const { t } = useTranslation()
  const key = TYPE_CONFIG[type] ? type : 'unknown'
  const config = TYPE_CONFIG[key]
  const label = t(`datasets.type_${key}`)

  const { Icon } = config
  // Every badge is the SAME fixed box whatever it holds, so a column of badges
  // stays aligned; only the icon inside differs in size.
  const box = size === 'sm' ? 'h-4 w-5' : 'h-[1.15rem] w-6'
  const iconPx = Math.round((size === 'sm' ? 12 : 14) * (config.iconScale ?? 1))
  // Menu items force `size-4` and `text-muted-foreground` on any descendant svg
  // carrying no size-/text- class of its own, which overrode both the icon's
  // dimensions and the badge's colour. Naming a size- and text- class opts out of
  // both, so a badge looks identical inside and outside a menu.
  const iconClass = cn('text-current', ICON_SIZE_CLASS[iconPx] ?? ICON_SIZE_CLASS[12])

  const badge = (
    <span
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded font-mono font-semibold leading-none',
        config.color,
        size === 'sm' ? 'text-[9px]' : 'text-[10px]',
        // With a label the badge grows to fit it, so the fixed box only applies
        // to the icon-only form.
        showLabel ? (size === 'sm' ? 'gap-0.5 px-1 py-0.5' : 'gap-0.5 px-1.5 py-0.5') : box,
      )}
    >
      {Icon ? <Icon className={iconClass} /> : config.icon}
      {showLabel && <span className="font-sans font-medium ml-0.5">{label}</span>}
    </span>
  )

  // The label is already visible next to the badge — a tooltip would just repeat it.
  if (showLabel || noTooltip) return badge

  // Provider included: the badge renders in screens that don't wrap one (schema
  // lists, preview headers), and a bare Tooltip throws without an ancestor provider.
  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>{badge}</TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

/**
 * The "Treat as <type>" entries, shared by every column-type menu (the dataset
 * table's column menu and the upload preview's header picker) so the badges,
 * wording and check mark can't drift between them.
 *
 * `Item` is passed in rather than imported: the same list renders inside a
 * DropdownMenu and a ContextMenu, which need their own item components. Same
 * pattern as `renderColumnMenuItems` in DatasetTable.
 */
export function renderTypeMenuItems({
  current,
  onSelect,
  Item,
}: {
  current: DatasetColumn['type'] | undefined
  onSelect: (type: DatasetColumn['type']) => void
  Item: React.ComponentType<{
    onClick?: () => void
    className?: string
    children?: React.ReactNode
  }>
}) {
  return COLUMN_TYPES.map((ty) => (
    <TypeMenuItem key={ty} type={ty} current={current} onSelect={onSelect} Item={Item} />
  ))
}

/** One "Treat as …" row. Split out so it can call the translation hook. */
function TypeMenuItem({
  type,
  current,
  onSelect,
  Item,
}: {
  type: DatasetColumn['type']
  current: DatasetColumn['type'] | undefined
  onSelect: (type: DatasetColumn['type']) => void
  Item: React.ComponentType<{
    onClick?: () => void
    className?: string
    children?: React.ReactNode
  }>
}) {
  const { t } = useTranslation()
  return (
    <Item onClick={() => onSelect(type)} className="text-xs">
      <TypeBadge type={type} size="sm" noTooltip />
      {t('datasets.col_treat_as', { type: t(`datasets.type_${type}`) })}
      {current === type && <span className="ml-auto text-primary">✓</span>}
    </Item>
  )
}
