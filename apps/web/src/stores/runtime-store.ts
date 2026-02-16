import { create } from 'zustand'
import type { RuntimeStatus } from '@/lib/runtimes/types'
import { onPyodideStatusChange, getPyodideStatus } from '@/lib/runtimes/pyodide-engine'
import { onWebRStatusChange, getWebRStatus, interruptR } from '@/lib/runtimes/webr-engine'

interface RuntimeState {
  pythonStatus: RuntimeStatus
  rStatus: RuntimeStatus
  isExecuting: boolean
  abortController: AbortController | null

  setPythonStatus: (status: RuntimeStatus) => void
  setRStatus: (status: RuntimeStatus) => void
  startExecution: () => AbortController
  stopExecution: () => void
  finishExecution: () => void
}

export const useRuntimeStore = create<RuntimeState>((set, get) => {
  // Subscribe to status changes from runtime engines
  onPyodideStatusChange((status) => set({ pythonStatus: status }))
  onWebRStatusChange((status) => set({ rStatus: status }))

  return {
    pythonStatus: getPyodideStatus(),
    rStatus: getWebRStatus(),
    isExecuting: false,
    abortController: null,

    setPythonStatus: (status) => set({ pythonStatus: status }),
    setRStatus: (status) => set({ rStatus: status }),

    startExecution: () => {
      const controller = new AbortController()
      set({ isExecuting: true, abortController: controller })
      return controller
    },

    stopExecution: () => {
      const { abortController } = get()
      abortController?.abort()
      // Also interrupt R if it's the one executing
      interruptR()
      set({ isExecuting: false, abortController: null })
    },

    finishExecution: () => {
      set({ isExecuting: false, abortController: null })
    },
  }
})
