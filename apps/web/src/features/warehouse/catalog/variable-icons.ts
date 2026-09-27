import type { ComponentType } from 'react'
import { Calendar, Tag, Stethoscope, Users, VenusAndMars } from 'lucide-react'
import type { CatalogVariableId } from '@/types/catalog'

export const VARIABLE_ICON: Record<CatalogVariableId, ComponentType<{ size?: number; className?: string }>> = {
  concept: Tag, period: Calendar, service: Stethoscope, age: Users, sex: VenusAndMars,
}
