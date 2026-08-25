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

## Schema

`schema` is either a **preset id** (`"omop-5.4"`, `"mimic-iv"`) or an **inline mapping**.

A preset id must resolve **on the importing instance** — if it is not installed there,
the import refuses rather than creating a database nothing can read. So either ship the
preset repo alongside and say it is a prerequisite, or inline the mapping when in doubt.
Inline always works and costs a larger `_database.json`.

An **in-memory** database (`inMemory: true`) has no tables at all: an ETL target that
starts empty and is filled by a pipeline. That is the only case where omitting `tables`
is correct.

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
