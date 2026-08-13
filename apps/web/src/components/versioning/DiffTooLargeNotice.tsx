import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Download, FileWarning, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { downloadBlob } from '@/lib/entity-io'

interface DiffTooLargeNoticeProps {
  path: string
  /** Fetch the two sides as text. Called only when the user asks to download,
   *  so a file we refused to diff is never pulled into memory on open. */
  fetchSides: () => Promise<{ old: string; new: string }>
}

/**
 * Shown instead of a diff when the file is too big to compare (see
 * `_DIFF_HUNK_MAX_CORE_LINES` in git_service.py): rendering it would freeze the
 * tab, and a head-of-file preview would be misleading when the changes are
 * spread throughout. GitHub does the same — refuse, and offer the raw files.
 *
 * Both sides are offered separately rather than as one combined file: an
 * external diff tool is what the user needs here, and it takes two inputs.
 */
export function DiffTooLargeNotice({ path, fetchSides }: DiffTooLargeNoticeProps) {
  const { t } = useTranslation()
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)

  const base = path.split('/').pop() || 'file'
  const download = async () => {
    setBusy(true)
    setFailed(false)
    try {
      const sides = await fetchSides()
      downloadBlob(new Blob([sides.old], { type: 'text/plain' }), `${base}.remote.txt`)
      downloadBlob(new Blob([sides.new], { type: 'text/plain' }), `${base}.local.txt`)
    } catch {
      setFailed(true)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center text-muted-foreground">
      <FileWarning size={28} />
      <p className="max-w-md text-sm">{t('versioning.diff_too_large')}</p>
      <Button variant="outline" size="sm" onClick={() => void download()} disabled={busy}>
        {busy ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
        {t('versioning.diff_download_both')}
      </Button>
      {failed && <p className="text-xs text-destructive">{t('versioning.diff_download_failed')}</p>}
    </div>
  )
}
