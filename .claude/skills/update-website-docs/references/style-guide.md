# Writing style for /docs pages

## Anatomy of a page

Every substantial doc page follows the same order:

1. **Frontmatter** — `layout`, `title`, `description`, `section`, `slug`.
2. **Imports** — `Callout`, `DeploymentBadges`, plus any frame components.
3. **"En résumé" / "Summary" block** — always, always first in the body, always blue.
4. **`<DeploymentBadges />`** — right after the summary.
5. **The content**, `##` sections with `###` subsections.
6. Optionally **"Pour aller plus loin" / "Going further"** — a short `<ul>` of 2–4 links
   to the neighbouring pages, each with a one-line "why you'd read it".

`h1` comes from the frontmatter `title` — never write `# Title` in the body. Start at `##`.

## The summary block

Hand-written HTML, not a component. Always blue whatever the section's accent colour:

```html
<div class="not-prose my-6 rounded-lg border border-blue-200 dark:border-blue-800/50 bg-blue-50/80 dark:bg-blue-950/30 p-5 sm:p-6">
  <p class="text-sm font-semibold text-blue-900 dark:text-blue-200 mb-2">En résumé</p>
  <p class="text-[15px] leading-relaxed text-foreground/90">
    Two to four sentences with <strong>bold</strong> on the key terms.
  </p>
</div>
```

The label is `En résumé` (FR) / `Summary` (EN). The text says what the page covers and
names the two or three concepts it introduces, each in `<strong>`. It should let a reader
decide in five seconds whether this page is the one they need.

## Tone

The primary reader is a **clinician or researcher who does not code**. Data scientists and
admins are secondary. That shapes everything:

- **Vouvoiement** in French ("vous créez", "cliquez sur"). Direct address in English.
- **Explain a technical term the first time it appears on the page**, briefly and inline —
  in italics or between commas — then use it freely. Do not re-explain it lower down.
- Prefer the domain example to the abstract statement. "un onglet *Démographie*, un onglet
  *Biologie*" beats "des onglets thématiques".
- **Bold** the UI elements the reader must find (**Ajouter un widget**, **mode édition**),
  *italics* for the first occurrence of a term or for an English word used as jargon
  (*dataset*, *data preparation*).
- Explicit em-dash asides are idiomatic here — the set uses them heavily, keep doing it.
- Never write "simply", "just", "obviously". Never address the reader as a developer.
- Do not invent behaviour. If a feature is half-built, say so in a `warning` Callout —
  the set already does this honestly (see `concepts/data-pipeline.mdx` on the pipeline
  canvas not being fully wired).

## Cross-linking

Cross-link generously; it is a hallmark of this doc set.

- To another doc page: `[Widgets intégrés](/docs/dashboards/builtin-widgets)`.
- Anchors work and are used: `/docs/dashboards/filters-and-more#filtres` — the anchor is
  the slugified heading **in that locale**, so the FR and EN links differ. Check the target
  page's heading before writing the anchor.
- To an educational article: `/resources/data-organization#format-long-vs-format-large`.
  **Do not duplicate `/resources` content** — OMOP, terminologies, long vs wide format,
  data quality principles are explained there. Link, then say in one sentence what the
  reader will find.
- To an external site, plain markdown works — `rehype-external-links` adds
  `target="_blank" rel="noopener noreferrer"` automatically. Inside raw HTML blocks you
  must write those attributes yourself.
- Never a bare URL as link text.

## Formatting inside the page

- **`<Callout>`** for asides: a caveat, a "what about X?", a pointer to a related page.
  Not for series navigation. See `components.md` for the types.
- **Frame components** (`<DashAddWidget client:load locale="fr" caption="…" />`) instead of
  screenshots — they are hand-drawn React mockups of the real UI. Give every one a
  `caption` that explains what to look at, and set `locale` to match the page's locale.
- **Bespoke HTML cards** are welcome for structural explanations (the three-space diagram
  in `concepts/data-pipeline.mdx`, the two-column comparison cards in
  `dashboards/overview.mdx`). Wrap them in `not-prose`, use theme tokens
  (`text-foreground`, `bg-card`, `border-border`) and the section accent colours with a
  `dark:` variant on every colour. Inline Lucide-style SVGs at 15–18px.
- **Tables** for reference material (option lists, formats). Plain markdown.
- **Code blocks** need a language: `r`, `sql`, `javascript`, `python`, `yaml`, `bash`,
  `html`, `css` (the Shiki config only loads these).
- Bullet lists of the form `- **Term** — explanation.` are the house pattern for
  enumerating options.

## FR ↔ EN

The EN page is a **structural mirror**: same headings in the same order, same components
with the same props, same links (pointing at `/en/…`). Translate the prose properly — it
is not a gloss — but never let the two files diverge in shape, or prev/next and the search
index stop lining up.

UI labels quoted in the text must be the app's real labels in that locale. Read them from
`apps/web/src/locales/fr.json` / `en.json`, not by translating the French label yourself.

## Deployment status is part of the content

Linkr ships in two modes (client-only in the browser, full-stack with FastAPI). Every page
declares what works where via `<DeploymentBadges />`, and any feature that needs a backend
must say so in the prose too, with a link to
`/docs/getting-started/deployment-modes`. Getting this wrong is the most costly kind of
error in this doc set — a reader tries something that cannot work in their install.
