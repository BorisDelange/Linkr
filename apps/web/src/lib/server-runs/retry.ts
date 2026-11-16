import { ApiError } from '@/lib/api-client'

/** Waits between retries of a request the network or the gateway failed: about a
 *  minute in all, the time a proxy restart or a dropped connection takes. */
const RETRY_MS = [1000, 2000, 4000, 8000, 15000, 30000]

/** A failure that says nothing of the run: the request did not reach the API. */
export function isTransient(err: unknown): boolean {
  if (err instanceof ApiError) return err.status === 502 || err.status === 503 || err.status === 504
  // fetch rejects with a TypeError when the network fails.
  return err instanceof TypeError
}

/** `request`, tried again while it fails on the way (`isTransient`), for about a minute. */
export async function retrying<T>(request: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await request()
    } catch (err) {
      if (signal?.aborted || attempt >= RETRY_MS.length || !isTransient(err)) throw err
      await sleep(RETRY_MS[attempt], signal)
    }
  }
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason)
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    function onAbort() {
      clearTimeout(timer)
      reject(signal!.reason)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
