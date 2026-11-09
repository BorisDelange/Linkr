/**
 * Whether the page is being left (a reload, a navigation away). The browser
 * then aborts every request in flight, and a long run reads that as a failure:
 * it is not one — its jobs go on on the server, and the next page resumes them.
 * A run checks this before recording an error.
 */
let leaving = false

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => { leaving = true })
  window.addEventListener('pageshow', () => { leaving = false })
  // Fires first, but can be answered "stay": a page still here a moment later
  // was not left.
  window.addEventListener('beforeunload', () => {
    leaving = true
    setTimeout(() => { leaving = false }, 1000)
  })
}

export function isPageLeaving(): boolean {
  return leaving
}
