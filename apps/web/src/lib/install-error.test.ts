import { describe, it, expect } from 'vitest'
import { summarizeInstallError, fullInstallError } from './install-error'

// The exact R traceback shape the API returns when renv can't resolve a package.
const R_ERROR = `{"detail":"\\n$ Rscript --vanilla -e 'renv::record(c(\\"lubridat\\"), lockfile=renv.lock)'\\nTraceback (most recent calls last):\\n15: renv::record(c(\\"lubridat\\"), lockfile = \\"renv.lock\\")\\nError: failed to resolve remote 'lubridat' -- package 'lubridat' is not available\\nExecution halted"}`

describe('summarizeInstallError', () => {
  it('extracts the R Error: line, not the generic Execution halted trailer', () => {
    expect(summarizeInstallError(R_ERROR)).toBe(
      "Error: failed to resolve remote 'lubridat' -- package 'lubridat' is not available"
    )
  })

  it('prefers a pip/uv error: line', () => {
    const raw = '$ uv add aaa\nerror: no solution found: package `aaa` was not found\n'
    expect(summarizeInstallError(raw)).toBe(
      'error: no solution found: package `aaa` was not found'
    )
  })

  it('strips ANSI codes from the headline', () => {
    expect(summarizeInstallError('\x1b[31mError: boom\x1b[0m')).toBe('Error: boom')
  })

  it('skips echoed command lines when picking the fallback line', () => {
    expect(summarizeInstallError('$ uv sync\nsomething odd happened')).toBe(
      'something odd happened'
    )
  })

  it('truncates a very long headline', () => {
    const long = 'error: ' + 'x'.repeat(500)
    const out = summarizeInstallError(long)
    expect(out.length).toBeLessThanOrEqual(201)
    expect(out.endsWith('…')).toBe(true)
  })
})

describe('fullInstallError', () => {
  it('unwraps the JSON detail and keeps the full traceback', () => {
    const full = fullInstallError(R_ERROR)
    expect(full).toContain('Traceback (most recent calls last)')
    expect(full).toContain('Execution halted')
    expect(full.startsWith('{')).toBe(false)
  })
})
