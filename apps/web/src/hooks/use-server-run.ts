import { useCallback, useSyncExternalStore } from 'react'
import {
  ACTIVE_RUN_STATUSES,
  RESUMABLE_RUN_STATUSES,
  getLatestServerRun,
  cancelServerRun,
  pauseServerRun,
  resumeServerRun,
  startServerRun,
  type ServerRun,
  type ServerRunKind,
} from '@/lib/api/server-runs'

/** How often an active run is read again. */
const POLL_MS = 1500
/** How often a run at rest is: one started elsewhere (the MCP, another tab) shows up. */
const IDLE_POLL_MS = 20_000

interface Entry {
  run: ServerRun | null
  loaded: boolean
  error: string | null
}

interface Reader {
  entry: Entry
  listeners: Set<() => void>
  timer?: ReturnType<typeof setTimeout>
  reading: boolean
  /** Bumped by every write: a read that started before one does not overwrite it. */
  seq: number
}

// One reader per run, whichever views show it (the Concepts tab and the lists
// that reload when it assembles, a catalog's tabs…): a view mounting later reads
// what the others read.
const readers = new Map<string, Reader>()
const EMPTY: Entry = { run: null, loaded: false, error: null }

const keyOf = (kind: ServerRunKind, scopeId: string) => `${kind}|${scopeId}`

function update(key: string, patch: Partial<Entry>) {
  const reader = readers.get(key)
  if (!reader) return
  reader.seq++
  reader.entry = { ...reader.entry, ...patch }
  schedule(key)
  for (const listener of reader.listeners) listener()
}

function schedule(key: string) {
  const reader = readers.get(key)
  if (!reader) return
  clearTimeout(reader.timer)
  if (reader.listeners.size === 0) return
  const { run } = reader.entry
  if (run && ACTIVE_RUN_STATUSES.includes(run.status)) {
    reader.timer = setTimeout(() => void read(key), POLL_MS)
  } else {
    reader.timer = setTimeout(() => (document.hidden ? schedule(key) : void read(key)), IDLE_POLL_MS)
  }
}

async function read(key: string) {
  const reader = readers.get(key)
  if (!reader || reader.reading) return
  reader.reading = true
  const seq = reader.seq
  const at = key.indexOf('|')
  try {
    const run = await getLatestServerRun<Record<string, unknown>>(key.slice(0, at) as ServerRunKind, key.slice(at + 1))
    reader.reading = false
    if (reader.seq === seq) update(key, { run, loaded: true })
    else schedule(key)
  } catch {
    reader.reading = false
    clearTimeout(reader.timer)
    if (reader.listeners.size > 0) reader.timer = setTimeout(() => void read(key), POLL_MS * 4)
  }
}

function subscribe(key: string, listener: () => void): () => void {
  let reader = readers.get(key)
  if (!reader) {
    reader = { entry: EMPTY, listeners: new Set(), reading: false, seq: 0 }
    readers.set(key, reader)
  }
  reader.listeners.add(listener)
  if (reader.listeners.size === 1) void read(key)
  return () => {
    const current = readers.get(key)
    if (!current) return
    current.listeners.delete(listener)
    if (current.listeners.size === 0) {
      clearTimeout(current.timer)
      readers.delete(key)
    }
  }
}

export interface ServerRunView<S = Record<string, unknown>> {
  /** The run going on, else the last one; null when none ran or not read yet. */
  run: ServerRun<S> | null
  loaded: boolean
  active: boolean
  resumable: boolean
  /** A request of this page failed (the run carries its own error). */
  error: string | null
  /** `spec`: what the kind's run is given (its model in the API's registry). */
  start: (spec: unknown) => Promise<void>
  pause: () => Promise<void>
  /** Stop it for good. */
  cancel: () => Promise<void>
  /** `spec`: compiled again, for a kind that takes one; the run's own otherwise. */
  resume: (spec?: unknown) => Promise<void>
}

/**
 * A server-owned run, as the page sees it: read, and read again while it goes on.
 * Nothing of it lives in the page — a reload reads it back where it is.
 * `enabled`: server mode, with a scope; client-only mode drives its runs itself.
 */
export function useServerRun<S = Record<string, unknown>>(kind: ServerRunKind, scopeId: string | undefined, enabled: boolean): ServerRunView<S> {
  const key = enabled && scopeId ? keyOf(kind, scopeId) : ''
  const entry = useSyncExternalStore(
    useCallback((listener: () => void) => (key ? subscribe(key, listener) : () => {}), [key]),
    () => (key ? readers.get(key)?.entry ?? EMPTY : EMPTY),
  )
  const run = entry.run as ServerRun<S> | null

  const act = useCallback(async (action: () => Promise<ServerRun>) => {
    update(key, { error: null })
    try {
      update(key, { run: await action(), loaded: true })
    } catch (err) {
      update(key, { error: err instanceof Error ? err.message : String(err) })
      throw err
    }
  }, [key])

  // Stable, and on the run as it is when called: a caller may hold them (a store's driver).
  const onRun = useCallback((action: (id: string) => Promise<ServerRun>) => {
    const current = key ? readers.get(key)?.entry.run : null
    return current ? act(() => action(current.id)) : Promise.resolve()
  }, [key, act])
  const start = useCallback((spec: unknown) => act(() => startServerRun(kind, scopeId!, spec)), [act, kind, scopeId])
  const pause = useCallback(() => onRun((id) => pauseServerRun(id)), [onRun])
  const cancel = useCallback(() => onRun((id) => cancelServerRun(id)), [onRun])
  const resume = useCallback((spec?: unknown) => onRun((id) => resumeServerRun(id, spec)), [onRun])

  return {
    run,
    loaded: entry.loaded,
    active: !!run && ACTIVE_RUN_STATUSES.includes(run.status),
    resumable: !!run && RESUMABLE_RUN_STATUSES.includes(run.status),
    error: entry.error,
    start,
    pause,
    cancel,
    resume,
  }
}
