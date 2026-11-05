"""Data side of the database matrix (README.md): what the queries need from the
data, a larger copy of it, and the same data loaded into every engine.

    python matrix.py facts    <parquet dir> <facts.json>
    python matrix.py upsample <parquet dir> <out dir> --factor N
    python matrix.py load     <parquet dir> <engine> [--target PATH]

Engines for `load`: duckdb, sqlite (a file at --target), postgresql, mysql,
sqlserver, oracle (the server named by the MATRIX_<ENGINE>_* variables, see
engines.py). Only DuckDB is needed: it reads the Parquet and writes every other
engine. A server already holding the same data (its `_linkr_matrix_load` row)
is left as it is: datamart volumes outlive a run, and loading 100,000 patients
takes far longer than the matrix itself.
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
    # A dataset with no visit_detail (Synthea) takes the stay from visit_occurrence.
    pid, vid = con.execute("""
        SELECT m.person_id, v.visit_occurrence_id
        FROM measurement m JOIN visit_detail v USING (person_id)
        GROUP BY ALL ORDER BY COUNT(*) DESC, 1, 2 LIMIT 1
    """).fetchone() or con.execute("""
        SELECT v.person_id, MIN(v.visit_occurrence_id)
        FROM visit_occurrence v
        WHERE v.person_id = (SELECT person_id FROM measurement GROUP BY 1 ORDER BY COUNT(*) DESC, 1 LIMIT 1)
        GROUP BY 1
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


def _fingerprint(data_dir: Path) -> str:
    """What was loaded: the dataset's folder, its tables and their sizes."""
    files = sorted(data_dir.glob("*.parquet"))
    name = data_dir.parent.name if data_dir.name == "data" else data_dir.name
    return f"{name}:" + ",".join(f"{p.stem}={p.stat().st_size}" for p in files)


def _community(con: duckdb.DuckDBPyConnection, ext: str) -> None:
    try:
        con.execute(f"LOAD {ext}")
    except duckdb.Error:
        con.execute(f"INSTALL {ext} FROM community")
        con.execute(f"LOAD {ext}")


def _mssql_exec(con: duckdb.DuckDBPyConnection, statement: str) -> None:
    con.execute("SELECT mssql_exec('dst', ?)", [statement]).fetchall()


def _sqlserver(con: duckdb.DuckDBPyConnection, data_dir: Path, tables: list[str]) -> None:
    admin = engines.admin_config("sqlserver")
    _community(con, "mssql")

    def secret(database: str) -> None:
        con.execute(f"CREATE OR REPLACE SECRET dst_login (TYPE mssql, HOST '{admin['host']}', PORT {admin['port']}, "
                    f"DATABASE '{database}', USER '{admin['user']}', PASSWORD '{engines.PASSWORD}', USE_ENCRYPT true)")

    secret("master")
    deadline = time.monotonic() + 120
    while True:
        try:
            con.execute("ATTACH '' AS dst (TYPE mssql, SECRET dst_login)")
            break
        except duckdb.Error:
            if time.monotonic() > deadline:
                raise
            time.sleep(3)
    db, schema = admin["database"], admin["load_schema"]
    _mssql_exec(con, f"IF DB_ID('{db}') IS NULL CREATE DATABASE {db}")
    con.execute("DETACH dst")
    secret(db)
    con.execute("ATTACH '' AS dst (TYPE mssql, SECRET dst_login)")
    if _loaded(con, f"SELECT * FROM mssql_scan('dst', 'SELECT fingerprint FROM {schema}._linkr_matrix_load')", data_dir):
        return
    for t in tables:
        _mssql_exec(con, f"DROP TABLE IF EXISTS {schema}.[{t}]")
    _mssql_exec(con, f"IF SCHEMA_ID('{schema}') IS NULL EXEC('CREATE SCHEMA {schema}')")
    _mssql_exec(con, f"DROP TABLE IF EXISTS {schema}._linkr_matrix_load")
    con.execute("SELECT mssql_refresh_cache('dst')").fetchall()
    for t in tables:
        con.execute(f'CREATE TABLE dst.{schema}."{t}" AS SELECT * FROM read_parquet(\'{data_dir / (t + ".parquet")}\')')
    for statement in engines.read_only_grants("sqlserver"):
        _mssql_exec(con, statement)
    _mssql_exec(con, f"CREATE TABLE {schema}._linkr_matrix_load (fingerprint nvarchar(max))")
    _mssql_exec(con, f"INSERT INTO {schema}._linkr_matrix_load VALUES (N'{_fingerprint(data_dir)}')")


# OHDSI's Oracle DDL: ids NUMBER(19), counts INTEGER, measures NUMBER, text
# VARCHAR2 — or CLOB past Oracle's 4000 bytes.
def _oracle_type(duck: str, longest: int | None) -> str:
    if duck == "BIGINT" or duck == "HUGEINT":
        return "NUMBER(19)"
    if duck in ("INTEGER", "SMALLINT", "TINYINT", "BOOLEAN"):
        return "INTEGER"
    if duck in ("DOUBLE", "FLOAT") or duck.startswith("DECIMAL"):
        return "NUMBER"
    if duck == "DATE":
        return "DATE"
    if duck.startswith("TIMESTAMP"):
        return "TIMESTAMP"
    return "CLOB" if (longest or 0) * 4 > 4000 else "VARCHAR2(4000 BYTE)"


# OHDSI's index scheme for an OMOP CDM: every table on its patient, an event
# table on its concept and its visit, the vocabulary on its keys. An Oracle
# warehouse has them, and a correlated EXISTS without them rescans the event
# table once per patient.
_INDEXED_COLUMNS = ("person_id", "visit_occurrence_id", "concept_id", "ancestor_concept_id", "descendant_concept_id",
                    "concept_id_1")
# Part of what was loaded: a load from before the indexes is redone.
_ORACLE_LOAD_VERSION = "indexed"


def _oracle_indexes(cur, owner: str, table: str, columns: list[str]) -> None:
    main_concept = f"{table.split('_')[0]}_concept_id"
    for i, column in enumerate(c for c in columns if c in _INDEXED_COLUMNS or c == main_concept):
        cur.execute(f'CREATE INDEX {owner}."IX_{table.upper()[:24]}_{i}" ON {owner}."{table.upper()}" ({column.upper()})')


def _oracle(con: duckdb.DuckDBPyConnection, data_dir: Path, tables: list[str]) -> None:
    """Through Oracle's own driver: the DuckDB extension for 1.5 issues no DDL,
    and the engine under test should not load its own data."""
    import oracledb

    admin = engines.admin_config("oracle")
    owner, reader = admin["load_schema"], engines.READER.upper()
    dsn = f"{admin['host']}:{admin['port']}/{admin['service']}"
    deadline = time.monotonic() + 300
    while True:
        try:
            ora = oracledb.connect(user=admin["user"], password=engines.PASSWORD, dsn=dsn)
            break
        except oracledb.Error:
            if time.monotonic() > deadline:
                raise
            time.sleep(5)
    cur = ora.cursor()

    def run(statement: str, ignore: bool = False) -> None:
        try:
            cur.execute(statement)
        except oracledb.DatabaseError:
            if not ignore:
                raise

    try:
        cur.execute(f"SELECT fingerprint FROM {owner}.linkr_matrix_load")
        row = cur.fetchone()
        if row and row[0].read() == f"{_ORACLE_LOAD_VERSION}:{_fingerprint(data_dir)}":
            print(f"  already loaded: {data_dir.name}")
            return
    except oracledb.DatabaseError:
        pass
    run(f'CREATE USER {owner} IDENTIFIED BY "{engines.PASSWORD}" QUOTA UNLIMITED ON USERS', ignore=True)
    run(f'CREATE USER {reader} IDENTIFIED BY "{engines.PASSWORD}"', ignore=True)
    run(f"GRANT CREATE SESSION TO {reader}")
    for t in [*tables, "linkr_matrix_load"]:
        run(f'DROP TABLE {owner}."{t.upper()}" PURGE', ignore=True)
    for t in tables:
        src = f"read_parquet('{data_dir / (t + '.parquet')}')"
        cols = con.execute(f"DESCRIBE SELECT * FROM {src}").fetchall()
        longest = {c[0]: con.execute(f'SELECT MAX(strlen("{c[0]}")) FROM {src}').fetchone()[0]
                   for c in cols if c[1] == "VARCHAR"}
        types = [_oracle_type(c[1], longest.get(c[0])) for c in cols]
        run(f'CREATE TABLE {owner}."{t.upper()}" ({", ".join(f"{c[0].upper()} {ty}" for c, ty in zip(cols, types))})')
        cur.setinputsizes(*[oracledb.DB_TYPE_CLOB if ty == "CLOB" else None for ty in types])
        insert = f'INSERT INTO {owner}."{t.upper()}" VALUES ({", ".join(f":{i + 1}" for i in range(len(cols)))})'
        rows = con.execute(f"SELECT * FROM {src}")
        while batch := rows.fetchmany(20_000):
            cur.executemany(insert, batch)
        _oracle_indexes(cur, owner, t, [c[0] for c in cols])
        run(f'GRANT SELECT ON {owner}."{t.upper()}" TO {reader}')
    # The optimizer's statistics, as a DBA's nightly job keeps them.
    cur.callproc("DBMS_STATS.GATHER_SCHEMA_STATS", [owner])
    run(f"CREATE TABLE {owner}.linkr_matrix_load (fingerprint CLOB)")
    cur.execute(f"INSERT INTO {owner}.linkr_matrix_load VALUES (:1)", [f"{_ORACLE_LOAD_VERSION}:{_fingerprint(data_dir)}"])
    ora.commit()
    ora.close()


def _loaded(con: duckdb.DuckDBPyConnection, query: str, data_dir: Path) -> bool:
    try:
        rows = con.execute(query).fetchall()
    except duckdb.Error:
        return False
    same = bool(rows) and rows[0][0] == _fingerprint(data_dir)
    if same:
        print(f"  already loaded: {data_dir.name}")
    return same


def load(data_dir: Path, engine: str, target: Path | None) -> None:
    con = _duckdb()
    tables = tables_of(data_dir)
    if engine in ("sqlserver", "oracle"):
        (_sqlserver if engine == "sqlserver" else _oracle)(con, data_dir, tables)
        con.close()
        print(f"  load {engine}: {len(tables)} tables")
        return
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
            if _loaded(con, f"SELECT fingerprint FROM dst.{schema}._linkr_matrix_load", data_dir):
                con.close()
                return
            _remote_exec(con, engine, f"DROP SCHEMA IF EXISTS {schema} CASCADE")
            _remote_exec(con, engine, f"CREATE SCHEMA {schema}")
            # The load check above read the catalogue before the schema existed.
            con.execute("CALL pg_clear_cache()")
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
        if engine == "postgresql":
            con.execute(f"CREATE TABLE {schema}._linkr_matrix_load AS SELECT ? AS fingerprint", [_fingerprint(data_dir)])
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
