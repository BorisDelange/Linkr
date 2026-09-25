import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, Copy } from 'lucide-react'
import { DataTable, type DataTableColumn } from '@/components/ui/data-table'
import { DialogShell } from '@/components/ui/dialog-shell'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { humanBytes } from '@/lib/format-helpers'
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

/** Copy button for one path, sized for a table cell. */
function CopyPathButton({ value }: { value: string }) {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={(e) => {
            // The row is not clickable, but the dialog behind it reacts to
            // stray clicks; keep the copy self-contained.
            e.stopPropagation()
            void navigator.clipboard.writeText(value).then(() => {
              setCopied(true)
              setTimeout(() => setCopied(false), 1500)
            })
          }}
          aria-label={t('files.copy')}
          className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          {copied ? <Check size={12} className="text-emerald-500" /> : <Copy size={12} />}
        </button>
      </TooltipTrigger>
      <TooltipContent>{copied ? t('common.copied') : t('files.copy')}</TooltipContent>
    </Tooltip>
  )
}

/** One table file: a table sharded across several files contributes one row each,
 *  because the path is what the reader copies and each shard has its own. */
interface ParquetFileRow {
  key: string
  table: string
  path: string
  exists: boolean
  /** Bytes for the whole table, carried on its first row only — see `size`. */
  sizeBytes: number | null
  shardCount: number
}

function toRows(tables: ParquetTablePath[]): ParquetFileRow[] {
  return tables.flatMap((tb) =>
    tb.paths.map((p) => ({
      key: `${tb.table}:${p}`,
      table: tb.table,
      path: p,
      exists: tb.exists,
      // The API sizes a TABLE, not a shard, so every shard of a sharded table
      // carries the table's total. Splitting it evenly would invent numbers;
      // leaving all but one blank would make the column lie when sorted.
      // Single-file tables — the common case — are unaffected either way.
      sizeBytes: tb.sizeBytes,
      shardCount: tb.paths.length,
    })),
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
  const { t, i18n } = useTranslation()
  const [copiedAll, setCopiedAll] = useState(false)

  const rows = useMemo(() => toRows(tables), [tables])

  const copyAll = () => {
    void navigator.clipboard
      .writeText(tables.flatMap((tb) => tb.paths).join('\n'))
      .then(() => {
        setCopiedAll(true)
        setTimeout(() => setCopiedAll(false), 1500)
      })
  }

  const columns: DataTableColumn<ParquetFileRow>[] = useMemo(
    () => [
      {
        id: 'table',
        header: t('databases.parquet_table_column'),
        accessor: (r) => r.table,
        size: 170,
        filter: 'text',
        cell: (r) => (
          <span className="flex items-center gap-1.5">
            <code className="truncate font-medium">{r.table}</code>
            {!r.exists && (
              <span className="shrink-0 text-[10px] text-amber-600 dark:text-amber-500">
                {t('etl.pipeline_db_table_missing')}
              </span>
            )}
          </span>
        ),
        tooltip: true,
      },
      {
        id: 'path',
        header: t('databases.parquet_path_column'),
        accessor: (r) => r.path,
        size: 380,
        filter: 'text',
        // font-mono, not a <code> block: the cell is already truncated by the
        // table, and a background would fight the row striping.
        cellClassName: 'font-mono',
      },
      {
        id: 'size',
        header: t('databases.parquet_size_column'),
        // Sort on the number, show the human string — a text sort would put
        // "9 KB" after "10 MB".
        accessor: (r) => r.sizeBytes ?? -1,
        display: (r) => (r.sizeBytes == null ? '—' : humanBytes(r.sizeBytes, i18n.language)),
        align: 'right',
        size: 90,
        filter: 'none',
      },
      {
        id: 'copy',
        header: '',
        accessor: () => '',
        cell: (r) => <CopyPathButton value={r.path} />,
        size: 40,
        sortable: false,
        resizable: false,
        align: 'center',
        filter: 'none',
      },
    ],
    [t, i18n.language],
  )

  return (
    <DialogShell
      open={open}
      onOpenChange={onOpenChange}
      kind="workbench"
      title={t('databases.parquet_files_title', { count: tables.length })}
      description={t('etl.pipeline_db_parquet_blob_hint')}
      onConfirm={copyAll}
      // Copy does not close the dialog, so a second button next to it would
      // either name nothing ("Cancel") or repeat the ✕ ("Close").
      hideCancel
      confirmLabel={
        <>
          {copiedAll ? <Check size={14} /> : <Copy size={14} />}
          {copiedAll ? t('common.copied') : t('databases.parquet_files_copy_all')}
        </>
      }
    >
      <DataTable
        data={rows}
        columns={columns}
        rowKey={(r) => r.key}
        // Biggest first: on a 30-table import, which files carry the weight is
        // the question this dialog is usually opened to answer.
        initialSorting={{ columnId: 'size', desc: true }}
        density="compact"
        stickyHeader
        viewKey="parquet-files-dialog"
        emptyMessage={t('databases.parquet_files_empty')}
      />
    </DialogShell>
  )
}
