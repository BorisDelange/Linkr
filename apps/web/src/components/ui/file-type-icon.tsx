/**
 * The icon shown beside a file name, shared by every file tree in the app.
 *
 * It lived privately in the IDE's FileTreeItem while the ETL tree grew its own
 * shorter version, so the same `.sql` file was blue in one panel and orange in
 * the other. One definition means a file looks the same wherever it appears.
 */
import {
  File,
  FileCode,
  FileJson,
  FileSpreadsheet,
  FileText,
  Folder,
  FolderOpen,
  Notebook,
} from 'lucide-react'
import { cn } from '@/lib/utils'

interface Props {
  name: string
  type?: 'file' | 'folder'
  /** Folders only: show the open variant. */
  isOpen?: boolean
  /** Force the spreadsheet icon: a dataset node may be named with no .csv suffix,
   *  and the Datasets page shows it unconditionally. */
  isDataset?: boolean
  size?: number
  className?: string
}

export function FileTypeIcon({
  name,
  type = 'file',
  isOpen = false,
  isDataset = false,
  size = 14,
  className,
}: Props) {
  const cls = (color: string) => cn('shrink-0', color, className)

  if (type === 'folder') {
    return isOpen
      ? <FolderOpen size={size} className={cls('text-blue-400')} />
      : <Folder size={size} className={cls('text-blue-400')} />
  }
  if (isDataset) return <FileSpreadsheet size={size} className={cls('text-emerald-500')} />

  switch (name.split('.').pop()?.toLowerCase()) {
    case 'py':
      return <FileCode size={size} className={cls('text-yellow-500')} />
    case 'r':
      return <FileCode size={size} className={cls('text-blue-500')} />
    case 'rmd':
      return <Notebook size={size} className={cls('text-blue-500')} />
    case 'qmd':
      return <Notebook size={size} className={cls('text-violet-500')} />
    case 'ipynb':
      return <Notebook size={size} className={cls('text-amber-500')} />
    case 'sql':
      return <FileCode size={size} className={cls('text-orange-400')} />
    case 'json':
      return <FileJson size={size} className={cls('text-green-400')} />
    case 'md':
      return <FileText size={size} className={cls('text-muted-foreground')} />
    case 'sh':
      return <FileCode size={size} className={cls('text-green-500')} />
    // Data files — match the Datasets page (FileSpreadsheet, emerald).
    case 'csv':
    case 'tsv':
    case 'xlsx':
    case 'xls':
    case 'parquet':
      return <FileSpreadsheet size={size} className={cls('text-emerald-500')} />
    default:
      return <File size={size} className={cls('text-muted-foreground')} />
  }
}
