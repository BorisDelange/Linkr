import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { getPyodide, getPyodideStatus } from '@/lib/runtimes/pyodide-engine'
import { getWebR, getWebRStatus } from '@/lib/runtimes/webr-engine'
import { isServerMode } from '@/lib/api-client'
import { TerminalSocket } from '@/lib/api/terminal-ws'
import { useAppStore, isEditorThemeDark } from '@/stores/app-store'

type TerminalType = 'bash' | 'python' | 'r'

// Commands that install packages imperatively — detected to warn that this
// bypasses the declarative environment (see executeCommand). Best-effort; a miss
// only means no warning, never a broken run.
const INSTALL_RE: Partial<Record<TerminalType, RegExp>> = {
  python: /\b(pip\s+install|uv\s+(add|pip\s+install)|conda\s+install|!pip\s+install)\b/,
  r: /\b(install\.packages|renv::install|devtools::install|remotes::install|BiocManager::install)\b/,
}

const terminalConfig: Record<TerminalType, { prompt: string }> = {
  bash: { prompt: '$ ' },
  python: { prompt: '>>> ' },
  r: { prompt: '> ' },
}

interface TerminalPanelProps {
  terminalType?: TerminalType
  onData?: (data: string) => void
  /** Present in full-stack mode: routes execution to the project's server kernel
   * (python/r) or a PTY shell (bash) over a WebSocket instead of WASM. */
  projectUid?: string
  /** Kernel namespace (session) for python/r REPLs. Ignored for bash. */
  envId?: string
  /** True when this terminal's tab is the active one. A hidden xterm has zero
   * size, so we re-fit when it becomes active again. */
  active?: boolean
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

export function TerminalPanel({ terminalType = 'bash', onData, projectUid, envId, active = true }: TerminalPanelProps) {
  const { t } = useTranslation()
  const containerRef = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const darkMode = useAppStore((s) => s.darkMode)
  const editorTheme = useAppStore((s) => s.editorSettings.theme)
  // The terminal uses the same font size the user set for the code editor, so the
  // REPL and the scripts read at one size.
  const fontSize = useAppStore((s) => s.editorSettings.fontSize)
  const isDark = isEditorThemeDark(editorTheme, darkMode)
  const xtermTheme = isDark ? terminalThemes.dark : terminalThemes.light

  // Update terminal theme when it changes without recreating the terminal
  useEffect(() => {
    if (terminalRef.current?.options.theme) terminalRef.current.options.theme = xtermTheme
    // Also update container background
    if (containerRef.current) containerRef.current.style.backgroundColor = xtermTheme.background
  }, [xtermTheme])

  // Track the editor font size live (no terminal recreation): update the option
  // then refit so the rows/cols recompute for the new cell size.
  useEffect(() => {
    if (!terminalRef.current) return
    terminalRef.current.options.fontSize = fontSize
    try { fitAddonRef.current?.fit() } catch { /* container not measured yet */ }
  }, [fontSize])

  // Becoming visible again: a hidden xterm measured zero size, so refit + refocus.
  useEffect(() => {
    if (!active) return
    // Defer to after the display:block paint so the container has real dimensions.
    const id = requestAnimationFrame(() => {
      try { fitAddonRef.current?.fit() } catch { /* not ready yet */ }
      terminalRef.current?.focus()
    })
    return () => cancelAnimationFrame(id)
  }, [active])

  useEffect(() => {
    if (!containerRef.current) return

    const config = terminalConfig[terminalType]
    let currentLine = ''
    const history: string[] = []
    let historyIndex = -1
    let executing = false
    // Full-stack: python/r attach to the project kernel, bash to a PTY, over a WS.
    const serverMode = isServerMode() && !!projectUid
    let socket: TerminalSocket | null = null

    const currentTheme = useAppStore.getState()
    const currentIsDark = isEditorThemeDark(currentTheme.editorSettings.theme, currentTheme.darkMode)
    const initialTheme = currentIsDark ? terminalThemes.dark : terminalThemes.light

    const terminal = new Terminal({
      fontFamily: "'Menlo', 'Monaco', 'Courier New', monospace",
      // Read fresh from the store so this creation effect need not depend on
      // fontSize (a live change is applied by the dedicated effect above).
      fontSize: currentTheme.editorSettings.fontSize,
      theme: initialTheme,
      cursorBlink: true,
      convertEol: true,
    })

    const fitAddon = new FitAddon()
    terminal.loadAddon(fitAddon)
    terminal.open(containerRef.current)
    fitAddon.fit()

    // Intercept Cmd/Ctrl+K: clear the terminal's own scrollback (like iTerm), and
    // stop the event so the GLOBAL clear_terminal shortcut doesn't also fire and
    // wipe the Console tab — that only happens from a script editor, not here.
    terminal.attachCustomKeyEventHandler((e) => {
      if (e.type === 'keydown' && (e.metaKey || e.ctrlKey) && e.key === 'k') {
        terminal.clear()
        terminal.write(config.prompt)
        e.preventDefault()
        e.stopPropagation()
        return false
      }
      return true
    })

    terminalRef.current = terminal
    fitAddonRef.current = fitAddon

    // The banner reflects where code actually runs: a server kernel in
    // full-stack mode, the in-browser WASM engine otherwise. Bash's banner is
    // replaced by the PTY's own prompt below, so only write it in WASM mode.
    const engineLabel = serverMode ? t('terminal.serverKernel') : t('terminal.wasm')
    const banner: Record<TerminalType, string> = {
      bash: serverMode
        ? ''
        : `\x1b[1;34mLinkr Terminal\x1b[0m — Bash (${t('terminal.wasm')})\r\n\x1b[2m${t('terminal.bashLimited')}\x1b[0m\r\n`,
      python: `\x1b[1;33mPython\x1b[0m (${engineLabel})\r\n`,
      r: `\x1b[1;36mR\x1b[0m (${engineLabel})\r\n`,
    }
    // The banner already ends in \r\n; write (not writeln) so there's no extra
    // blank line before the prompt.
    if (banner[terminalType]) terminal.write(banner[terminalType])
    if (!(serverMode && terminalType === 'bash')) terminal.write(config.prompt)

    if (onData) {
      terminal.onData(onData)
    }

    const resizeObserver = new ResizeObserver(() => fitAddon.fit())
    resizeObserver.observe(containerRef.current)

    const teardown = () => {
      resizeObserver.disconnect()
      socket?.close()
      terminal.dispose()
    }

    // Full-stack Bash: a raw PTY. The shell owns echo, line editing, the prompt
    // and colors — we pass every keystroke through untouched (Ctrl+C is byte
    // 0x03, handled by the PTY) and paint back whatever bytes the shell emits.
    if (serverMode && terminalType === 'bash') {
      terminal.clear()
      terminal.writeln(`\x1b[2m${t('terminal.connecting')}\x1b[0m`)
      let firstOutput = true
      socket = new TerminalSocket(
        { projectUid: projectUid!, language: 'bash' },
        {
          onOpen: () => {
            terminal.clear()
            const { rows, cols } = terminal
            socket?.resize(rows, cols)
          },
          onMessage: (msg) => {
            if (msg.type === 'output' && msg.data) {
              let data = msg.data
              // The PTY emits a leading CR/LF on start (macOS bash); strip it from
              // the very first chunk so the terminal doesn't open on a blank line.
              if (firstOutput) {
                data = data.replace(/^[\r\n]+/, '')
                firstOutput = false
              }
              terminal.write(data)
            }
            else if (msg.type === 'exit') terminal.writeln(`\r\n\x1b[2m${t('terminal.shellExited')}\x1b[0m`)
          },
          onClose: ({ authFailed }) => {
            terminal.writeln(
              authFailed
                ? `\r\n\x1b[31m${t('terminal.authFailed')}\x1b[0m`
                : `\r\n\x1b[2m${t('terminal.disconnected')}\x1b[0m`
            )
          },
        }
      )
      socket.connect()
      terminal.onData((data) => socket?.sendInput(data))
      resizeObserver.disconnect()
      const ptyResize = new ResizeObserver(() => {
        fitAddon.fit()
        socket?.resize(terminal.rows, terminal.cols)
      })
      ptyResize.observe(containerRef.current)
      return () => {
        ptyResize.disconnect()
        teardown()
      }
    }

    // Full-stack python/r: line-edited REPL against the persistent kernel; the
    // WASM engines below are the front-only path. Chunks stream in live.
    if (serverMode && (terminalType === 'python' || terminalType === 'r')) {
      socket = new TerminalSocket(
        { projectUid: projectUid!, language: terminalType, envId },
        {
          onMessage: (msg) => {
            if ((msg.type === 'stdout' || msg.type === 'output') && msg.data) {
              terminal.write(msg.data.replace(/\n/g, '\r\n'))
            } else if (msg.type === 'stderr' && msg.data) {
              terminal.write(`\x1b[31m${msg.data.replace(/\n/g, '\r\n')}\x1b[0m`)
            } else if (msg.type === 'error' && msg.message) {
              terminal.writeln(`\x1b[31m${msg.message}\x1b[0m`)
              executing = false
              terminal.write(config.prompt)
            } else if (msg.type === 'done') {
              executing = false
              terminal.write(config.prompt)
            }
          },
          onClose: ({ authFailed }) => {
            if (authFailed) terminal.writeln(`\r\n\x1b[31m${t('terminal.authFailed')}\x1b[0m`)
            else terminal.writeln(`\r\n\x1b[2m${t('terminal.disconnected')}\x1b[0m`)
          },
        }
      )
      socket.connect()
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

      // Installing from the terminal bypasses the declarative env (the manifest +
      // lockfile the Environments manager edits): the package lands in the library
      // but not the lockfile, so it won't show in the manager, won't travel in git,
      // and is wiped on the next build. Warn, then still run the command.
      if (serverMode && INSTALL_RE[terminalType]?.test(cmd)) {
        terminal.writeln(`\x1b[33m${t('terminal.installWarning')}\x1b[0m`)
      }

      // Server REPL: hand the line to the kernel; chunks stream back via
      // socket.onMessage, which reprints the prompt on the done/error message.
      if (socket) {
        socket.runCode(cmd)
        return
      }

      // In server mode a missing socket means no project context (no server
      // kernel). Never fall back to the WASM runtime — that would load Pyodide/
      // WebR in a deployment meant to run all compute server-side.
      if (isServerMode()) {
        writeOutput(t('terminal.noProjectContext'), true)
        executing = false
        terminal.write(config.prompt)
        return
      }

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
      // While a command runs, ignore input except Ctrl+C (kernel interrupt).
      if (executing && data !== '\x03') return

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
          if (socket && executing) {
            // Interrupt the running kernel (SIGINT); done/error reprints the prompt.
            terminal.writeln('^C')
            socket.interrupt()
            break
          }
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

    return teardown
  }, [terminalType, onData, projectUid, envId, t])

  return (
    <div
      ref={containerRef}
      className="h-full w-full"
      style={{ backgroundColor: xtermTheme.background, padding: '6px 0 6px 8px' }}
    />
  )
}
