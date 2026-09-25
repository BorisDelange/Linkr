import type { ClassName } from '@/lib/schema-classes/contracts'

/**
 * One tint per clinical subject, shared by a block's header and its tab's dot,
 * so a block is recognisable in the All tab too. Literal class strings: Tailwind
 * only generates the classes it can read in the source.
 */
export const CLASS_TONES: Record<ClassName, { header: string; dot: string }> = {
  patient: { header: 'border-sky-500/20 bg-sky-500/10', dot: 'bg-sky-500' },
  visit: { header: 'border-violet-500/20 bg-violet-500/10', dot: 'bg-violet-500' },
  visit_detail: { header: 'border-violet-500/20 bg-violet-500/10', dot: 'bg-violet-500' },
  note: { header: 'border-amber-500/20 bg-amber-500/10', dot: 'bg-amber-500' },
  concept: { header: 'border-emerald-500/20 bg-emerald-500/10', dot: 'bg-emerald-500' },
  event: { header: 'border-rose-500/20 bg-rose-500/10', dot: 'bg-rose-500' },
  drug: { header: 'border-orange-500/20 bg-orange-500/10', dot: 'bg-orange-500' },
}
