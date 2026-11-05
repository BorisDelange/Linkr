/**
 * How much the Data overview holds and asks at once, after the machine it runs
 * on: a low-end laptop or a tablet gets fewer events per row, one query at a
 * time and a smaller cache. Read from what the browser says of the device
 * (`deviceMemory`, in GB, Chromium only and capped at 8; `hardwareConcurrency`);
 * a browser that says nothing gets the full budget.
 */
export interface OverviewBudget {
  /** Events read per row before it is drawn as density instead. */
  eventLimit: number
  /** Queries in flight at once. */
  concurrency: number
  /** Density tiles kept, across rows and zoom levels. */
  maxTiles: number
}

export function overviewBudget(device: { deviceMemory?: number; hardwareConcurrency?: number } = {}): OverviewBudget {
  const memory = device.deviceMemory ?? 8
  const cores = device.hardwareConcurrency ?? 8
  if (memory <= 2 || cores <= 2) return { eventLimit: 1000, concurrency: 1, maxTiles: 1000 }
  if (memory <= 4 || cores <= 4) return { eventLimit: 2000, concurrency: 2, maxTiles: 2000 }
  return { eventLimit: 4000, concurrency: 4, maxTiles: 4000 }
}

/** The budget of the machine this page runs on. */
export const deviceOverviewBudget = (): OverviewBudget =>
  overviewBudget(typeof navigator === 'undefined' ? {} : (navigator as Navigator & { deviceMemory?: number }))
