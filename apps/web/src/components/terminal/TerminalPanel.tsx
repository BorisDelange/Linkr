import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { getPyodide, getPyodideStatus } from '@/lib/runtimes/pyodide-engine'
import { getWebR, getWebRStatus } from '@/lib/runtimes/webr-engine'
import { useAppStore } from '@/stores/app-store'

type TerminalType = 'bash' | 'python' | 'r'

const terminalConfig: Record<TerminalType, { welcome: string; prompt: string }> = {
  bash: {
    welcome: '\x1b[1;34mLinkr Terminal\x1b[0m — Bash (WASM)\r\n\x1b[2mNote: limited shell — use Python or R terminals for code execution\x1b[0m\r\n',
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

// Terminal themes matching the Monaco editor themes
const terminalThemes = {
  dark: {
    background: '#0f172b',
    foreground: '#e2e8f0',
    cursor: '#93c5fd',
    selectionBackground: '#1e40af55',
    black: '#0f172b',
    brightBlack: '#475569',
    red: '#f87171',
    brightRed: '#fca5a5',
    green: '#86efac',
    brightGreen: '#bbf7d0',
    yellow: '#fcd34d',
    brightYellow: '#fde68a',
    blue: '#93c5fd',
    brightBlue: '#bfdbfe',
    magenta: '#c4b5fd',
    brightMagenta: '#ddd6fe',
    cyan: '#7dd3fc',
    brightCyan: '#bae6fd',
    white: '#e2e8f0',
    brightWhite: '#f8fafc',
  },
  light: {
    background: '#ffffff',
    foreground: '#0f172b',
    cursor: '#2563eb',
    selectionBackground: '#bfdbfe88',
    black: '#0f172b',
    brightBlack: '#475569',
    red: '#dc2626',
    brightRed: '#ef4444',
    green: '#16a34a',
    brightGreen: '#22c55e',
    yellow: '#d97706',
    brightYellow: '#f59e0b',
    blue: '#2563eb',
    brightBlue: '#3b82f6',
    magenta: '#7c3aed',
    brightMagenta: '#8b5cf6',
    cyan: '#0284c7',
    brightCyan: '#0ea5e9',
    white: '#e2e8f0',
    brightWhite: '#f8fafc',
  },
}

export function TerminalPanel({ terminalType = 'bash', onData }: TerminalPanelProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const darkMode = useAppStore((s) => s.darkMode)
  const editorTheme = useAppStore((s) => s.editorSettings.theme)
  const isDark = editorTheme === 'auto' ? darkMode : editorTheme === 'linkr-dark' || editorTheme === 'vs-dark'
  const xtermTheme = isDark ? terminalThemes.dark : terminalThemes.light

  // Update terminal theme when it changes without recreating the terminal
  useEffect(() => {
    terminalRef.current?.options.theme && (terminalRef.current.options.theme = xtermTheme)
    // Also update container background
    if (containerRef.current) containerRef.current.style.backgroundColor = xtermTheme.background
  }, [xtermTheme])

  useEffect(() => {
    if (!containerRef.current) return

    const config = terminalConfig[terminalType]
    let currentLine = ''
    let history: string[] = []
    let historyIndex = -1
    let executing = false

    const currentTheme = useAppStore.getState()
    const currentEditorTheme = currentTheme.editorSettings.theme
    const currentIsDark = currentEditorTheme === 'auto' ? currentTheme.darkMode : currentEditorTheme === 'linkr-dark' || currentEditorTheme === 'vs-dark'
    const initialTheme = currentIsDark ? terminalThemes.dark : terminalThemes.light

    const terminal = new Terminal({
      fontFamily: "'Menlo', 'Monaco', 'Courier New', monospace",
      fontSize: 13,
      theme: initialTheme,
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
      style={{ backgroundColor: xtermTheme.background }}
    />
  )
}
