import { McpServer } from '@modelcontextprotocol/server'
import { describe, expect, it } from 'vitest'
import type { Job, ProjectEnvironment } from '@/lib/api/environments'
import type { IdeConnection } from '@/types'
import {
  buildOptionsOverride, formatEnvironment, formatIdeConnections, formatJobList, formatRunJob, formatSessions,
  parsePackages, redactUrl,
} from './runtime'
import { registerRuntimeTools } from './tools-runtime'

const job = (over: Partial<Job>): Job => ({
  id: 'j1', projectUid: 'p1', workspaceId: null, kind: 'run', label: 'model.R', status: 'done',
  progress: 100, logTail: '', result: null, createdAt: '2026-09-27T10:11:12.000Z', ...over,
})

describe('formatSessions', () => {
  it('lists default first, named sessions, and orphan live kernels, per language', () => {
    const out = formatSessions(
      [{ id: 's1', projectUid: 'p1', language: 'r', name: 'Long fit' }],
      [
        { language: 'r', sessionId: 'default', alive: true, busy: false, pid: 1, rssKb: 204800, idleSeconds: 12 },
        { language: 'r', sessionId: 's1', alive: true, busy: true, pid: 2, rssKb: null, idleSeconds: 0 },
        { language: 'r', sessionId: 'ghost', alive: true, busy: false, pid: 3, rssKb: null, idleSeconds: 5 },
      ],
      ['r'],
    )
    const lines = out.split('\n')
    expect(lines[0]).toBe('R:')
    expect(lines[1]).toContain('default')
    expect(lines[1]).toContain('idle 12s, 200 MB')
    expect(lines[2]).toContain('"Long fit" (session "s1") — running code')
    expect(lines[3]).toContain('session "ghost"')
  })

  it('says when a session has no live kernel', () => {
    expect(formatSessions([], [], ['python'])).toContain('no live kernel')
  })
})

describe('formatJobList', () => {
  it('prints one line per job with its id', () => {
    expect(formatJobList([job({ status: 'running', progress: 40 })]))
      .toBe('- 2026-09-27 10:11:12 · run · "model.R" — running 40% · job_id: j1')
    expect(formatJobList([])).toBe('No recent job.')
  })
})

describe('formatRunJob', () => {
  it('shows the log, the table and the figure count once done', () => {
    const out = formatRunJob(job({
      logTail: 'n = 42',
      result: { figures: [{ type: 'svg', data: '<svg/>' }], table: { headers: ['a'], rows: [['1']] }, html: null },
    }))
    expect(out.startsWith('Job j1 (run) "model.R": done')).toBe(true)
    expect(out).toContain('stdout:\nn = 42')
    expect(out).toContain('table:\na\n1')
    expect(out).toContain('1 figure(s)')
    expect(out).not.toContain('Ran successfully')
  })

  it('shows the output so far while running', () => {
    const out = formatRunJob(job({ status: 'running', progress: 10, logTail: 'step 1\nstep 2' }))
    expect(out).toContain('Still in progress')
    expect(out).toContain('step 2')
  })
})

describe('redactUrl', () => {
  it('masks credentials in a URL', () => {
    expect(redactUrl('https://bob:s3cret@pypi.hospital.org/simple')).toBe('https://***@pypi.hospital.org/simple')
    expect(redactUrl('https://cloud.r-project.org')).toBe('https://cloud.r-project.org')
  })
})

describe('formatEnvironment', () => {
  const env: ProjectEnvironment = {
    id: 'e', projectUid: 'p1', language: 'r', kind: 'managed', status: 'draft', interpreterPath: null, staleSessions: ['default'],
  }

  it('lists packages with available updates, kernel packages and redacted options', () => {
    const out = formatEnvironment({
      env,
      packages: [{ name: 'jsonlite', spec: '', system: true }, { name: 'dplyr', spec: '==1.1.0' }],
      updates: { packages: { dplyr: '1.1.4' }, checkedAt: '2026-09-01' },
      options: { override: { repos: 'https://u:p@mirror.local/cran' }, effective: { repos: 'https://u:p@mirror.local/cran' } },
    })
    expect(out).toContain('Status: draft')
    expect(out).toContain('restart_kernel')
    expect(out).toContain('- jsonlite (kernel package, cannot be removed)')
    expect(out).toContain('- dplyr ==1.1.0 → 1.1.4 available')
    expect(out).toContain('repos=https://***@mirror.local/cran')
    expect(out).not.toContain('u:p@')
  })

  it('bounds the package list', () => {
    const packages = Array.from({ length: 5 }, (_, i) => ({ name: `p${i}`, spec: '' }))
    expect(formatEnvironment({ env, packages, updates: null, options: null }, 2)).toContain('… 3 more')
  })
})

describe('parsePackages', () => {
  it('splits on commas and whitespace, drops blanks and duplicates', () => {
    expect(parsePackages(['dplyr==1.2.1, tidyr', ' lubridate  tidyr'])).toEqual(['dplyr==1.2.1', 'tidyr', 'lubridate'])
    expect(parsePackages('')).toEqual([])
  })
})

describe('buildOptionsOverride', () => {
  it('merges over the current override and clears a field given as ""', () => {
    expect(buildOptionsOverride('r', { repos: 'https://a.org', method: 'curl' }, { method: '' }))
      .toEqual({ override: { repos: 'https://a.org' } })
    expect(buildOptionsOverride('python', {}, { index_url: ' https://pypi.local/simple ', trusted_host: 'pypi.local' }))
      .toEqual({ override: { indexUrl: 'https://pypi.local/simple', trustedHost: 'pypi.local' } })
  })

  it('refuses the other language\'s fields, bad URLs, unknown methods and credentials', () => {
    expect(buildOptionsOverride('r', {}, { index_url: 'https://x.org' })).toHaveProperty('error')
    expect(buildOptionsOverride('python', {}, { repos: 'https://x.org' })).toHaveProperty('error')
    expect(buildOptionsOverride('r', {}, { repos: "https://x.org'; system('id')" })).toHaveProperty('error')
    expect(buildOptionsOverride('r', {}, { method: 'curl; rm' })).toHaveProperty('error')
    expect(buildOptionsOverride('python', {}, { index_url: 'https://u:p@x.org/simple' })).toHaveProperty('error')
  })
})

describe('formatIdeConnections', () => {
  it('shows linked databases and custom connections without secrets', () => {
    const custom = [{
      id: 'c1', projectUid: 'p1', name: 'Local PG', source: 'custom', status: 'disconnected', createdAt: '',
      connectionConfig: { engine: 'postgresql', host: 'db.local', port: 5432, username: 'bob', password: 'x' },
    }] as unknown as IdeConnection[]
    const out = formatIdeConnections([{ id: 'd1', name: 'MIMIC', engine: 'duckdb', status: 'connected' }], custom)
    expect(out).toContain('database_id: d1 · duckdb · connected')
    expect(out).toContain('connection id: c1 · postgresql · disconnected · host=db.local, port=5432')
    expect(out).not.toContain('bob')
    expect(out).not.toContain('password')
    expect(formatIdeConnections([], [])).toBe('No database connection in this project.')
  })
})

describe('registerRuntimeTools', () => {
  it('registers every tool with a valid schema', () => {
    expect(() => registerRuntimeTools(new McpServer({ name: 't', version: '0' }))).not.toThrow()
  })
})
