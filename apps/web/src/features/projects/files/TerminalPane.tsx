import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Terminal, X, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { TerminalPanel } from '@/components/terminal/TerminalPanel'
import { cn } from '@/lib/utils'

type TerminalType = 'bash' | 'python' | 'r'

interface TerminalTab {
  id: string
  type: TerminalType
  label: string
}

const terminalLabels: Record<TerminalType, string> = {
  bash: 'Bash',
  python: 'Python',
  r: 'R',
}

let tabCounter = 1

interface TerminalPaneProps {
  onClose: () => void
}

export function TerminalPane({ onClose }: TerminalPaneProps) {
  const { t } = useTranslation()
  const [tabs, setTabs] = useState<TerminalTab[]>([
    { id: 'term-0', type: 'bash', label: 'Bash' },
  ])
  const [activeTabId, setActiveTabId] = useState('term-0')

  const addTab = (type: TerminalType) => {
    const id = `term-${tabCounter++}`
    const label = `${terminalLabels[type]} ${tabCounter}`
    setTabs((prev) => [...prev, { id, type, label }])
    setActiveTabId(id)
  }

  const closeTab = (id: string) => {
    setTabs((prev) => {
      const remaining = prev.filter((tab) => tab.id !== id)
      if (remaining.length === 0) {
        onClose()
        return prev
      }
      if (activeTabId === id) {
        const idx = prev.findIndex((tab) => tab.id === id)
        const newActive = remaining[Math.min(idx, remaining.length - 1)]
        setActiveTabId(newActive.id)
      }
      return remaining
    })
  }

  const activeTab = tabs.find((tab) => tab.id === activeTabId)

  return (
    <div className="flex h-full flex-col overflow-hidden border-t">
      <div className="flex items-center justify-between border-b bg-muted/30 px-1 py-0.5">
        <div className="flex items-center gap-0 overflow-x-auto">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTabId(tab.id)}
              className={cn(
                'group flex items-center gap-1.5 rounded-sm px-2.5 py-1 text-xs transition-colors',
                tab.id === activeTabId
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              )}
            >
              <Terminal size={12} />
              <span>{tab.label}</span>
              {tabs.length > 1 && (
                <span
                  onClick={(e) => {
                    e.stopPropagation()
                    closeTab(tab.id)
                  }}
                  className="ml-0.5 rounded p-0.5 opacity-0 hover:bg-accent group-hover:opacity-100"
                >
                  <X size={10} />
                </span>
              )}
            </button>
          ))}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-xs" className="ml-0.5 shrink-0">
                <Plus size={12} />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuItem onClick={() => addTab('bash')}>
                <Terminal size={14} />
                Bash
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => addTab('python')}>
                <Terminal size={14} />
                Python
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => addTab('r')}>
                <Terminal size={14} />
                R
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <div className="flex items-center gap-0.5 shrink-0">
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={onClose}
          >
            <X size={12} />
          </Button>
        </div>
      </div>
      <div className="flex-1 overflow-hidden">
        {activeTab && (
          <TerminalPanel key={activeTab.id} terminalType={activeTab.type} />
        )}
      </div>
    </div>
  )
}
