import type { ProjectStatus, BadgeColor, PresetBadgeColor } from '@/types'

// Shared badge/status colour helpers. Kept in a neutral module (not a feature
// component) so UI primitives can reuse them without a circular import.

/**
 * `outline` is the scoped-badge value half: a white ground with the colour as
 * border and text. Its text token is the same `-700`/`-300` pair as `text`,
 * which is exactly the shade chosen to be read on a light ground.
 */
export const PRESET_COLORS: {
  value: PresetBadgeColor
  bg: string
  text: string
  swatch: string
  outline: string
}[] = [
  { value: 'blue', bg: 'bg-blue-100 dark:bg-blue-950', text: 'text-blue-700 dark:text-blue-300', swatch: 'bg-blue-400', outline: 'border-blue-300 text-blue-700 dark:border-blue-800 dark:text-blue-300' },
  { value: 'red', bg: 'bg-red-100 dark:bg-red-950', text: 'text-red-700 dark:text-red-300', swatch: 'bg-red-400', outline: 'border-red-300 text-red-700 dark:border-red-800 dark:text-red-300' },
  { value: 'green', bg: 'bg-green-100 dark:bg-green-950', text: 'text-green-700 dark:text-green-300', swatch: 'bg-green-400', outline: 'border-green-300 text-green-700 dark:border-green-800 dark:text-green-300' },
  { value: 'violet', bg: 'bg-violet-100 dark:bg-violet-950', text: 'text-violet-700 dark:text-violet-300', swatch: 'bg-violet-400', outline: 'border-violet-300 text-violet-700 dark:border-violet-800 dark:text-violet-300' },
  { value: 'amber', bg: 'bg-amber-100 dark:bg-amber-950', text: 'text-amber-700 dark:text-amber-300', swatch: 'bg-amber-400', outline: 'border-amber-300 text-amber-700 dark:border-amber-800 dark:text-amber-300' },
  { value: 'rose', bg: 'bg-rose-100 dark:bg-rose-950', text: 'text-rose-700 dark:text-rose-300', swatch: 'bg-rose-400', outline: 'border-rose-300 text-rose-700 dark:border-rose-800 dark:text-rose-300' },
  { value: 'cyan', bg: 'bg-cyan-100 dark:bg-cyan-950', text: 'text-cyan-700 dark:text-cyan-300', swatch: 'bg-cyan-400', outline: 'border-cyan-300 text-cyan-700 dark:border-cyan-800 dark:text-cyan-300' },
  { value: 'slate', bg: 'bg-slate-100 dark:bg-slate-800', text: 'text-slate-700 dark:text-slate-300', swatch: 'bg-slate-400', outline: 'border-slate-300 text-slate-700 dark:border-slate-700 dark:text-slate-300' },
]

/** Border + text classes for the scoped-badge value half, on a white ground. */
export function getBadgeOutlineClasses(color: BadgeColor): string {
  return PRESET_COLORS.find((pc) => pc.value === color)?.outline ?? ''
}

/** Returns Tailwind classes for preset colors, or inline-style-friendly info for custom hex */
export function getBadgeClasses(color: BadgeColor): string {
  const c = PRESET_COLORS.find((pc) => pc.value === color)
  return c ? `${c.bg} ${c.text}` : ''
}

/** Returns inline style for custom hex colors */
export function getBadgeStyle(color: BadgeColor): React.CSSProperties | undefined {
  const isPreset = PRESET_COLORS.some((pc) => pc.value === color)
  if (isPreset) return undefined
  return { backgroundColor: `${color}20`, color }
}

export function isCustomColor(color: BadgeColor): boolean {
  return !PRESET_COLORS.some((pc) => pc.value === color)
}

/**
 * Contrast ratio of white against a custom badge colour must clear this before
 * the colour may be used as text on a white ground. 4.5:1 is WCAG AA for body
 * text; badges are small, so there is no case for the relaxed 3:1 large-text bar.
 */
const MIN_CONTRAST_ON_WHITE = 4.5

function parseHex(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return null
  const digits = m[1].length === 3 ? m[1].replace(/./g, (c) => c + c) : m[1]
  const n = parseInt(digits, 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

const toHex = (channels: [number, number, number]) =>
  `#${channels.map((c) => Math.round(Math.min(255, Math.max(0, c))).toString(16).padStart(2, '0')).join('')}`

/** Relative luminance, WCAG 2.x definition. */
function luminance([r, g, b]: [number, number, number]): number {
  const [lr, lg, lb] = [r, g, b].map((c) => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * lr + 0.7152 * lg + 0.0722 * lb
}

/** Contrast ratio against white, WCAG 2.x. 1 = white on white, 21 = black on white. */
export function contrastOnWhite(color: string): number {
  const rgb = parseHex(color)
  if (!rgb) return MIN_CONTRAST_ON_WHITE
  return 1.05 / (luminance(rgb) + 0.05)
}

/**
 * A custom badge colour darkened until it is legible as text on white.
 *
 * The scoped-badge chip prints its value half as coloured text on a white
 * ground, where a pale pick (a light yellow, say) would be invisible. Presets
 * never need this — their text tokens are the `-700` shades, chosen for a light
 * ground — so this only ever runs on user-picked hex.
 *
 * Darkening scales the channels toward black, which holds the hue: the badge
 * still reads as "the yellow one", just dark enough to be read.
 */
export function darkenForWhiteBackground(color: string): string {
  const rgb = parseHex(color)
  if (!rgb) return color
  if (contrastOnWhite(color) >= MIN_CONTRAST_ON_WHITE) return color

  // Binary search the scale factor: contrast increases monotonically as the
  // channels go down. Each candidate is ROUNDED before being measured, because
  // rounding is what the rendered colour goes through — measuring the real-valued
  // channels accepts a factor whose 8-bit form lands just under the target.
  const scaled = (factor: number) =>
    rgb.map((c) => Math.round(c * factor)) as [number, number, number]

  let low = 0
  let high = 1
  for (let i = 0; i < 16; i++) {
    const mid = (low + high) / 2
    if (1.05 / (luminance(scaled(mid)) + 0.05) >= MIN_CONTRAST_ON_WHITE) low = mid
    else high = mid
  }
  return toHex(scaled(low))
}

const STATUS_COLORS: Record<ProjectStatus, { bg: string; text: string; dot: string }> = {
  active: { bg: 'bg-emerald-100 dark:bg-emerald-950', text: 'text-emerald-700 dark:text-emerald-300', dot: 'bg-emerald-500' },
  completed: { bg: 'bg-blue-100 dark:bg-blue-950', text: 'text-blue-700 dark:text-blue-300', dot: 'bg-blue-500' },
  archived: { bg: 'bg-slate-100 dark:bg-slate-800', text: 'text-slate-600 dark:text-slate-400', dot: 'bg-slate-400' },
  draft: { bg: 'bg-amber-100 dark:bg-amber-950', text: 'text-amber-700 dark:text-amber-300', dot: 'bg-amber-500' },
}

/** Returns Tailwind classes for a project status */
export function getStatusClasses(status: ProjectStatus): string {
  const s = STATUS_COLORS[status]
  return `${s.bg} ${s.text}`
}

/** Returns the dot color class for a project status */
export function getStatusDotClass(status: ProjectStatus): string {
  return STATUS_COLORS[status].dot
}
