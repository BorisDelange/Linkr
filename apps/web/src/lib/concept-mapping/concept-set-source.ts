/**
 * Locate the concept sets inside a dictionary, however it arrived.
 *
 * A dictionary is a repository (or a ZIP of one) holding a folder of concept-set
 * JSONs, so the useful default is "import all of them". The same input must still
 * accept a link to a single file, because sometimes one concept set is all that
 * is wanted — the shape of what was pasted says which, so the user does not have
 * to choose.
 *
 * Everything here is pure: fetching and cloning happen in the dialog, which
 * reuses the shared git-clone-to-ZIP path (see components/ui/import-source-dialog).
 */

import { naturalCompare } from '@/lib/format-helpers'

// Re-exported: this module was its original home, and it is part of the API
// callers here already import.
export { naturalCompare }

/** Where the concept sets of a dictionary live, by convention. */
export const CONCEPT_SETS_DIR = 'concept_sets'

/**
 * File path inside a repo, when the pasted URL pointed at one file rather than
 * the repository. `cleanGitUrl` throws this part away (it wants a clone URL), so
 * it is extracted separately and used to narrow the import afterwards.
 *
 * Recognises the `/blob/<ref>/<path>` and `/raw/<ref>/<path>` forms used by
 * GitHub and GitLab, the GitLab `/-/blob/…` variant, and a raw.githubusercontent
 * URL (`/<owner>/<repo>/<ref>/<path>`).
 */
export function fileTargetOf(rawUrl: string): string | null {
  const url = rawUrl.trim().split(/[?#]/, 1)[0]
  if (!url) return null

  const rawHost = url.match(/^https?:\/\/raw\.githubusercontent\.com\/[^/]+\/[^/]+\/[^/]+\/(.+)$/i)
  if (rawHost) return normalizeTarget(rawHost[1])

  const nav = url.match(/\/(?:blob|raw)\/[^/]+\/(.+)$/i)
  if (nav) return normalizeTarget(nav[1])

  return null
}

function normalizeTarget(path: string): string | null {
  const clean = path.replace(/^\/+/, '')
  return clean.toLowerCase().endsWith('.json') ? clean : null
}

/**
 * Concept-set JSONs inside an archive, most-likely-first.
 *
 * A cloned repo carries far more than concept sets (README, CI config, other
 * data), and a ZIP built by a host wraps everything in a `<repo>-<ref>/` folder.
 * Files under a `concept_sets/` directory are therefore preferred; when the
 * archive has no such folder, any JSON is taken so a hand-made ZIP still works.
 *
 * `only` restricts the result to one file — used when the pasted URL named a
 * single concept set. Matching is on the path suffix, since the archive prefixes
 * everything with its wrapper folder.
 */
export function pickConceptSetEntries(paths: string[], only?: string | null): string[] {
  const jsons = paths.filter((p) => (
    p.toLowerCase().endsWith('.json')
    && !p.endsWith('/')
    && !p.includes('__MACOSX')
    // Dotfiles and vendored code are never dictionary content.
    && !p.split('/').some((seg) => seg.startsWith('.') || seg === 'node_modules')
  ))

  if (only) {
    const wanted = only.replace(/^\/+/, '').toLowerCase()
    const hit = jsons.filter((p) => {
      const lower = p.toLowerCase()
      return lower === wanted || lower.endsWith(`/${wanted}`)
    })
    return hit.sort(naturalCompare)
  }

  const inConceptSets = jsons.filter((p) => p.split('/').includes(CONCEPT_SETS_DIR))
  return (inConceptSets.length > 0 ? inConceptSets : jsons).sort(naturalCompare)
}



/** Repo name from a clone URL, for labelling the import batch. */
export function repoLabelOf(url: string): string {
  const path = url.trim().split(/[?#]/, 1)[0].replace(/\/+$/, '').replace(/\.git$/i, '')
  const parts = path.split('/').filter(Boolean)
  const [owner, repo] = parts.slice(-2)
  return repo ? `${owner}/${repo}` : (owner ?? url)
}
