/** Runs the tasks handed to it at most `limit` at a time, in arrival order. */
export function createConcurrencyLimit(limit: number): <T>(task: () => Promise<T>) => Promise<T> {
  let running = 0
  const waiters: (() => void)[] = []
  return async (task) => {
    // A finishing task hands its slot straight to the next waiter instead of
    // freeing it: freed, a caller arriving before the waiter resumed took it too,
    // and one more task ran than the limit allows.
    if (running >= limit) await new Promise<void>((resolve) => waiters.push(resolve))
    else running++
    try {
      return await task()
    } finally {
      const next = waiters.shift()
      if (next) next()
      else running--
    }
  }
}
