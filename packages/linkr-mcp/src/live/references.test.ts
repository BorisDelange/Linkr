import { fromJsonSchema } from '@modelcontextprotocol/server'
import { describe, expect, it, vi } from 'vitest'
import { CATALOG } from './build'
import { checkArguments, inputJsonSchema, type CatalogTool } from './gateway'
import { cachedDirectory, resolveArguments, withReferences, type Directory, type Ref, type RefKind } from './references'
import { READ, WRITE, text } from './shared'

const DB_A: Ref = { id: '545d0a67-2c98-4270-9df6-07c2cdd31eef', label: 'MIMIC-IV demo', names: ['MIMIC-IV demo', 'mimic_demo'] }
const DB_B: Ref = { id: 'b2', label: 'Synthetic ICU', names: ['Synthetic ICU'] }
const PROJECT: Ref = { id: 'p1', label: 'Sepsis study', names: ['Sepsis study'] }

function directory(refs: Partial<Record<RefKind, Ref[]>>, linked: Record<string, string[]> = {}): Directory {
  return {
    list: vi.fn(async (kind: RefKind) => refs[kind] ?? []),
    linkedDatabases: async (uid) => linked[uid] ?? [],
    forget: vi.fn(),
  }
}

const resolve = (args: Record<string, unknown>, dir: Directory, params = Object.keys(args), defaults = false) =>
  resolveArguments(args, params, defaults, dir)

describe('resolveArguments', () => {
  const dir = directory({ database: [DB_A, DB_B], project: [PROJECT] })

  it('keeps an exact id', async () => {
    expect(await resolve({ database_id: DB_A.id, sql: 'x' }, dir, ['database_id']))
      .toEqual({ args: { database_id: DB_A.id, sql: 'x' } })
  })

  it('takes an exact name, case-insensitively, the alias included', async () => {
    expect(await resolve({ database_id: 'mimic-iv DEMO' }, dir)).toEqual({ args: { database_id: DB_A.id } })
    expect(await resolve({ database_id: 'MIMIC_DEMO' }, dir)).toEqual({ args: { database_id: DB_A.id } })
    expect(await resolve({ project_uid: 'sepsis study' }, dir)).toEqual({ args: { project_uid: 'p1' } })
  })

  it('takes a name written with other spaces, dashes and underscores', async () => {
    expect(await resolve({ database_id: 'mimic-iv-demo' }, dir)).toEqual({ args: { database_id: DB_A.id } })
    expect(await resolve({ database_id: 'synthetic_icu' }, dir)).toEqual({ args: { database_id: 'b2' } })
  })

  it('refuses an ambiguous name and lists the candidates with their ids', async () => {
    const twins = directory({ database: [DB_A, { id: 'a2', label: 'MIMIC-IV demo', names: ['MIMIC-IV demo'] }] })
    const result = await resolve({ database_id: 'mimic-iv demo' }, twins)
    expect(result).toEqual({
      error: `database_id "mimic-iv demo" matches 2 databases: MIMIC-IV demo (${DB_A.id}), MIMIC-IV demo (a2). `
        + 'Give the id of the one you mean.',
    })
  })

  it('prefers the cohort of the project given in the same call', async () => {
    const cohorts = directory({
      project: [PROJECT],
      cohort: [
        { id: 'c1', label: 'Adults', names: ['Adults'], owner: 'other' },
        { id: 'c2', label: 'Adults', names: ['Adults'], owner: 'p1' },
      ],
    })
    expect(await resolve({ project_uid: 'Sepsis study', cohort_id: 'adults' }, cohorts))
      .toEqual({ args: { project_uid: 'p1', cohort_id: 'c2' } })
  })

  it('says what was received and what can be used when nothing matches', async () => {
    const result = await resolve({ database_id: 'EHRSQL' }, dir)
    expect(result).toEqual({
      error: 'database_id "EHRSQL" matches no database (by id or name). '
        + `Databases you can access: MIMIC-IV demo (${DB_A.id}), Synthetic ICU (b2).`,
    })
  })

  it('does not take a truncated id', async () => {
    const result = await resolve({ database_id: '545d0a67-2c98-4270-9df6-0000' }, dir)
    expect('error' in result && result.error).toMatch(/^database_id "545d0a67-2c98-4270-9df6-0000" matches no database/)
  })

  it('lists a few objects, then points to the full listing', async () => {
    const many = Array.from({ length: 13 }, (_, i) => ({ id: `d${i}`, label: `DB ${i}`, names: [`DB ${i}`] }))
    const result = await resolve({ database_id: 'nope' }, directory({ database: many }))
    expect('error' in result && result.error).toMatch(/DB 9 \(d9\), and 3 more \(list_databases lists them all\)\.$/)
  })

  it('re-reads the listing before calling a name unknown, for an object just created', async () => {
    const list = vi.fn(async (_kind: RefKind, notBefore?: number) => (notBefore ? [DB_A, DB_B] : [DB_A]))
    expect(await resolve({ database_id: 'Synthetic ICU' }, { list, linkedDatabases: async () => [] }))
      .toEqual({ args: { database_id: 'b2' } })
    expect(list).toHaveBeenLastCalledWith('database', expect.any(Number))
  })

  it('leaves the value to the call when the listing itself fails', async () => {
    const broken: Directory = { list: async () => { throw new Error('down') }, linkedDatabases: async () => [] }
    expect(await resolve({ database_id: 'EHRSQL' }, broken)).toEqual({ args: { database_id: 'EHRSQL' } })
  })
})

describe('ids and names', () => {
  it('takes a uuid as an id without listing anything, even one no listing returns', async () => {
    const dir = directory({ database: [DB_A] })
    const unlisted = '0b7d3c1e-5a4f-4c2b-9e8d-7f6a5b4c3d2e'
    expect(await resolve({ database_id: unlisted }, dir)).toEqual({ args: { database_id: unlisted } })
    expect(dir.list).not.toHaveBeenCalled()
  })

  it('reads a value equal to one object\'s id and another\'s name as the id', async () => {
    const dir = directory({ cohort: [
      { id: 'adults', label: 'Adults', names: ['Adults'] },
      { id: 'c9', label: 'adults', names: ['adults'] },
    ] })
    expect(await resolve({ cohort_id: 'adults' }, dir)).toEqual({ args: { cohort_id: 'adults' } })
  })

  it('prefers the exact spelling over a case-insensitive match', async () => {
    const dir = directory({ cohort: [
      { id: 'c1', label: 'ICU', names: ['ICU'] },
      { id: 'c2', label: 'icu', names: ['icu'] },
    ] })
    expect(await resolve({ cohort_id: 'icu' }, dir)).toEqual({ args: { cohort_id: 'c2' } })
    expect(await resolve({ cohort_id: 'ICU' }, dir)).toEqual({ args: { cohort_id: 'c1' } })
    expect('error' in await resolve({ cohort_id: 'Icu' }, dir)).toBe(true)
  })

  it('reads a database name among the project\'s databases when several share it', async () => {
    const twin: Ref = { id: 'b3', label: 'Synthetic ICU', names: ['Synthetic ICU'] }
    const dir = directory({ project: [PROJECT], database: [DB_A, DB_B, twin] }, { p1: ['b3'] })
    expect(await resolve({ project_uid: 'Sepsis study', database_id: 'synthetic icu' }, dir))
      .toEqual({ args: { project_uid: 'p1', database_id: 'b3' } })
    expect('error' in await resolve({ database_id: 'synthetic icu' }, dir)).toBe(true)
  })

  it('resolves a git or README id by the kind its entity parameter names', async () => {
    const dir = directory({ project: [PROJECT], database: [DB_A] })
    expect(await resolve({ entity: 'project', id: 'Sepsis study' }, dir, ['id']))
      .toEqual({ args: { entity: 'project', id: 'p1' } })
    expect(await resolve({ entity_type: 'database', entity_id: 'mimic_demo' }, dir, ['entity_id']))
      .toEqual({ args: { entity_type: 'database', entity_id: DB_A.id } })
    expect(await resolve({ entity: 'sql_collection', id: 'My queries' }, dir, ['id']))
      .toEqual({ args: { entity: 'sql_collection', id: 'My queries' } })
  })
})

describe('cachedDirectory', () => {
  it('keeps listings per user, and lists once per call even when the name is unknown', async () => {
    const fetch = vi.fn(async () => [DB_A])
    let caller = 'alice'
    const dir = cachedDirectory(fetch, () => caller)
    await dir.list('database')
    await dir.list('database')
    expect(fetch).toHaveBeenCalledTimes(1)
    caller = 'bob'
    await dir.list('database')
    expect(fetch).toHaveBeenCalledTimes(2)

    caller = 'carol'
    expect('error' in await resolveArguments({ database_id: 'EHRSQL' }, ['database_id'], false, dir)).toBe(true)
    expect(fetch).toHaveBeenCalledTimes(3)
  })

  it('re-lists after forget, for the current user only', async () => {
    const fetch = vi.fn(async () => [DB_A])
    let caller = 'alice'
    const dir = cachedDirectory(fetch, () => caller)
    await dir.list('database')
    caller = 'bob'
    await dir.list('database')
    dir.forget!()
    await dir.list('database')
    caller = 'alice'
    await dir.list('database')
    expect(fetch).toHaveBeenCalledTimes(3)
  })
})

describe('objects the user cannot see', () => {
  // The listings are the user's own: an object outside them does not exist for the resolver.
  const HIDDEN = { id: 'hidden-1', name: 'Restricted ICU' }
  const dir = directory({ database: [DB_A] })

  it('stays not found by name and by a non-uuid id, and is never named in the message', async () => {
    for (const value of [HIDDEN.name, HIDDEN.id]) {
      const result = await resolve({ database_id: value }, dir)
      expect('error' in result).toBe(true)
      const message = (result as { error: string }).error
      expect(message).toContain(`Databases you can access: MIMIC-IV demo (${DB_A.id}).`)
      expect(message.replace(`"${value}"`, '')).not.toMatch(/Restricted ICU|hidden-1/)
    }
  })
})

describe('database_id left out', () => {
  it('uses the only database the user can access', async () => {
    expect(await resolve({ sql: 'x' }, directory({ database: [DB_A] }), ['database_id'], true))
      .toEqual({ args: { sql: 'x', database_id: DB_A.id } })
  })

  it('lists the databases when there are several', async () => {
    const result = await resolve({ sql: 'x' }, directory({ database: [DB_A, DB_B] }), ['database_id'], true)
    expect(result).toEqual({
      error: `database_id is missing, and you can access 2 databases: MIMIC-IV demo (${DB_A.id}), Synthetic ICU (b2). `
        + 'Give database_id (an id or a name).',
    })
  })

  it('is left to the tool when the tool does not default it', async () => {
    expect(await resolve({ sql: 'x' }, directory({ database: [DB_A] }), ['database_id'], false))
      .toEqual({ args: { sql: 'x' } })
  })
})

function fakeTool(annotations: typeof READ | typeof WRITE): CatalogTool & { calls: unknown[] } {
  const calls: unknown[] = []
  return {
    name: 'fake', toolset: 'warehouse', calls,
    config: {
      annotations,
      inputSchema: fromJsonSchema({
        type: 'object',
        properties: { database_id: { type: 'string' }, sql: { type: 'string', description: 'The query.' } },
        required: ['database_id', 'sql'],
      }),
    },
    handler: async (args) => { calls.push(args); return text('ok') },
  }
}

describe('withReferences', () => {
  it('makes database_id optional on a read tool, and resolves before the call', async () => {
    const raw = fakeTool(READ)
    const tool = withReferences(raw, directory({ database: [DB_A] }))
    const schema = inputJsonSchema(tool) as { required: string[]; properties: Record<string, { description?: string }> }
    expect(schema.required).toEqual(['sql'])
    expect(schema.properties.database_id.description).toMatch(/^Id or name; may be left out/)
    expect(schema.properties.sql.description).toBe('The query.')
    expect('value' in await checkArguments(tool, { sql: 'x' })).toBe(true)

    await tool.handler({ sql: 'x' })
    await tool.handler({ database_id: 'mimic-iv-demo', sql: 'y' })
    expect(raw.calls).toEqual([{ sql: 'x', database_id: DB_A.id }, { database_id: DB_A.id, sql: 'y' }])
  })

  it('keeps database_id required on a tool that writes', () => {
    const tool = withReferences(fakeTool(WRITE), directory({ database: [DB_A] }))
    const schema = inputJsonSchema(tool) as { required: string[]; properties: Record<string, { description?: string }> }
    expect(schema.required).toEqual(['database_id', 'sql'])
    expect(schema.properties.database_id.description).toBe('Id or name.')
  })

  it('drops the listings after a tool that writes, not after a read', async () => {
    const read = directory({ database: [DB_A] })
    await withReferences(fakeTool(READ), read).handler({ database_id: DB_A.id, sql: 'x' })
    expect(read.forget).not.toHaveBeenCalled()
    const write = directory({ database: [DB_A] })
    await withReferences(fakeTool(WRITE), write).handler({ database_id: DB_A.id, sql: 'x' })
    expect(write.forget).toHaveBeenCalledOnce()
  })

  it('returns the error instead of calling the tool', async () => {
    const raw = fakeTool(READ)
    const result = await withReferences(raw, directory({ database: [DB_A] })).handler({ database_id: 'EHRSQL', sql: 'x' })
    expect(result.isError).toBe(true)
    expect(raw.calls).toEqual([])
  })
})

describe('catalog', () => {
  const schemaOf = (name: string) =>
    inputJsonSchema(CATALOG.find((t) => t.name === name)!) as { required?: string[]; properties: Record<string, { description?: string }> }

  it('says "id or name" on the reference parameters and defaults database_id on read tools only', () => {
    for (const name of ['run_sql', 'search_concepts', 'describe_database']) {
      expect(schemaOf(name).required ?? []).not.toContain('database_id')
    }
    expect(schemaOf('create_dataset_from_query').required).toContain('database_id')
    expect(schemaOf('list_cohorts').properties.project_uid.description).toBe('Id or name.')
    expect(schemaOf('get_cohort').properties.cohort_id.description).toBe('Id or name.')
    expect(schemaOf('get_git_status').properties.id.description)
      .toMatch(/For a project, workspace, mapping project or database, its name also works\.$/)
    expect(schemaOf('get_readme').properties.entity_id.description).toMatch(/For a workspace, database or mapping project, its name also works\.$/)
  })
})
