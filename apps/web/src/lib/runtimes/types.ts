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
}
