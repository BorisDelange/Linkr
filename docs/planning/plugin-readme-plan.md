# Plugin READMEs — the tutorial that travels with the plugin

**Status:** in progress · **Branch:** `feature/plugin-readme` · started 2026-09-03

A plugin's manifest carries a one-line description. That is enough to pick it out
of a list and nowhere near enough to *use* it: SPC alone asks the user to choose
between p, u, c, individuals, P′/U′, EWMA and g/t charts, and to know that the
choice sets the variance model. That knowledge has to live somewhere the user can
reach at the moment of the choice.

The answer is the README each entity already has — surfaced where the plugin is
chosen and where it is configured, not only in the Settings editor.

## 1. What already exists

Most of the plumbing is built; it is simply not exposed outside Settings.

| Piece | Where | State |
| --- | --- | --- |
| `readme?: LocalizedString` on the entity | `types/index.ts` (`UserPlugin`) | ✅ |
| README editor + renderer | `components/editor/ReadmeEditor.tsx`, `MarkdownRenderer.tsx` | ✅ |
| Markdown deps (`react-markdown`, `remark-gfm`, `remark-math`) | `apps/web/package.json` | ✅ |
| README attachments (images) | `hooks/use-readme-attachments.ts` | ✅ |
| Plugin overview showing the README | `features/settings/PluginOverviewTab.tsx` | ✅ |
| Docs read/write per plugin row | `features/settings/use-plugin-actions.tsx` (`docs.getReadme`) | ✅ |
| Export convention `README.md` / `README.<lang>.md` | `lib/entity-io.ts` (`writeEntityDocs`, `readmeLangMeta`) | ✅ |
| Golden fixture proving a plugin exports its README | `lib/__fixtures__/export-golden/user-plugin/expected/` | ✅ |

Two gaps:

1. **Built-in plugins have no README at all.** `packages/default-plugins/*/*/`
   holds only `plugin.json`.
2. **The README is never shown at the point of use** — only in Settings →
   Plugins → the editor.

## 2. Where the README shows up

Three surfaces, chosen so that nothing gets stacked on top of a sheet that is
already nearly full-screen.

### (a) The picker — a right-hand sheet

The three "choose a plugin" modals all render the same shared component, so **one
insertion point covers all three**:

- `features/projects/lab/datasets/CreateAnalysisDialog.tsx`
- `features/projects/dashboard/AddWidgetDialog.tsx`
- `features/projects/warehouse/patient-data/AddPatientWidgetDialog.tsx`
- → all use `components/PluginPicker.tsx`

Each card already carries an `Info` icon whose only job today is a tooltip
(description, version, deps). It keeps the tooltip on hover — useful when
scanning a grid — and gains a click that opens the README in a right-hand sheet
over the dialog. The picker stays mounted underneath: read, close, still in the
list, selection intact.

These three are plain dialogs, so a sheet lays over them cleanly.

### (b) The widget editor / analysis shell — a third tab

`WidgetEditorDialog` is **itself** a right-side sheet at `w-[calc(100vw-16rem)]`.
A second sheet on top would be both stacked and redundant. It already has a
toolbar of tabs driving the left pane of an Allotment split — `Config` and
`Code`. The README becomes a **third tab, `Doc`**, beside them:

- `features/projects/dashboard/WidgetEditorDialog.tsx` — `activeTab: 'config' | 'code' | null`
- `features/projects/lab/datasets/analyses/AnalysisShell.tsx` — same shape, same change

This is better than a sheet anyway: the chart stays visible in the right pane
while the doc is read in the left one, which is exactly what choosing an SPC
chart type calls for.

Note `GenericConfigPanel` receives only the `schema`, not the plugin — so the tab
lives in these two callers, which do know the plugin.

### (c) Settings → Plugins

Already done (`PluginOverviewTab`). Nothing to do.

## 3. Where the README lives

Built-in plugins are file-based, one folder per plugin, so the README sits beside
the manifest — matching the export convention already used by every other entity:

```
packages/default-plugins/analyses/spc/
├── plugin.json
├── README.md       ← en
└── README.fr.md    ← fr
```

Bilingual EN/FR, like the manifests (`name`/`description` are already `{en, fr}`).
Loaded as `LocalizedString` and read through `localized(readme, lang)`, which
falls back to `.en` when a translation is missing.

Loading — three small links, everything downstream already exists:

1. `import spcReadmeEn from '@default-plugins/analyses/spc/README.md?raw'` in
   `lib/plugins/default-plugins.ts`, beside the manifest import it already does.
2. Carry it on the registered `Plugin` so the picker can reach it without a
   storage round-trip.
3. `seedBuiltinPluginsForWorkspace()` populates the row's `readme` field, which
   it does not do today — it only writes `files['plugin.json']`. That one line
   makes `docs.getReadme` work for built-ins exactly as it already does for user
   plugins, and makes the README export with the plugin (`writeEntityDocs`),
   which is covered by the golden fixture.

Note the two JSON files are not the same thing and must not be conflated:
`entity.json` / `_plugin.json` is Linkr **entity metadata** (identity, provenance,
licence), while `plugin.json` is the plugin's **functional manifest**
(configSchema, runtime, icon). The README is an entity doc, like everywhere else.

One caveat: `linkr-analysis-key-indicator` is the last plugin whose manifest is
an inline TS literal in `default-plugins.ts` rather than a folder, so it has
nowhere to put a README until it is moved to `packages/default-plugins/`. Out of
scope here; it simply shows no doc.

## 4. Plan

1. **Plumbing** — resolve a README for any plugin (built-in via the bundled file,
   user plugin via the existing docs store) behind one accessor.
2. **Picker sheet** — `Info` becomes clickable in `PluginPicker`; a
   `PluginReadmeSheet` renders the markdown. Covers the three modals at once.
   It renders through `components/editor/MarkdownRenderer` — read-only, and it
   already handles GitHub callouts, wikilinks, KaTeX and mermaid. Not
   `EntityReadmePanel`, which is the *editor* and belongs in Settings.
3. **`Doc` tab** — third tab in `WidgetEditorDialog` and `AnalysisShell`, hidden
   when the plugin has no README.
4. **Write the SPC README** — EN + FR, the first real one (below).
5. **i18n** — new keys in both `locales/en.json` and `locales/fr.json`.

Backfilling the other twelve built-ins is follow-up work, not this change; the
tab and the sheet simply don't appear for a plugin without a README.

## 5. The SPC README — what it must cover

SPC is the right first plugin: it is the one where the config is meaningless
without the theory. The doc is a *tutorial*, not a reference dump.

- **What a control chart is for** — distinguishing common-cause variation from a
  real signal, so teams stop reacting to noise.
- **Choosing the chart** — the decision that comes first because it sets the
  variance model: proportion → p, rate → u/c, measurement → individuals, rare
  events → g/t, slow drift → EWMA, overdispersion → Laney P′/U′.
- **Why limits move** — stepped limits follow each period's denominator; a small
  month gets wider limits.
- **Reading a signal** — the detection rules, and what the flagged points mean.
- **The baseline** — why limits are frozen on a baseline period and what the
  dashed marker is.
- **The warnings** — too few periods, events too rare for a rate, overdispersion,
  a denominator that cannot apply.
- **A worked example** on a plausible ICU indicator.

Theory background already written up in `docs/planning/spc-plugin-plan.md`.
