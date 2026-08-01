import { stripAnsi } from '@/lib/ansi'

/**
 * Condense a raw provisioner error (a full uv/renv traceback, often with the
 * exact command prefixed and repeated) into a single readable line. The full text
 * stays available (tooltip / job log) — this is just the headline.
 *
 * Prefers the real error line: R prints `Error: failed to resolve …` above a
 * generic `Execution halted`, and pip/uv print `error: …`. Falls back to the last
 * non-empty non-command line.
 */
export function summarizeInstallError(raw: string): string {
  const clean = stripAnsi(raw)
  // The API wraps the detail as JSON sometimes ({"detail": "..."}) — unwrap it.
  const detail = tryUnwrapDetail(clean)
  const lines = detail
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    // Drop the echoed command lines (we prefix "$ …" to the log) and R's generic
    // trailer so the headline is the actual cause.
    .filter((l) => !l.startsWith('$ ') && l !== 'Execution halted')

  const errorLine =
    lines.find((l) => /^error:/i.test(l)) ??
    lines.find((l) => /^error\b/i.test(l)) ??
    lines[lines.length - 1] ??
    detail

  return errorLine.length > 200 ? errorLine.slice(0, 200) + '…' : errorLine
}

/** The full, cleaned error text for a tooltip / details view (ANSI stripped, JSON
 *  detail unwrapped). */
export function fullInstallError(raw: string): string {
  return tryUnwrapDetail(stripAnsi(raw))
}

function tryUnwrapDetail(text: string): string {
  const trimmed = text.trim()
  if (trimmed.startsWith('{') && trimmed.includes('"detail"')) {
    try {
      const parsed = JSON.parse(trimmed)
      if (typeof parsed?.detail === 'string') return parsed.detail
    } catch {
      // Not valid JSON — fall through and use the text as-is.
    }
  }
  return text
}
