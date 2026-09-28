/**
 * Fetching a data dictionary repository.
 *
 * Server mode clones it (any host, private ones with the user's token) through
 * the shared clone-to-ZIP route. Front-only has no git client, so it reads a
 * GitHub repository through the API (one tree listing) and raw.githubusercontent
 * (the files) — both answer cross-origin requests. Other hosts need server mode:
 * GitLab's tree API does not.
 */
import { isServerMode } from '@/lib/api-client'
import { gitCloneToZip } from '@/lib/api/git'
import { isDictionaryFile, readDictionaryTree, type DictionaryContent } from './content'

export const DEFAULT_DICTIONARY_REPO = 'https://github.com/indicate-eu/data-dictionary'
export const DEFAULT_DICTIONARY_BRANCH = 'main'

/** `owner/repo` of a GitHub URL (https or ssh, with or without `.git`). */
export function githubRepoOf(url: string): { owner: string; repo: string } | null {
  const m = url.trim().match(/github\.com[/:]([^/\s]+)\/([^/\s#?]+?)(?:\.git)?\/?(?:[#?].*)?$/i)
  return m ? { owner: m[1], repo: m[2] } : null
}

/** A readable name for a repository URL: its last path segment. */
export function repoName(url: string): string {
  return url.trim().replace(/\.git$/, '').replace(/\/+$/, '').split(/[/:]/).pop() || url
}

async function fromClone(url: string, branch: string): Promise<{ files: Record<string, string>; commit: string | null }> {
  const { blob, oid } = await gitCloneToZip(url, branch)
  const JSZip = (await import('jszip')).default
  const zip = await JSZip.loadAsync(blob)
  const files: Record<string, string> = {}
  for (const [path, entry] of Object.entries(zip.files)) {
    if (!entry.dir && isDictionaryFile(path)) files[path] = await entry.async('string')
  }
  return { files, commit: oid }
}

async function fromGitHub(owner: string, repo: string, branch: string): Promise<{ files: Record<string, string>; commit: string | null }> {
  const api = `https://api.github.com/repos/${owner}/${repo}`
  const head = await fetch(`${api}/commits/${encodeURIComponent(branch)}`)
  if (!head.ok) throw new Error(`GitHub: ${owner}/${repo}@${branch} not found (${head.status})`)
  const sha = String(((await head.json()) as { sha: string }).sha)
  const tree = await fetch(`${api}/git/trees/${sha}?recursive=1`)
  if (!tree.ok) throw new Error(`GitHub: cannot list ${owner}/${repo} (${tree.status})`)
  const paths = ((await tree.json()) as { tree: { path: string; type: string }[] }).tree
    .filter((e) => e.type === 'blob' && isDictionaryFile(e.path))
    .map((e) => e.path)
  const files: Record<string, string> = {}
  for (let i = 0; i < paths.length; i += 20) {
    await Promise.all(paths.slice(i, i + 20).map(async (path) => {
      const res = await fetch(`https://raw.githubusercontent.com/${owner}/${repo}/${sha}/${path}`)
      if (res.ok) files[path] = await res.text()
    }))
  }
  return { files, commit: sha }
}

/** The dictionary content at the head of `branch`. */
export async function fetchDictionary(url: string, branch: string, lang = 'en'): Promise<DictionaryContent> {
  let fetched: { files: Record<string, string>; commit: string | null }
  if (isServerMode()) {
    fetched = await fromClone(url, branch)
  } else {
    const gh = githubRepoOf(url)
    if (!gh) throw new Error('Without the server, only GitHub repositories can be read.')
    fetched = await fromGitHub(gh.owner, gh.repo, branch)
  }
  const content = readDictionaryTree(fetched.files, fetched.commit, lang)
  if (content.conceptSets.length === 0) throw new Error('No concept set found (concept_sets/*.json).')
  return content
}
