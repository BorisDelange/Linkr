import { Component, type ReactNode } from 'react'

interface Props {
  children: ReactNode
}

interface State {
  hasError: boolean
  error: Error | null
}

/**
 * Top-level error boundary that catches fatal crashes (e.g. IDB schema mismatch)
 * and offers the user a way to reset data instead of staring at a blank page.
 */
export class AppErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error }
  }

  handleReset = () => {
    // Set flag and reload — actual deletion happens in main.tsx before IDB is opened
    localStorage.setItem('linkr-pending-reset', '1')
    window.location.href = '/'
  }

  handleReload = () => {
    window.location.reload()
  }

  render() {
    if (!this.state.hasError) return this.props.children

    return (
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        height: '100vh', fontFamily: 'Inter, system-ui, sans-serif',
        background: '#09090b', color: '#fafafa',
      }}>
        <div style={{ maxWidth: 480, textAlign: 'center', padding: 24 }}>
          <h1 style={{ fontSize: 22, fontWeight: 600, marginBottom: 12 }}>
            Something went wrong
          </h1>
          <p style={{ fontSize: 14, color: '#a1a1aa', marginBottom: 8 }}>
            The app encountered an unexpected error. This can happen after an update
            if local data is no longer compatible.
          </p>
          <p style={{ fontSize: 12, color: '#71717a', marginBottom: 24, fontFamily: 'monospace', wordBreak: 'break-all' }}>
            {this.state.error?.message}
          </p>
          <div style={{ display: 'flex', gap: 12, justifyContent: 'center' }}>
            <button
              onClick={this.handleReload}
              style={{
                padding: '8px 16px', borderRadius: 6, border: '1px solid #27272a',
                background: 'transparent', color: '#fafafa', cursor: 'pointer', fontSize: 13,
              }}
            >
              Reload
            </button>
            <button
              onClick={this.handleReset}
              style={{
                padding: '8px 16px', borderRadius: 6, border: 'none',
                background: '#dc2626', color: '#fff', cursor: 'pointer', fontSize: 13,
              }}
            >
              Clear all data &amp; reload
            </button>
          </div>
        </div>
      </div>
    )
  }
}
