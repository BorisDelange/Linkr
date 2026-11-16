import { useTranslation } from 'react-i18next'
import { GitCommitVertical } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { NoticeBanner } from '@/components/ui/notice-banner'
import type { GitTrackedUnmarkedFile } from '@/lib/api/git'

/**
 * The files the repository tracks that the export leaves out until the user marks
 * them. Nothing marks them on the user's behalf: the band lists them, says the
 * next push deletes them from the remote, and offers to mark them — `onMark` goes
 * through the data-versioning confirmation.
 */
export function TrackedUnmarkedNotice({
  files,
  onMark,
}: {
  files: GitTrackedUnmarkedFile[]
  onMark: (files: GitTrackedUnmarkedFile[]) => void
}) {
  const { t } = useTranslation()
  if (files.length === 0) return null
  return (
    <NoticeBanner
      tone="warning"
      className="items-start"
      title={t('versioning.tracked_unmarked_title', { count: files.length })}
      description={
        <>
          <p className="mt-0.5 leading-relaxed">{t('versioning.tracked_unmarked_hint', { count: files.length })}</p>
          <ul className="mt-2 max-h-28 divide-y overflow-y-auto rounded-md border bg-background/60">
            {files.map((f) => (
              <li key={f.path} className="flex items-center gap-2 py-0.5 pl-2 pr-1">
                <span className="min-w-0 flex-1 truncate font-mono text-foreground" title={f.path}>{f.path}</span>
                <Button size="xs" variant="ghost" className="shrink-0" onClick={() => onMark([f])}>
                  <GitCommitVertical />
                  {t('versioning.tracked_unmarked_mark')}
                </Button>
              </li>
            ))}
          </ul>
        </>
      }
      action={files.length > 1 ? (
        <Button size="sm-tight" variant="outline" onClick={() => onMark(files)}>
          <GitCommitVertical />
          {t('versioning.tracked_unmarked_mark_all', { count: files.length })}
        </Button>
      ) : undefined}
    />
  )
}
