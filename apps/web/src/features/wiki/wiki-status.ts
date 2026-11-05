import type { WikiPageStatus } from '@/types'
import { PRESET_COLORS } from '@/lib/badge-colors'

export const WIKI_STATUSES: WikiPageStatus[] = ['draft', 'needs_revision', 'approved']

export const WIKI_STATUS_DOT: Record<WikiPageStatus, string> = {
  draft: 'bg-muted-foreground/50',
  needs_revision: 'bg-warning',
  approved: PRESET_COLORS.find((c) => c.value === 'green')?.swatch ?? '',
}
