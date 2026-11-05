import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/api-client', () => ({ apiRequest: vi.fn(), getApiBaseUrl: () => '' }))

const { detectWebAppPreset } = await import('./web-apps')
type Preset = Parameters<typeof detectWebAppPreset>[2][number]

// The shapes the server's presets take (services/execution/web_apps.py).
const PRESETS: Preset[] = [
  { key: 'shiny', label: 'Shiny', language: 'r', names: ['app.R', 'ui.R', 'server.R'], content: '\\bshinyApp\\s*\\(' },
  { key: 'shiny-python', label: 'Shiny for Python', language: 'python', names: [], content: '^\\s*(from\\s+shiny(\\.express)?\\s+import|import\\s+shiny)\\b' },
  { key: 'streamlit', label: 'Streamlit', language: 'python', names: [], content: '^\\s*(import\\s+streamlit|from\\s+streamlit\\s+import)\\b' },
]

describe('detectWebAppPreset', () => {
  it('recognises an entry file by name, in any folder', () => {
    expect(detectWebAppPreset('dashboards/app.R', '', PRESETS)?.key).toBe('shiny')
  })

  it('recognises one by content, on any line', () => {
    expect(detectWebAppPreset('x.py', '"""doc"""\nimport streamlit as st', PRESETS)?.key).toBe('streamlit')
    expect(detectWebAppPreset('x.py', 'from shiny.express import ui', PRESETS)?.key).toBe('shiny-python')
    expect(detectWebAppPreset('x.R', 'shinyApp(ui, server)', PRESETS)?.key).toBe('shiny')
  })

  it('matches only presets of the file language', () => {
    expect(detectWebAppPreset('app.py', '', PRESETS)).toBeNull()
    expect(detectWebAppPreset('x.R', 'import streamlit', PRESETS)).toBeNull()
  })
})
