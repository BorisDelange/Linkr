import { create } from 'zustand'

/**
 * Whether the dashboard's filter panel is open, kept outside the page so it
 * survives navigation — leaving a dashboard and coming back used to close it.
 * In memory only: a reload lands on the default (open).
 */
interface DashboardPanelsState {
  filterOpen: boolean
  toggleFilter: () => void
  setFilterOpen: (open: boolean) => void
}

export const useDashboardPanelsStore = create<DashboardPanelsState>((set, get) => ({
  filterOpen: true,
  toggleFilter: () => set({ filterOpen: !get().filterOpen }),
  setFilterOpen: (open) => set({ filterOpen: open }),
}))
