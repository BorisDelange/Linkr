export type RuntimeLanguage = 'python' | 'r'

export type RuntimeStatus = 'idle' | 'loading' | 'ready' | 'executing' | 'error'

export interface RuntimeFigure {
  id: string
  type: 'svg' | 'png'
  /** SVG string or data:image/png;base64,... */
  data: string
  label: string
}

export interface RuntimeTable {
  headers: string[]
  rows: string[][]
}

export interface RuntimeOutput {
  stdout: string
  stderr: string
  figures: RuntimeFigure[]
  table: RuntimeTable | null
  html: string | null
  /** The code raised. NOT the same as a non-empty stderr: R writes warnings and
   *  messages there on a perfectly successful run, so callers that must tell a
   *  failure from a warning (the notebook stopping a Run all, result colouring)
   *  read this, never `stderr`. Absent on older payloads → treated as false. */
  failed?: boolean
}
