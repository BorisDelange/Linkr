import { useEffect, useLayoutEffect, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

/**
 * Renders `children` once and shows them inside whichever element `target` is,
 * moving the DOM rather than re-rendering. React remounts whatever changes parent
 * (or portal container), so a notebook dragged to the other panel would lose its
 * outputs and its running cells; here the portal's container never changes, only
 * where that container is attached.
 */
export function KeepAlivePortal({ target, children }: { target: HTMLElement | null; children: ReactNode }) {
  const [host] = useState(() => {
    const el = document.createElement('div')
    el.style.display = 'contents'
    return el
  })

  useLayoutEffect(() => {
    if (target) target.appendChild(host)
    else host.remove()
  }, [target, host])

  useEffect(() => () => host.remove(), [host])

  return createPortal(children, host)
}
