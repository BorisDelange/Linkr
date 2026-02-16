/**
 * Quick spike to test @marimo-team/blocks integration.
 * This component renders a minimal marimo-powered Python notebook
 * with a single cell. Used to validate that the package works
 * with our React 19 setup and Pyodide loads correctly.
 */
import {
  Provider as MarimoProvider,
  CellEditor,
  CellOutput,
  CellRunButton,
} from '@marimo-team/blocks'

interface MarimoTestProps {
  /** Initial Python code for the cell */
  code?: string
}

export function MarimoTest({ code = 'import sys\nprint(f"Python {sys.version}")' }: MarimoTestProps) {
  return (
    <MarimoProvider
      pyodideUrl="https://cdn.jsdelivr.net/pyodide/v0.27.0/full/"
      dependencies={[]}
      onReady={() => console.log('[marimo-test] Pyodide ready')}
      onError={(err) => console.error('[marimo-test] Pyodide error:', err)}
    >
      <div className="flex flex-col gap-2 p-4">
        <div className="text-sm font-medium">Marimo Test Cell</div>
        <div className="border rounded-md overflow-hidden">
          <CellEditor
            id="test-cell"
            code={code}
            onCodeChange={(c) => console.log('[marimo-test] code changed:', c.slice(0, 50))}
          />
        </div>
        <div className="flex items-center gap-2">
          <CellRunButton
            id="test-cell"
            className="px-3 py-1 text-xs bg-primary text-primary-foreground rounded-md hover:bg-primary/90"
            onExecutionStart={() => console.log('[marimo-test] execution started')}
            onExecutionComplete={(err) => {
              if (err) console.error('[marimo-test] execution error:', err)
              else console.log('[marimo-test] execution complete')
            }}
          >
            {({ isRunning }) => (isRunning ? 'Running...' : 'Run')}
          </CellRunButton>
        </div>
        <div className="border rounded-md p-2 min-h-[60px] bg-muted/30">
          <CellOutput id="test-cell" />
        </div>
      </div>
    </MarimoProvider>
  )
}
