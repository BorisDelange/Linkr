/**
 * The data seed in flight (front-only), for whoever must not touch a seeded
 * database before it is written: the seed stores a database's Parquet, writes
 * its row, then mounts it itself. A page reached by a deep link on a first visit
 * used to mount the same database meanwhile, from a row or a file list still
 * being written — DuckDB then failed ("TProtocolException: Invalid data") and
 * the page read it as "no concept table". Once the seed is over, the store adopts
 * the mounts it made rather than mounting again: a second mount re-registers the
 * same Parquet buffers under the same names, and a query reading them meanwhile
 * failed the same way ("No magic bytes found at end of file").
 *
 * Its own module so the data-source store can wait on it without importing the
 * seed loader.
 */
let inFlight: Promise<void> | null = null
const seedMounted = new Set<string>()

export function trackDataSeed(run: Promise<void>): Promise<void> {
  inFlight = run
  void run.finally(() => {
    if (inFlight === run) inFlight = null
  }).catch(() => {})
  return run
}

/** Settles when the data seed in flight, if any, has ended — never rejects. */
export async function dataSeedSettled(): Promise<void> {
  if (inFlight) await inFlight.catch(() => {})
}

/** The seed mounted this database in DuckDB itself, outside the data-source store. */
export function noteSeedMounted(dataSourceId: string): void {
  seedMounted.add(dataSourceId)
}

/** Whether the seed mounted this database — answered once, the store then owns the mount. */
export function takeSeedMounted(dataSourceId: string): boolean {
  return seedMounted.delete(dataSourceId)
}
