# shadcn/ui Components Reference

Source repo cloned at: `../shadcn-ui/apps/v4/registry/bases/radix/ui/`

> This is the **upstream catalogue** — what shadcn offers and what's installed.
> For how OUR composed components are built and styled (datatable, dialogs,
> toolbars, page headers, type scale), see **`docs/ui-patterns.md`** — read that
> first before building any UI.

## All Available Components (59 total)

### Layout & Navigation
- **Sidebar** - Composable sidebar with collapsible, header/footer/content/groups/menu items. Variants: sidebar/floating/inset. Collapsible: offcanvas/icon/none. Side: left/right.
- **Navigation Menu** - Top nav with dropdowns
- **Breadcrumb** - Breadcrumb navigation
- **Tabs** - Tabbed content
- **Resizable** - Resizable panels (like allotment)
- **Pagination** - Page navigation
- **Menubar** - Menu bar (File/Edit/View style)
- **Scroll Area** - Custom scrollbar wrapper

### Data Display
- **Card** - Container with header/content/footer
- **Table** - Styled table
- **Data Table** - Full-featured table with sorting, filtering, pagination (TanStack Table)
- **Badge** - Small label/tag
- **Avatar** - User avatar with fallback
- **Chart** - Data visualization (Recharts-based)
- **Carousel** - Content carousel
- **Skeleton** - Loading placeholder
- **Empty** - Empty state component
- **Typography** - Text components
- **Kbd** - Keyboard shortcut display
- **Spinner** - Loading spinner

### Forms & Input
- **Button** - Standard button with variants
- **Button Group** - Grouped buttons
- **Input** - Text input
- **Input Group** - Input with addons
- **Input OTP** - One-time password input
- **Textarea** - Multi-line text input
- **Select** - Custom select dropdown
- **Native Select** - Native HTML select
- **Checkbox** - Checkbox input
- **Radio Group** - Radio button group
- **Switch** - Toggle switch
- **Slider** - Range slider
- **Calendar** - Date calendar
- **Date Picker** - Date selection
- **Combobox** - Searchable select (Command-based)
- **Field** - Form field wrapper
- **Label** - Form label
- **Toggle** - Toggle button
- **Toggle Group** - Grouped toggles

### Overlays & Feedback
- **Dialog** - Modal dialog
- **Alert Dialog** - Confirmation dialog
- **Sheet** - Side panel overlay
- **Drawer** - Bottom drawer
- **Dropdown Menu** - Context dropdown
- **Context Menu** - Right-click menu
- **Popover** - Floating popover
- **Hover Card** - Hover tooltip card
- **Tooltip** - Small tooltip
- **Toast / Sonner** - Toast notifications
- **Alert** - Inline alert message
- **Command** - Command palette (cmdk)
- **Progress** - Progress bar

### Utility
- **Accordion** - Expandable sections
- **Collapsible** - Collapsible content
- **Separator** - Visual separator
- **Aspect Ratio** - Aspect ratio container
- **Direction** - RTL/LTR support
- **Item** - Generic item component

## Installed from shadcn/ui

alert-dialog, avatar, badge, button, calendar, card, checkbox, collapsible, context-menu, dialog, dropdown-menu, input, kbd, label, popover, progress, scroll-area, select, separator, sheet, sidebar, skeleton, slider, switch, table, tabs, textarea, tooltip

Everything else in `apps/web/src/components/ui/` is composed in-house: **see `docs/ui-patterns.md` for when and how to use it.**

## Not yet installed (candidates)

- **Command** - For command palette (Ctrl+K)
- **Breadcrumb** - For Header navigation
- **Accordion** - Expandable sections
- **Sonner/Toast** - For notifications
