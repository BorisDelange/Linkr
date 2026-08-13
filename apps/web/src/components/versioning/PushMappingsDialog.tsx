import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { FileWarning, Loader2 } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { useGitSyncStore } from '@/stores/git-sync-store'
import { diffPushMappings } from '@/lib/concept-mapping/push-mappings-diff'
import type { MappingChange } from '@/lib/concept-mapping/merge'
import { PullMappingsTable } from './PullMappingsTable'
import type { GitScope } from '@/lib/api/git'

interface PushMappingsDialogProps {
  scope: GitScope
  id: string
  branch: string
  onClose: () => void
}

/**
 * "What mappings am I about to push?" — the push-side counterpart of the pull
 * picker, read-only because the changes are already made; the question is only
 * what they are.
 *
 * It reuses the diff endpoint the file viewer already calls (so the result is
 * usually cached and opens instantly) and turns the two JSON blobs into rows.
 */
export function PushMappingsDialog({ scope, id, branch, onClose }: PushMappingsDialogProps) {
  const { t } = useTranslation()
  const getRawSides = useGitSyncStore((s) => s.getRawSides)
  const [state, setState] = useState<
    | { kind: 'loading' }
    | { kind: 'rows'; changes: MappingChange[] }
    | { kind: 'unlistable' }
  >({ kind: 'loading' })

  useEffect(() => {
    let cancelled = false
    setState({ kind: 'loading' })
    // Raw sides, never the rendered diff: that one condenses or refuses a big
    // file, and a truncated payload is not parseable JSON — precisely the case
    // this table exists for. getRawSides asks the server for both sides verbatim
    // (server mode) or reads the export ZIP (standalone); comparing them by
    // mapping key is cheap even at ~1500 objects.
    void getRawSides(scope, id, 'mappings.json', branch).then((sides) => {
      if (cancelled) return
      const result = diffPushMappings(sides.old, sides.new)
      setState(result ? { kind: 'rows', changes: result.changes } : { kind: 'unlistable' })
    }).catch(() => {
      if (!cancelled) setState({ kind: 'unlistable' })
    })
    return () => { cancelled = true }
  }, [scope, id, branch, getRawSides])

  if (state.kind === 'rows' && state.changes.length > 0) {
    return <PullMappingsTable changes={state.changes} onClose={onClose} readOnly />
  }

  // Loading, unlistable, or parsed-but-empty (the file differs only in key order
  // or whitespace) all render as a short notice rather than an empty datatable.
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="text-sm">{t('versioning.push_mappings_review')}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col items-center gap-3 px-2 py-6 text-center text-sm text-muted-foreground">
          {state.kind === 'loading' ? (
            <>
              <Loader2 size={20} className="animate-spin" />
              {t('versioning.sync_computing')}
            </>
          ) : (
            <>
              <FileWarning size={24} />
              <p>{t(state.kind === 'unlistable' ? 'versioning.push_mappings_unlistable' : 'versioning.push_mappings_none')}</p>
            </>
          )}
        </div>
        <div className="flex justify-end">
          <Button size="sm" onClick={onClose}>{t('common.close')}</Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
