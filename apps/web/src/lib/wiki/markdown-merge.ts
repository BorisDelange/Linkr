/**
 * Paragraph-based 3-way merge of Markdown, for the wiki pull.
 *
 * The unit is the block, not the line: re-wrapping a paragraph rewrites all of
 * its lines, and a line merge would then report a conflict with any other edit
 * that touched the same paragraph. Blocks are separated by blank lines; a fenced
 * code block stays one block even across blank lines inside it.
 *
 * Each side is aligned with BASE (LCS over blocks) and reduced to hunks — "these
 * base blocks became those". Hunks that touch different base blocks apply
 * independently, even when the blocks are neighbours: that is the point of the
 * block granularity, where a line-based diff3 would call two edits to adjacent
 * paragraphs a conflict. Only hunks over the same blocks (or two insertions at the
 * same place) conflict, and not when both sides made the same change.
 */

export type MergeSegment =
  | { kind: 'stable'; blocks: string[] }
  | { kind: 'conflict'; base: string[]; local: string[]; remote: string[] }

export interface MarkdownMerge {
  segments: MergeSegment[]
  conflicts: number
}

const FENCE_RE = /^\s{0,3}(`{3,}|~{3,})/

export function splitBlocks(text: string): string[] {
  const blocks: string[] = []
  let current: string[] = []
  let fence: string | null = null
  const flush = () => {
    if (current.length) blocks.push(current.join('\n'))
    current = []
  }
  for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
    const marker = FENCE_RE.exec(line)?.[1]
    if (fence) {
      current.push(line)
      if (marker && marker[0] === fence[0] && marker.length >= fence.length) fence = null
      continue
    }
    if (marker) {
      fence = marker
      current.push(line)
      continue
    }
    if (line.trim() === '') flush()
    else current.push(line)
  }
  flush()
  return blocks
}

/** For each index of `a`, the index of `b` it is matched with (LCS), or -1. */
function lcsMatch(a: string[], b: string[]): number[] {
  const n = a.length
  const m = b.length
  const len: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      len[i][j] = a[i] === b[j] ? len[i + 1][j + 1] + 1 : Math.max(len[i + 1][j], len[i][j + 1])
    }
  }
  const match = new Array<number>(n).fill(-1)
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) { match[i] = j; i++; j++ }
    else if (len[i + 1][j] >= len[i][j + 1]) i++
    else j++
  }
  return match
}

const same = (x: string[], y: string[]) => x.length === y.length && x.every((v, i) => v === y[i])

/** base[start, end) replaced by `blocks` on one side. start === end: an insertion. */
interface Hunk { start: number; end: number; blocks: string[]; side: 'local' | 'remote' }

function hunksOf(base: string[], other: string[], side: Hunk['side']): Hunk[] {
  const match = lcsMatch(base, other)
  const hunks: Hunk[] = []
  let b = 0
  let o = 0
  const flush = (bEnd: number, oEnd: number) => {
    if (bEnd > b || oEnd > o) hunks.push({ start: b, end: bEnd, blocks: other.slice(o, oEnd), side })
  }
  for (let k = 0; k < base.length; k++) {
    if (match[k] < 0) continue
    flush(k, match[k])
    b = k + 1
    o = match[k] + 1
  }
  flush(base.length, other.length)
  return hunks
}

function overlaps(a: Hunk, b: Hunk): boolean {
  if (a.start === b.start) return true
  const insideOf = (ins: Hunk, h: Hunk) => ins.start === ins.end && h.start < ins.start && ins.start < h.end
  return Math.max(a.start, b.start) < Math.min(a.end, b.end) || insideOf(a, b) || insideOf(b, a)
}

/** base[start, end) with one side's hunks (all inside that range) applied. */
function applyWithin(base: string[], start: number, end: number, hunks: Hunk[]): string[] {
  const out: string[] = []
  let i = start
  for (const h of hunks) {
    out.push(...base.slice(i, h.start), ...h.blocks)
    i = h.end
  }
  out.push(...base.slice(i, end))
  return out
}

export function mergeMarkdown(base: string, local: string, remote: string): MarkdownMerge {
  const B = splitBlocks(base)
  const hunks = [...hunksOf(B, splitBlocks(local), 'local'), ...hunksOf(B, splitBlocks(remote), 'remote')]
    .sort((a, b) => a.start - b.start || a.end - b.end)

  const segments: MergeSegment[] = []
  let conflicts = 0
  const push = (blocks: string[]) => {
    if (!blocks.length) return
    const last = segments[segments.length - 1]
    if (last?.kind === 'stable') last.blocks.push(...blocks)
    else segments.push({ kind: 'stable', blocks: [...blocks] })
  }

  let i = 0
  let h = 0
  while (h < hunks.length) {
    const group = [hunks[h++]]
    let end = group[0].end
    while (h < hunks.length && group.some((g) => overlaps(g, hunks[h]))) {
      end = Math.max(end, hunks[h].end)
      group.push(hunks[h++])
    }
    const start = group[0].start
    push(B.slice(i, start))
    const mine = group.filter((g) => g.side === 'local')
    const theirs = group.filter((g) => g.side === 'remote')
    const l = applyWithin(B, start, end, mine)
    const r = applyWithin(B, start, end, theirs)
    if (!mine.length) push(r)
    else if (!theirs.length || same(l, r)) push(l)
    else {
      segments.push({ kind: 'conflict', base: B.slice(start, end), local: l, remote: r })
      conflicts++
    }
    i = end
  }
  push(B.slice(i))
  return { segments, conflicts }
}

/**
 * The merged text, each conflict settled on one side. When the result is one of
 * the inputs block for block, that input is returned verbatim, so a pull that
 * merely takes the remote never rewrites its spacing.
 */
export function resolveMerge(
  merge: MarkdownMerge,
  conflictSide: 'local' | 'remote',
  inputs: { local: string; remote: string },
): string {
  const blocks = merge.segments.flatMap((s) =>
    s.kind === 'stable' ? s.blocks : conflictSide === 'local' ? s.local : s.remote,
  )
  if (same(blocks, splitBlocks(inputs.remote))) return inputs.remote
  if (same(blocks, splitBlocks(inputs.local))) return inputs.local
  const trailing = inputs.remote.endsWith('\n') || inputs.local.endsWith('\n') ? '\n' : ''
  return blocks.join('\n\n') + trailing
}
