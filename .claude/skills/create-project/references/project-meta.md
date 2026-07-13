# Reference — project metadata, README, tasks, badges

The `"project"` object in `spec.json` plus the optional README/tasks it produces.

```json
"project": {
  "projectId": "icu-activity",
  "name":        {"en": "ICU Activity", "fr": "Activité de réanimation"},
  "description": {"en": "Real-time ICU activity overview.", "fr": "…"},
  "shortDescription": {"en": "…", "fr": "…"},
  "readme":     "# ICU Activity\n\nMarkdown…",
  "readmeFile": "README.md",
  "todos":  [{"text": "Validate mortality figures", "done": false}],
  "notes":  "Free-form markdown scratchpad.",
  "badges": [{"label": "ICU", "color": "red"}, {"label": "Demo", "color": "blue"}],
  "status": "active"
}
```

## Fields

- **`name`**, **`description`**, **`shortDescription`** — localized `{en, fr}`.
  Always fill both languages. `name` is required.
- **`projectId`** — stable slug. Optional; defaults to a slug of the English name.
- **`readme`** *(string)* OR **`readmeFile`** *(path relative to spec.json)* — the
  project README rendered on the project home. Prefer `readmeFile` for anything
  more than a few lines (keeps `spec.json` readable, lets you write real markdown).
  If both are given, `readme` wins. → written to `README.md` in the ZIP.
- **`todos`** *(array)* — `{text, done}` items shown in the project's task list.
- **`notes`** *(string)* — free-form notes. `todos`+`notes` → `tasks.json`
  (written only if non-empty, mirroring the app).
- **`badges`** *(array)* — `{label, color}` chips on the project card.
  Colors: `blue | red | green | orange | slate | purple | yellow | teal | pink`
  (any CSS-token color the badge component supports; stick to these for safety).
- **`status`** — `active` (default) | `archived` | `draft`.

## README quality

The README is the first thing a user sees. Make it a real project brief:
a one-line purpose, a "Data" section describing each dataset and its columns,
a "Dashboards" section listing tabs and what each answers, and (if present) an
"Analysis" section pointing at the IDE scripts. See `examples/README.md`.

## Invariants

- `project.json` carries `appVersion` and OMITS `readme`/`todos`/`notes` (those
  live in `README.md` / `tasks.json`). The script handles this split.
- Instance fields (`ownerId`, `workspaceId`, `gitRemoteConfig`, timestamps) are
  regenerated on import — do not author them.
