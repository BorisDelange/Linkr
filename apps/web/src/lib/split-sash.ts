/**
 * A double click on a split pane's divider resets its sizes (Allotment's sash);
 * the browser's own default for it is to select the nearest text — the editor's
 * line numbers beside the divider. Cancel that default for every divider.
 */
export function preventSashTextSelection(): void {
  document.addEventListener(
    'mousedown',
    (e) => {
      if (e.detail > 1 && e.target instanceof Element && e.target.closest('[class*="sash-module_sash"]')) {
        e.preventDefault()
      }
    },
    true,
  )
}
