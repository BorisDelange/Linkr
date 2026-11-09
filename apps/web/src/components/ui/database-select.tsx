import { useTranslation } from 'react-i18next'
import { Database } from 'lucide-react'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useDatabaseOptions } from '@/hooks/use-database-options'
import { localized } from '@/lib/localized'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/stores/app-store'

interface Props {
  workspaceId: string | null | undefined
  /** Narrows the list to the databases this project has linked. */
  projectUid?: string
  value: string | undefined
  onChange: (dataSourceId: string) => void
  placeholder?: string
  size?: 'xs' | 'sm' | 'default'
  className?: string
  disabled?: boolean
  /** Show a database icon in the trigger. For a toolbar control standing on its
   *  own; a form field is already named by its label, so it stays off there. */
  icon?: boolean
  /** Offer a first "none" entry that clears the choice (onChange receives ''),
   *  for a form where the database is optional. */
  noneLabel?: string
}

const NONE = '__none__'

/**
 * The "choose a database" control, shared by every picker.
 *
 * The same Select-over-`useDatabaseOptions` was hand-copied into nine dialogs,
 * so a fix to one (the workspace scoping, the vocabulary exclusion) had to be
 * remembered in eight others. Anything that must hold for every picker — the
 * empty-list wording below, in particular — belongs here.
 */
export function DatabaseSelect({
  workspaceId,
  projectUid,
  value,
  onChange,
  placeholder,
  size = 'default',
  className,
  disabled,
  icon = false,
  noneLabel,
}: Props) {
  const { t } = useTranslation()
  const language = useAppStore((s) => s.language)
  const sources = useDatabaseOptions(workspaceId, projectUid)

  // An empty dropdown reads as "broken", so say which of the two reasons it is:
  // a project offers only what it has linked, and linking is a different screen.
  const empty = sources.length === 0
  const emptyLabel = projectUid
    ? t('databases.no_linked_database')
    : t('databases.no_database')

  return (
    <Select
      value={value ?? ''}
      onValueChange={(v) => onChange(v === NONE ? '' : v)}
      disabled={disabled || empty}
    >
      <SelectTrigger size={size} className={cn(icon && 'gap-1.5', className)}>
        {icon && <Database size={12} className="shrink-0 text-muted-foreground" />}
        <SelectValue placeholder={empty ? emptyLabel : (placeholder ?? t('databases.select_database'))} />
      </SelectTrigger>
      <SelectContent>
        {noneLabel && (
          <>
            <SelectItem value={NONE}>{noneLabel}</SelectItem>
            <SelectSeparator />
          </>
        )}
        {sources.map((ds) => (
          <SelectItem key={ds.id} value={ds.id}>
            {localized(ds.name, language)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
