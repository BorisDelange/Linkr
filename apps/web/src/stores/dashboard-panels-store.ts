import { create } from 'zustand'

/**
 * Which side panel is open on the dashboard, kept outside the page so it
 * survives navigation — leaving a dashboard and coming back used to close it.
 *
 * In memory only: a reload lands on Filters, never on the assistant, whatever
 * was open last time.
 *
 * At most ONE panel is open at a time: two 320px panels leave the dashboard
 * itself squeezed, which defeats the point of watching it change. Opening one
 * closes the other. Closing the assistant does not lose the conversation — that
 * lives in agent-session-store.
 */
interface PanelPrefs {
  filterOpen: boolean
  agentOpen: boolean
}

interface DashboardPanelsState extends PanelPrefs {
  toggleFilter: () => void
  toggleAgent: () => void
  setFilterOpen: (open: boolean) => void
  setAgentOpen: (open: boolean) => void
}

export const useDashboardPanelsStore = create<DashboardPanelsState>((set, get) => ({
  filterOpen: true,
  agentOpen: false,
  toggleFilter: () =>
    set({ filterOpen: !get().filterOpen, agentOpen: false }),
  toggleAgent: () =>
    set({ agentOpen: !get().agentOpen, filterOpen: false }),
  setFilterOpen: (open) =>
    set({ filterOpen: open, agentOpen: open ? false : get().agentOpen }),
  setAgentOpen: (open) =>
    set({ agentOpen: open, filterOpen: open ? false : get().filterOpen }),
}))
