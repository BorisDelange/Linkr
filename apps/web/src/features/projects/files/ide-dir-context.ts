import { createContext } from 'react'

/** Absolute server path of the IDE working dir (server mode), shared with every
 * tree row so "Copy path" yields a real path. Null in front-only mode, which has
 * no filesystem path to give. */
export const IdeDirContext = createContext<string | null>(null)
