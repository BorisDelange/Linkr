import { COLOR_PALETTE } from '@/components/ui/color-picker-popover'

/**
 * Default series colours, in the order concepts are assigned them: red, blue,
 * green, then on through the rest. Distinct hues first so the first few series
 * on a chart are told apart at a glance, rather than adjacent shades.
 *
 * Deliberately excludes `none` and `slate`: an unconfigured concept used to fall
 * back to a grey that read as "no colour set" rather than as a series colour.
 */
export const CONCEPT_COLOR_ORDER = [
  'red',
  'blue',
  'green',
  'orange',
  'violet',
  'teal',
  'pink',
  'amber',
  'cyan',
  'lime',
  'indigo',
  'rose',
  'emerald',
  'fuchsia',
  'sky',
  'purple',
  'yellow',
] as const

/** Palette name auto-assigned to the concept at `index`. Wraps around. */
export function defaultConceptColorName(index: number): string {
  return CONCEPT_COLOR_ORDER[index % CONCEPT_COLOR_ORDER.length]
}

/** Resolve a palette name (or a raw `#hex`) to a concrete hex value. */
export function paletteHex(color: string | undefined): string | null {
  if (!color) return null
  if (color.startsWith('#')) return color
  return COLOR_PALETTE.find((c) => c.name === color)?.hex ?? null
}

/**
 * The colour a concept is drawn in: its explicit choice when set, otherwise the
 * auto colour for its position. `index` is the concept's position in the
 * widget's own conceptIds list, so a series keeps its colour as long as the
 * selection order is unchanged.
 */
export function conceptColorHex(
  explicit: string | undefined,
  index: number,
): string {
  return paletteHex(explicit) ?? paletteHex(defaultConceptColorName(index)) ?? '#3b82f6'
}
