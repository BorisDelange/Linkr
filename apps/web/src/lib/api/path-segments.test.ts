import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// Paths of a file tree built in this folder, not request paths.
const FILE_TREE_PATHS = ['datasets.ts: /${name}', 'datasets.ts: /${changes.name}', 'ide-files.ts: /${changes.name}']

// A row's id comes from the server, and through it from whoever wrote the row: in a
// path it stays one segment, whatever it holds.
describe('API path templates', () => {
  it('encode every value put in a path segment', () => {
    const dir = join(process.cwd(), 'src/lib/api')
    const raw = readdirSync(dir)
      .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
      .flatMap((name) => {
        const matches = readFileSync(join(dir, name), 'utf8').match(/\/\$\{[a-z][\w.]*\}(?=[/`?])/g) ?? []
        return matches.map((match) => `${name}: ${match}`)
      })
    expect(raw.filter((match) => !FILE_TREE_PATHS.includes(match))).toEqual([])
  })
})
