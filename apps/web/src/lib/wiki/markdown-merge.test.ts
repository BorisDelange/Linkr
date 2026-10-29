import { describe, expect, it } from 'vitest'
import { mergeMarkdown, resolveMerge, splitBlocks } from './markdown-merge'

const doc = (...blocks: string[]) => blocks.join('\n\n') + '\n'

describe('splitBlocks', () => {
  it('splits on blank lines and keeps a fenced block whole', () => {
    expect(splitBlocks('# T\n\nPara one\nstill one\n\n```\na\n\nb\n```\n\nEnd\n')).toEqual([
      '# T', 'Para one\nstill one', '```\na\n\nb\n```', 'End',
    ])
  })
})

describe('mergeMarkdown', () => {
  const base = doc('# Setup', 'Install it.', 'Run it.', 'Done.')

  it('takes each side where only that side changed', () => {
    const local = doc('# Setup', 'Install it with uv.', 'Run it.', 'Done.')
    const remote = doc('# Setup', 'Install it.', 'Run it.', 'Done, see the FAQ.')
    const merge = mergeMarkdown(base, local, remote)
    expect(merge.conflicts).toBe(0)
    expect(resolveMerge(merge, 'remote', { local, remote })).toBe(
      doc('# Setup', 'Install it with uv.', 'Run it.', 'Done, see the FAQ.'),
    )
  })

  it('does not conflict when one side re-wraps a paragraph the other left alone', () => {
    const local = doc('# Setup', 'Install\nit.', 'Run it.', 'Done.')
    const remote = doc('# Setup', 'Install it.', 'Run it.', 'Done.', 'New section.')
    const merge = mergeMarkdown(base, local, remote)
    expect(merge.conflicts).toBe(0)
    expect(resolveMerge(merge, 'remote', { local, remote })).toBe(
      doc('# Setup', 'Install\nit.', 'Run it.', 'Done.', 'New section.'),
    )
  })

  it('merges edits to two neighbouring paragraphs, one on each side', () => {
    const local = doc('# Setup', 'Install it with uv.', 'Run it.', 'Done.')
    const remote = doc('# Setup', 'Install it.', 'Run it twice.', 'Done.')
    const merge = mergeMarkdown(base, local, remote)
    expect(merge.conflicts).toBe(0)
    expect(resolveMerge(merge, 'remote', { local, remote })).toBe(
      doc('# Setup', 'Install it with uv.', 'Run it twice.', 'Done.'),
    )
  })

  it('conflicts on two insertions at the same place', () => {
    expect(mergeMarkdown(base, doc('# Setup', 'Mine.', 'Install it.', 'Run it.', 'Done.'),
      doc('# Setup', 'Theirs.', 'Install it.', 'Run it.', 'Done.')).conflicts).toBe(1)
  })

  it('reports a conflict when both sides change the same paragraph differently', () => {
    const local = doc('# Setup', 'Install it with uv.', 'Run it.', 'Done.')
    const remote = doc('# Setup', 'Install it with pip.', 'Run it.', 'Done.')
    const merge = mergeMarkdown(base, local, remote)
    expect(merge.conflicts).toBe(1)
    expect(resolveMerge(merge, 'local', { local, remote })).toBe(local)
    expect(resolveMerge(merge, 'remote', { local, remote })).toBe(remote)
  })

  it('accepts the same change made on both sides', () => {
    const both = doc('# Setup', 'Install it.', 'Run it twice.', 'Done.')
    expect(mergeMarkdown(base, both, both).conflicts).toBe(0)
  })

  it('merges a page added on both sides from an empty base as a conflict only where they differ', () => {
    const merge = mergeMarkdown('', doc('A', 'B'), doc('A', 'C'))
    expect(merge.conflicts).toBe(1)
  })

  it('keeps a deletion on one side when the other left the block alone', () => {
    const local = doc('# Setup', 'Install it.', 'Done.')
    const remote = doc('# Setup', 'Install it.', 'Run it.', 'Done.', 'Extra.')
    const merge = mergeMarkdown(base, local, remote)
    expect(merge.conflicts).toBe(0)
    expect(resolveMerge(merge, 'remote', { local, remote })).toBe(doc('# Setup', 'Install it.', 'Done.', 'Extra.'))
  })
})
