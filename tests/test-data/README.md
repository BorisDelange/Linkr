# Test datasets

Large OMOP datasets for the database matrix and for trying Linkr at scale, built
once and kept between runs. Overview of the tiers: [docs/testing.md](../../docs/testing.md).

```bash
npm run test-data -- --list            # where they are, which are built
npm run test-data                      # build every missing one
npm run test-data -- synthea-100k      # just this one
npm run test:matrix -- --dataset synthea-100k --spe
```

## Where they live

In the folder `testData.dir` of the gitignored `config.local.json` names, never in
the checkout (they weigh several GB):

```json
{ "testData": { "dir": "/absolute/path/of/your/choice" } }
```

Without it they go to `.cache/test-data/`. `npm run worktree:new` copies
`config.local.json`, so every worktree shares the same folder.

## The datasets

| Name | What | Size |
|---|---|---|
| `mimic-iv-demo-omop` | the public MIMIC-IV demo in OMOP CDM 5.4, 100 patients — the reference schema and mapping | 6 MB |
| `mimic-iv-demo-omop-x100` | the demo ×100 (`matrix.py upsample`): 10,000 patients under new ids | ~100× the demo |
| `synthea-100k` | Synthea, 100,000 synthetic patients; 158,000 notes, 309 M characters | 2 GB |
| `mimic-iv-demo-dense` | the demo + patients `990000001`–`4` with 100k, 1 M, 5 M and 20 M events over a year (`build.py dense`) | 220 MB |
| `mimic-iv-demo-dense-5m` | the same up to 5 M events, small enough for a browser to store | 60 MB |

`--scale N` on the matrix makes further copies next to them (`<dataset>-x<N>`).

`synthea-100k` is assembled by [`build.py`](build.py) from three public sources,
downloaded once into `<dir>/_downloads/` (~1.7 GB, kept for a rebuild):

- **Clinical tables**: the [Synthea OMOP export on AWS Open Data](https://registry.opendata.aws/synthea-omop/)
  (CDM 5.3, CSV compressed with lzo — `brew install lzop`), conformed to the demo's
  5.4 tables, columns and types (ids widened to BIGINT). Tables Synthea does not
  have (`visit_detail`, `death`, …) are present and empty.
- **Vocabulary**: OHDSI's [Eunomia](https://github.com/OHDSI/EunomiaDatasets) Synthea
  vocabulary merged with the demo's. It names most of the concepts Synthea uses, not all.
- **Notes**: the [Asclepius synthetic discharge summaries](https://huggingface.co/datasets/starmpcc/Asclepius-Synthetic-Clinical-Notes)
  (158,000 notes up to 6,000 characters), each on a visit, plus generated edge
  cases: lengths around Oracle's 4,000 bytes and SQL Server's 4,000 / 8,000, up to
  1,000,000 characters; accents, Greek, Cyrillic, Arabic, Hebrew, CJK, emoji; quotes,
  backslashes, comment markers; line breaks (LF, CRLF), tabs; the empty string.

Asclepius is licensed **CC BY-NC-SA 4.0**: fine for local testing, never to be
committed, published or baked into a seed. Synthea and Eunomia carry no such limit.

## In the matrix

Server engines (PostgreSQL, SQL Server, Oracle) keep what they were loaded with
in their Docker volume, with a `_linkr_matrix_load` row naming the dataset: the
next run with the same dataset skips the load. `docker compose … down -v` wipes them.
