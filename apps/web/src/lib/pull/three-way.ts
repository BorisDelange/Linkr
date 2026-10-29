/**
 * The 3-way pull of any versioned entity (docs/planning/collaborative-versioning-plan.md
 * §9.2): from what the server says the remote changed — each file with its base,
 * local and remote versions — to the items the user decides on, and back to the
 * file contents the merged tree is built from.
 *
 * What an item is depends on the file:
 *  - Markdown: the file, merged by paragraph; a conflict where both sides changed
 *    the same paragraph.
 *  - JSON object (a manifest, a dashboard, a cohort): one item per top-level field.
 *    `appVersion`/`minAppVersion` are stamps of whoever exported, never items.
 *  - JSON array of keyed objects (`_tree.json`, `checks.json`, `mappings.json`):
 *    one item per element, by its natural key.
 *  - Code, CSV, any other text: the file, merged by line.
 *  - Binary, or text too large to ship: the file, whole.
 *
 * Accepting an item takes the remote side of it (a merged file takes the merge,
 * its conflicting parts from the remote); declining keeps the local side, which
 * then shows as a change to push.
 */
import type { GitScope } from '@/lib/api/git'
import { buildPullFiles, itemIdFor, type PullDecision, type PullItem, type PullItemState, type PullPlan } from '@/lib/pull-plan'
import { LINES, PARAGRAPHS, mergeText, resolveMerge, type MarkdownMerge, type MergeUnit } from '@/lib/wiki/markdown-merge'

export interface ThreeWayFile {
  path: string
  baseOid?: string | null
  localOid?: string | null
  remoteOid?: string | null
  binary?: boolean
  base?: string | null
  local?: string | null
  remote?: string | null
}

export interface ThreeWayPreview {
  branch: string
  remoteHead: string | null
  syncedOid?: string | null
  files: ThreeWayFile[]
}

/** Stamped by the exporting app, not authored: never offered, never merged. */
const STAMP_FIELDS = new Set(['appVersion', 'minAppVersion'])

/** Keys that identify an element of a JSON array, in order of preference. */
const ELEMENT_KEYS = ['id', 'path', 'key', 'templateKey', 'entityId', 'name'] as const

type Json = Record<string, unknown>

/** How one file is decided on. */
export type FileMerge =
  | { kind: 'whole'; state: PullItemState }
  | { kind: 'text'; unit: 'paragraphs' | 'lines'; merge: MarkdownMerge; base: string; local: string; remote: string; state: PullItemState }
  | { kind: 'fields'; base: Json | null; local: Json | null; remote: Json | null; fields: { key: string; state: PullItemState }[] }
  | { kind: 'elements'; keyField: string; base: Json[]; local: Json[]; remote: Json[]; elements: { key: string; state: PullItemState }[] }

export interface PreparedFile {
  file: ThreeWayFile
  merge: FileMerge
}

const stable = (v: unknown): string => {
  const sort = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(sort)
    if (x && typeof x === 'object') {
      return Object.fromEntries(Object.keys(x as Json).sort().map((k) => [k, sort((x as Json)[k])]))
    }
    return x
  }
  return v === undefined ? 'undefined' : JSON.stringify(sort(v))
}

/** add / update / delete when only the remote moved; conflict when both did. */
function verdict(base: unknown, local: unknown, remote: unknown, present: (v: unknown) => boolean): PullItemState | null {
  const [b, l, r] = [stable(base), stable(local), stable(remote)]
  if (r === l) return null
  if (l === b) return !present(base) ? 'add' : !present(remote) ? 'delete' : 'update'
  if (r === b) return null
  return 'conflict'
}

const has = (v: unknown) => v !== undefined && v !== null

function unitFor(path: string): { name: 'paragraphs' | 'lines'; unit: MergeUnit } {
  return /\.md$/i.test(path) ? { name: 'paragraphs', unit: PARAGRAPHS } : { name: 'lines', unit: LINES }
}

function parseJson(text: string | null | undefined): unknown {
  if (text == null) return undefined
  try { return JSON.parse(text) } catch { return Symbol.for('unparseable') }
}

/** The key field shared by every element of the three arrays, or null. */
function elementKey(arrays: unknown[][]): string | null {
  const all = arrays.flat()
  if (all.length === 0 || !all.every((e) => e && typeof e === 'object' && !Array.isArray(e))) return null
  for (const key of ELEMENT_KEYS) {
    const values = arrays.map((a) => a.map((e) => (e as Json)[key]))
    if (values.every((vs) => vs.every((v) => typeof v === 'string' && v) && new Set(vs).size === vs.length)) return key
  }
  return null
}

export function prepareFile(file: ThreeWayFile): PreparedFile | null {
  if (file.binary || (file.base == null && file.local == null && file.remote == null && (file.baseOid || file.localOid || file.remoteOid))) {
    const state = verdict(file.baseOid ?? null, file.localOid ?? null, file.remoteOid ?? null, has)
    return state ? { file, merge: { kind: 'whole', state } } : null
  }
  const [base, local, remote] = [file.base ?? null, file.local ?? null, file.remote ?? null]
  if (remote === local) return null

  if (/\.json$/i.test(file.path)) {
    const [b, l, r] = [parseJson(base), parseJson(local), parseJson(remote)]
    const objects = [b, l, r].every((v) => v === undefined || (v && typeof v === 'object' && !Array.isArray(v)))
    if (objects && [b, l, r].some((v) => v !== undefined)) {
      const [bo, lo, ro] = [b, l, r].map((v) => (v ?? null) as Json | null)
      const keys = [...new Set([...Object.keys(lo ?? {}), ...Object.keys(ro ?? {}), ...Object.keys(bo ?? {})])]
      const fields = keys
        .filter((k) => !STAMP_FIELDS.has(k))
        .map((k) => ({ key: k, state: verdict(bo?.[k], lo?.[k], ro?.[k], has) }))
        .filter((f): f is { key: string; state: PullItemState } => f.state !== null)
      return fields.length ? { file, merge: { kind: 'fields', base: bo, local: lo, remote: ro, fields } } : null
    }
    const arrays = [b, l, r].map((v) => (v === undefined ? [] : v))
    if (arrays.every(Array.isArray)) {
      const keyField = elementKey(arrays as unknown[][])
      if (keyField) {
        const [ba, la, ra] = arrays as Json[][]
        const index = (a: Json[]) => new Map(a.map((e) => [String(e[keyField]), e]))
        const [bm, lm, rm] = [index(ba), index(la), index(ra)]
        const keys = [...new Set([...rm.keys(), ...lm.keys(), ...bm.keys()])]
        const elements = keys
          .map((k) => ({ key: k, state: verdict(bm.get(k), lm.get(k), rm.get(k), has) }))
          .filter((e): e is { key: string; state: PullItemState } => e.state !== null)
        return elements.length ? { file, merge: { kind: 'elements', keyField, base: ba, local: la, remote: ra, elements } } : null
      }
    }
  }

  const { name, unit } = unitFor(file.path)
  const state = verdict(base, local, remote, has)
  if (!state) return null
  const merge = mergeText(base ?? '', local ?? '', remote ?? '', unit)
  // Both changed but in different places: an update the merge settles, not a conflict.
  const resolved = state === 'conflict' && merge.conflicts === 0 && local != null && remote != null ? 'update' : state
  return { file, merge: { kind: 'text', unit: name, merge, base: base ?? '', local: local ?? '', remote: remote ?? '', state: resolved } }
}

export function prepareThreeWay(preview: ThreeWayPreview): PreparedFile[] {
  return preview.files.map(prepareFile).filter((f): f is PreparedFile => f !== null)
}

export interface ThreeWayLabels {
  file: string
  field: (key: string) => string
  element: (key: string) => string
  merged: string
}

export function itemsOf(prepared: PreparedFile, labels: ThreeWayLabels): PullItem[] {
  const { merge } = prepared
  switch (merge.kind) {
    case 'whole':
      return [{ key: 'file', label: labels.file, state: merge.state }]
    case 'text':
      return [{
        key: 'file', label: labels.file, state: merge.state,
        detail: merge.state === 'update' && merge.local !== merge.base ? labels.merged : undefined,
      }]
    case 'fields':
      return merge.fields.map((f) => ({ key: `field:${f.key}`, label: labels.field(f.key), state: f.state }))
    case 'elements':
      return merge.elements.map((e) => ({ key: `el:${e.key}`, label: labels.element(e.key), state: e.state }))
  }
}

export function buildThreeWayPlan(
  scope: GitScope,
  preview: ThreeWayPreview,
  prepared: PreparedFile[],
  labels: ThreeWayLabels,
): PullPlan {
  return {
    scope,
    branch: preview.branch,
    remoteHead: preview.remoteHead,
    files: buildPullFiles(scope, prepared.map((p) => ({ path: p.file.path, items: itemsOf(p, labels) }))),
  }
}

export type Override = { text: string } | { remote: true } | { delete: true }

/**
 * The text a file ends up with, given the decisions; undefined when the local
 * file stays as it is, null when it is to be deleted.
 */
export function mergedContent(prepared: PreparedFile, decisions: Map<string, PullDecision>): Override | undefined {
  const { file, merge } = prepared
  const accepted = (key: string) => decisions.get(itemIdFor(file.path, key)) === 'accept'
  switch (merge.kind) {
    case 'whole':
      if (!accepted('file')) return undefined
      return merge.state === 'delete' ? { delete: true } : { remote: true }
    case 'text': {
      if (!accepted('file')) return undefined
      if (file.remote == null) return { delete: true }
      const unit = merge.unit === 'paragraphs' ? PARAGRAPHS : LINES
      return { text: resolveMerge(merge.merge, 'remote', { local: merge.local, remote: merge.remote }, unit) }
    }
    case 'fields': {
      const taken = merge.fields.filter((f) => accepted(`field:${f.key}`))
      if (taken.length === 0) return undefined
      if (merge.remote === null && taken.length === merge.fields.length && merge.local !== null) return { delete: true }
      const out: Json = { ...(merge.local ?? {}) }
      for (const f of taken) {
        if (merge.remote && f.key in merge.remote) out[f.key] = merge.remote[f.key]
        else delete out[f.key]
      }
      return { text: JSON.stringify(out, null, 2) }
    }
    case 'elements': {
      const taken = new Set(merge.elements.filter((e) => accepted(`el:${e.key}`)).map((e) => e.key))
      if (taken.size === 0) return undefined
      const keyOf = (e: Json) => String(e[merge.keyField])
      const remoteByKey = new Map(merge.remote.map((e) => [keyOf(e), e]))
      // Local order, each taken element replaced or dropped, then the taken
      // additions in remote order.
      const out: Json[] = []
      const seen = new Set<string>()
      for (const e of merge.local) {
        const k = keyOf(e)
        seen.add(k)
        if (!taken.has(k)) out.push(e)
        else if (remoteByKey.has(k)) out.push(remoteByKey.get(k)!)
      }
      for (const e of merge.remote) if (taken.has(keyOf(e)) && !seen.has(keyOf(e))) out.push(e)
      return { text: JSON.stringify(out, null, 2) }
    }
  }
}

/** Every file a decision changes, as the merged-tree request expects it. */
export function overridesFor(prepared: PreparedFile[], decisions: Map<string, PullDecision>): Record<string, Override> {
  const out: Record<string, Override> = {}
  for (const p of prepared) {
    const o = mergedContent(p, decisions)
    if (o) out[p.file.path] = o
  }
  return out
}
