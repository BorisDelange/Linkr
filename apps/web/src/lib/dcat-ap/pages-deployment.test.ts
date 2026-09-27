import { describe, expect, it } from 'vitest'
import {
  buildPagesCiFile,
  buildPagesTree,
  guessPagesProvider,
  isPagesTreePath,
  pagesUrlFromRemote,
} from './pages-deployment'

describe('guessPagesProvider', () => {
  it('picks GitHub for github.com and GitLab for everything else', () => {
    expect(guessPagesProvider('https://github.com/owner/repo.git')).toBe('github')
    expect(guessPagesProvider('git@github.com:owner/repo.git')).toBe('github')
    expect(guessPagesProvider('https://framagit.org/interhop/linkr/catalog')).toBe('gitlab')
    expect(guessPagesProvider('https://git.chu.example/team/catalog')).toBe('gitlab')
    expect(guessPagesProvider(undefined)).toBe('gitlab')
  })
})

describe('pagesUrlFromRemote', () => {
  it('maps gitlab.com, framagit and github.com project sites', () => {
    expect(pagesUrlFromRemote('https://gitlab.com/Group/catalog.git', 'gitlab'))
      .toEqual({ kind: 'known', url: 'https://group.gitlab.io/catalog/' })
    expect(pagesUrlFromRemote('https://framagit.org/interhop/linkr/catalog', 'gitlab'))
      .toEqual({ kind: 'known', url: 'https://interhop.frama.io/linkr/catalog/' })
    expect(pagesUrlFromRemote('git@github.com:owner/repo.git', 'github'))
      .toEqual({ kind: 'known', url: 'https://owner.github.io/repo/' })
  })

  it('serves a user/group site repo at the root', () => {
    expect(pagesUrlFromRemote('https://github.com/Owner/owner.github.io', 'github'))
      .toEqual({ kind: 'known', url: 'https://owner.github.io/' })
    expect(pagesUrlFromRemote('https://gitlab.com/grp/grp.gitlab.io', 'gitlab'))
      .toEqual({ kind: 'known', url: 'https://grp.gitlab.io/' })
  })

  it('never leaks credentials from the remote', () => {
    const r = pagesUrlFromRemote('https://oauth2:secret@gitlab.com/g/p.git', 'gitlab')
    expect(r).toEqual({ kind: 'known', url: 'https://g.gitlab.io/p/' })
  })

  it('reports self-hosted instances, provider mismatches and unusable remotes', () => {
    expect(pagesUrlFromRemote('https://git.chu.example/team/catalog', 'gitlab')).toEqual({ kind: 'self-hosted' })
    expect(pagesUrlFromRemote('https://gitlab.com/g/p', 'github')).toEqual({ kind: 'provider-mismatch', hostProvider: 'gitlab' })
    expect(pagesUrlFromRemote('https://github.com/owner', 'github')).toEqual({ kind: 'invalid-remote' })
    expect(pagesUrlFromRemote('https://github.com/o/r/tree/main', 'github')).toEqual({ kind: 'invalid-remote' })
    expect(pagesUrlFromRemote('', 'gitlab')).toEqual({ kind: 'invalid-remote' })
  })
})

describe('buildPagesCiFile', () => {
  it('GitLab: a pages job publishing site/ as public on the linked branch', () => {
    const yml = buildPagesCiFile('gitlab', 'main')
    expect(yml).toContain('pages:\n')
    expect(yml).toContain('    - cp -r site public\n')
    expect(yml).toContain('      - public\n')
    expect(yml).toContain('    - if: $CI_COMMIT_BRANCH == "main"\n')
  })

  it('GitHub: upload + deploy actions with the Pages permissions', () => {
    const yml = buildPagesCiFile('github', 'release/v1')
    expect(yml).toContain('      - "release/v1"\n')
    expect(yml).toContain('  pages: write\n  id-token: write\n')
    expect(yml).toMatch(/actions\/upload-pages-artifact@v\d+\n\s+with:\n\s+path: site\n/)
    expect(yml).toContain('uses: actions/deploy-pages@')
  })

  it('falls back to the default branch for a name unsafe in YAML', () => {
    expect(buildPagesCiFile('gitlab', 'a"b: c')).toContain('$CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH')
    expect(buildPagesCiFile('github', 'a"b: c')).not.toContain('branches:')
    expect(buildPagesCiFile('gitlab', undefined)).toContain('$CI_DEFAULT_BRANCH')
  })
})

describe('buildPagesTree', () => {
  const files = [
    { name: 'catalog.html', content: '<html>' },
    { name: 'concepts.csv', content: 'a\n' },
    { name: 'metadata.jsonld', content: '{}' },
  ]

  it('serves the catalog page as site/index.html and adds the CI file', () => {
    const tree = buildPagesTree(files, 'github', 'main')
    expect(tree.map((f) => f.path)).toEqual([
      'site/index.html', 'site/concepts.csv', 'site/metadata.jsonld', '.github/workflows/pages.yml',
    ])
    expect(tree[0]).toMatchObject({ content: '<html>', mimeType: 'text/html' })
    expect(tree.every((f) => isPagesTreePath(f.path))).toBe(true)
  })

  it('uses .gitlab-ci.yml for GitLab', () => {
    expect(buildPagesTree(files, 'gitlab', 'main').at(-1)?.path).toBe('.gitlab-ci.yml')
  })
})

describe('isPagesTreePath', () => {
  it('only lets site files and the two CI files into the repo', () => {
    expect(isPagesTreePath('site/index.html')).toBe(true)
    expect(isPagesTreePath('site/data/concepts.csv')).toBe(true)
    expect(isPagesTreePath('.gitlab-ci.yml')).toBe(true)
    expect(isPagesTreePath('.github/workflows/pages.yml')).toBe(true)
    expect(isPagesTreePath('entity.json')).toBe(false)
    expect(isPagesTreePath('site/../entity.json')).toBe(false)
    expect(isPagesTreePath('site/.hidden')).toBe(false)
    expect(isPagesTreePath('.github/workflows/other.yml')).toBe(false)
    expect(isPagesTreePath('site/')).toBe(false)
  })
})
