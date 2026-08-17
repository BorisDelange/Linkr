import { DayPicker } from 'react-day-picker'
import { enUS, fr } from 'react-day-picker/locale'
import { useTranslation } from 'react-i18next'
import { ChevronDownIcon, ChevronLeftIcon, ChevronRightIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { buttonVariants } from '@/components/ui/button'

/**
 * Month calendar (react-day-picker v10).
 *
 * Written against v10's slot names with plain Tailwind sizes rather than copied
 * from the shadcn registry: that file drives every dimension through
 * `--cell-size` / `--cell-radius` custom properties and `cn-calendar-*` classes
 * that ship with its own stylesheet. Without them each cell collapsed to zero
 * width and the whole grid piled up on itself.
 */
export function Calendar({
  className,
  classNames,
  showOutsideDays = true,
  locale,
  ...props
}: React.ComponentProps<typeof DayPicker>) {
  const { t, i18n } = useTranslation()
  // Follows the APP's language, not the browser's — and the locale carries the
  // first day of the week with it (Monday in French, Sunday in English), so it
  // must not be hard-coded separately.
  const activeLocale = locale ?? (i18n.language?.startsWith('fr') ? fr : enUS)

  return (
    <DayPicker
      locale={activeLocale}
      // The date-fns locale translates month and day names, but the nav and
      // dropdown aria-labels are react-day-picker's own English strings.
      labels={{
        labelPrevious: () => t('common.previous_month'),
        labelNext: () => t('common.next_month'),
        labelMonthDropdown: () => t('common.month'),
        labelYearDropdown: () => t('common.year'),
      }}
      showOutsideDays={showOutsideDays}
      className={cn('p-3', className)}
      classNames={{
        // `nav` is rendered as a SIBLING of `month`, not inside the caption, so
        // the positioning context has to be this wrapper.
        months: 'relative flex flex-col gap-4 sm:flex-row',
        month: 'flex flex-col gap-2',

        month_caption: 'flex h-7 items-center justify-center',
        // Also the visible half of each dropdown, hence the inline layout and
        // the sizing of the chevron that v10 nests inside it.
        caption_label:
          'flex items-center gap-0.5 px-1 text-xs font-medium [&>svg]:size-3 [&>svg]:text-muted-foreground',
        nav: 'absolute inset-x-0 top-0 flex h-7 items-center justify-between',
        button_previous: cn(
          buttonVariants({ variant: 'ghost' }),
          'size-6 p-0 text-muted-foreground hover:text-foreground',
        ),
        button_next: cn(
          buttonVariants({ variant: 'ghost' }),
          'size-6 p-0 text-muted-foreground hover:text-foreground',
        ),

        // With captionLayout="dropdown", v10 renders a real <select> AND a
        // visible label span for it. The select is meant to be an invisible
        // overlay on top of that label — styling it as a visible control shows
        // the month and year twice.
        dropdowns: 'flex items-center justify-center gap-1 px-8 text-xs font-medium',
        dropdown_root:
          'relative inline-flex items-center rounded-md border border-transparent hover:border-input has-focus:border-ring has-focus:ring-[3px] has-focus:ring-ring/50',
        dropdown: 'absolute inset-0 z-10 cursor-pointer opacity-0',
        months_dropdown: '',
        years_dropdown: '',

        month_grid: 'w-full border-collapse',
        weekdays: 'flex',
        weekday: 'w-8 text-[10px] font-normal text-muted-foreground',
        weeks: '',
        week: 'mt-0.5 flex w-full',

        day: 'relative size-8 p-0 text-center text-xs',
        day_button: cn(
          buttonVariants({ variant: 'ghost' }),
          'size-8 rounded-md p-0 text-xs font-normal aria-selected:opacity-100',
        ),

        today: 'font-semibold text-primary',
        selected:
          '[&>button]:bg-primary [&>button]:text-primary-foreground [&>button]:hover:bg-primary [&>button]:hover:text-primary-foreground',
        outside: 'text-muted-foreground/50',
        disabled: 'text-muted-foreground/40 opacity-50',
        hidden: 'invisible',

        range_start: '[&>button]:rounded-r-none',
        range_end: '[&>button]:rounded-l-none',
        range_middle:
          '[&>button]:rounded-none [&>button]:bg-accent [&>button]:text-accent-foreground',

        week_number_header: 'w-8',
        week_number: 'w-8 text-[10px] text-muted-foreground',
        ...classNames,
      }}
      components={{
        Chevron: ({ orientation, className: chevronClass, ...rest }) => {
          const Icon =
            orientation === 'left'
              ? ChevronLeftIcon
              : orientation === 'right'
                ? ChevronRightIcon
                : ChevronDownIcon
          return <Icon className={cn('size-4', chevronClass)} {...rest} />
        },
      }}
      {...props}
    />
  )
}
