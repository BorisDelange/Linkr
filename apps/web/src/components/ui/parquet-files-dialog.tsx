import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, Copy } from 'lucide-react'
import { DialogShell } from '@/components/ui/dialog-shell'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { ParquetTablePath } from '@/lib/api/data-sources'
import { cn } from '@/lib/utils'

/** A value plus a copy button: it is meant to be pasted into another tool, and a
 *  long path is impractical to select by hand. */
export function CopyablePath({ value, mono = true }: { value: string; mono?: boolean }) {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)

  const copy = () => {
    void navigator.clipboard.writeText(value).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }

  return (
    <div className="flex min-w-0 items-center gap-1">
      {/* break-all, not break-words: a path has no spaces to wrap on, so it would
          otherwise widen whatever narrow column it sits in. */}
      <code
        className={cn(
          'block min-w-0 flex-1 break-all rounded bg-muted/50 px-1.5 py-1 text-[10px] leading-relaxed',
          !mono && 'font-sans',
        )}
      >
        {value}
      </code>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={copy}
            aria-label={t('files.copy')}
            // items-center on the row centres the button against the whole code
            // block; a hand-tuned top margin only lined up on a one-line value.
            className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            {copied ? <Check size={11} className="text-emerald-500" /> : <Copy size={11} />}
          </button>
        </TooltipTrigger>
        <TooltipContent>{copied ? t('common.copied') : t('files.copy')}</TooltipContent>
      </Tooltip>
    </div>
  )
}

/**
 * The tables of a Parquet source with the blob path(s) a script would read.
 *
 * A raw MIMIC import has 30+ tables, each with its own path: inline that is a
 * wall of hashes burying everything around it, so both the ETL sidebar and the
 * database overview only announce the count and open this on demand.
 */
export function ParquetFilesDialog({
  open,
  onOpenChange,
  tables,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  tables: ParquetTablePath[]
}) {
  const { t } = useTranslation()
  const [copiedAll, setCopiedAll] = useState(false)

  const copyAll = () => {
    void navigator.clipboard
      .writeText(tables.flatMap((tb) => tb.paths).join('\n'))
      .then(() => {
        setCopiedAll(true)
        setTimeout(() => setCopiedAll(false), 1500)
      })
  }

  return (
    <DialogShell
      open={open}
      onOpenChange={onOpenChange}
      kind="workbench"
      title={t('databases.parquet_files_title', { count: tables.length })}
      description={t('etl.pipeline_db_parquet_blob_hint')}
      onConfirm={copyAll}
      confirmLabel={
        <>
          {copiedAll ? <Check size={14} /> : <Copy size={14} />}
          {copiedAll ? t('common.copied') : t('databases.parquet_files_copy_all')}
        </>
      }
    >
      {/* space-y-3 between tables against space-y-0.5 inside one: the name has to
          group with its own path, not float between two. pr-6 keeps the copy
          buttons clear of the scrollbar, which overlays the body's right edge —
          a narrower gutter still left it sitting on top of them. */}
      <div className="space-y-3 pr-6">
        {tables.map((tb) => (
          <div key={tb.table} className="space-y-0.5">
            <div className="flex items-center gap-1.5">
              <code className="text-xs font-medium">{tb.table}</code>
              {!tb.exists && (
                <span className="text-[10px] text-amber-600 dark:text-amber-500">
                  {t('etl.pipeline_db_table_missing')}
                </span>
              )}
            </div>
            {tb.paths.map((p) => (
              <CopyablePath key={p} value={p} />
            ))}
          </div>
        ))}
      </div>
    </DialogShell>
  )
}
