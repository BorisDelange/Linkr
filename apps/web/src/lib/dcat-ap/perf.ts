// TODO(data-catalog): temporary timings to find what makes the Publish preview slow; remove once found.

const t0 = performance.now()

/** Logs `label` with the time since `start` and since the page loaded, in the console as `[catalog-perf]`. */
export function perfLog(label: string, start?: number, extra?: unknown): void {
  const now = performance.now()
  const took = start == null ? '' : `${Math.round(now - start)} ms`
  console.info(`[catalog-perf] +${Math.round(now - t0)} ms`, label, took, extra ?? '')
}
