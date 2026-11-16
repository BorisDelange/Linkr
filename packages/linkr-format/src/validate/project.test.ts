import { describe, expect, it } from 'vitest'
import { MemoryTree } from '../tree.js'
import { validateProject } from './project.js'

describe('validateProject: IDE connections', () => {
  const tree = (connectionConfig: unknown) => new MemoryTree({
    'project.json': JSON.stringify({ name: { en: 'P' }, projectId: 'p', appVersion: '2.3.3' }),
    'databases/remote.json': JSON.stringify({ name: 'Remote', source: 'custom', connectionConfig }),
  })

  it('accepts a connection that names only its engine', () => {
    expect(validateProject(tree({ engine: 'postgresql' }))).toEqual([])
  })

  it('warns of an older connection that names where it points or as whom, which the import drops', () => {
    const issues = validateProject(tree({ engine: 'postgresql', host: 'h.example', username: 'u', serverPath: '/srv/x.duckdb' }))
    expect(issues).toHaveLength(1)
    expect(issues[0]).toMatchObject({
      path: 'databases/remote.json', pointer: '/connectionConfig', severity: 'warning', code: 'legacy-format',
    })
    expect(issues[0].message).toContain('`host`')
  })

  it('refuses a connection config that is not an object', () => {
    expect(validateProject(tree('postgresql://h'))[0]).toMatchObject({ severity: 'error', code: 'wrong-type' })
  })
})
