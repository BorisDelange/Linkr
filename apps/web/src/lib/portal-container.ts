import { createContext, useContext } from 'react'

/**
 * Target element for Radix portals (Select/Popover/Dropdown content). Defaults to null, which
 * makes Radix portal into document.body. When the dashboard goes into the browser Fullscreen API,
 * only the fullscreen element's subtree is rendered — content portaled to body would be invisible.
 * Providing the fullscreen element here keeps menus working in fullscreen.
 */
const PortalContainerContext = createContext<HTMLElement | null>(null)

export const PortalContainerProvider = PortalContainerContext.Provider

export function usePortalContainer(): HTMLElement | null {
  return useContext(PortalContainerContext)
}

/** Where a hand-made portal (a canvas tooltip or menu) mounts: the fullscreen
 *  element while there is one, else document.body. */
export function usePortalTarget(): HTMLElement {
  return useContext(PortalContainerContext) ?? document.body
}
