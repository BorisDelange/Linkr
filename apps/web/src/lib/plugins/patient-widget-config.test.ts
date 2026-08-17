import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// The editor preview renders a widget with the UNSAVED draft config, passed via
// the `config` prop that PatientComponentPluginProps declares. A widget that
// ignores that prop and re-reads its config from the store by widgetId shows the
// last SAVED state instead: pick two concepts and the preview still reads "no
// concepts selected" while the SQL tab already lists them. That was a real bug,
// and it is invisible to the type checker — the prop is simply unused.

const WIDGETS_DIR = join(
  __dirname,
  '../../features/projects/warehouse/patient-data/widgets',
)

/** Widgets whose config drives what they render. */
const CONFIG_DRIVEN = ['TimelineWidget.tsx', 'NotesWidget.tsx']

describe('patient widgets honour the config prop', () => {
  for (const file of CONFIG_DRIVEN) {
    it(`${file} prefers the passed config over the stored one`, () => {
      const src = readFileSync(join(WIDGETS_DIR, file), 'utf8')

      // It must accept the prop...
      expect(src, `${file} must accept a config prop`).toMatch(/config:\s*configProp/)

      // ...and the resolved config must fall back to the store, not start from it.
      const assignment = src.match(/const config = \(([^;]*?)\) as/s)?.[1] ?? ''
      expect(assignment, `${file} must resolve config from the prop first`).toMatch(
        /configProp\s*\?\?/,
      )
    })
  }
})
