import type { WikiPageStatus } from '@/types'

export const WIKI_STATUSES: WikiPageStatus[] = ['draft', 'needs_revision', 'approved']

export const WIKI_STATUS_DOT: Record<WikiPageStatus, string> = {
  draft: 'bg-muted-foreground/50',
  needs_revision: 'bg-warning',
  approved: 'bg-emerald-500',
}
