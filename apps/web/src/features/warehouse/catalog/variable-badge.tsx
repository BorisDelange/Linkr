import { useTranslation } from 'react-i18next'
import { Badge } from '@/components/ui/badge'
import { VARIABLE_COLORS } from '@/lib/data-catalog/variable-colors'
import { cn } from '@/lib/utils'
import type { CatalogVariableId } from '@/types/catalog'
import { VARIABLE_ICON } from './variable-icons'

/** A variable as its coloured badge: icon and name, in the hue it has everywhere. */
export function VariableBadge({ id, className }: { id: CatalogVariableId; className?: string }) {
  const { t } = useTranslation()
  const Icon = VARIABLE_ICON[id]
  return (
    <Badge variant="outline" className={cn(VARIABLE_COLORS[id].badge, className)}>
      <Icon />
      {t(`data_catalog.var_${id}`)}
    </Badge>
  )
}

/** Several variables crossed: their badges joined by ×. */
export function CrossingBadges({ vars, className }: { vars: readonly CatalogVariableId[]; className?: string }) {
  return (
    <span className={cn('inline-flex flex-wrap items-center gap-1', className)}>
      {vars.map((v, i) => (
        <span key={v} className="inline-flex items-center gap-1">
          {i > 0 && <span className="text-[10px] text-muted-foreground">×</span>}
          <VariableBadge id={v} />
        </span>
      ))}
    </span>
  )
}
