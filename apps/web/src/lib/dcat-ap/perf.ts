// TODO(data-catalog): temporary timings to find what makes the Publish preview slow; remove once found.

/** Logs `label` with the time since `start` and since the app was opened, in the console as `[catalog-perf]`. */
export function perfLog(label: string, start?: number, extra?: unknown): void {
  const now = performance.now()
  const took = start == null ? '' : `${Math.round(now - start)} ms`
  console.info(`[catalog-perf] +${Math.round(now)} ms`, label, took, extra ?? '')
}

// Anything that holds the main thread over 200 ms, so a gap between two lines above has a name.
if (typeof PerformanceObserver !== 'undefined' && PerformanceObserver.supportedEntryTypes?.includes('longtask')) {
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) if (e.duration > 200) perfLog('main thread blocked', undefined, `${Math.round(e.duration)} ms (from +${Math.round(e.startTime)} ms)`)
  }).observe({ type: 'longtask', buffered: true })
}

// Firefox and Safari have no long-task entries: a 100 ms heartbeat that fires late says the same.
else if (typeof window !== 'undefined') {
  let last = performance.now()
  setInterval(() => {
    const now = performance.now()
    // A hidden tab's timers are throttled to 1 s: not a block.
    if (now - last > 300 && document.visibilityState === 'visible') perfLog('main thread blocked', undefined, `~${Math.round(now - last - 100)} ms (from +${Math.round(last)} ms)`)
    last = now
  }, 100)
}
