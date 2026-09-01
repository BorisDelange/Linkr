import { Component, type ReactNode } from 'react'

interface Props {
  children: ReactNode
  /** Shown instead of the viewer when it fails — the raw source, still readable. */
  fallback: ReactNode
}

/**
 * Keeps a failed code viewer local.
 *
 * Monaco's loader is a module-level singleton, so an editor can throw during mount
 * for reasons that have nothing to do with the surrounding page — most visibly
 * "InstantiationService has been disposed" when a viewer mounts while a previous
 * instance is still being torn down. Without a boundary here that reaches
 * AppErrorBoundary, and the whole app shows its "local data is no longer
 * compatible" crash screen because a code sample in a dialog failed to highlight.
 *
 * The fallback keeps the code readable as plain text, which is the part the reader
 * actually came for.
 */
export class CodeViewerBoundary extends Component<Props, { failed: boolean }> {
  state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children
  }
}
