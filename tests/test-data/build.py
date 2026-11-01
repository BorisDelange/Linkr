"""Build the large OMOP test datasets, once, into the folder `testData.dir` of
config.local.json names. `scripts/test-data.mjs` drives it; see README.md.

    python build.py synthea <downloads dir> <reference data dir> <out dir>
    python build.py subset  <dataset dir> <out dir> --patients N

`synthea` turns the public Synthea 100k OMOP export (CDM 5.3, CSV, no vocabulary,
no notes) into a Parquet folder shaped like the reference (the MIMIC-IV demo,
CDM 5.4): every table of the reference, its columns and types; the vocabulary of
OHDSI's Eunomia Synthea set merged with the reference's; a `note` table holding
the Asclepius synthetic discharge summaries plus generated edge cases (long
texts around the 4000 / 8000 limits of Oracle and SQL Server, every script,
quotes, line breaks).
"""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
import zipfile
from pathlib import Path

import duckdb

SYNTHEA_TABLES = (
    "person", "observation_period", "visit_occurrence", "condition_occurrence", "drug_exposure",
    "procedure_occurrence", "measurement", "observation", "condition_era", "drug_era",
)
VOCABULARY_TABLES = {
    "concept": ("concept_id",),
    "concept_ancestor": ("ancestor_concept_id", "descendant_concept_id"),
    "concept_class": ("concept_class_id",),
    "concept_relationship": ("concept_id_1", "concept_id_2", "relationship_id"),
    "concept_synonym": ("concept_id", "concept_synonym_name", "language_concept_id"),
    "domain": ("domain_id",),
    "drug_strength": ("drug_concept_id", "ingredient_concept_id"),
    "relationship": ("relationship_id",),
    "vocabulary": ("vocabulary_id",),
}

# OMOP concepts of the generated notes: EHR note, discharge summary, English, UTF-8.
NOTE_TYPE, NOTE_CLASS, ENGLISH, UTF8 = 32831, 44814637, 4180186, 32678


def _lit(value: str | Path) -> str:
    return "'" + str(value).replace("'", "''") + "'"


def _columns(con: duckdb.DuckDBPyConnection, parquet: Path) -> list[tuple[str, str]]:
    return [(r[0], r[1]) for r in con.execute(f"DESCRIBE SELECT * FROM read_parquet({_lit(parquet)})").fetchall()]


def _target_type(name: str, ref_type: str) -> str:
    # The demo's ids are INTEGER; 100k patients' measurement ids are not far from
    # the limit, and an upsampled copy passes it.
    return "BIGINT" if name.endswith("_id") and ref_type == "INTEGER" else ref_type


def _conformed(con: duckdb.DuckDBPyConnection, source_cols: set[str], ref_cols: list[tuple[str, str]]) -> str:
    exprs = []
    for name, ref_type in ref_cols:
        t = _target_type(name, ref_type)
        exprs.append(f'TRY_CAST("{name}" AS {t}) AS "{name}"' if name in source_cols else f'NULL::{t} AS "{name}"')
    return ", ".join(exprs)


def _csv_from_lzo(lzo: Path, csv: Path) -> None:
    with csv.open("wb") as out:
        subprocess.run(["lzop", "-dc", str(lzo)], stdout=out, check=True)


def _clinical(con: duckdb.DuckDBPyConnection, downloads: Path, ref: Path, out: Path) -> None:
    for t in SYNTHEA_TABLES:
        dst = out / f"{t}.parquet"
        if dst.exists():
            continue
        csv = downloads / "synthea100k" / f"{t}.csv"
        print(f"  {t}: decompressing", flush=True)
        _csv_from_lzo(downloads / "synthea100k" / f"{t}.csv.lzo", csv)
        try:
            src = f"read_csv({_lit(csv)}, header = true, all_varchar = true)"
            cols = {r[0] for r in con.execute(f"DESCRIBE SELECT * FROM {src}").fetchall()}
            select = _conformed(con, cols, _columns(con, ref / f"{t}.parquet"))
            tmp = dst.with_suffix(".tmp")
            con.execute(f"COPY (SELECT {select} FROM {src}) TO {_lit(tmp)} (FORMAT parquet, ROW_GROUP_SIZE 1000000)")
            tmp.rename(dst)
        finally:
            csv.unlink(missing_ok=True)
        n = con.execute(f"SELECT COUNT(*) FROM read_parquet({_lit(dst)})").fetchone()[0]
        print(f"  {t}: {n:,} rows", flush=True)


def _eunomia(downloads: Path) -> Path:
    folder = downloads / "eunomia" / "Synthea27NjParquet"
    if not (folder / "concept.parquet").exists():
        with zipfile.ZipFile(downloads / "eunomia" / "Synthea27NjParquet_5.4.zip") as z:
            z.extractall(downloads / "eunomia")
    return folder


def _vocabulary(con: duckdb.DuckDBPyConnection, downloads: Path, ref: Path, out: Path) -> None:
    eunomia = _eunomia(downloads)
    for t, keys in VOCABULARY_TABLES.items():
        ref_cols = _columns(con, ref / f"{t}.parquet")
        names = ", ".join(f'"{c}"' for c, _ in ref_cols)
        parts = [f"SELECT {names}, 0 AS _rank FROM read_parquet({_lit(ref / f'{t}.parquet')})"]
        if (eunomia / f"{t}.parquet").exists():
            cols = {c for c, _ in _columns(con, eunomia / f"{t}.parquet")}
            parts.append(f"SELECT {_conformed(con, cols, ref_cols)}, 1 FROM read_parquet({_lit(eunomia / f'{t}.parquet')})")
        key = ", ".join(f'"{k}"' for k in keys)
        con.execute(f"""
            COPY (SELECT {names} FROM ({" UNION ALL ".join(parts)})
                  QUALIFY ROW_NUMBER() OVER (PARTITION BY {key} ORDER BY _rank) = 1)
            TO {_lit(out / f"{t}.parquet")} (FORMAT parquet)
        """)


def _edge_case_texts() -> list[tuple[str, str]]:
    scripts = "Patient âgé de 72 ans — œdème, Übelkeit, ñandú, Ελληνικά, русский, العربية, עברית, 中文病历, 日本語, 한국어, हिन्दी"
    emoji = "Douleur 🙂😷🫀 évaluée à 7/10 ✓ ← → ∑ ≥ ≤ ± µg/kg/min"
    quoting = "Il a dit : \"pas d'allergie\" ; O'Brien; back\\slash; 50% _under_ ; -- not a comment ; /* nor this */ ; $$dollar$$"
    breaks = "Ligne 1\nLigne 2\r\nLigne 3\tavec tabulation\n\n  indentée  "
    out = [
        ("Edge: scripts", scripts), ("Edge: emoji", emoji), ("Edge: quoting", quoting),
        ("Edge: line breaks", breaks), ("Edge: empty string", ""), ("Edge: spaces only", "   "),
    ]
    # Lengths at the edges of VARCHAR2(4000) / NVARCHAR(4000) / VARCHAR(8000) and
    # of a 32 KB block, in one-byte and multibyte characters.
    for n in (3999, 4000, 4001, 7999, 8000, 8001, 32767, 32768, 100_000, 1_000_000):
        out.append((f"Edge: {n} ascii chars", ("Lorem ipsum dolor sit amet. " * (n // 28 + 1))[:n]))
        out.append((f"Edge: {n} multibyte chars", ("é" * n)))
    out.append(("Edge: 4000 chars ending in a 4-byte emoji", "a" * 3999 + "🫀"))
    return out


def _notes(con: duckdb.DuckDBPyConnection, downloads: Path, ref: Path, out: Path) -> None:
    edge = _edge_case_texts()
    con.execute("CREATE OR REPLACE TEMP TABLE edge(title VARCHAR, body VARCHAR)")
    con.executemany("INSERT INTO edge VALUES (?, ?)", edge)
    visits = f"read_parquet({_lit(out / 'visit_occurrence.parquet')})"
    # A constant, so the join below is an equi-join, not a nested loop over every visit.
    visit_count = con.execute(f"SELECT COUNT(*) FROM {visits}").fetchone()[0]
    select = ", ".join(f'"{c}"::{_target_type(c, t)} AS "{c}"' for c, t in _columns(con, ref / "note.parquet"))
    # Each note on a visit, spread evenly over every visit, so a patient's notes
    # sit among their other events.
    con.execute(f"""
        COPY (
          WITH v AS (SELECT visit_occurrence_id, person_id, visit_start_date, visit_start_datetime,
                            ROW_NUMBER() OVER (ORDER BY visit_occurrence_id) - 1 AS k
                     FROM {visits}),
          texts AS (
            SELECT 'Discharge summary' AS title, note AS body, 0 AS edge
            FROM read_parquet({_lit(downloads / 'asclepius' / 'asclepius.parquet')})
            UNION ALL SELECT title, body, 1 FROM edge),
          numbered AS (SELECT *, ROW_NUMBER() OVER (ORDER BY edge, title, md5(body)) AS note_id FROM texts)
          SELECT {select} FROM (
            SELECT t.note_id, v.person_id, v.visit_start_date AS note_date,
                   COALESCE(v.visit_start_datetime, v.visit_start_date::TIMESTAMP) AS note_datetime,
                   {NOTE_TYPE} AS note_type_concept_id, {NOTE_CLASS} AS note_class_concept_id,
                   t.title AS note_title, t.body AS note_text,
                   {UTF8} AS encoding_concept_id, {ENGLISH} AS language_concept_id,
                   NULL AS provider_id, v.visit_occurrence_id, NULL AS visit_detail_id,
                   t.title AS note_source_value, NULL AS note_event_id, NULL AS note_event_field_concept_id
            FROM numbered t JOIN v ON v.k = (t.note_id * 7919) % {visit_count})
          ORDER BY note_id
        ) TO {_lit(out / 'note.parquet')} (FORMAT parquet)
    """)
    n = con.execute(f"SELECT COUNT(*), SUM(length(note_text)) FROM read_parquet({_lit(out / 'note.parquet')})").fetchone()
    print(f"  note: {n[0]:,} notes, {n[1]:,} characters", flush=True)


def _remaining(con: duckdb.DuckDBPyConnection, ref: Path, out: Path) -> None:
    """Every other table of the reference, empty with its columns, except a
    cdm_source row saying what this is."""
    for parquet in sorted(ref.glob("*.parquet")):
        dst = out / parquet.name
        if dst.exists():
            continue
        cols = _columns(con, parquet)
        select = ", ".join(f'NULL::{_target_type(c, t)} AS "{c}"' for c, t in cols)
        con.execute(f"COPY (SELECT {select} WHERE false) TO {_lit(dst)} (FORMAT parquet)")
    con.execute(f"""
        COPY (SELECT * REPLACE ('Synthea 100k (synthetic)' AS cdm_source_name, 'synthea-100k' AS cdm_source_abbreviation)
              FROM read_parquet({_lit(ref / 'cdm_source.parquet')}) LIMIT 1)
        TO {_lit(out / 'cdm_source.parquet')} (FORMAT parquet)
    """)


def synthea(downloads: Path, ref: Path, out: Path) -> None:
    out.mkdir(parents=True, exist_ok=True)
    con = duckdb.connect()
    # A one-off build on a developer's machine: leave it half its cores.
    con.execute(f"SET threads = {max(1, (os.cpu_count() or 2) // 2)}")
    _clinical(con, downloads, ref, out)
    _vocabulary(con, downloads, ref, out)
    _notes(con, downloads, ref, out)
    _remaining(con, ref, out)
    print(f"  synthea-100k → {out}", flush=True)


def subset(src: Path, out: Path, patients: int) -> None:
    """The first `patients` patients of `src` (by id) with everything that is
    theirs; the tables of no patient (vocabulary, care sites) whole. For an engine
    that cannot hold the whole dataset (Oracle Free stores 12 GB)."""
    out.mkdir(parents=True, exist_ok=True)
    con = duckdb.connect()
    con.execute(f"SET threads = {max(1, (os.cpu_count() or 2) // 2)}")
    con.execute(f"""CREATE TEMP TABLE kept AS SELECT person_id FROM read_parquet({_lit(src / 'person.parquet')})
                    ORDER BY person_id LIMIT {int(patients)}""")
    for parquet in sorted(src.glob("*.parquet")):
        names = {c for c, _ in _columns(con, parquet)}
        rows = f"read_parquet({_lit(parquet)})"
        where = " WHERE person_id IN (SELECT person_id FROM kept)" if "person_id" in names else ""
        con.execute(f"COPY (SELECT * FROM {rows}{where}) TO {_lit(out / parquet.name)} (FORMAT parquet)")
    n = con.execute(f"SELECT COUNT(*) FROM read_parquet({_lit(out / 'measurement.parquet')})").fetchone()[0]
    print(f"  subset: {patients:,} patients, {n:,} measurements → {out}", flush=True)


def main() -> int:
    p = argparse.ArgumentParser()
    sub = p.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("synthea")
    s.add_argument("downloads", type=Path)
    s.add_argument("reference", type=Path)
    s.add_argument("out", type=Path)
    b = sub.add_parser("subset")
    b.add_argument("source", type=Path)
    b.add_argument("out", type=Path)
    b.add_argument("--patients", type=int, required=True)
    a = p.parse_args()
    if a.cmd == "subset":
        subset(a.source, a.out, a.patients)
    else:
        synthea(a.downloads, a.reference, a.out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
