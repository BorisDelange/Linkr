/**
 * Paragraph-based 3-way merge of Markdown, for the wiki pull.
 *
 * The unit is the block, not the line: re-wrapping a paragraph rewrites all of
 * its lines, and a line merge would then report a conflict with any other edit
 * that touched the same paragraph. Blocks are separated by blank lines; a fenced
 * code block stays one block even across blank lines inside it.
 *
 * The algorithm is diff3 over blocks: align BASE with each side (LCS), walk the
 * blocks both sides kept unchanged, and settle each region between them — taken
 * from the side that changed it, or a conflict when both changed it differently.
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

export function mergeMarkdown(base: string, local: string, remote: string): MarkdownMerge {
  const B = splitBlocks(base)
  const L = splitBlocks(local)
  const R = splitBlocks(remote)
  const toL = lcsMatch(B, L)
  const toR = lcsMatch(B, R)

  const segments: MergeSegment[] = []
  let conflicts = 0
  const push = (blocks: string[]) => {
    if (!blocks.length) return
    const last = segments[segments.length - 1]
    if (last?.kind === 'stable') last.blocks.push(...blocks)
    else segments.push({ kind: 'stable', blocks: [...blocks] })
  }
  const settle = (b: string[], l: string[], r: string[]) => {
    if (same(l, b)) push(r)
    else if (same(r, b) || same(l, r)) push(l)
    else {
      segments.push({ kind: 'conflict', base: b, local: l, remote: r })
      conflicts++
    }
  }

  let bi = 0
  let li = 0
  let ri = 0
  for (let k = 0; k < B.length; k++) {
    if (toL[k] < 0 || toR[k] < 0) continue
    settle(B.slice(bi, k), L.slice(li, toL[k]), R.slice(ri, toR[k]))
    push([B[k]])
    bi = k + 1
    li = toL[k] + 1
    ri = toR[k] + 1
  }
  settle(B.slice(bi), L.slice(li), R.slice(ri))
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
