import { McpServer, fromJsonSchema, type ToolAnnotations } from '@modelcontextprotocol/server'
import { describe, expect, it } from 'vitest'
import { CATALOG } from './build'
import { captureTools, checkArguments, formatIndex, formatToolCard, kindOf, searchTools, type CatalogTool } from './gateway'
import { DESTRUCTIVE, READ, WRITE, text } from './shared'

const tool = (name: string, toolset: string, description: string, annotations: ToolAnnotations = READ): CatalogTool => ({
  name, toolset, config: { description, annotations }, handler: async () => text(name),
})

describe('captureTools', () => {
  it('collects what a register function declares, with its family', () => {
    const got = captureTools('demo', [(s: McpServer) => {
      s.registerTool('ping', { description: 'Ping.', annotations: READ }, async () => text('pong'))
    }])
    expect(got.map((t) => [t.name, t.toolset])).toEqual([['ping', 'demo']])
  })
})

describe('kindOf', () => {
  it('maps annotations to the run tool that may call it', () => {
    expect(kindOf(READ)).toBe('read')
    expect(kindOf({ ...READ, openWorldHint: true })).toBe('read')
    expect(kindOf(WRITE)).toBe('write')
    expect(kindOf(DESTRUCTIVE)).toBe('delete')
    expect(kindOf(undefined)).toBe('write')
  })
})

describe('searchTools', () => {
  const catalog = [
    tool('create_dq_check', 'dq', 'Add a custom SQL data-quality check to a rule set.', WRITE),
    tool('list_dq_rule_sets', 'dq', 'Data-quality rule sets of a workspace.'),
    tool('review_mappings', 'mapping', 'Vote on concept mappings: approve, reject, flag.', WRITE),
    tool('create_project', 'workspace', 'Create a project in a workspace.', WRITE),
  ]

  it('ranks name words above description words', () => {
    expect(searchTools(catalog, 'create a check')[0].name).toBe('create_dq_check')
    expect(searchTools(catalog, 'approve the mappings')[0].name).toBe('review_mappings')
  })

  it('matches plural and singular, and ignores accents and stop words', () => {
    expect(searchTools(catalog, 'projects').map((t) => t.name)).toContain('create_project')
    expect(searchTools(catalog, 'créer un projet')).toEqual([])
    expect(searchTools(catalog, 'the of a')).toEqual([])
  })

  it('finds real tools for everyday requests', () => {
    const top = (q: string) => searchTools(CATALOG, q, 5).map((t) => t.name)
    expect(top('add a data quality check')).toContain('create_dq_check')
    expect(top('review mappings')).toContain('review_mappings')
    expect(top('create a project')).toContain('create_project')
    expect(top('install R package')).toContain('install_packages')
    expect(top('run etl pipeline')).toContain('run_etl_pipeline')
    expect(top('wiki page')).toContain('get_wiki_page')
    expect(top('git diff')).toContain('get_git_diff')
  })
})

describe('formatting', () => {
  it('gives a tool card with its kind, run tool and argument schema', () => {
    const card = formatToolCard({
      ...tool('delete_thing', 'demo', 'Delete a thing.', DESTRUCTIVE),
      config: {
        description: 'Delete a thing.', annotations: DESTRUCTIVE,
        inputSchema: fromJsonSchema({ type: 'object', properties: { id: { type: 'string' } }, required: ['id'] }),
      },
    })
    expect(card).toContain('delete_thing — delete, call with run_linkr_delete_tool (family: demo)')
    expect(card).toContain('"required":["id"]')
  })

  it('indexes names by family and stars the direct ones', () => {
    const out = formatIndex([tool('a', 'x', ''), tool('b', 'x', ''), tool('c', 'y', '')], new Set(['b']))
    expect(out).toContain('- x: a, b*')
    expect(out).toContain('- y: c')
  })
})

describe('checkArguments', () => {
  const withSchema: CatalogTool = {
    ...tool('t', 'demo', ''),
    config: { inputSchema: fromJsonSchema({ type: 'object', properties: { id: { type: 'string' } }, required: ['id'] }) },
  }

  it('passes fitting arguments and lists the issues of others', async () => {
    expect(await checkArguments(withSchema, { id: 'x' })).toEqual({ value: { id: 'x' } })
    const bad = await checkArguments(withSchema, { id: 3 })
    expect('issues' in bad && bad.issues.join()).toMatch(/string/)
    expect('issues' in (await checkArguments(withSchema, undefined))).toBe(true)
  })
})
