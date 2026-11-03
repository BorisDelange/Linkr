import { useCallback, useState } from 'react'

/** The plugin editors whose output pane is remembered, one choice each. */
export type OutputPaneScope = 'patient-widget' | 'warehouse-plugin' | 'dashboard-widget' | 'dataset-analysis'

const storageKey = (scope: OutputPaneScope) => `linkr:editor-output:${scope}`

/** Whether a plugin editor shows its output pane, remembered per editor in this
 *  browser. */
export function useOutputPane(scope: OutputPaneScope): [boolean, (visible: boolean) => void] {
  const [visible, setVisible] = useState(() => {
    try {
      return localStorage.getItem(storageKey(scope)) !== 'hidden'
    } catch {
      return true
    }
  })
  const set = useCallback((next: boolean) => {
    setVisible(next)
    try {
      localStorage.setItem(storageKey(scope), next ? 'shown' : 'hidden')
    } catch {
      // Private window or blocked storage: the choice lasts for this editor only.
    }
  }, [scope])
  return [visible, set]
}
