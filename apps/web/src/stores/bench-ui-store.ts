import { create } from 'zustand'

/**
 * What the bench is set up to run: which models, which surfaces, which depth.
 *
 * Held outside the tab because switching sub-tabs (or leaving the page) unmounts
 * it, and re-picking four models every time is tedious. Persisted per workspace:
 * two workspaces configure different models, so one shared selection would name
 * models that do not exist in the other.
 *
 * localStorage rather than the server: this is bench setup on this machine, not
 * a decision about the workspace. It matches where the other UI preferences live
 * (panel state, auto-build), and carries nothing worth syncing.
 */
const STORAGE_KEY = 'linkr.agent.bench.ui'

export type BenchMode = 'quick' | 'full'

export interface BenchSelection {
  models: string[]
  surfaces: string[]
  mode: BenchMode
  /** Which report the detail view is showing. */
  selectedModel: string
  /** Distinguishes "never opened here" from "deselected everything on purpose",
   *  which look identical from an empty model list — without it, clearing the
   *  selection would silently refill on the next visit. */
  touched: boolean
}

export const DEFAULT_SELECTION: BenchSelection = {
  models: [],
  surfaces: ['dashboard'],
  mode: 'quick',
  selectedModel: '',
  touched: false,
}

type Stored = Record<string, BenchSelection>

function load(): Stored {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    return parsed && typeof parsed === 'object' ? (parsed as Stored) : {}
  } catch {
    return {}
  }
}

function persist(state: Stored): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  } catch {
    // A full or unavailable localStorage must not break the bench controls.
  }
}

interface BenchUiState {
  byWorkspace: Stored
  get: (workspaceId: string) => BenchSelection
  /** A deliberate choice by the user; marks the workspace as touched. */
  update: (workspaceId: string, patch: Partial<BenchSelection>) => void
  /** A value the app filled in (initial preselect, pruning a deleted model).
   *  Leaves `touched` alone so it is not mistaken for a user decision. */
  reconcile: (workspaceId: string, patch: Partial<BenchSelection>) => void
}

function write(
  set: (fn: (state: BenchUiState) => Partial<BenchUiState>) => void,
  workspaceId: string,
  patch: Partial<BenchSelection>,
  touched: boolean
) {
  set((state) => {
    const current = state.byWorkspace[workspaceId] ?? DEFAULT_SELECTION
    const byWorkspace = {
      ...state.byWorkspace,
      [workspaceId]: { ...current, ...patch, touched: current.touched || touched },
    }
    persist(byWorkspace)
    return { byWorkspace }
  })
}

export const useBenchUiStore = create<BenchUiState>((set, get) => ({
  byWorkspace: load(),

  get: (workspaceId) => get().byWorkspace[workspaceId] ?? DEFAULT_SELECTION,

  update: (workspaceId, patch) => write(set, workspaceId, patch, true),

  reconcile: (workspaceId, patch) => write(set, workspaceId, patch, false),
}))
