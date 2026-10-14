import { createContext } from 'react'

/** The tree's one "mark data file for versioning" confirmation, shared by every
 *  row (and the bulk action) instead of a dialog per row. Without a provider the
 *  mark is applied unconfirmed. */
export const FileTreeVersioningContext = createContext<{
  requestMark: (paths: string[], apply: () => void) => void
}>({ requestMark: (_paths, apply) => apply() })
