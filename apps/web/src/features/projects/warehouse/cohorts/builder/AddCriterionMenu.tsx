import { useTranslation } from 'react-i18next'
import {
  Calendar,
  Clock,
  Heart,
  Plus,
  Search,
  Skull,
  User,
  Users,
  FolderTree,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import type { CriteriaType } from '@/types'

interface AddCriterionMenuProps {
  onAddCriterion: (type: CriteriaType) => void
  onAddGroup: () => void
}

const criteriaItems: { type: CriteriaType; labelKey: string; icon: typeof User }[] = [
  { type: 'age', labelKey: 'cohorts.criteria_age', icon: User },
  { type: 'sex', labelKey: 'cohorts.criteria_sex', icon: Users },
  { type: 'death', labelKey: 'cohorts.criteria_death', icon: Skull },
  { type: 'period', labelKey: 'cohorts.criteria_period', icon: Calendar },
  { type: 'duration', labelKey: 'cohorts.criteria_duration', icon: Clock },
  { type: 'visit_type', labelKey: 'cohorts.criteria_visit_type', icon: Heart },
  { type: 'concept', labelKey: 'cohorts.criteria_concept', icon: Search },
]

export function AddCriterionMenu({ onAddCriterion, onAddGroup }: AddCriterionMenuProps) {
  const { t } = useTranslation()

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="gap-1.5 text-xs w-full">
          <Plus size={12} />
          {t('cohorts.add_criterion')}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-52">
        <DropdownMenuLabel className="text-xs text-muted-foreground">
          {t('cohorts.section_criteria')}
        </DropdownMenuLabel>
        <DropdownMenuGroup>
          {criteriaItems.map(({ type, labelKey, icon: Icon }) => (
            <DropdownMenuItem
              key={type}
              onClick={() => onAddCriterion(type)}
              className="gap-2 text-xs"
            >
              <Icon size={14} />
              {t(labelKey)}
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-xs text-muted-foreground">
          {t('cohorts.section_logic')}
        </DropdownMenuLabel>
        <DropdownMenuGroup>
          <DropdownMenuItem onClick={onAddGroup} className="gap-2 text-xs">
            <FolderTree size={14} />
            {t('cohorts.add_group')}
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
