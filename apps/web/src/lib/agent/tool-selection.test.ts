import { describe, expect, it } from 'vitest'
import { selectToolNames } from './tool-selection'

describe('selectToolNames', () => {
  it('always offers the core create/inspect tools', () => {
    const names = selectToolNames('bonjour')
    expect(names).toEqual(
      expect.arrayContaining([
        'add_tab',
        'add_widget',
        'describe_dataset',
        'describe_plugin',
      ])
    )
  })

  it('withholds destructive tools from a request that is not a deletion', () => {
    // The one place a miss is worth it: the model cannot reach for a delete while
    // doing something else.
    const names = selectToolNames('ajoute un onglet Test')
    expect(names).not.toContain('remove_tab')
    expect(names).not.toContain('remove_widget')
  })

  it.each([
    'supprime l\'onglet Test',
    'delete the Labs tab',
    'enlève ce widget',
    'remove widget 3',
    'efface cet onglet',
  ])('offers destructive tools for: %s', (request) => {
    expect(selectToolNames(request)).toContain('remove_tab')
  })

  it.each([
    'mets ce widget sur la moitié de la largeur',
    'make it full width',
    'change the plot type to boxplot',
    'redimensionne le graphique',
    'configure the widget',
  ])('offers modify tools for: %s', (request) => {
    expect(selectToolNames(request)).toContain('set_layout')
    expect(selectToolNames(request)).toContain('configure_widget')
  })

  it('offers modify tools on any follow-up, since "make it wider" has no keyword', () => {
    expect(selectToolNames('plus grand', true)).toContain('set_layout')
  })

  it('never drops a core tool, whatever the request', () => {
    // Being wrong must cost tokens, never capability.
    for (const request of ['', 'supprime tout', 'blah blah', 'resize']) {
      expect(selectToolNames(request)).toContain('add_widget')
      expect(selectToolNames(request)).toContain('describe_dataset')
    }
  })
})
