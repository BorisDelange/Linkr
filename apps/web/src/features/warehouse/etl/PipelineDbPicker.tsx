import { useTranslation } from 'react-i18next'
import { ChevronDown, Check, Database } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { useOverflowTooltip } from '@/hooks/use-overflow-tooltip'
import { cn } from '@/lib/utils'
import type { DataSource } from '@/types'
import { compareByRole, roleIconColor, type PipelineRole } from './role-presentation'

interface Props {
  databases: DataSource[]
  selectedId: string | undefined
  onSelect: (id: string) => void
  roleOf: (id: string | undefined) => PipelineRole | undefined
  placeholder?: string
}

/**
 * Pick which of the pipeline's databases to look at. Used by the schema browser
 * tab; the scripts editor has its own variant because there the choice is a
 * per-file override that can be cleared.
 */
export function PipelineDbPicker({
  databases,
  selectedId,
  onSelect,
  roleOf,
  placeholder,
}: Props) {
  const { t } = useTranslation()
  const { ref, overflows, triggerProps } = useOverflowTooltip()

  const ordered = [...databases].sort((a, b) => compareByRole(a.id, b.id, roleOf))
  const selected = databases.find((ds) => ds.id === selectedId)
  const label = selected?.name ?? placeholder ?? ''
  const selectedRole = roleOf(selectedId)

  if (databases.length === 0) return null

  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button
              variant="outline"
              size="xs"
              className="gap-1 max-w-[260px] text-[11px]"
              {...triggerProps}
            >
              <Database
                size={11}
                className={cn('shrink-0', roleIconColor(selectedRole))}
              />
              <span ref={ref} className="truncate">{label}</span>
              {selectedRole && (
                <span className="shrink-0 text-[10px] text-muted-foreground">
                  ({t(`etl.${selectedRole}`)})
                </span>
              )}
              <ChevronDown size={10} className="shrink-0 opacity-50" />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        {overflows && <TooltipContent side="bottom">{label}</TooltipContent>}
      </Tooltip>
      <DropdownMenuContent align="start" className="w-[280px]">
        {ordered.map((ds) => {
          const role = roleOf(ds.id)
          return (
            <DropdownMenuItem
              key={ds.id}
              onClick={() => onSelect(ds.id)}
              className="gap-2 py-1 text-xs"
              title={ds.name}
            >
              <Database size={12} className={cn('shrink-0', roleIconColor(role))} />
              <span className="truncate">{ds.name}</span>
              {role && (
                <span className="shrink-0 text-[10px] text-muted-foreground">
                  ({t(`etl.${role}`)})
                </span>
              )}
              {ds.id === selectedId && <Check size={12} className="ml-auto shrink-0" />}
            </DropdownMenuItem>
          )
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
