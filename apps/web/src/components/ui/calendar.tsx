import { DayPicker } from 'react-day-picker'
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
  ...props
}: React.ComponentProps<typeof DayPicker>) {
  return (
    <DayPicker
      showOutsideDays={showOutsideDays}
      className={cn('p-3', className)}
      classNames={{
        months: 'flex flex-col sm:flex-row gap-4',
        month: 'flex flex-col gap-3',

        // The caption row holds the label (or the month/year dropdowns) between
        // the two nav arrows, which are absolutely placed at its edges.
        month_caption: 'relative flex h-8 items-center justify-center',
        caption_label: 'text-sm font-medium',
        nav: 'absolute inset-x-0 top-0 flex h-8 items-center justify-between px-1',
        button_previous: cn(
          buttonVariants({ variant: 'ghost' }),
          'size-7 p-0 text-muted-foreground hover:text-foreground',
        ),
        button_next: cn(
          buttonVariants({ variant: 'ghost' }),
          'size-7 p-0 text-muted-foreground hover:text-foreground',
        ),

        // captionLayout="dropdown" swaps the label for two native selects; they
        // are given room to breathe instead of overlapping the arrows.
        dropdowns: 'flex items-center justify-center gap-1.5 px-8',
        dropdown_root: 'relative',
        dropdown:
          'h-7 rounded-md border bg-background px-2 text-xs font-medium outline-none focus:ring-2 focus:ring-ring/40',
        months_dropdown: '',
        years_dropdown: '',

        month_grid: 'w-full border-collapse',
        weekdays: 'flex',
        weekday: 'w-9 text-[0.7rem] font-normal text-muted-foreground',
        weeks: '',
        week: 'mt-1 flex w-full',

        day: 'relative size-9 p-0 text-center text-sm',
        day_button: cn(
          buttonVariants({ variant: 'ghost' }),
          'size-9 rounded-md p-0 font-normal aria-selected:opacity-100',
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

        week_number_header: 'w-9',
        week_number: 'w-9 text-[0.7rem] text-muted-foreground',
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
