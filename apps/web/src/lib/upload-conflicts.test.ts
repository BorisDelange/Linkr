import { describe, expect, it } from 'vitest'
import { findConflicts, planUpload, safeUploadFileName } from './upload-conflicts'

const EXISTING = [
  { id: 'f1', name: '00_vocabulary.sql' },
  { id: 'f2', name: '10_src_core.sql' },
]

describe('findConflicts', () => {
  it('names the candidates that already exist', () => {
    const out = findConflicts(
      [{ name: '00_vocabulary.sql', content: 'x' }, { name: 'new.sql', content: 'y' }],
      EXISTING,
    )
    expect(out).toEqual(['00_vocabulary.sql'])
  })

  it('matches case-insensitively', () => {
    // Two files differing only in case are one file to git on macOS/Windows, and
    // the export tree could not hold both.
    expect(findConflicts([{ name: '00_VOCABULARY.SQL', content: 'x' }], EXISTING))
      .toEqual(['00_VOCABULARY.SQL'])
  })

  it('reports nothing when the names are all new', () => {
    expect(findConflicts([{ name: 'fresh.sql', content: 'x' }], EXISTING)).toEqual([])
  })
})

describe('planUpload', () => {
  it('replace updates the EXISTING file, keeping its id', () => {
    // The id must survive: the versioning marks, the run history and the
    // execution order all point at it.
    const plan = planUpload(
      [{ name: '00_vocabulary.sql', content: 'new body' }],
      EXISTING,
      'replace',
    )
    expect(plan.creates).toEqual([])
    expect(plan.replaces).toEqual([
      { id: 'f1', name: '00_vocabulary.sql', content: 'new body' },
    ])
  })

  it('replace keeps the stored name\'s casing, not the upload\'s', () => {
    const plan = planUpload(
      [{ name: '00_VOCABULARY.SQL', content: 'b' }],
      EXISTING,
      'replace',
    )
    expect(plan.replaces[0].name).toBe('00_vocabulary.sql')
  })

  it('keep-both adds a suffixed copy and leaves the original alone', () => {
    const plan = planUpload(
      [{ name: '00_vocabulary.sql', content: 'copy' }],
      EXISTING,
      'keep-both',
    )
    expect(plan.replaces).toEqual([])
    expect(plan.creates).toEqual([{ name: '00_vocabulary-2.sql', content: 'copy' }])
  })

  it('passes non-clashing files straight through under either choice', () => {
    for (const resolution of ['keep-both', 'replace'] as const) {
      const plan = planUpload([{ name: 'fresh.sql', content: 'x' }], EXISTING, resolution)
      expect(plan.creates).toEqual([{ name: 'fresh.sql', content: 'x' }])
      expect(plan.replaces).toEqual([])
    }
  })

  it('two files in ONE drop cannot claim the same name', () => {
    const plan = planUpload(
      [{ name: 'dup.sql', content: 'a' }, { name: 'dup.sql', content: 'b' }],
      [],
      'keep-both',
    )
    expect(plan.creates.map((c) => c.name)).toEqual(['dup.sql', 'dup-2.sql'])
  })

  it('keeps counting past an existing -2', () => {
    const plan = planUpload(
      [{ name: 'a.sql', content: 'x' }],
      [{ id: '1', name: 'a.sql' }, { id: '2', name: 'a-2.sql' }],
      'keep-both',
    )
    expect(plan.creates[0].name).toBe('a-3.sql')
  })

  it('handles a mixed drop: one replace, one add, one renamed', () => {
    const plan = planUpload(
      [
        { name: '00_vocabulary.sql', content: 'v2' },
        { name: 'brand_new.sql', content: 'n' },
      ],
      EXISTING,
      'replace',
    )
    expect(plan.replaces).toHaveLength(1)
    expect(plan.creates.map((c) => c.name)).toEqual(['brand_new.sql'])
  })
})

describe('safeUploadFileName', () => {
  it('strips a path handed back by a directory drop', () => {
    // The tree stores hierarchy in parentId, not in the name: `sub/file.sql`
    // would otherwise create a file literally called "sub/file.sql".
    expect(safeUploadFileName('sub/file.sql')).toBe('file.sql')
    expect(safeUploadFileName('a\\b\\file.sql')).toBe('file.sql')
  })

  it('refuses the names the export owns, at the root', () => {
    // The export writes these from the entity's own fields, so an uploaded file
    // of the same name is silently overwritten and the user loses it.
    for (const name of ['README.md', 'readme.md', 'LICENSE.md', 'LICENSE', 'attachments']) {
      expect(safeUploadFileName(name, null)).toBeUndefined()
    }
  })

  it('allows those names inside a folder, where nothing collides', () => {
    expect(safeUploadFileName('README.md', 'folder-1')).toBe('README.md')
  })

  it('refuses names that address nothing', () => {
    expect(safeUploadFileName('')).toBeUndefined()
    expect(safeUploadFileName('   ')).toBeUndefined()
    expect(safeUploadFileName('.')).toBeUndefined()
    expect(safeUploadFileName('..')).toBeUndefined()
    expect(safeUploadFileName('sub/')).toBeUndefined()
  })

  it('leaves an ordinary name alone', () => {
    expect(safeUploadFileName('analysis.py')).toBe('analysis.py')
    expect(safeUploadFileName('  spaced.sql  ')).toBe('spaced.sql')
  })
})
