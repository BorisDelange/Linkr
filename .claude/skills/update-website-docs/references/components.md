# Components available in a /docs page

Paths are relative to the website repo. `.astro` components render statically; `.tsx` ones
are React and **need `client:load`** in MDX.

## Core

### `Callout` — `@/components/ui/Callout.astro`

```mdx
import Callout from "@/components/ui/Callout.astro";

<Callout type="note" title="Un même filtre, plusieurs jeux de données">
Body text, may contain <strong>HTML</strong>, links, and lists.
</Callout>
```

`type`: `info` (blue, default) · `warning` (amber) · `success` (emerald) · `note` (violet)
· `example` (teal). `title` optional but used almost everywhere.

Convention in this doc set: `info` for a helpful aside or a definition, `note` for
"by the way, related thing over there", `warning` for a limitation or an unfinished
feature, `example` for a worked case.

Inside a Callout you are outside `prose`, so markdown links do work but write plain HTML
`<a>` for anything more elaborate — the component styles `a`, `ul`, `ol`, `p+p` itself.

### `DeploymentBadges` — `@/components/docs/DeploymentBadges.astro`

Two pills ("Client" / "Backend") with hover tooltips, placed right after the summary block.

```mdx
<DeploymentBadges client="available" backend="planned" />
```

Each prop is `available` (green check) · `planned` (grey clock) · `unavailable` (red cross).
Defaults are `client="available" backend="planned"`. The locale is derived from the URL, so
no prop for it.

### `DraftPage` — `@/components/docs/DraftPage.astro`

Wraps a whole page body. In `npm run dev` it renders the children; in the production build
it renders a "🚧 work in progress" warning callout instead. Pair it with `draft: true` on
the page's entry in `docs-nav.ts` (which puts a WIP badge in the sidebar while keeping the
link clickable).

```mdx
<DraftPage description="les modes de stockage et l'import de bases">

…real content, visible in dev only…

</DraftPage>
```

## Structural helpers

### `StepCard` — `@/components/ui/StepCard.astro`

A numbered step. Props: `number` (number), `title`, `description`, optional `color`
(`sky` | `blue` | `indigo` | `violet` | `emerald` | `amber` | `rose` | `teal`).
Wrap a run of them in `<div class="not-prose my-6">`. Used heavily in
`getting-started/first-project.mdx`, usually with a frame component right under each step.

### `Takeaways` — `@/components/ui/Takeaways.astro`

Blue box of checkmarked bullets. `items: string[]`, each item an **HTML string**
(`set:html`, so `<strong>` and `<a>` work). This is a `/resources` article convention; docs
pages more often end with a "Pour aller plus loin" `<ul>` instead. Use it only if the page
really is a tutorial.

### `DataCard` — `@/components/ui/DataCard.astro`

Icon + title + description card. Props: `icon` (a key from its built-in icon map — `users`,
`file`, `heart`, `pill`, `book`, `edit`, `lightbulb`, `refresh`, `handshake`, `unlock`,
`shield`, `message`, `calendar`, `briefcase`, …), `color`, `title`, `description`.

### `NextArticle` — `@/components/ui/NextArticle.astro`

Props: `href`, `label`, `title`. A `/resources` convention — docs pages get prev/next for
free from `DocsLayout`, so **don't use it in /docs**.

### `ImageLightbox` — `@/components/ui/ImageLightbox.tsx`

Click-to-zoom image, `client:load`. Props: `src`, `alt`, `className`. Currently unused in
/docs — the set deliberately prefers hand-drawn frame mockups to screenshots, because
screenshots go stale and can't be localised. If you do add images, put them under
`public/images/docs/`.

## Frame components — the fake-UI mockups

The distinctive thing about this doc set: instead of screenshots, the UI is redrawn as
React components using the app's real Tailwind classes and Lucide icons, inside a browser
chrome frame with a caption. They are bilingual (`locale` prop) and theme-aware.

All take `{ locale?: "fr" | "en", caption?: string }` and need `client:load`:

```mdx
import { DashAddWidget } from "@/components/docs/LinkrDashboardFrames";

<DashAddWidget client:load locale="fr" caption="La boîte de dialogue « Ajouter un widget »…" />
```

Files in `src/components/docs/`:

| File | Exports (prefix) | Covers |
|---|---|---|
| `LinkrDashboardFrames.tsx` | `Dash*` | `DashHub`, `DashAnatomy`, `DashNestedTabs`, `DashEditMode`, `DashBuiltinGallery`, `DashAddWidget`, `DashWidgetConfig`, `DashCodeWidget`, `DashFilters`, `DashExportDialog`, `DashSettingsDialog` |
| `LinkrConceptMappingFrames.tsx` | `Cm*` | ~40 frames covering the whole concept-mapping section, plus `TermTooltip` |
| `LinkrFirstProjectFrames.tsx` | `Linkr*` | `LinkrDatabaseCard`, `LinkrConceptsTable`, `LinkrCohortBuilder`, `LinkrVersioningExport` |
| `LinkrWidgetPreviews.tsx` | `Pv*` | `PvTable1`, `PvKeyIndicator`, `PvPlotBuilder`, `PvKaplanMeier`, `PvCorrelation`, `PvStatTests`, `PvRegression`, `PvSankey` |
| `LabPreview.tsx` | default | Lab area preview, props `locale`, `tabs` |
| `LinkrDemoFrame.tsx` | default | Live demo iframe frame |
| `LinkrMapPreview.tsx` / `LinkrMapLeaflet.tsx` | default | Leaflet map |

Before writing a new frame, `grep -n "^export function" src/components/docs/*.tsx` — there
is probably one already.

### `TermTooltip` — inline glossary

Exported from `LinkrConceptMappingFrames.tsx`. A dotted-underline term with a hover
definition. Good for the one technical word a clinician may not know, without derailing
the sentence.

```mdx
import { TermTooltip } from "@/components/docs/LinkrConceptMappingFrames";

… l'identifiant technique (<TermTooltip client:load content="Un slug est une version courte, en minuscules et sans accents…">slug</TermTooltip>) …
```

### Adding a new frame

1. Add an exported function to the section's `*Frames.tsx` (or create a new file for a new
   section, copying the local `Frame` wrapper from an existing one).
2. Signature `({ locale = "fr", caption }: BaseProps)`; return `<Frame caption={caption}>…`.
3. All user-visible strings come from a `const text = { fr: {...}, en: {...} }[locale]`
   object — never hardcode French in a frame.
4. Mirror the **real** app: same Lucide icons, same Tailwind classes as the components in
   `linkr/apps/web/src/`, same labels as `apps/web/src/locales/*.json`. Open the real
   component before drawing it.
5. Every colour needs a `dark:` counterpart.

## What a docs page does NOT get

- No `# h1` in the body (comes from frontmatter `title`).
- No table of contents markup — `DocsLayout` builds the right-hand TOC from your `##`/`###`.
- No prev/next links — `DocsLayout` derives them from `docs-nav.ts` order.
- No breadcrumbs — same.
- No search metadata — Pagefind indexes the layout's `data-pagefind-body` automatically.
