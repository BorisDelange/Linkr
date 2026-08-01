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

interface EnvironmentsUiState {
  /** True while the Environments modal should be open. */
  open: boolean
  pending: PendingEnvInstall | null
  setOpen: (open: boolean) => void
  /** Open the modal on `language` and queue `packages` for a one-click install. */
  requestInstall: (language: 'python' | 'r', packages: string[]) => void
  /** Called by the panel once it has consumed the pending install. */
  clearPending: () => void
}

export const useEnvironmentsUiStore = create<EnvironmentsUiState>((set, get) => ({
  open: false,
  pending: null,
  setOpen: (open) => set({ open }),
  requestInstall: (language, packages) =>
    set({ open: true, pending: { language, packages, nonce: (get().pending?.nonce ?? 0) + 1 } }),
  clearPending: () => set({ pending: null }),
}))
