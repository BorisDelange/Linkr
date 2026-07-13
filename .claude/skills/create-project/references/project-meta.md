# Reference — project metadata, README, tasks, badges

The `"project"` object in `spec.json` plus the optional README/tasks it produces.

```json
"project": {
  "projectId": "icu-activity",
  "name":        {"en": "ICU Activity", "fr": "Activité de réanimation"},
  "description": {"en": "Real-time ICU activity overview.", "fr": "…"},
  "shortDescription": {"en": "…", "fr": "…"},
  "readme":     {"en": "# ICU Activity\n\nMarkdown…", "fr": {"file": "README.fr.md"}},
  "todos":  [{"text": {"en": "Validate mortality", "fr": "Valider la mortalité"}, "done": false}],
  "notes":  {"en": "Scratchpad.", "fr": "Bloc-notes."},
  "badges": [{"label": {"en": "ICU", "fr": "Réa"}, "color": "red"}, {"label": "Demo", "color": "blue"}],
  "status": "active"
}
```

## Fields

- **`name`**, **`description`**, **`shortDescription`** — localized `{en, fr}`.
  Always fill both languages. `name` is required.
- **`projectId`** — stable slug. Optional; defaults to a slug of the English name.
- **README — localized, one file per language.** `README.md` holds the primary
  language (English if present), `README.fr.md` (etc.) hold the others. Provide it via:
  - **`readme`** — a string (→ English) **or** a `{en, fr}` map. Each language's
    value is either inline markdown or `{"file": "path"}` to read from disk.
  - **`readmeFile`** — a string path (→ English) **or** a `{en, fr}` map of paths.
  - `readme` wins over `readmeFile` per language. Prefer files for long READMEs.
  - **Do write both languages** — the user reads the project in their locale, and
    a missing FR README shows the EN one. Author `README.md` + `README.fr.md`.
- **`todos`** *(array)* — `{text, done}`; **`text` is localized** (`{en, fr}`, or a
  plain string treated as English). An `id` is optional (auto-assigned).
- **`notes`** — free-form notes, **localized** (`{en, fr}` or a string → English).
  `todos`+`notes` → `tasks.json` (written only if non-empty, mirroring the app).
- **`badges`** *(array)* — `{label, color}` chips on the project card.
  **`label` is localized** (`{en, fr}`, or a plain string treated as English).
  Colors: `blue | red | green | orange | slate | purple | yellow | teal | pink`
  (any CSS-token color the badge component supports; stick to these for safety).
- **`status`** — `active` (default) | `archived` | `draft`.

## README quality

The README is the first thing a user sees. Make it a real project brief:
a one-line purpose, a "Data" section describing each dataset and its columns,
a "Dashboards" section listing tabs and what each answers, and (if present) an
"Analysis" section pointing at the IDE scripts. See `examples/README.md`.

## Invariants (mirror entity-io.ts writeReadmeFiles / parseProjectZip)

- `project.json` carries `appVersion` and OMITS `readme`/`todos`/`notes` (those
  live in `README*.md` / `tasks.json`). The script handles this split.
- README round-trips per language: `README.md` = primary, `README.<lang>.md` =
  others. Import matches `^README(?:\.([a-z]{2}))?\.md$`, so use 2-letter codes.
- `tasks.json` = `{todos: [{id, text, done}], notes}` with `text`/`notes` as
  `{lang: string}` maps.
- Instance fields (`ownerId`, `workspaceId`, `gitRemoteConfig`, timestamps) are
  regenerated on import — do not author them.
