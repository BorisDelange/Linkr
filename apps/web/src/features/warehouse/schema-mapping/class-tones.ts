import type { ClassName } from '@/lib/schema-classes/contracts'

export interface ClassTone {
  /** A relation block's header in the mapping editor. */
  header: string
  /** The dot beside a tab or section title. */
  dot: string
  /** A table node in the schema diagram. */
  node: { bg: string; border: string; headerBg: string; icon: string }
}

const tone = (header: string, dot: string, node: ClassTone['node']): ClassTone => ({ header, dot, node })

/**
 * One colour per clinical subject, shared by the mapping editor and the schema
 * diagram so a class reads the same everywhere. Literal class strings: Tailwind
 * only generates the classes it can read in the source.
 */
export const CLASS_TONES: Record<ClassName, ClassTone> = {
  patient: tone('border-sky-500/20 bg-sky-500/10', 'bg-sky-500', {
    bg: 'bg-sky-50 dark:bg-sky-950', border: 'border-sky-400 dark:border-sky-600', headerBg: 'bg-sky-100 dark:bg-sky-900', icon: 'text-sky-600 dark:text-sky-400',
  }),
  visit: tone('border-violet-500/20 bg-violet-500/10', 'bg-violet-500', {
    bg: 'bg-violet-50 dark:bg-violet-950', border: 'border-violet-400 dark:border-violet-600', headerBg: 'bg-violet-100 dark:bg-violet-900', icon: 'text-violet-600 dark:text-violet-400',
  }),
  visit_detail: tone('border-violet-500/20 bg-violet-500/10', 'bg-violet-500', {
    bg: 'bg-violet-50 dark:bg-violet-950', border: 'border-violet-400 dark:border-violet-600', headerBg: 'bg-violet-100 dark:bg-violet-900', icon: 'text-violet-600 dark:text-violet-400',
  }),
  note: tone('border-amber-500/20 bg-amber-500/10', 'bg-amber-500', {
    bg: 'bg-amber-50 dark:bg-amber-950', border: 'border-amber-400 dark:border-amber-600', headerBg: 'bg-amber-100 dark:bg-amber-900', icon: 'text-amber-600 dark:text-amber-400',
  }),
  concept: tone('border-emerald-500/20 bg-emerald-500/10', 'bg-emerald-500', {
    bg: 'bg-emerald-50 dark:bg-emerald-950', border: 'border-emerald-400 dark:border-emerald-600', headerBg: 'bg-emerald-100 dark:bg-emerald-900', icon: 'text-emerald-600 dark:text-emerald-400',
  }),
  event: tone('border-rose-500/20 bg-rose-500/10', 'bg-rose-500', {
    bg: 'bg-rose-50 dark:bg-rose-950', border: 'border-rose-400 dark:border-rose-600', headerBg: 'bg-rose-100 dark:bg-rose-900', icon: 'text-rose-600 dark:text-rose-400',
  }),
  drug: tone('border-orange-500/20 bg-orange-500/10', 'bg-orange-500', {
    bg: 'bg-orange-50 dark:bg-orange-950', border: 'border-orange-400 dark:border-orange-600', headerBg: 'bg-orange-100 dark:bg-orange-900', icon: 'text-orange-600 dark:text-orange-400',
  }),
}
