// Minimal ANSI SGR parser for rendering captured command output (build/install
// logs) with colour, without pulling a dependency or using dangerouslySetInnerHTML.
// Covers the codes uv/renv/pip actually emit: the 8 standard + 8 bright foreground
// colours, bold, and reset. Anything else (cursor moves, 256/truecolour) is
// ignored — its text still shows, just uncoloured.

export interface AnsiSegment {
  text: string
  /** Tailwind text-colour class, or undefined for the default colour. */
  className?: string
  bold?: boolean
}

// Standard (30-37) and bright (90-97) foreground colours → Tailwind classes that
// read well on the muted job-log background in both themes.
const FG: Record<number, string> = {
  30: 'text-foreground', 31: 'text-red-500', 32: 'text-emerald-500',
  33: 'text-amber-500', 34: 'text-blue-500', 35: 'text-fuchsia-500',
  36: 'text-cyan-500', 37: 'text-foreground',
  90: 'text-muted-foreground', 91: 'text-red-400', 92: 'text-emerald-400',
  93: 'text-amber-400', 94: 'text-blue-400', 95: 'text-fuchsia-400',
  96: 'text-cyan-400', 97: 'text-foreground',
}

// Matches a CSI SGR sequence: ESC [ <params> m
// eslint-disable-next-line no-control-regex
const SGR_RE = /\x1b\[([0-9;]*)m/g

/** Split ANSI-coded text into styled segments. Unstyled runs get no className. */
export function parseAnsi(input: string): AnsiSegment[] {
  const segments: AnsiSegment[] = []
  let className: string | undefined
  let bold = false
  let lastIndex = 0

  const push = (text: string) => {
    if (text) segments.push({ text, className, bold: bold || undefined })
  }

  SGR_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = SGR_RE.exec(input)) !== null) {
    push(input.slice(lastIndex, m.index))
    lastIndex = SGR_RE.lastIndex
    // An empty param list (ESC[m) is a reset, same as 0.
    const codes = m[1] === '' ? [0] : m[1].split(';').map((c) => parseInt(c, 10))
    for (const code of codes) {
      if (code === 0) {
        className = undefined
        bold = false
      } else if (code === 1) {
        bold = true
      } else if (code === 22) {
        bold = false
      } else if (code === 39) {
        className = undefined
      } else if (FG[code]) {
        className = FG[code]
      }
    }
  }
  push(input.slice(lastIndex))
  return segments
}

/** Strip all ANSI SGR codes from text (for copy-to-clipboard, length checks). */
export function stripAnsi(input: string): string {
  // eslint-disable-next-line no-control-regex
  return input.replace(/\x1b\[[0-9;]*m/g, '')
}
