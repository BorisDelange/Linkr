import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { getPyodide, getPyodideStatus } from '@/lib/runtimes/pyodide-engine'
import { getWebR, getWebRStatus } from '@/lib/runtimes/webr-engine'

type TerminalType = 'bash' | 'python' | 'r'

const terminalConfig: Record<TerminalType, { welcome: string; prompt: string }> = {
  bash: {
    welcome: '\x1b[1;34mlinkr Terminal\x1b[0m — Bash (WASM)\r\n\x1b[2mNote: limited shell — use Python or R terminals for code execution\x1b[0m\r\n',
    prompt: '$ ',
  },
  python: {
    welcome: '\x1b[1;33mPython\x1b[0m (Pyodide WASM)\r\n',
    prompt: '>>> ',
  },
  r: {
    welcome: '\x1b[1;36mR\x1b[0m (webR WASM)\r\n',
    prompt: '> ',
  },
}

interface TerminalPanelProps {
  terminalType?: TerminalType
  onData?: (data: string) => void
}

async function executePythonRepl(code: string): Promise<{ stdout: string; stderr: string }> {
  const pyodide = await getPyodide()
  let stdout = ''
  let stderr = ''
  pyodide.setStdout({ batched: (msg: string) => { stdout += msg + '\n' } })
  pyodide.setStderr({ batched: (msg: string) => { stderr += msg + '\n' } })
  try {
    const result = await pyodide.runPythonAsync(code)
    if (result !== undefined && result !== null && String(result) !== 'None') {
      stdout += String(result) + '\n'
    }
  } catch (err) {
    stderr += (err instanceof Error ? err.message : String(err)) + '\n'
  }
  return { stdout: stdout.trimEnd(), stderr: stderr.trimEnd() }
}

async function executeRRepl(code: string): Promise<{ stdout: string; stderr: string }> {
  const webR = await getWebR()
  let stdout = ''
  let stderr = ''
  try {
    const shelter = await new webR.Shelter()
    try {
      const result = await shelter.captureR(code, { withAutoprint: true })
      for (const out of result.output) {
        if (out.type === 'stdout') stdout += out.data + '\n'
        else if (out.type === 'stderr') stderr += out.data + '\n'
      }
    } finally {
      shelter.purge()
    }
  } catch (err) {
    stderr += (err instanceof Error ? err.message : String(err)) + '\n'
  }
  return { stdout: stdout.trimEnd(), stderr: stderr.trimEnd() }
}

export function TerminalPanel({ terminalType = 'bash', onData }: TerminalPanelProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)

  useEffect(() => {
    if (!containerRef.current) return

    const config = terminalConfig[terminalType]
    let currentLine = ''
    let history: string[] = []
    let historyIndex = -1
    let executing = false

    const terminal = new Terminal({
      fontFamily: "'Menlo', 'Monaco', 'Courier New', monospace",
      fontSize: 13,
      theme: {
        background: '#1e1e1e',
        foreground: '#d4d4d4',
        cursor: '#d4d4d4',
      },
      cursorBlink: true,
      convertEol: true,
    })

    const fitAddon = new FitAddon()
    terminal.loadAddon(fitAddon)
    terminal.open(containerRef.current)
    fitAddon.fit()

    // Intercept Cmd/Ctrl+K: clear terminal and let the event bubble to window
    terminal.attachCustomKeyEventHandler((e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        terminal.clear()
        terminal.write(config.prompt)
        // Let the event propagate so useGlobalShortcuts also fires (clears console output)
        return false
      }
      return true
    })

    terminalRef.current = terminal
    fitAddonRef.current = fitAddon

    terminal.writeln(config.welcome)
    terminal.write(config.prompt)

    if (onData) {
      terminal.onData(onData)
    }

    const writeOutput = (text: string, isError = false) => {
      if (!text) return
      const lines = text.split('\n')
      for (const line of lines) {
        if (isError) {
          terminal.writeln(`\x1b[31m${line}\x1b[0m`)
        } else {
          terminal.writeln(line)
        }
      }
    }

    const executeCommand = async (cmd: string) => {
      if (!cmd.trim()) {
        terminal.write(config.prompt)
        return
      }

      history.push(cmd)
      historyIndex = -1
      executing = true

      if (terminalType === 'python') {
        if (getPyodideStatus() !== 'ready' && getPyodideStatus() !== 'executing') {
          terminal.writeln('\x1b[33mLoading Python runtime...\x1b[0m')
        }
        try {
          const { stdout, stderr } = await executePythonRepl(cmd)
          writeOutput(stdout)
          writeOutput(stderr, true)
        } catch (err) {
          writeOutput(err instanceof Error ? err.message : String(err), true)
        }
      } else if (terminalType === 'r') {
        if (getWebRStatus() !== 'ready' && getWebRStatus() !== 'executing') {
          terminal.writeln('\x1b[33mLoading R runtime...\x1b[0m')
        }
        try {
          const { stdout, stderr } = await executeRRepl(cmd)
          writeOutput(stdout)
          writeOutput(stderr, true)
        } catch (err) {
          writeOutput(err instanceof Error ? err.message : String(err), true)
        }
      } else {
        // Bash — minimal built-in commands
        const parts = cmd.trim().split(/\s+/)
        const command = parts[0]
        const args = parts.slice(1)
        switch (command) {
          case 'echo':
            terminal.writeln(args.join(' '))
            break
          case 'clear':
            terminal.clear()
            break
          case 'help':
            terminal.writeln('Available commands: echo, clear, help, date, pwd')
            terminal.writeln('For code execution, use the Python or R terminals.')
            break
          case 'date':
            terminal.writeln(new Date().toString())
            break
          case 'pwd':
            terminal.writeln('/linkr/project')
            break
          default:
            terminal.writeln(`\x1b[31mCommand not found: ${command}\x1b[0m`)
            terminal.writeln('\x1b[2mType "help" for available commands\x1b[0m')
        }
      }

      executing = false
      terminal.write(config.prompt)
    }

    terminal.onData((data) => {
      if (executing) return

      switch (data) {
        case '\r': { // Enter
          terminal.writeln('')
          const cmd = currentLine
          currentLine = ''
          executeCommand(cmd)
          break
        }
        case '\x7f': // Backspace
          if (currentLine.length > 0) {
            currentLine = currentLine.slice(0, -1)
            terminal.write('\b \b')
          }
          break
        case '\x1b[A': // Arrow Up
          if (history.length > 0) {
            if (historyIndex === -1) historyIndex = history.length - 1
            else if (historyIndex > 0) historyIndex--
            // Clear current line
            while (currentLine.length > 0) {
              terminal.write('\b \b')
              currentLine = currentLine.slice(0, -1)
            }
            currentLine = history[historyIndex]
            terminal.write(currentLine)
          }
          break
        case '\x1b[B': // Arrow Down
          if (historyIndex !== -1) {
            while (currentLine.length > 0) {
              terminal.write('\b \b')
              currentLine = currentLine.slice(0, -1)
            }
            if (historyIndex < history.length - 1) {
              historyIndex++
              currentLine = history[historyIndex]
              terminal.write(currentLine)
            } else {
              historyIndex = -1
              currentLine = ''
            }
          }
          break
        case '\x03': // Ctrl+C
          currentLine = ''
          terminal.writeln('^C')
          terminal.write(config.prompt)
          break
        case '\x0c': // Ctrl+L
          terminal.clear()
          terminal.write(config.prompt)
          break
        default:
          if (data >= ' ') {
            currentLine += data
            terminal.write(data)
          }
      }
    })

    const resizeObserver = new ResizeObserver(() => {
      fitAddon.fit()
    })
    resizeObserver.observe(containerRef.current)

    // Listen for clear-terminal custom event (Cmd+K shortcut)
    const handleClear = () => {
      terminal.clear()
      terminal.write(config.prompt)
    }
    window.addEventListener('linkr:clear-terminal', handleClear)

    return () => {
      window.removeEventListener('linkr:clear-terminal', handleClear)
      resizeObserver.disconnect()
      terminal.dispose()
    }
  }, [terminalType, onData])

  return (
    <div
      ref={containerRef}
      className="h-full w-full"
      style={{ backgroundColor: '#1e1e1e' }}
    />
  )
}
