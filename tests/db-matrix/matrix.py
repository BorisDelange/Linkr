"""Data side of the database matrix (README.md): what the queries need from the
data, a larger copy of it, and the same data loaded into every engine.

    python matrix.py facts    <parquet dir> <facts.json>
    python matrix.py upsample <parquet dir> <out dir> --factor N
    python matrix.py load     <parquet dir> <engine> [--target PATH]

Engines for `load`: duckdb, sqlite (a file at --target), postgresql, mysql
(the server named by the MATRIX_<ENGINE>_* variables, see engines.py).
Only DuckDB is needed: it reads the Parquet and writes every other engine.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path

import duckdb

sys.path.insert(0, str(Path(__file__).parent))
import engines  # noqa: E402

# Vocabulary and metadata tables: copied once by the upsampling, never repeated.
SHARED_TABLES = {
    "concept", "concept_ancestor", "concept_class", "concept_relationship", "concept_synonym",
    "domain", "drug_strength", "relationship", "vocabulary", "source_to_concept_map",
    "cdm_source", "metadata", "care_site", "location", "provider", "cohort_definition",
}

# Columns holding an id of a person, a visit, a stay or a row: shifted by the
# copy's offset so every copy is a distinct set of patients.
ID_COLUMN_SUFFIX = "_id"
NOT_SHIFTED_SUFFIXES = ("concept_id", "care_site_id", "provider_id", "location_id", "type_concept_id")

# Copies are spaced this far apart in id space: above the demo's largest id.
ID_STRIDE = 1_000_000_000


def tables_of(data_dir: Path) -> list[str]:
    return sorted(p.stem for p in data_dir.glob("*.parquet"))


def connect_reference(data_dir: Path) -> duckdb.DuckDBPyConnection:
    con = duckdb.connect()
    for t in tables_of(data_dir):
        con.execute(f"CREATE VIEW \"{t}\" AS SELECT * FROM read_parquet('{data_dir / (t + '.parquet')}')")
    return con


# ── facts ────────────────────────────────────────────────────────────────────

EVENT_TABLES = {
    "Condition": ("condition_occurrence", "condition_concept_id"),
    "Drug": ("drug_exposure", "drug_concept_id"),
    "Measurement": ("measurement", "measurement_concept_id"),
    "Observation": ("observation", "observation_concept_id"),
    "Procedure": ("procedure_occurrence", "procedure_concept_id"),
}


def facts(data_dir: Path, out: Path) -> None:
    con = connect_reference(data_dir)
    # The patient with the most measurements that also has a stay: every patient
    # query then has rows to compare.
    pid, vid = con.execute("""
        SELECT m.person_id, v.visit_occurrence_id
        FROM measurement m JOIN visit_detail v USING (person_id)
        GROUP BY ALL ORDER BY COUNT(*) DESC, 1, 2 LIMIT 1
    """).fetchone()
    vdid = con.execute(
        "SELECT MIN(visit_detail_id) FROM visit_detail WHERE visit_occurrence_id = ?", [vid]
    ).fetchone()[0]
    lo, hi = con.execute(
        "SELECT MIN(measurement_datetime), MAX(measurement_datetime) FROM measurement WHERE person_id = ?", [pid]
    ).fetchone()
    concepts = {}
    for label, (table, column) in EVENT_TABLES.items():
        rows = con.execute(f"""
            SELECT {column} FROM {table} WHERE {column} IS NOT NULL AND {column} <> 0
            GROUP BY 1 ORDER BY COUNT(*) DESC, 1 LIMIT 5
        """).fetchall()
        if rows:
            concepts[label] = [int(r[0]) for r in rows]
    mid = con.execute("SELECT MEDIAN(person_id)::BIGINT FROM person").fetchone()[0]
    out.write_text(json.dumps({
        "tables": tables_of(data_dir),
        "patientId": str(pid),
        "visitId": str(vid),
        "visitDetailId": str(vdid) if vdid is not None else None,
        "from": lo.strftime("%Y-%m-%d %H:%M:%S"),
        "to": hi.strftime("%Y-%m-%d %H:%M:%S"),
        "concepts": concepts,
        "midPatientId": int(mid),
    }, indent=1))
    print(f"  facts: patient {pid}, visit {vid}, {sum(map(len, concepts.values()))} concepts → {out}")


# ── upsample ─────────────────────────────────────────────────────────────────

def _shifted_select(con: duckdb.DuckDBPyConnection, path: Path) -> str:
    cols = con.execute(f"DESCRIBE SELECT * FROM read_parquet('{path}')").fetchall()
    exprs = []
    for name, ctype, *_ in cols:
        shift = name.endswith(ID_COLUMN_SUFFIX) and not name.endswith(NOT_SHIFTED_SUFFIXES) and ctype in ("BIGINT", "INTEGER", "HUGEINT")
        if shift:
            exprs.append(f'("{name}"::BIGINT + k * {ID_STRIDE}) AS "{name}"')
        elif ctype.startswith("TIMESTAMP") or ctype == "DATE":
            # Each copy a few days later, so that copies are not identical in time.
            exprs.append(f'("{name}" + to_days((k % 365)::INTEGER))::{ctype} AS "{name}"')
        else:
            exprs.append(f'"{name}"')
    return ", ".join(exprs)


def upsample(data_dir: Path, out_dir: Path, factor: int) -> None:
    """`factor` copies of every patient, with their visits and events, under new
    ids; the vocabulary once. Written with DuckDB, so a factor in the hundreds
    takes seconds per table, not a Python loop over rows."""
    out_dir.mkdir(parents=True, exist_ok=True)
    con = duckdb.connect()
    for t in tables_of(data_dir):
        src, dst = data_dir / f"{t}.parquet", out_dir / f"{t}.parquet"
        if t in SHARED_TABLES or factor == 1:
            con.execute(f"COPY (SELECT * FROM read_parquet('{src}')) TO '{dst}' (FORMAT parquet)")
            continue
        select = _shifted_select(con, src)
        con.execute(f"""
            COPY (SELECT {select} FROM read_parquet('{src}'), range({factor}) r(k))
            TO '{dst}' (FORMAT parquet, ROW_GROUP_SIZE 1000000)
        """)
    persons = con.execute(f"SELECT COUNT(*) FROM read_parquet('{out_dir / 'person.parquet'}')").fetchone()[0]
    rows = con.execute(f"SELECT COUNT(*) FROM read_parquet('{out_dir / 'measurement.parquet'}')").fetchone()[0]
    print(f"  upsample ×{factor}: {persons:,} patients, {rows:,} measurements → {out_dir}")


# ── load ─────────────────────────────────────────────────────────────────────

def _duckdb() -> duckdb.DuckDBPyConnection:
    con = duckdb.connect()
    # Inside the SPE there is no internet: the extensions come from the image's bundle.
    if ext_dir := os.environ.get("MATRIX_DUCKDB_EXT_DIR"):
        con.execute(f"SET extension_directory = '{ext_dir}'")
    return con


def _remote_exec(con: duckdb.DuckDBPyConnection, engine: str, statement: str) -> None:
    fn = "postgres_execute" if engine == "postgresql" else "mysql_execute"
    quoted = statement.replace("'", "''")
    con.execute(f"CALL {fn}('dst', '{quoted}')")


def _attach_when_ready(con: duckdb.DuckDBPyConnection, dsn: str, ext: str, seconds: int = 90) -> None:
    """A datamart container answers on its port before it accepts logins (MySQL
    finishes its first-start setup behind an open port): retry for a while."""
    deadline = time.monotonic() + seconds
    while True:
        try:
            con.execute(f"ATTACH '{dsn}' AS dst (TYPE {ext})")
            return
        except duckdb.IOException:
            if time.monotonic() > deadline:
                raise
            time.sleep(3)


# SQLite's declared type for each DuckDB type, as a SQLite OMOP is usually
# written (OHDSI's DDL, Eunomia): dates and timestamps as ISO text under a DATE /
# TIMESTAMP declaration, which is what DuckDB's scanner reads back as a date.
_SQLITE_TYPES = {"BIGINT": "INTEGER", "INTEGER": "INTEGER", "SMALLINT": "INTEGER", "HUGEINT": "INTEGER",
                 "DOUBLE": "REAL", "FLOAT": "REAL", "DATE": "DATE", "TIMESTAMP": "TIMESTAMP", "BOOLEAN": "INTEGER"}


def _sqlite_type(duck: str) -> str:
    return "REAL" if duck.startswith("DECIMAL") else _SQLITE_TYPES.get(duck, "TEXT")


def _load_sqlite(data_dir: Path, target: Path) -> None:
    """Through sqlite3 itself rather than DuckDB's writer, which declares every
    date and decimal column VARCHAR — a file no real SQLite OMOP looks like."""
    import sqlite3

    con = duckdb.connect()
    out = sqlite3.connect(target)
    for t in tables_of(data_dir):
        src = f"read_parquet('{data_dir / (t + '.parquet')}')"
        cols = con.execute(f"DESCRIBE SELECT * FROM {src}").fetchall()
        out.execute(f'CREATE TABLE "{t}" ({", ".join(f'"{c[0]}" {_sqlite_type(c[1])}' for c in cols)})')
        select = ", ".join(
            f'strftime("{c[0]}", \'%Y-%m-%d\')' if c[1] == "DATE"
            else f'strftime("{c[0]}", \'%Y-%m-%d %H:%M:%S\')' if c[1].startswith("TIMESTAMP")
            else f'"{c[0]}"::DOUBLE' if c[1].startswith("DECIMAL")
            else f'"{c[0]}"'
            for c in cols
        )
        cur = con.execute(f"SELECT {select} FROM {src}")
        marks = ", ".join("?" * len(cols))
        while batch := cur.fetchmany(50_000):
            out.executemany(f'INSERT INTO "{t}" VALUES ({marks})', batch)
    out.commit()
    out.close()


def load(data_dir: Path, engine: str, target: Path | None) -> None:
    con = _duckdb()
    tables = tables_of(data_dir)
    if engine == "sqlite":
        if target is None:
            raise SystemExit("--target is required for sqlite")
        target.unlink(missing_ok=True)
        _load_sqlite(data_dir, target)
        print(f"  load sqlite: {len(tables)} tables")
        return
    if engine == "duckdb":
        if target is None:
            raise SystemExit(f"--target is required for {engine}")
        target.unlink(missing_ok=True)
        con.execute(f"ATTACH '{target}' AS dst")
        schema = "dst.main"
    else:
        admin = engines.admin_config(engine)
        ext = "postgres" if engine == "postgresql" else "mysql"
        con.execute(f"INSTALL {ext}; LOAD {ext}")
        _attach_when_ready(con, admin["dsn"], ext)
        schema = admin["load_schema"]
        if engine == "postgresql":
            _remote_exec(con, engine, f"DROP SCHEMA IF EXISTS {schema} CASCADE")
            _remote_exec(con, engine, f"CREATE SCHEMA {schema}")
            schema = f"dst.{schema}"
        else:
            _remote_exec(con, engine, f"DROP DATABASE IF EXISTS {schema}")
            _remote_exec(con, engine, f"CREATE DATABASE {schema}")
            con.execute("DETACH dst")
            con.execute(f"ATTACH '{admin['dsn']}' AS dst (TYPE mysql)")
            schema = f"dst.{schema}"
    for t in tables:
        con.execute(f'CREATE TABLE {schema}."{t}" AS SELECT * FROM read_parquet(\'{data_dir / (t + ".parquet")}\')')
    if engine != "duckdb":
        for statement in engines.read_only_grants(engine):
            _remote_exec(con, engine, statement)
    con.close()
    print(f"  load {engine}: {len(tables)} tables")


def main() -> None:
    p = argparse.ArgumentParser()
    sub = p.add_subparsers(dest="cmd", required=True)
    f = sub.add_parser("facts"); f.add_argument("data", type=Path); f.add_argument("out", type=Path)
    u = sub.add_parser("upsample"); u.add_argument("data", type=Path); u.add_argument("out", type=Path); u.add_argument("--factor", type=int, required=True)
    lo = sub.add_parser("load"); lo.add_argument("data", type=Path); lo.add_argument("engine"); lo.add_argument("--target", type=Path)
    a = p.parse_args()
    if a.cmd == "facts":
        facts(a.data, a.out)
    elif a.cmd == "upsample":
        upsample(a.data, a.out, a.factor)
    else:
        load(a.data, a.engine, a.target)


if __name__ == "__main__":
    main()
