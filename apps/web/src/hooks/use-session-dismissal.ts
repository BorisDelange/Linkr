import { useState } from 'react'

const dismissed = new Set<string>()

/** A notice the user closed stays closed for the rest of the session — leaving
 *  the page and coming back included — and returns on reload. `key` names the
 *  notice and what it is about (`flight:<database id>`). */
export function useSessionDismissal(key: string): [dismissed: boolean, dismiss: () => void] {
  const [, rerender] = useState(0)
  return [
    dismissed.has(key),
    () => {
      dismissed.add(key)
      rerender((n) => n + 1)
    },
  ]
}
