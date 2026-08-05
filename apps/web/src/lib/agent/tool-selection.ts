/**
 * Which tools to send for a given request.
 *
 * Tool definitions are re-sent on every call and are now the dominant cost of the
 * prompt (~700 of ~900 tokens). Sending eight when the user asked to create a tab
 * wastes most of that, and a longer prompt measurably degrades small-model
 * accuracy, not just latency.
 *
 * The filter is deliberately ASYMMETRIC: a keyword hit only ever ADDS a group,
 * and the core group is always present. Being wrong therefore costs tokens, never
 * capability — the alternative (dropping a tool the user needed) would produce
 * "I can't do that" on a request the assistant can in fact handle.
 *
 * Destructive tools are the exception worth the risk of a miss: they are only
 * offered when the request actually reads like a deletion, so the model cannot
 * reach for one while doing something else. It still cannot delete unprompted —
 * confirmation is enforced downstream.
 */

/** Always available: creating and inspecting is what most requests need. */
const CORE = ['add_tab', 'add_widget', 'describe_dataset', 'describe_plugin']

const MODIFY = ['configure_widget', 'set_layout']
const DESTRUCTIVE = ['remove_tab', 'remove_widget']

// Kept in both languages because the UI is FR/EN and users type in either.
const MODIFY_HINTS = [
  'config', 'configur', 'change', 'modif', 'edit', 'éditer', 'set ',
  'resize', 'redimension', 'width', 'largeur', 'height', 'hauteur',
  'move', 'déplac', 'deplac', 'layout', 'size', 'taille', 'half', 'moitié',
  'moitie', 'full', 'pleine', 'colonne', 'column', 'grid', 'grille',
  'switch', 'remplac', 'replace', 'update', 'ajust',
]

const DESTRUCTIVE_HINTS = [
  'delete', 'remove', 'supprim', 'efface', 'retir', 'drop ', 'clear ',
  'enlev', 'enlèv', 'get rid',
]

function mentions(text: string, hints: string[]): boolean {
  const lowered = text.toLowerCase()
  return hints.some((hint) => lowered.includes(hint))
}

/**
 * Tool names to expose for `request`, given what the conversation already did.
 *
 * `alreadyActed` widens the set once the assistant has created something: a
 * follow-up like "make it wider" carries no keyword of its own but clearly needs
 * the modify tools.
 */
export function selectToolNames(request: string, alreadyActed = false): string[] {
  const names = [...CORE]
  if (alreadyActed || mentions(request, MODIFY_HINTS)) names.push(...MODIFY)
  if (mentions(request, DESTRUCTIVE_HINTS)) names.push(...DESTRUCTIVE)
  return names
}
