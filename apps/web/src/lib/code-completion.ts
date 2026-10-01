import type { CodeCompletionItem } from '@/lib/runtimes/types'

// `df$col`, `pkg::fn`, `obj@slot`: R completes the whole token, but the list
// should show only what follows the accessor. Mirrors apps/api completion.py.
const R_ACCESSORS = [':::', '::', '$', '@']

export function rCompletionLabel(completion: string): string {
  let cut = 0
  for (const a of R_ACCESSORS) {
    const i = completion.lastIndexOf(a)
    if (i !== -1) cut = Math.max(cut, i + a.length)
  }
  return completion.slice(cut) || completion
}

/** R's completion engine answers with the token it read and the full completions. */
export function rCompletionItems(token: string, completions: string[]): CodeCompletionItem[] {
  return completions.map((c) => ({
    label: rCompletionLabel(c),
    insert: c,
    kind: c.endsWith('=') ? 'argument' : c.endsWith('(') ? 'function' : '',
    typed: token.length,
  }))
}
