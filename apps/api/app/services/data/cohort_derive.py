"""Derive a database from a cohort: every table of the source, filtered on the
cohort, copied into a new DuckDB file or into a new SQL schema of a writable
database — self-contained, so the result is queryable without its parent.

Two phases on two connections, and the order is the security boundary:

1. The cohort's membership query — SQL the CLIENT built, from the criteria —
   runs with the source attached READ_ONLY and nothing else, and only its
   `(id, patient_id)` rows come back.
2. The copy runs with the target attached writable, and only statements this
   module generates: table names from the source catalog, id columns from the
   schema mapping, all validated as identifiers.

So the client's SQL can never write anywhere — which matters most when the
target is a production Postgres.

Which rows a table keeps follows the cohort's level and the finest id the table
carries (see `classify`). A table carrying none (vocabulary, care_site…) is copied
whole, or skipped when the caller asks.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

import duckdb

from app.services.data.db_connect import (
    _alias_role,
    _attach_role,
    _engine_spec,
    _dsn,
    _ext_dir,
    _lock_down_user_sql,
    _reject_forbidden_statements,
    _require_ident,
    _role_schema_path,
    _scope,
    _split_statements,
    _sql_path,
    _strip_leading_noise,
)

LEVELS = ("patient", "visit", "visit_detail")


@dataclass
class IdColumns:
    """Column names that identify a patient, a stay, a unit stay — read from the
    schema mapping, so MIMIC (`subject_id`, `hadm_id`, `stay_id`) and eHOP are
    filtered the same way OMOP (`person_id`, …) is."""

    patient: set[str] = field(default_factory=set)
    visit: set[str] = field(default_factory=set)
    visit_detail: set[str] = field(default_factory=set)
    # Where to find each unit stay's parent stay, for the visit_detail level.
    visit_detail_table: tuple[str | None, str] | None = None
    visit_detail_id: str | None = None
    visit_detail_visit_id: str | None = None


def id_columns(mapping: dict) -> IdColumns:
    cols = IdColumns()
    pt = mapping.get("patientTable") or {}
    vt = mapping.get("visitTable") or {}
    vd = mapping.get("visitDetailTable") or {}
    for name in (pt.get("idColumn"), vt.get("patientIdColumn"), vd.get("patientIdColumn")):
        if name:
            cols.patient.add(name.lower())
    for et in (mapping.get("eventTables") or {}).values():
        if et.get("patientIdColumn"):
            cols.patient.add(et["patientIdColumn"].lower())
    for name in (vt.get("idColumn"), vd.get("visitIdColumn")):
        if name:
            cols.visit.add(name.lower())
    if vd.get("idColumn"):
        cols.visit_detail.add(vd["idColumn"].lower())
    if vd.get("table") and vd.get("idColumn") and vd.get("visitIdColumn"):
        cols.visit_detail_table = (vd.get("schema"), vd["table"])
        cols.visit_detail_id = vd["idColumn"]
        cols.visit_detail_visit_id = vd["visitIdColumn"]
    return cols


def mapping_schemas(mapping: dict) -> set[str]:
    """The schemas a mapping names its tables in, besides the default one."""
    refs = [mapping.get(k) or {} for k in ("patientTable", "visitTable", "visitDetailTable", "noteTable", "deathTable")]
    refs += list((mapping.get("eventTables") or {}).values())
    return {r["schema"] for r in refs if isinstance(r, dict) and r.get("schema")}


def classify(columns: list[str], level: str, ids: IdColumns) -> tuple[str, str] | None:
    """`(filter kind, column)` for a table, or None when it carries no id.

    The finest id at or above the cohort's level wins: at visit_detail level a
    table with a unit-stay id keeps the cohort's unit stays; one with only a stay
    id keeps the parent stays; one with only a patient id keeps the patients."""
    by_lower = {c.lower(): c for c in columns}

    def first(names: set[str]) -> str | None:
        return next((by_lower[n] for n in sorted(names) if n in by_lower), None)

    if level == "visit_detail":
        if (c := first(ids.visit_detail)):
            return ("visit_detail", c)
        if (c := first(ids.visit)):
            return ("parent_visit", c)
    if level == "visit" and (c := first(ids.visit)):
        return ("visit", c)
    if (c := first(ids.patient)):
        return ("patient", c)
    return None


# Where each filter reads its keys from, in the phase-2 connection.
_KEY_SOURCE = {
    "patient": 'SELECT patient_id FROM _members',
    "visit": 'SELECT id FROM _members',
    "visit_detail": 'SELECT id FROM _members',
    "parent_visit": 'SELECT id FROM _parent_visits',
}


@dataclass
class SourceSpec:
    """How to attach the source: a role spec as `db_connect._attach_role` takes it."""

    spec: dict

    @property
    def default_schema(self) -> str:
        # An external database exposes one schema (the configured scope); a file
        # or a Parquet folder puts its tables in `main`.
        if self.spec.get("kind") == "external":
            return _scope(self.spec["config"])
        return "main"


def _connect() -> duckdb.DuckDBPyConnection:
    con = duckdb.connect()
    con.execute(f"SET extension_directory = '{_sql_path(_ext_dir())}'")
    return con


def _source_tables(con: duckdb.DuckDBPyConnection, source: SourceSpec) -> list[tuple[str, str, list[str]]]:
    """`(schema, table, columns)` for every table of the attached source."""
    if source.spec.get("kind") == "external":
        where, params = "table_catalog = 'source' AND table_schema = ?", [source.default_schema]
    else:
        where, params = "table_catalog = 'source' AND table_schema NOT IN ('information_schema', 'pg_catalog')", []
    rows = con.execute(
        f"SELECT table_schema, table_name, column_name FROM information_schema.columns WHERE {where} "
        "ORDER BY table_schema, table_name, ordinal_position",
        params,
    ).fetchall()
    out: dict[tuple[str, str], list[str]] = {}
    for schema, table, column in rows:
        out.setdefault((str(schema), str(table)), []).append(str(column))
    return [(s, t, cols) for (s, t), cols in out.items()]


def _source_search_path(con: duckdb.DuckDBPyConnection, source: SourceSpec) -> str:
    if source.spec.get("kind") == "external":
        return f"source.{source.default_schema}"
    return ",".join(["source", *_role_schema_path(con)])


def _check_membership_sql(sql: str) -> str:
    """One SELECT, nothing else: it is client SQL, and runs before any write."""
    statements = _split_statements(sql)
    if len(statements) != 1:
        raise ValueError("the cohort query must be a single statement")
    stmt = statements[0]
    head = _strip_leading_noise(stmt).lstrip().split(None, 1)[0].upper() if stmt.strip() else ""
    if head not in ("SELECT", "WITH"):
        raise ValueError("the cohort query must be a SELECT")
    _reject_forbidden_statements(stmt)
    return stmt


def compute_members(source: SourceSpec, membership_sql: str):
    """Phase 1: the cohort's `(id, patient_id)` rows, as an Arrow table."""
    stmt = _check_membership_sql(membership_sql)
    con = _connect()
    try:
        _attach_role(con, "source", source.spec)
        # Set before the lock: the client SQL must not be able to move it.
        con.execute(f"SET search_path='{_source_search_path(con, source)}'")
        _lock_down_user_sql(con)
        table = con.execute(stmt).fetch_arrow_table()
    finally:
        con.close()
    names = set(table.column_names)
    if not {"id", "patient_id"} <= names:
        raise ValueError("the cohort query must return `id` and `patient_id`")
    return table.select(["id", "patient_id"])


def plan(source: SourceSpec, mapping: dict, level: str) -> list[dict]:
    """What a derivation would do with each table — for the dialog, before anything runs."""
    if level not in LEVELS:
        raise ValueError(f"cannot derive at level {level!r}")
    ids = id_columns(mapping)
    con = _connect()
    try:
        _attach_role(con, "source", source.spec)
        tables = _source_tables(con, source)
    finally:
        con.close()
    out = []
    for schema, table, columns in tables:
        how = classify(columns, level, ids)
        out.append({
            "schema": None if schema == source.default_schema else schema,
            "table": table,
            "filter": how[0] if how else None,
            "column": how[1] if how else None,
        })
    return out


@dataclass
class TargetSpec:
    """Where the copy lands. `file` is a DuckDB file Linkr owns; `external` a
    database reached over the network. `schema` None = the tables keep the
    source's own schemas (a new database); a name = everything goes into that
    new SQL schema."""

    kind: str  # "file" | "external"
    path: str | None = None
    config: dict | None = None
    password: str | None = None
    schema: str | None = None
    fresh_file: bool = False
    replace_schema: bool = False


def _attach_target(con: duckdb.DuckDBPyConnection, target: TargetSpec) -> None:
    if target.kind == "file":
        con.execute(f"ATTACH '{_sql_path(target.path)}' AS target")
        return
    if target.kind == "external":
        spec = _engine_spec(target.config)
        con.execute(f"INSTALL {spec['extension']}")
        con.execute(f"LOAD {spec['extension']}")
        dsn = _dsn(target.config, target.password).replace("'", "''")
        # Writable, deliberately: this is the one place Linkr writes into a
        # database it did not create, and only statements generated here run.
        con.execute(f"ATTACH '{dsn}' AS target (TYPE {spec['type']})")
        return
    raise ValueError(f"unknown target kind {target.kind!r}")


def _same_file(a: str | None, b: str | None) -> bool:
    return bool(a and b) and os.path.normcase(os.path.realpath(a)) == os.path.normcase(os.path.realpath(b))


def derive(
    source: SourceSpec,
    target: TargetSpec,
    members,
    mapping: dict,
    level: str,
    copy_personless: bool,
) -> list[dict]:
    """Phase 2: copy every table, filtered, into the target. Returns what was written."""
    if level not in LEVELS:
        raise ValueError(f"cannot derive at level {level!r}")
    ids = id_columns(mapping)
    if target.schema is not None:
        _require_ident(target.schema, "schema name")
    if target.kind == "file" and target.fresh_file:
        Path(target.path).unlink(missing_ok=True)

    con = _connect()
    try:
        same_file = source.spec.get("kind") == "file" and target.kind == "file" and _same_file(source.spec.get("path"), target.path)
        _attach_target(con, target)
        if same_file:
            # DuckDB will not open one file twice: read the source through the
            # writable attach, via read-only views named `source` (the ETL's own
            # answer to a pipeline writing into the database it reads).
            _alias_role(con, "source", "target")
        else:
            _attach_role(con, "source", source.spec)

        tables = _source_tables(con, source)
        if target.schema is not None:
            # One schema cannot hold two tables of one name, so a source published
            # over several (MIMIC-IV's hosp/icu) only derives into a new database.
            # Asked of the mapping, not the catalog: in a file that already holds
            # earlier derivations, their schemas are not the source's.
            declared = mapping_schemas(mapping)
            if declared:
                raise ValueError(
                    "this source spreads its tables over several schemas "
                    f"({', '.join(sorted(declared))}); derive it into a new database instead"
                )
            tables = [t for t in tables if t[0] == source.default_schema]
        schemas = {s for s, _, _ in tables if s != source.default_schema}

        con.register("_members_arrow", members)
        con.execute("CREATE TEMP TABLE _members AS SELECT * FROM _members_arrow")
        con.unregister("_members_arrow")
        if level == "visit_detail" and ids.visit_detail_table:
            vd_schema, vd_table = ids.visit_detail_table
            ref = f'"source"."{_require_ident(vd_schema or source.default_schema, "schema name")}"."{_require_ident(vd_table, "table name")}"'
            con.execute(
                f'CREATE TEMP TABLE _parent_visits AS SELECT DISTINCT vd."{_require_ident(ids.visit_detail_visit_id, "column name")}" AS id '
                f'FROM {ref} vd WHERE vd."{_require_ident(ids.visit_detail_id, "column name")}" IN (SELECT id FROM _members)'
            )

        if target.schema is not None:
            if target.replace_schema:
                con.execute(f'DROP SCHEMA IF EXISTS target."{target.schema}" CASCADE')
            con.execute(f'CREATE SCHEMA target."{target.schema}"')
        else:
            for s in sorted(schemas):
                con.execute(f'CREATE SCHEMA IF NOT EXISTS target."{_require_ident(s, "schema name")}"')

        written: list[dict] = []
        for schema, table, columns in tables:
            how = classify(columns, level, ids)
            if how is None and not copy_personless:
                written.append({"schema": schema, "table": table, "filter": None, "rows": None, "skipped": True})
                continue
            if how and how[0] == "parent_visit" and not ids.visit_detail_table:
                how = None
            src = f'"source"."{_require_ident(schema, "schema name")}"."{_require_ident(table, "table name")}"'
            dest_schema = target.schema or ("main" if schema == source.default_schema else schema)
            dest = f'target."{dest_schema}"."{_require_ident(table, "table name")}"'
            where = ""
            if how:
                where = f' WHERE "{_require_ident(how[1], "column name")}" IN ({_KEY_SOURCE[how[0]]})'
            con.execute(f"CREATE TABLE {dest} AS SELECT * FROM {src}{where}")
            rows = con.execute(f"SELECT COUNT(*) FROM {dest}").fetchone()[0]
            written.append({
                "schema": None if dest_schema == "main" else dest_schema,
                "table": table,
                "filter": how[0] if how else None,
                "rows": int(rows),
                "skipped": False,
            })
        if target.kind == "file":
            con.execute("CHECKPOINT target")
        return written
    except Exception:
        # A half-written new file is worse than none: it would read as a database
        # that exists and holds some of the cohort.
        con.close()
        if target.kind == "file" and target.fresh_file:
            Path(target.path).unlink(missing_ok=True)
        raise
    finally:
        con.close()
