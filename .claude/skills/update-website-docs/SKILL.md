---
name: update-website-docs
description: Write or update the end-user documentation on linkr-website (linkr.interhop.org) — the /docs section, bilingual FR/EN Astro + MDX. Use when a Linkr feature changed and its doc page needs updating, when adding a new doc page or section, when promoting a draft page to real content, or when the user asks to document something on the website.
---

# Update the Linkr website documentation

The user documentation for Linkr lives in a **separate repo**, not in `linkr/`:

```
/Users/borisdelange/Documents/Mac/Programming projects/linkr-website
```

It is an Astro 5 + React 19 + MDX site deployed on GitLab Pages at
**https://linkr.interhop.org**. The `/docs` section is the source of truth for end-user
documentation. This skill covers only `/docs` — `/resources` (educational articles) and
`/blog` follow different conventions, described in that repo's `CLAUDE.md`.

⚠️ That repo's `CLAUDE.md` still describes `/docs` as "Content Pending" with an empty
`docs-nav.ts`. **That is stale** — there are ~43 pages × 2 locales today. Trust this skill
and the actual files, not that section.

## Before writing anything

1. **Read the current page(s)** you are about to touch, in **both** locales.
2. **Check the feature in the app code** (`linkr/apps/web/src/…`). The docs describe real
   UI: button labels, dialog names, menu paths. Do not document from memory — open the
   component and read the actual `t('…')` labels in `apps/web/src/locales/fr.json` /
   `en.json`. Write the FR doc with the FR app labels and the EN doc with the EN ones.
3. **Read at least one neighbouring page** in the same section, to match its structure,
   density, and tone. `references/style-guide.md` has the full rules.

## The five things that must stay in sync

Any change to the doc set touches these. Missing one silently breaks the site:

| # | What | Where |
|---|------|-------|
| 1 | The FR page | `src/pages/docs/<section>/<slug>.mdx` |
| 2 | The EN page | `src/pages/en/docs/<section>/<slug>.mdx` |
| 3 | The nav entry | `src/data/docs-nav.ts` |
| 4 | The FR nav title | `src/lib/i18n.ts`, `fr` object |
| 5 | The EN nav title | `src/lib/i18n.ts`, `en` object |

**FR and EN must always exist as a pair.** A page present in only one locale is a bug —
the sidebar, prev/next and Pagefind search all iterate the same nav for both locales.

## Task recipes

### A. Update an existing page after a feature change

1. Read the FR + EN page.
2. Read the app code for the changed feature; note the exact FR/EN UI labels.
3. Edit the FR page, then port the same edit to the EN page — same headings, same
   component calls, same order. The two files are structural mirrors.
4. If the change adds or removes a concept worth a nav entry, apply recipe B or D.
5. Run the checks below.

### B. Add a new page to an existing section

1. Add the child to the section's `items` in `src/data/docs-nav.ts`, at the right position
   (sidebar order = reading order = prev/next order):
   ```ts
   { titleKey: "docs.nav.<short>.<slug>", slug: "<slug>" },
   ```
   Key naming follows the existing short prefixes: `cm.` (concept-mapping), `dash.`
   (dashboards), `prep.` (preparing-data), `explore.` (exploring-analyzing), `collab.`,
   `admin.`, `ref.`, `concepts.`. Getting-started keys have no prefix.
2. Add `"docs.nav.<short>.<slug>"` to **both** the `fr` and `en` objects in `src/lib/i18n.ts`.
3. Create both MDX files from `references/page-template.mdx`.
4. Run the checks.

### C. Promote a draft page to real content

Draft pages are wrapped in `<DraftPage>` (renders the real content in `npm run dev`, a
"work in progress" callout in production) and carry `draft: true` in `docs-nav.ts`.

1. Write the real content in both locales, removing the `<DraftPage>` wrapper and its import.
2. Remove `draft: true` from that item in `docs-nav.ts`.
3. Replace the placeholder `description` in the frontmatter with a real one.
4. Run the checks.

### D. Add a whole new section

1. Add the section object to `docsNav` with its `items`.
2. Add i18n keys in **both** locales for: the section title (`docs.nav.<section>`), the
   section hub subtitle (`docs.section.<section>.subtitle` — shown on `/docs`), and every
   child title.
3. Create `src/pages/docs/<section>/` and `src/pages/en/docs/<section>/` with all pages.
4. Run the checks.

## Checks before finishing

Run all of these from the website repo. The last one catches the mistake this doc set has
actually made before (links to a section that was later renamed).

```bash
cd "/Users/borisdelange/Documents/Mac/Programming projects/linkr-website"

# 1. FR/EN pairing — must print nothing
diff <(cd src/pages/docs && find . -name '*.mdx' | sort) \
     <(cd src/pages/en/docs && find . -name '*.mdx' | sort)

# 2. Every nav i18n key exists in both locales — must print nothing
grep -oE 'titleKey: "[^"]+"' src/data/docs-nav.ts | cut -d'"' -f2 | sort -u |
  while read k; do
    [ "$(grep -c "\"$k\":" src/lib/i18n.ts)" -eq 2 ] || echo "i18n key not in both locales: $k"
  done

# 3. Internal /docs links resolve — must print nothing
grep -rhoE '\(/(en/)?docs/[^)#]+' src/pages/docs src/pages/en/docs | tr -d '(' | sort -u |
  while read l; do
    p=$(echo "$l" | sed 's|^/en/docs|src/pages/en/docs|; s|^/docs|src/pages/docs|')
    [ -f "$p.mdx" ] || [ -f "$p/index.astro" ] || echo "BROKEN LINK: $l"
  done

# 4. The site builds
npm run build
```

Known pre-existing breakage from check 3 (fix opportunistically if you touch those pages):
`/docs/more/plugins` and `/docs/presenting/reports`, referenced from
`dashboards/tabs-and-widgets.mdx` and `dashboards/overview.mdx`. The real targets are
`/docs/exploring-analyzing/plugins` and `/docs/exploring-analyzing/reports`.

Preview with `npm run dev` (http://localhost:4321). Dev mode also reveals `devOnly` nav
entries and unwraps `<DraftPage>`, so what you see there is not what production shows.

## Committing

Commit in the **website repo**, not in `linkr/`. Messages are English, plain, no emoji, no
AI attribution — e.g. `Document dashboard export options`, `Update French translation for
concept mapping export`. Do not push unless asked.

If the same change also alters `linkr/`'s own developer docs (`docs/architecture.md`,
`docs/planning/*`), those stay in `linkr/` — the website carries **user-facing** docs only.

## References

- `references/style-guide.md` — page anatomy, the "En résumé" block, tone, and the writing
  rules that make a page match the rest of the set. **Read it before writing prose.**
- `references/components.md` — every component available in a docs page, with props: the
  `Callout` types, `DeploymentBadges`, `StepCard`, `DraftPage`, and the large library of
  fake-UI "frame" mockups (`LinkrDashboardFrames`, `LinkrConceptMappingFrames`…), including
  how to add a new one.
- `references/page-template.mdx` — copy-paste skeleton for a new page.
