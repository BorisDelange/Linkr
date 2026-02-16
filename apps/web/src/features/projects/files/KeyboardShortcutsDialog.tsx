import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { RotateCcw, Lock } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { useShortcutStore } from '@/stores/shortcut-store'
import {
  SHORTCUT_GROUPS,
  BROWSER_RESERVED,
  type ShortcutActionId,
  type KeyCombo,
} from '@/types/shortcuts'

interface KeyboardShortcutsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

const isMac = navigator.platform.toUpperCase().includes('MAC')

function comboToDisplay(combo: KeyCombo): string[] {
  const parts: string[] = []
  if (combo.ctrlOrMeta) parts.push(isMac ? '⌘' : 'Ctrl')
  if (combo.shift) parts.push('Shift')
  if (combo.alt) parts.push(isMac ? '⌥' : 'Alt')
  // Capitalize key display
  const keyDisplay =
    combo.key === 'Enter'
      ? '↵'
      : combo.key === '`'
        ? '`'
        : combo.key.length === 1
          ? combo.key.toUpperCase()
          : combo.key
  parts.push(keyDisplay)
  return parts
}

function isBrowserReserved(combo: KeyCombo): boolean {
  return BROWSER_RESERVED.some(
    (r) =>
      r.key.toLowerCase() === combo.key.toLowerCase() &&
      r.ctrlOrMeta === combo.ctrlOrMeta &&
      r.shift === combo.shift &&
      r.alt === combo.alt
  )
}

function eventToCombo(e: KeyboardEvent): KeyCombo | null {
  // Ignore modifier-only presses
  if (['Control', 'Meta', 'Shift', 'Alt'].includes(e.key)) return null
  return {
    key: e.key.length === 1 ? e.key.toLowerCase() : e.key,
    ctrlOrMeta: e.metaKey || e.ctrlKey,
    shift: e.shiftKey,
    alt: e.altKey,
  }
}

function Kbd({ children }: { children: string }) {
  return (
    <kbd className="inline-flex h-5 min-w-[20px] items-center justify-center rounded border border-border bg-muted px-1.5 text-[10px] font-medium text-muted-foreground">
      {children}
    </kbd>
  )
}

function ComboDisplay({ combo }: { combo: KeyCombo }) {
  const parts = comboToDisplay(combo)
  return (
    <div className="flex items-center gap-0.5">
      {parts.map((part, i) => (
        <span key={i} className="flex items-center gap-0.5">
          {i > 0 && (
            <span className="text-[10px] text-muted-foreground">+</span>
          )}
          <Kbd>{part}</Kbd>
        </span>
      ))}
    </div>
  )
}

export function KeyboardShortcutsDialog({
  open,
  onOpenChange,
}: KeyboardShortcutsDialogProps) {
  const { t } = useTranslation()
  const { shortcuts, setBinding, resetBinding, resetAll, findConflict, isCustomized } =
    useShortcutStore()

  const [recordingId, setRecordingId] = useState<ShortcutActionId | null>(null)
  const [pendingCombo, setPendingCombo] = useState<KeyCombo | null>(null)
  const recorderRef = useRef<HTMLDivElement>(null)

  // Close recording when dialog closes
  useEffect(() => {
    if (!open) {
      setRecordingId(null)
      setPendingCombo(null)
    }
  }, [open])

  // Listen for keydown while recording
  useEffect(() => {
    if (!recordingId) return

    const handleKeyDown = (e: KeyboardEvent) => {
      e.preventDefault()
      e.stopPropagation()

      // Escape cancels recording
      if (e.key === 'Escape') {
        setRecordingId(null)
        setPendingCombo(null)
        return
      }

      const combo = eventToCombo(e)
      if (!combo) return
      setPendingCombo(combo)
    }

    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  }, [recordingId])

  const conflictId = useMemo(() => {
    if (!pendingCombo || !recordingId) return null
    return findConflict(pendingCombo, recordingId)
  }, [pendingCombo, recordingId, findConflict])

  const browserReserved = useMemo(() => {
    if (!pendingCombo) return false
    return isBrowserReserved(pendingCombo)
  }, [pendingCombo])

  const confirmRecording = useCallback(() => {
    if (!recordingId || !pendingCombo) return
    setBinding(recordingId, pendingCombo)
    setRecordingId(null)
    setPendingCombo(null)
  }, [recordingId, pendingCombo, setBinding])

  const cancelRecording = useCallback(() => {
    setRecordingId(null)
    setPendingCombo(null)
  }, [])

  const startRecording = useCallback((id: ShortcutActionId) => {
    setRecordingId(id)
    setPendingCombo(null)
  }, [])

  const hasAnyCustom = useMemo(
    () => Object.keys(shortcuts).some((id) => isCustomized(id as ShortcutActionId)),
    [shortcuts, isCustomized]
  )

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('shortcuts.title')}</DialogTitle>
          <DialogDescription className="sr-only">
            {t('shortcuts.title')}
          </DialogDescription>
        </DialogHeader>

        <TooltipProvider delayDuration={300}>
          <div className="mt-2 space-y-5">
            {SHORTCUT_GROUPS.map((group) => (
              <div key={group.titleKey}>
                <h3 className="mb-2 text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  {t(group.titleKey)}
                </h3>
                <div className="space-y-1">
                  {group.actions.map((actionId) => {
                    const def = shortcuts[actionId]
                    if (!def) return null
                    const isMonaco = def.scope === 'monaco-builtin'
                    const isRecording = recordingId === actionId
                    const customized = isCustomized(actionId)

                    return (
                      <div
                        key={actionId}
                        className={cn(
                          'flex items-center justify-between rounded-md px-2 py-1.5 -mx-2',
                          isRecording && 'bg-accent/50 ring-1 ring-primary/30'
                        )}
                      >
                        <span className="text-sm flex items-center gap-1.5">
                          {t(def.labelKey)}
                          {isMonaco && (
                            <Tooltip>
                              <TooltipTrigger>
                                <Lock size={10} className="text-muted-foreground/50" />
                              </TooltipTrigger>
                              <TooltipContent>
                                {t('shortcuts.monaco_handled')}
                              </TooltipContent>
                            </Tooltip>
                          )}
                        </span>

                        <div className="flex items-center gap-1.5">
                          {isRecording ? (
                            <div ref={recorderRef} className="flex items-center gap-2">
                              {pendingCombo ? (
                                <>
                                  <ComboDisplay combo={pendingCombo} />
                                  {conflictId && (
                                    <span className="text-[10px] text-yellow-600 dark:text-yellow-400">
                                      {t('shortcuts.conflict_warning', {
                                        action: t(shortcuts[conflictId].labelKey),
                                      })}
                                    </span>
                                  )}
                                  {browserReserved && (
                                    <span className="text-[10px] text-red-500">
                                      {t('shortcuts.browser_reserved')}
                                    </span>
                                  )}
                                  <Button
                                    variant="ghost"
                                    size="icon-xs"
                                    onClick={confirmRecording}
                                    disabled={browserReserved}
                                    className="h-5 w-5"
                                  >
                                    <span className="text-xs">✓</span>
                                  </Button>
                                  <Button
                                    variant="ghost"
                                    size="icon-xs"
                                    onClick={cancelRecording}
                                    className="h-5 w-5"
                                  >
                                    <span className="text-xs">✕</span>
                                  </Button>
                                </>
                              ) : (
                                <span className="text-xs text-muted-foreground animate-pulse">
                                  {t('shortcuts.press_keys')}
                                </span>
                              )}
                            </div>
                          ) : (
                            <button
                              onClick={
                                isMonaco ? undefined : () => startRecording(actionId)
                              }
                              className={cn(
                                'rounded px-1 py-0.5 transition-colors',
                                isMonaco
                                  ? 'cursor-default opacity-60'
                                  : 'hover:bg-accent cursor-pointer'
                              )}
                              disabled={isMonaco}
                            >
                              <ComboDisplay combo={def.binding} />
                            </button>
                          )}

                          {customized && !isRecording && (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Button
                                  variant="ghost"
                                  size="icon-xs"
                                  onClick={() => resetBinding(actionId)}
                                  className="h-5 w-5"
                                >
                                  <RotateCcw size={10} />
                                </Button>
                              </TooltipTrigger>
                              <TooltipContent>
                                {t('shortcuts.reset_one')}
                              </TooltipContent>
                            </Tooltip>
                          )}
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            ))}
          </div>
        </TooltipProvider>

        {hasAnyCustom && (
          <div className="mt-4 flex justify-end">
            <Button
              variant="outline"
              size="sm"
              onClick={resetAll}
              className="text-xs"
            >
              <RotateCcw size={12} className="mr-1.5" />
              {t('shortcuts.reset_all')}
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
