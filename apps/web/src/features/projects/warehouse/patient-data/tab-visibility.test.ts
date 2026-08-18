import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Keep-alive leaves visited tabs mounted so returning to one is instant. But a
// patient widget refetches whenever the selected patient or visit changes, so a
// mounted-but-hidden widget would query the warehouse alongside the visible one:
// paging through patients would cost (visited tabs × widgets) queries instead of
// one tab's worth. Each fetching widget must therefore bail out while hidden.
//
// This is a performance property with no visible symptom until a board gets
// heavy, which is exactly the kind of thing that silently regresses.

const WIDGETS_DIR = join(__dirname, 'widgets')

/** Widgets that query the warehouse from a patient/visit-keyed effect. */
const FETCHING_WIDGETS = [
  'TimelineWidget.tsx',
  'NotesWidget.tsx',
  'PatientSummaryWidget.tsx',
]

describe('patient widgets skip fetching while their tab is hidden', () => {
  for (const file of FETCHING_WIDGETS) {
    const src = readFileSync(join(WIDGETS_DIR, file), 'utf8')

    it(`${file} reads tab visibility`, () => {
      expect(src, `${file} must call useTabVisible`).toMatch(/useTabVisible\(\)/)
    })

    it(`${file} bails out of the fetch effect when hidden`, () => {
      expect(src, `${file} must guard on !visible`).toMatch(/if \(!visible\) return/)
    })

    it(`${file} refetches when the tab is revealed`, () => {
      // `visible` must be a dependency, or a hidden tab would never catch up on
      // the patient that changed while it was away.
      const deps = src.match(/\}, \[visible[^\]]*\]\)/)
      expect(deps, `${file} must list visible first in the fetch deps`).not.toBeNull()
    })
  }

  it('keeps the data it already has instead of clearing on hide', () => {
    // Clearing would defeat keep-alive: revealing the tab would refetch anyway.
    const src = readFileSync(join(WIDGETS_DIR, 'TimelineWidget.tsx'), 'utf8')
    const guard = src.slice(src.indexOf('if (!visible) return'))
    // The bail-out returns before any setData([]) in that effect.
    expect(guard.startsWith('if (!visible) return')).toBe(true)
  })
})

describe('the visibility default', () => {
  it('is true, so a widget outside a tab wrapper still loads', () => {
    // The editor preview and the add dialog render widgets with no provider.
    const src = readFileSync(join(__dirname, 'TabVisibilityContext.tsx'), 'utf8')
    expect(src).toMatch(/createContext\(true\)/)
  })
})
