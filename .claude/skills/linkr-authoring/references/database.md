# Databases

A database repo is the one entity tree that carries **data**. Written with
`write_database(path, spec)`, which generates the metadata and **copies** the Parquet
files from paths you give it.

Field list: `describe_entity_schema("database")`. This page covers what that cannot say.

```
_database.json    metadata + how to read the tables
data/*.parquet    one file per table
.gitattributes    *.parquet tracked with LFS
README.md         what the data is, where it came from
LICENSE.md        the licence it is redistributed under
```

## The rule that comes before everything

> **Synthetic or public open data only.** Never a connected database, a hospital
> extract, or a file whose provenance you do not know.

The app itself never exports a row — deliberately, so it can never be the path by which
patient data leaves a hospital. This tool is allowed to do what the app refuses *because
it runs outside that context*. That is the whole justification, and it collapses the
moment the data is not public.

If the provenance is unclear, stop and ask. A repo cannot be unpublished once pushed,
and a Parquet file carries no label saying whose data it is.

## Tables

Each entry pairs a SQL table name with the file to copy in:

```json
{ "name": "patients", "source": "/data/mimic-iv-demo/patients.parquet" }
```

`name` is what SQL will address and becomes `data/<name>.parquet` — so it must match
what the schema mapping expects. A mapping pointing at `person` while the file is called
`patients` produces a database that imports cleanly and answers nothing.

Tables are sorted on write, so re-running the same spec is byte-stable.

## Schema: inline the mapping, and say where it came from

`schema` is **the mapping itself**, written inline. A bare name (`"omop-5.4"`) is
refused, and that is not a style preference:

- A database **copies** its mapping; it never references a preset. Picking one in the
  app copies `preset.mapping` into the source, so there is no link to follow afterwards.
- A name would only resolve against presets *installed on the importing instance*, and
  the built-in preset table that used to answer those lookups is being retired — schemas
  are installed from the catalog now, not compiled into the app.

So read the mapping out of the schema preset repo (its `mapping.json`) and inline
it. The repo is then installable in any order, with no prerequisite.

Because the copy loses provenance, record it in **`schemaSource`**:

```json
"schemaSource": {
  "lineageId": "…",
  "label": { "en": "OMOP CDM 5.4", "fr": "OMOP CDM 5.4" },
  "version": "0.1.0"
}
```

`lineageId` is copied **verbatim from the preset's own `lineageId`** — required. Not its
`presetId`: that is a local primary key, regenerated on import to keep local uniqueness,
so it names the schema on one instance and nothing anywhere else.

`label` is the snapshot, and it is what the app shows when the schema is **not installed
there** — without it, a database whose schema repo nobody installed has no name at all.
Same split as `createdBy` / `createdByDetails`: an identity to resolve, a copy to read.

If the preset you are copying from has no `lineageId`, it was exported before lineage
existed — re-export it from the app rather than inventing one.

An **in-memory** database (`inMemory: true`) has no tables at all: an ETL target that
starts empty and is filled by a pipeline. That is the only case where omitting `tables`
is correct — it still needs a mapping.

## LFS is not optional

Parquet goes in Git LFS, and `write_database` writes the `.gitattributes` for you. Two
things depend on it: a host will reject or choke on multi-megabyte blobs in normal
history, and Linkr's server-side clone resolves LFS pointers before the app sees the
tree. **Initialise LFS in the repo before the first commit** (`git lfs install`,
`git lfs track "*.parquet"` is already declared) — committing the Parquet as ordinary
blobs first and converting later leaves them in history forever.

## Licences travel with the data

A dataset's licence is a redistribution condition, not decoration. MIMIC-IV demo is
**ODbL 1.0**, which requires the notice to travel with the data — so `LICENSE.md` and
the attribution in `README.md` are part of what makes republishing it legitimate.

Say in the README where the data came from, which version, and what may be done with it.
Someone installing from the catalog sees the licence on the card before installing; an
absent one reads as "no licence", which is what a reuser must not have to guess at.

## Size

The card shows the download size from the catalog entry's `sizeBytes`, so a user knows
before starting an 18 MB download. Declare it when publishing an entry.

For reference: MIMIC-IV demo is 18 MB across 32 tables; its OMOP form is 12 MB. The
install path caps a clone at 200 MB.
