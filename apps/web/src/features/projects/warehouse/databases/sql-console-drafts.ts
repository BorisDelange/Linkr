/** The draft of each database's SQL console, kept while the app is open — the
 *  console saves nothing, but leaving it for the Schema tab must not lose the query. */
export const sqlConsoleDrafts = new Map<string, string>()

const pendingRuns = new Set<string>()

/** Puts `sql` in a database's console and has it run as soon as the console
 *  next mounts — the caller opens the SQL tab right after. */
export function openInSqlConsole(draftKey: string, sql: string): void {
  sqlConsoleDrafts.set(draftKey, sql)
  pendingRuns.add(draftKey)
}

/** Whether a run is waiting for this console. Consumes it: returning to the tab
 *  later must not run the query again. */
export function takePendingRun(draftKey: string): boolean {
  return pendingRuns.delete(draftKey)
}
