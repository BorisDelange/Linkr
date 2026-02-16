/**
 * Tiny reactive store for files in the shared virtual filesystem.
 * Updated by the onSharedFilesChanged callback from shared-fs.ts.
 */
import { create } from 'zustand'
import { onSharedFilesChanged } from '@/lib/runtimes/shared-fs'

interface SharedFsState {
  /** File names in data/datasets/ (e.g. ["data/datasets/mortality_dataset.csv"]) */
  fileNames: string[]
}

export const useSharedFsStore = create<SharedFsState>()(() => ({
  fileNames: [],
}))

// Subscribe to shared-fs changes and update the store
onSharedFilesChanged((files) => {
  useSharedFsStore.setState({ fileNames: Array.from(files.keys()) })
})
