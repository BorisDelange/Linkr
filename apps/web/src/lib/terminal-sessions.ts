import type { Terminal } from '@xterm/xterm'
import type { FitAddon } from '@xterm/addon-fit'

/**
 * Terminals that outlive their panel. Leaving the IDE page unmounts every
 * TerminalPanel; keeping the xterm (scrollback) and its socket (bash PTY, REPL
 * connection) here lets the panel re-attach to them on return instead of
 * starting a blank session. A terminal ends only when its tab is closed.
 */
export interface LiveTerminal {
  /** What the session was opened for: a panel asking for something else starts anew. */
  signature: string
  /** The element xterm rendered into, moved into whichever panel shows it. */
  host: HTMLDivElement
  terminal: Terminal
  fitAddon: FitAddon
  /** Callbacks into the panel currently showing the terminal (the session's
   *  handlers were created by the first one). */
  sink: { setInstallOffer: (offer: { language: 'python' | 'r'; packages: string[] } | null) => void }
  dispose: () => void
}

const live = new Map<string, LiveTerminal>()

export function getLiveTerminal(key: string): LiveTerminal | undefined {
  return live.get(key)
}

export function registerLiveTerminal(key: string, entry: LiveTerminal) {
  live.set(key, entry)
}

export function disposeLiveTerminal(key: string) {
  live.get(key)?.dispose()
  live.delete(key)
}
