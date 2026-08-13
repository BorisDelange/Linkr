/**
 * What a push would change in `mappings.json`, as reviewable rows.
 *
 * The pull side gets this for free — it holds a 3-way merge in memory. The push
 * side only ever had a text diff, which for a generated JSON of ~1500 objects is
 * unreadable: the answer to "which mappings am I about to add?" was buried in
 * thousands of brace lines.
 *
 * So we derive the same `MappingChange` rows the pull table already renders, out
 * of the two JSON blobs the diff endpoint returns. No extra request, no new
 * server work — and the two directions end up describing changes the same way.
 *
 * Roles are mirrored on purpose: pushing means OUR content becomes the remote's,
 * so `local` (what we are sending) plays the "incoming" part and `remote` (what
 * the repo holds) plays the "current" one. `add` therefore means "this push adds
 * a mapping to the repo", which is what the user is asking about.
 */
import type { ConceptMapping } from '@/types'
import { mappingKey, mappingsEqual, type MappingChange } from './merge'

export interface PushMappingsDiff {
  changes: MappingChange[]
  /** Rows the two sides agree on — not listed, but worth reporting as context. */
  unchanged: number
}

/** Parse a `mappings.json` blob; anything unexpected yields null (see below). */
function parseMappings(text: string): ConceptMapping[] | null {
  const trimmed = text.trim()
  // An absent side (the file is being added or deleted) is an empty list, not a
  // failure — that is exactly the "everything is new" case worth showing.
  if (!trimmed) return []
  try {
    const parsed = JSON.parse(trimmed)
    return Array.isArray(parsed) ? (parsed as ConceptMapping[]) : null
  } catch {
    // A truncated payload (the server condensed an oversized file to hunks) is
    // not JSON. Refusing here is what lets the caller say "can't itemise this"
    // rather than silently reporting a diff computed from half a file.
    return null
  }
}

/**
 * Build the change rows, or null when the payload cannot be itemised (truncated
 * or not an array). Callers must treat null as "no table", never as "no changes".
 */
export function diffPushMappings(
  remoteText: string,
  localText: string,
): PushMappingsDiff | null {
  const remote = parseMappings(remoteText)
  const local = parseMappings(localText)
  if (!remote || !local) return null

  const byKey = (list: ConceptMapping[]) => {
    const m = new Map<string, ConceptMapping>()
    for (const item of list) m.set(mappingKey(item), item)
    return m
  }
  const r = byKey(remote)
  const l = byKey(local)

  const changes: MappingChange[] = []
  let unchanged = 0

  for (const key of new Set([...r.keys(), ...l.keys()])) {
    const rm = r.get(key) ?? null
    const lm = l.get(key) ?? null

    // `local` is the incoming side here, so it fills the slot the pull table
    // reads for "what lands" — see the role note above.
    if (rm && lm) {
      if (mappingsEqual(rm, lm)) unchanged++
      else changes.push({ key, type: 'update', remote: lm, local: rm, base: rm })
    } else if (lm) {
      changes.push({ key, type: 'add', remote: lm, local: null, base: null })
    } else if (rm) {
      changes.push({ key, type: 'delete', remote: null, local: rm, base: rm })
    }
  }

  return { changes, unchanged }
}
