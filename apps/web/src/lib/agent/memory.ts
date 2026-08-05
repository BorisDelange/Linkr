/**
 * The assistant's memory: a short list of user-written preferences, and nothing
 * else.
 *
 * Deliberately NOT auto-learned. An agent that infers durable facts from a
 * conversation about patients will eventually store one — and in a clinical
 * setting a silent, persistent record of that is a data leak that outlives the
 * session, and would be re-sent to the model (possibly a remote one) on every
 * later request. So memory here is: the user types it, the user sees it, the
 * user deletes it.
 *
 * Scoped per dashboard, since "always use histograms" is a statement about a
 * dashboard's style, not about the person.
 */

const STORAGE_PREFIX = 'linkr.agent.memory.'

/** Kept small on purpose: this is re-sent with every request. */
export const MAX_NOTES = 10
export const MAX_NOTE_LENGTH = 200

function key(dashboardId: string): string {
  return `${STORAGE_PREFIX}${dashboardId}`
}

export function loadMemory(dashboardId: string): string[] {
  try {
    const raw = localStorage.getItem(key(dashboardId))
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter((note): note is string => typeof note === 'string').slice(0, MAX_NOTES)
  } catch {
    return []
  }
}

export function saveMemory(dashboardId: string, notes: string[]): void {
  const cleaned = notes
    .map((note) => note.trim().slice(0, MAX_NOTE_LENGTH))
    .filter(Boolean)
    .slice(0, MAX_NOTES)
  if (!cleaned.length) {
    localStorage.removeItem(key(dashboardId))
    return
  }
  localStorage.setItem(key(dashboardId), JSON.stringify(cleaned))
}

export function addNote(dashboardId: string, note: string): string[] {
  const notes = [...loadMemory(dashboardId), note]
  saveMemory(dashboardId, notes)
  return loadMemory(dashboardId)
}

export function removeNote(dashboardId: string, index: number): string[] {
  const notes = loadMemory(dashboardId)
  notes.splice(index, 1)
  saveMemory(dashboardId, notes)
  return loadMemory(dashboardId)
}

/** Prompt block for the stored notes, or empty when there are none. */
export function memoryContext(notes: string[]): string {
  if (!notes.length) return ''
  return `User preferences:\n${notes.map((note) => `- ${note}`).join('\n')}`
}
