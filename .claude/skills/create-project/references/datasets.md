# Reference — datasets (CSV → table)

Each dataset becomes a table under Lab › Datasets. You author **one CSV per
dataset** and one entry in the spec's `"datasets"` array.

## Authoring the CSV

- First row = headers using real column names (`person_id`, `age`, `sex`).
- Make it **clinically coherent**: correlate fields (older age ↔ higher
  mortality), plausible ranges/units, include every categorical column your
  charts group by and every column your dashboard filters on.
- A few hundred rows is enough (~200 default). Write them out literally in the
  file — you may generate them with a throwaway inline loop, but the CSV on disk
  must contain real rows, not a generator.
- Dates as strings like `2185-01-17 20:11`.

## Spec entry

```json
"datasets": [
  {
    "slug": "icu-stays",         // folder + csv file name in the ZIP
    "name": "ICU stays",         // display name (also the dataset folder)
    "csv":  "icu-stays.csv",     // path relative to spec.json
    "types": {"age": "number"}   // optional per-column type override
  }
]
```

## Column types

Inferred per column: `number` if every non-empty value parses as a number, else
`string`. Override with `"types"` when inference guesses wrong (e.g. a zip-code
or an all-numeric id you want treated as a string, or a date column). Valid
types: `string | number | boolean | date | unknown`.

## Invariants (mirror entity-io.ts)

- `datasets/_tree.json` = `DatasetFile[]`.
- Rows live in `datasets/<name>/_data.json` as `{ "rows": [...] }`, keyed by
  **column id** (`col-0`, `col-1`, …) — NOT by header name. The script does this
  remap for you.
- `datasets/<name>/_columns.json` = `DatasetColumn[]` (`{id, name, type, order}`).
- The dataset folder is derived from the dataset's **`name`** (minus any trailing
  extension), matching `buildDatasetPath`. The CSV file inside is named from `slug`.
- **The dataset `name` (and anything else that becomes a ZIP folder/file path — dataset
  names, IDE folder/file paths) MUST be ASCII, no accents, ideally no spaces.** The
  folder name has to survive a macOS NFD filesystem round-trip and an exact-string ZIP
  lookup in `parseNewLayout` (entity-io.ts). macOS (APFS/HFS+) stores filenames in NFD
  while the JSON keeps NFC, so a name like `Données CLIP-MIR` imports fine *directly*
  but is **silently dropped** once the project is unpacked to disk / a git repo (how the
  linkr-portal stores projects) and re-zipped — you get the dashboard but no dataset and
  no error. Keep `name` a plain slug (e.g. `clip_mir_data`; NeoCLIP uses `table_agregee`)
  and put the human-readable/localized label elsewhere. Display localization of the
  dataset is not driven by this folder name anyway. `build_zip.py` hard-errors on a
  non-ASCII `name`/IDE path and warns on spaces.
- Widgets and filters reference columns by **header name**; the script remaps them
  to `col-N` at build time (see `references/dashboards.md`).
