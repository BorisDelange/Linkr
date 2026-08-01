import { create } from 'zustand'

/** A one-shot request to open the Environments modal on a language tab and, if
 *  `packages` is non-empty, immediately install them the declarative way. Set by
 *  the "install in environment" affordances (script output button, terminal toast);
 *  consumed by the modal + its language panel, then cleared. */
export interface PendingEnvInstall {
  language: 'python' | 'r'
  packages: string[]
  /** Bumped on each request so the panel re-acts even for the same package set. */
  nonce: number
}

const AUTO_BUILD_KEY = 'linkr.env.autoBuild'

function readAutoBuild(): boolean {
  try {
    return localStorage.getItem(AUTO_BUILD_KEY) === 'true'
  } catch {
    return false
  }
}

interface EnvironmentsUiState {
  /** True while the Environments modal should be open. */
  open: boolean
  pending: PendingEnvInstall | null
  /** When true, add/remove/update rebuilds the environment immediately instead of
   *  just marking it draft. Persisted (localStorage), a per-user preference. */
  autoBuild: boolean
  setOpen: (open: boolean) => void
  setAutoBuild: (autoBuild: boolean) => void
  /** Open the modal on `language` and queue `packages` for a one-click install. */
  requestInstall: (language: 'python' | 'r', packages: string[]) => void
  /** Called by the panel once it has consumed the pending install. */
  clearPending: () => void
}

export const useEnvironmentsUiStore = create<EnvironmentsUiState>((set, get) => ({
  open: false,
  pending: null,
  autoBuild: readAutoBuild(),
  setOpen: (open) => set({ open }),
  setAutoBuild: (autoBuild) => {
    try {
      localStorage.setItem(AUTO_BUILD_KEY, String(autoBuild))
    } catch {
      // Ignore a storage failure (private mode) — the toggle still works this session.
    }
    set({ autoBuild })
  },
  requestInstall: (language, packages) =>
    set({ open: true, pending: { language, packages, nonce: (get().pending?.nonce ?? 0) + 1 } }),
  clearPending: () => set({ pending: null }),
}))
