import { describe, expect, it } from 'vitest'
import { salvageTextToolCall } from './agent-loop'

describe('salvageTextToolCall', () => {
  it('recovers a call the model printed as prose', () => {
    // The exact failure seen in use: the model wrote the call as text instead of
    // emitting it through the tool-call protocol, so nothing ran and nothing was
    // reported — the user just saw JSON echoed back.
    const call = salvageTextToolCall(
      '{"name": "remove_tab", "parameters": {"tab_id": "Tab 7"}}'
    )
    expect(call).toEqual({
      id: 'call_salvaged',
      name: 'remove_tab',
      args: { tab_id: 'Tab 7' },
    })
  })

  it('accepts the "arguments" spelling too', () => {
    const call = salvageTextToolCall('{"name":"add_tab","arguments":{"name":"Labs"}}')
    expect(call?.args).toEqual({ name: 'Labs' })
  })

  it('finds the call inside surrounding prose', () => {
    const call = salvageTextToolCall(
      'Bien sûr, je vais le faire :\n{"name": "add_tab", "parameters": {"name": "Test"}}\nVoilà.'
    )
    expect(call?.name).toBe('add_tab')
  })

  it('keeps nested argument objects intact', () => {
    const call = salvageTextToolCall(
      '{"name":"add_widget","parameters":{"config":{"plotType":"histogram"}}}'
    )
    expect(call?.args).toEqual({ config: { plotType: 'histogram' } })
  })

  it('ignores plain prose', () => {
    expect(salvageTextToolCall('I have added the tab for you.')).toBeNull()
    expect(salvageTextToolCall('')).toBeNull()
  })

  it('ignores malformed JSON rather than throwing', () => {
    expect(salvageTextToolCall('{"name": "add_tab", "parameters":')).toBeNull()
  })

  it('ignores an object with no tool name', () => {
    expect(salvageTextToolCall('{"parameters": {"tabId": "tab_1"}}')).toBeNull()
  })
})
