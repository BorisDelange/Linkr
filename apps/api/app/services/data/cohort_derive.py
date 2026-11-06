"""Derive a database from a cohort: every table of the source, filtered on the
cohort, copied into a new DuckDB file or into a new SQL schema of a writable
database — self-contained, so the result is queryable without its parent.

Two phases on two connections, and the order is the security boundary:

1. The cohort's membership query — SQL the CLIENT built, from the criteria —
   runs with the source attached READ_ONLY and nothing else, and only its
   `(id, patient_id)` rows come back.
2. The copy runs with the target attached writable, and only statements this
   module generates: table names from the source catalog, id columns from the
   schema mapping, all validated as identifiers. What it reads can still be a
   view or a macro stored in the source's file, so once every database is attached
   this connection is cut off the filesystem too (`_lock_down_copy`).

So the client's SQL can never write anywhere — which matters most when the
target is a production Postgres.

Which rows a table keeps follows the scope — the cohort's level, or a wider one
(every stay of the cohort's patients) — and the id the table carries that fits
it best (see `classify`). A table carrying none is copied whole, or skipped when
the caller asks, only when it is known to hold no patient row: a dictionary the
mapping reads as concepts, or a reference table of OMOP or MIMIC
(`proven_personless`). Never copied, whatever the caller asks: one a patient
relation reads without a patient id column (`unresolved_tables`) and one carrying
an id no kept set lists. One nothing says anything about (`unproven`: OMOP's
note_nlp, cost or fact_relationship hold patient rows behind ids of another kind)
is not copied either, unless the caller names that very table
(`Minimization.copy_unproven`): it then comes whole, rows of patients outside the
cohort included, with no id replaced.

On top of that, what the caller minimises (`Minimization`): the tables copied,
the variables an event table keeps, the precision of the birth dates. And the
ids, when pseudonymised (`Pseudonyms`): every patient, stay and unit-stay id is
replaced, in every table, by a pseudonym drawn for this derivation (the links
between stays too, see `pseudonym_level`; the source system's own patient and
stay numbers are emptied, free text is copied as it is) — keyed
HMAC-SHA-256 or random, as the CNIL health-data-warehouse referential asks
(SEC-PSE-1, SEC-ESP-2) — and the correspondence, if kept, goes to another
database than the derived one.
"""

from __future__ import annotations

import contextlib
import hmac
import os
import re
import secrets
import threading
from collections.abc import Callable
from dataclasses import dataclass, field, replace
from pathlib import Path

import duckdb

from app.services.data import derive_writers
from app.services.data.db_connect import (
    _alias_role,
    _attach_role,
    _ext_dir,
    _external_search_path,
    _forbid_file_access,
    _group_parquet,
    _lock_down_user_sql,
    _reject_forbidden_statements,
    _reject_stored_passthrough,
    _require_ident,
    _role_schema_path,
    _scope,
    _split_statements,
    _sql_path,
    _strip_leading_noise,
    is_system_schema,
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
    visit_detail_patient_id: str | None = None
    # Where to find each patient's stays, for a scope wider than the cohort.
    visit_table: tuple[str | None, str] | None = None
    visit_id: str | None = None
    visit_patient_id: str | None = None


def _v2_relations(mapping: dict) -> list[tuple[str, dict]]:
    """(relation key, spec) for every relation of a format-v2 mapping."""
    out = [(k, mapping[k]) for k in ("patient", "visit", "visitDetail", "note") if isinstance(mapping.get(k), dict)]
    for lst in ("concepts", "events", "drugs"):
        out += [(lst, r) for r in mapping.get(lst) or [] if isinstance(r, dict)]
    return out


def _field_column(spec: dict, field_name: str) -> str | None:
    """The source column a v2 field reads directly from the relation's grain
    table (`alias.column` on the `from` alias); None for an expression, a
    constant, a joined table or a relation written in SQL."""
    if not isinstance(spec, dict) or (spec.get("customSql") or "").strip():
        return None
    ref = (spec.get("fields") or {}).get(field_name)
    grain = spec.get("from") or {}
    if not isinstance(ref, str) or "." not in ref or not grain.get("alias"):
        return None
    alias, column = ref.split(".", 1)
    return column if alias.lower() == str(grain["alias"]).lower() else None


def effective_mapping(mapping: dict, overrides: dict | None) -> dict:
    """The mapping with a database's relation overrides applied — what the app
    queries (effectiveMapping, lib/schema-classes/overrides.ts). Parameters do
    not change column names, so only relations matter here."""
    relations = (overrides or {}).get("relations") or {}
    removed = (overrides or {}).get("removed") or []
    if mapping.get("formatVersion") != 2 or not (relations or removed):
        return mapping
    out = dict(mapping)
    for key in removed:
        head, _, name = key.partition(".")
        if head in ("patient", "visit", "visitDetail", "note"):
            out.pop(head, None)
        elif head in ("concepts", "events", "drugs"):
            id_field = "key" if head == "concepts" else "label"
            out[head] = [r for r in (out.get(head) or []) if not (isinstance(r, dict) and r.get(id_field) == name)]
    for key, spec in relations.items():
        head, _, name = key.partition(".")
        if head in ("patient", "visit", "visitDetail", "note"):
            out[head] = spec
            continue
        if head not in ("concepts", "events", "drugs"):
            continue
        id_field = "key" if head == "concepts" else "label"
        items = list(out.get(head) or [])
        idx = next((i for i, r in enumerate(items) if isinstance(r, dict) and r.get(id_field) == name), None)
        if idx is None:
            items.append(spec)
        else:
            items[idx] = spec
        out[head] = items
    return out


def id_columns(mapping: dict) -> IdColumns:
    if mapping.get("formatVersion") == 2:
        return _id_columns_v2(mapping)
    # A mapping stored before format v2: the app converts it when it loads the
    # database and writes it back, but the server reads whatever is stored.
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
        cols.visit_detail_patient_id = vd.get("patientIdColumn") or None
    if vt.get("table") and vt.get("idColumn") and vt.get("patientIdColumn"):
        cols.visit_table = (vt.get("schema"), vt["table"])
        cols.visit_id = vt["idColumn"]
        cols.visit_patient_id = vt["patientIdColumn"]
    return cols


def _id_columns_v2(mapping: dict) -> IdColumns:
    cols = IdColumns()
    for key, spec in _v2_relations(mapping):
        if key == "concepts":
            continue
        if (c := _field_column(spec, "patient_id")):
            cols.patient.add(c.lower())
    for key in ("visit", "visitDetail"):
        if (c := _field_column(mapping.get(key) or {}, "visit_id")):
            cols.visit.add(c.lower())
    vd = mapping.get("visitDetail") or {}
    vd_id = _field_column(vd, "visit_detail_id")
    vd_visit = _field_column(vd, "visit_id")
    if vd_id:
        cols.visit_detail.add(vd_id.lower())
    grain = vd.get("from") or {}
    if vd_id and vd_visit and grain.get("table"):
        cols.visit_detail_table = (grain.get("schema"), grain["table"])
        cols.visit_detail_id = vd_id
        cols.visit_detail_visit_id = vd_visit
        cols.visit_detail_patient_id = _field_column(vd, "patient_id")
    visit = mapping.get("visit") or {}
    v_id, v_patient = _field_column(visit, "visit_id"), _field_column(visit, "patient_id")
    grain = visit.get("from") or {}
    if v_id and v_patient and grain.get("table"):
        cols.visit_table = (grain.get("schema"), grain["table"])
        cols.visit_id = v_id
        cols.visit_patient_id = v_patient
    return cols


def _relation_name(key: str, spec: dict) -> str:
    if key in ("events", "drugs"):
        return f"{key}.{spec.get('label') or '?'}"
    return key


def _names_table(sql: str, table: str) -> bool:
    # Over-matching (a column of the same name, the same table in another
    # schema) only makes a table unresolved, which skips it: the safe side.
    return re.search(rf'(?<![\w"])"?{re.escape(table)}"?(?![\w"])', sql, re.IGNORECASE) is not None


def unresolved_tables(mapping: dict, tables: list[tuple[str, str, list[str]]]) -> dict[tuple[str, str], str]:
    """`(schema, table) → relation` for the source tables a patient-bearing v2
    relation reads without naming its patient id as a column of the table (an
    expression, or custom SQL). Such a table can carry no id `classify` finds,
    and copying it whole would leak every patient into the derived database."""
    if mapping.get("formatVersion") != 2:
        return {}
    # A dictionary a custom relation joins is personless by design: still copied.
    dictionaries = _dictionary_tables(mapping)
    out: dict[tuple[str, str], str] = {}
    for key, spec in _v2_relations(mapping):
        if key == "concepts" or _field_column(spec, "patient_id"):
            continue
        name = _relation_name(key, spec)
        sql = (spec.get("customSql") or "").strip()
        grain = spec.get("from") or {}
        for schema, table, _cols in tables:
            if sql:
                hit = table.lower() not in dictionaries and _names_table(sql, table)
            else:
                hit = str(grain.get("table") or "").lower() == table.lower() and (
                    not grain.get("schema") or str(grain["schema"]).lower() == schema.lower()
                )
            if hit:
                out.setdefault((schema, table), name)
    return out


def mapping_schemas(mapping: dict) -> set[str]:
    """The schemas a mapping names its tables in, besides the default one."""
    if mapping.get("formatVersion") == 2:
        tables = []
        for _key, spec in _v2_relations(mapping):
            tables += [spec.get("from") or {}, *(spec.get("joins") or [])]
        return {t["schema"] for t in tables if isinstance(t, dict) and t.get("schema")}
    refs = [mapping.get(k) or {} for k in ("patientTable", "visitTable", "visitDetailTable", "noteTable", "deathTable")]
    refs += list((mapping.get("eventTables") or {}).values())
    return {r["schema"] for r in refs if isinstance(r, dict) and r.get("schema")}


def check_scope(level: str, scope: str | None) -> str:
    """The scope a derivation keeps, the cohort's level by default: that level or
    a wider one (the cohort's patients with all their stays), never a finer one,
    which the cohort gives no way to choose."""
    if level not in LEVELS:
        raise ValueError(f"cannot derive at level {level!r}")
    scope = scope or level
    if scope not in LEVELS:
        raise ValueError(f"unknown scope {scope!r}")
    if LEVELS.index(scope) > LEVELS.index(level):
        raise ValueError("the scope can only be the cohort's level or a wider one")
    return scope


def keyed_levels(ids: IdColumns, level: str, scope: str) -> set[str]:
    """The levels whose kept ids can be listed (`_keep_<level>`), so that a table
    carrying an id of that level can be filtered on it."""
    out = {"patient"}
    if scope == "patient":
        visit = ids.visit_table is not None
    elif level == "visit":
        visit = True
    else:
        visit = ids.visit_detail_table is not None
    if visit:
        out.add("visit")
    unit_stays = ids.visit_detail_table is not None and (visit or (scope == "patient" and ids.visit_detail_patient_id))
    if scope == "visit_detail" or unit_stays:
        out.add("visit_detail")
    return out


# Which id a table is filtered on, best first: the scope's own, then a finer one
# (the unit stays of the kept stays), then a coarser one (the kept patients).
_ORDER = {
    "patient": ("patient", "visit", "visit_detail"),
    "visit": ("visit", "visit_detail", "patient"),
    "visit_detail": ("visit_detail", "visit", "patient"),
}


def _id_sets(ids: IdColumns) -> dict[str, set[str]]:
    return {"patient": ids.patient, "visit": ids.visit, "visit_detail": ids.visit_detail}


def id_level(column: str, ids: IdColumns) -> str | None:
    """The level a column identifies (patient, stay, unit stay), if any."""
    name = column.lower()
    return next((lvl for lvl in ("visit_detail", "visit", "patient") if name in _id_sets(ids)[lvl]), None)


# Ids of a level a table carries under another name than the one the mapping
# gives it (OMOP's links between stays and between unit stays), and the
# suffixes OMOP builds every such name with.
_LINKED_IDS = {
    "preceding_visit_occurrence_id": "visit",
    "preceding_visit_detail_id": "visit_detail",
    "visit_detail_parent_id": "visit_detail",
    "parent_visit_detail_id": "visit_detail",
}
_ID_SUFFIXES = (("visit_detail_id", "visit_detail"), ("visit_occurrence_id", "visit"), ("person_id", "patient"))

# The source system's own patient, stay and unit-stay numbers, which a
# pseudonymised build empties. The other `*_source_value` columns hold the
# source's codes (a lab code, a drug code), not who the row is about.
IDENTIFYING_SOURCE_VALUES = frozenset({"person_source_value", "visit_source_value", "visit_detail_source_value"})


def pseudonym_level(column: str, ids: IdColumns) -> str | None:
    """The level whose pseudonym replaces `column` in a pseudonymised build: the
    mapping's id columns, and every other column naming an id of a level."""
    if (lvl := id_level(column, ids)):
        return lvl
    name = column.lower()
    if name in _LINKED_IDS:
        return _LINKED_IDS[name]
    return next((lvl for suffix, lvl in _ID_SUFFIXES if name.endswith(suffix)), None)


def classify(columns: list[str], scope: str, ids: IdColumns, keyed: set[str]) -> tuple[str, str] | None:
    """`(filter kind, column)` for a table, or None when it carries no id `keyed`
    lists. The kind is the column's level — `parent_visit` for a stay id at the
    unit-stay scope, which keeps the stays of the cohort's unit stays."""
    by_lower = {c.lower(): c for c in columns}
    for lvl in _ORDER[scope]:
        if lvl not in keyed:
            continue
        column = next((by_lower[n] for n in sorted(_id_sets(ids)[lvl]) if n in by_lower), None)
        if column:
            return ("parent_visit" if lvl == "visit" and scope == "visit_detail" else lvl, column)
    return None


def _carried_id(columns: list[str], ids: IdColumns) -> str | None:
    """An id column the table carries, whatever its level, under the mapping's
    name or one naming an id of a level."""
    return next((c for c in columns if pseudonym_level(c, ids)), None)


# Tables whose rows describe the terminology, the health system or the dataset:
# OMOP's and MIMIC's own, by the definition of these models. Not OMOP's `location`,
# which `person.location_id` points at: a row there can be one patient's address.
_REFERENCE_TABLES = frozenset({
    "concept", "vocabulary", "domain", "concept_class", "concept_relationship", "relationship", "concept_synonym",
    "concept_ancestor", "concept_recommended", "concept_cpt4", "concept_numeric", "drug_strength",
    "source_to_concept_map", "attribute_definition", "cohort_definition", "cdm_source", "metadata",
    "care_site", "provider",
    "d_items", "d_labitems", "d_hcpcs", "d_cpt", "d_icd_diagnoses", "d_icd_procedures", "caregiver", "caregivers",
})


def _dictionary_tables(mapping: dict) -> set[str]:
    """The tables the mapping reads as concept dictionaries, lower-cased."""
    if mapping.get("formatVersion") != 2:
        return {str(t.get("table") or "").lower() for t in mapping.get("conceptTables") or [] if isinstance(t, dict)}
    return {
        str(t.get("table") or "").lower()
        for key, spec in _v2_relations(mapping) if key == "concepts"
        for t in [spec.get("from") or {}, *(spec.get("joins") or [])] if isinstance(t, dict)
    }


def proven_personless(table: str, mapping: dict) -> bool:
    """Whether a table carrying no id is known to hold no patient row. No id column
    found proves nothing: a table can reach its patients through another table."""
    return table.lower() in _REFERENCE_TABLES or table.lower() in _dictionary_tables(mapping)


# What `unfilterable` says of a table carrying no id it could be filtered on.
NO_KNOWN_ID = "no id Linkr can filter on"


def _refused(table: str, columns: list[str], ids: IdColumns, mapping: dict) -> str | None:
    """Why a table with no filter is never copied, or None when it may be whole."""
    return _carried_id(columns, ids) or (None if proven_personless(table, mapping) else NO_KNOWN_ID)


_FILTER_LEVEL = {"patient": "patient", "visit": "visit", "parent_visit": "visit", "visit_detail": "visit_detail"}


@dataclass
class SourceSpec:
    """How to attach the source: a role spec as `db_connect._attach_role` takes it."""

    spec: dict

    @property
    def default_schema(self) -> str | None:
        # An external database's is the configured one, if any (every other schema
        # is read too); a file or a Parquet folder puts its tables in `main`.
        if self.spec.get("kind") == "external":
            return _scope(self.spec["config"])
        return "main"

    def is_default(self, schema: str) -> bool:
        # DuckDB matches names regardless of case, and so may the configured one.
        return self.default_schema is not None and schema.lower() == self.default_schema.lower()


def _connect() -> duckdb.DuckDBPyConnection:
    con = duckdb.connect()
    con.execute(f"SET extension_directory = '{_sql_path(_ext_dir())}'")
    return con


def _source_tables(con: duckdb.DuckDBPyConnection, source: SourceSpec) -> list[tuple[str, str, list[str]]]:
    """`(schema, table, columns)` for every table of the attached source."""
    rows = con.execute(
        "SELECT table_schema, table_name, column_name FROM information_schema.columns "
        "WHERE table_catalog = 'source' ORDER BY table_schema, table_name, ordinal_position",
    ).fetchall()
    out: dict[tuple[str, str], list[str]] = {}
    for schema, table, column in rows:
        if is_system_schema(str(schema)):
            continue
        out.setdefault((str(schema), str(table)), []).append(str(column))
    return [(s, t, cols) for (s, t), cols in out.items()]


def _source_search_path(con: duckdb.DuckDBPyConnection, source: SourceSpec) -> str:
    if source.spec.get("kind") == "external":
        return _external_search_path(con, source.spec["config"], catalog="source", head=())
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


def _source_files(source: SourceSpec) -> list[str]:
    """The files a Parquet source's views read, which must stay readable once the
    connection is cut off the filesystem."""
    if source.spec.get("kind") != "parquet":
        return []
    groups = _group_parquet(source.spec.get("files") or [], source.spec.get("known") or [])
    return [p for paths in groups.values() for p in paths]


def _lock_down_copy(con: duckdb.DuckDBPyConnection, source: SourceSpec, writers: list, stored_in: list[str]) -> None:
    """Cut the copy's connection off the server, every database it needs attached:
    what it reads may be a view or a macro stored in the source's file, which runs
    with this connection's rights. Stays readable: the source's own files, and the
    scratch folder a writer sends rows through."""
    _reject_stored_passthrough(con, stored_in)
    scratch = [str(w.tmp) for w in writers if w is not None and getattr(w, "tmp", None)]
    if scratch:
        paths = ", ".join("'" + _sql_path(p) + "'" for p in scratch)
        con.execute(f"SET allowed_directories=[{paths}]")
    _forbid_file_access(con, _source_files(source))
    _lock_down_user_sql(con)


def compute_members(source: SourceSpec, membership_sql: str):
    """Phase 1: the cohort's `(id, patient_id)` rows, as an Arrow table."""
    stmt = _check_membership_sql(membership_sql)
    con = _connect()
    try:
        _attach_role(con, "source", source.spec)
        # Set before the lock: the client SQL must not be able to move it.
        con.execute(f"SET search_path='{_source_search_path(con, source)}'")
        _forbid_file_access(con, _source_files(source))
        _lock_down_user_sql(con)
        table = con.execute(stmt).fetch_arrow_table()
    finally:
        con.close()
    names = set(table.column_names)
    if not {"id", "patient_id"} <= names:
        raise ValueError("the cohort query must return `id` and `patient_id`")
    return table.select(["id", "patient_id"])


def plan(source: SourceSpec, mapping: dict, level: str, scope: str | None = None) -> list[dict]:
    """What a derivation would do with each table — for the dialog, before anything runs.

    `columns` lets the client pick a table's variable and date columns;
    `pseudonymized`, the id columns a pseudonymised build replaces."""
    scope = check_scope(level, scope)
    ids = id_columns(mapping)
    keyed = keyed_levels(ids, level, scope)
    con = _connect()
    try:
        _attach_role(con, "source", source.spec)
        _forbid_file_access(con, _source_files(source))
        _lock_down_user_sql(con)
        tables = _source_tables(con, source)
    finally:
        con.close()
    unresolved = unresolved_tables(mapping, tables)
    out = []
    for schema, table, columns in tables:
        how = classify(columns, scope, ids, keyed)
        refused = None if how or (schema, table) in unresolved else _refused(table, columns, ids, mapping)
        out.append({
            "schema": None if source.is_default(schema) else schema,
            "table": table,
            "filter": how[0] if how else None,
            "column": how[1] if how else None,
            "unresolved": None if how else unresolved.get((schema, table)),
            "unfilterable": refused,
            "unproven": refused == NO_KNOWN_ID,
            "columns": columns,
            "pseudonymized": [c for c in columns if pseudonym_level(c, ids)],
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


def _destination(target: TargetSpec) -> derive_writers.Destination:
    return derive_writers.Destination(target.kind, target.path, target.config, target.password)


def _open_writer(con: duckdb.DuckDBPyConnection, target: TargetSpec, alias: str) -> derive_writers.Writer:
    return derive_writers.writer_for(con, _destination(target), alias)


def drop_schema(target: TargetSpec) -> None:
    """Drop the SQL schema a derivation created (`target.schema`), with its
    tables — an Oracle one is emptied: a schema there is a user, not Linkr's."""
    _require_ident(target.schema, "schema name")
    con = _connect()
    writer = None
    try:
        writer = _open_writer(con, target, "target")
        writer.drop_schema(target.schema)
    finally:
        if writer is not None:
            writer.close()
        con.close()


class DeriveCancelled(Exception):
    """The derivation was stopped by its user; what it wrote is removed."""


@dataclass
class DeriveControl:
    """How a running derivation reports progress and is stopped, from another
    thread: `on_table(done, total, table)` after each table, and `cancel()`,
    which interrupts the statement in flight rather than waiting for it — one
    `CREATE TABLE … AS SELECT` over a large table can take minutes."""

    on_table: Callable[[int, int, str], None] | None = None
    cancelled: threading.Event = field(default_factory=threading.Event)
    _con: duckdb.DuckDBPyConnection | None = None

    def cancel(self) -> None:
        self.cancelled.set()
        con = self._con
        if con is not None:
            try:
                con.interrupt()
            except Exception:  # noqa: BLE001 — already closed: nothing to stop
                pass

    def check(self) -> None:
        if self.cancelled.is_set():
            raise DeriveCancelled("the derivation was cancelled")


def _same_file(a: str | None, b: str | None) -> bool:
    return bool(a and b) and os.path.normcase(os.path.realpath(a)) == os.path.normcase(os.path.realpath(b))


def _wal(path: Path) -> Path:
    return path.with_name(path.name + ".wal")


def _remove_db_file(path: Path) -> None:
    path.unlink(missing_ok=True)
    _wal(path).unlink(missing_ok=True)


def _swap_in(tmp: Path, dest: Path) -> None:
    # The old file's log must go first: DuckDB would replay it onto the new file.
    _wal(dest).unlink(missing_ok=True)
    os.replace(tmp, dest)
    if _wal(tmp).exists():
        os.replace(_wal(tmp), _wal(dest))


TableKey = tuple[str | None, str]


@dataclass
class Minimization:
    """What the caller keeps besides the scope. Tables are keyed as the plan names
    them: `(schema or None for the default one, table)`, lower-cased.

    `tables`: the ones copied (None: every one, `copy_personless` deciding those
    with no patient). `copy_unproven`: the tables nothing shows to be personless the
    caller explicitly asks for, the only way to get one: `tables` does not reach
    them. `variables`: an event table's concept columns and the
    concepts it keeps (none: the table is created empty, so every relation of
    the mapping still binds). `dates`: column → `year`, `month` (truncated) or
    `null` (emptied) — a birth date kept to the precision asked; a date kept to
    the month also empties the table's day of birth (`day_of_birth`,
    `birth_day`), one kept to the year its month as well, as OMOP stores them
    beside `birth_datetime`.

    A key naming the source's default schema is the same as one naming none."""

    scope: str | None = None
    tables: set[TableKey] | None = None
    copy_unproven: set[TableKey] = field(default_factory=set)
    variables: dict[TableKey, tuple[list[str], list[int]]] = field(default_factory=dict)
    dates: dict[TableKey, dict[str, str]] = field(default_factory=dict)


DATE_PRECISIONS = ("year", "month", "null")

_BIRTH_PARTS = {"day": ("day_of_birth", "birth_day"), "month": ("month_of_birth", "birth_month")}


def _with_birth_parts(dates: dict[str, str], columns: list[str]) -> dict[str, str]:
    """`dates` with the day (and month) of birth a coarser precision drops."""
    precisions = set(dates.values())
    dropped = (["day"] if precisions & {"month", "year"} else []) + (["month"] if "year" in precisions else [])
    asked = {c.lower() for c in dates}
    out = dict(dates)
    for part in dropped:
        for c in columns:
            if c.lower() in _BIRTH_PARTS[part] and c.lower() not in asked:
                out[c] = "null"
    return out


def _normalized(source: SourceSpec, minimization: Minimization) -> Minimization:
    def key(k: TableKey) -> TableKey:
        schema, table = k
        return (None if schema is None or source.is_default(schema) else schema.lower(), table.lower())

    return Minimization(
        scope=minimization.scope,
        tables=None if minimization.tables is None else {key(k) for k in minimization.tables},
        copy_unproven={key(k) for k in minimization.copy_unproven},
        variables={key(k): v for k, v in minimization.variables.items()},
        dates={key(k): v for k, v in minimization.dates.items()},
    )


@dataclass
class Pseudonyms:
    """How the ids are replaced. `hmac`: HMAC-SHA-256 of the id under `key`, so a
    rebuild with the same key gives the same pseudonyms; `random`: drawn by a
    CSPRNG, recoverable only through the correspondence table. `correspondence`
    (a writable target, its `schema` set) receives `(derivation_id, derivation,
    kind, original_id, pseudonym, built_at)` rows in `correspondence_table`."""

    method: str
    key: bytes | None = None
    correspondence: TargetSpec | None = None
    correspondence_table: str = "linkr_pseudonyms"
    derivation_id: str = ""
    derivation: str = ""


def pseudonyms_for(method: str, key: bytes | None, level: str, ids: list[str]) -> list[int]:
    """A pseudonym per id: a positive 63-bit integer, distinct within the level."""
    if method == "hmac":
        if not key:
            raise ValueError("an HMAC pseudonymisation needs a key")
        out = [int.from_bytes(hmac.digest(key, f"{level}:{i}".encode(), "sha256")[:8], "big") >> 1 for i in ids]
        if len(set(out)) != len(out):
            # About one chance in 10^7 for ten million ids: a new key draws again.
            raise ValueError("two ids drew the same pseudonym; derive again with a new key")
        return out
    if method == "random":
        seen: set[int] = set()
        out = []
        for _ in ids:
            value = secrets.randbits(63)
            while value in seen:
                value = secrets.randbits(63)
            seen.add(value)
            out.append(value)
        return out
    raise ValueError(f"unknown pseudonymisation method {method!r}")


# A type as information_schema spells it, safe to CAST to.
_TYPE = re.compile(r"^[A-Za-z][A-Za-z0-9_ (),]*$")


def _safe_type(value: str) -> str:
    if not _TYPE.fullmatch(value or ""):
        raise ValueError(f"cannot rewrite a column of type {value!r}")
    return value


def _is_text(sql_type: str) -> bool:
    return sql_type.upper().startswith(("VARCHAR", "CHAR", "TEXT", "STRING"))


def _column_types(con: duckdb.DuckDBPyConnection, schema: str, table: str) -> dict[str, str]:
    rows = con.execute(
        "SELECT column_name, data_type FROM information_schema.columns "
        "WHERE table_catalog = 'source' AND table_schema = ? AND table_name = ?",
        [schema, table],
    ).fetchall()
    return {str(c): str(t) for c, t in rows}


def _create_keep_tables(
    con: duckdb.DuckDBPyConnection, source: SourceSpec, ids: IdColumns, level: str, scope: str, keyed: set[str],
) -> None:
    """`_keep_<level>(id)`: the patients, stays and unit stays the scope keeps."""

    def ref(where: tuple[str | None, str]) -> str:
        schema, table = where
        return f'"source"."{_require_ident(schema or source.default_schema, "schema name")}"."{_require_ident(table, "table name")}"'

    def col(name: str | None) -> str:
        return f'"{_require_ident(name, "column name")}"'

    con.execute("CREATE TEMP TABLE _keep_patient AS SELECT DISTINCT patient_id AS id FROM _members")
    if "visit" in keyed:
        if scope == "patient":
            sql = (f"SELECT DISTINCT {col(ids.visit_id)} AS id FROM {ref(ids.visit_table)} "
                   f"WHERE {col(ids.visit_patient_id)} IN (SELECT id FROM _keep_patient)")
        elif level == "visit":
            sql = "SELECT DISTINCT id FROM _members"
        else:
            sql = (f"SELECT DISTINCT {col(ids.visit_detail_visit_id)} AS id FROM {ref(ids.visit_detail_table)} "
                   f"WHERE {col(ids.visit_detail_id)} IN (SELECT id FROM _members)")
        con.execute(f"CREATE TEMP TABLE _keep_visit AS {sql}")
    if "visit_detail" in keyed:
        if scope == "visit_detail":
            sql = "SELECT DISTINCT id FROM _members"
        elif "visit" in keyed:
            sql = (f"SELECT DISTINCT {col(ids.visit_detail_id)} AS id FROM {ref(ids.visit_detail_table)} "
                   f"WHERE {col(ids.visit_detail_visit_id)} IN (SELECT id FROM _keep_visit)")
        else:
            sql = (f"SELECT DISTINCT {col(ids.visit_detail_id)} AS id FROM {ref(ids.visit_detail_table)} "
                   f"WHERE {col(ids.visit_detail_patient_id)} IN (SELECT id FROM _keep_patient)")
        con.execute(f"CREATE TEMP TABLE _keep_visit_detail AS {sql}")


def _create_pseudonym_maps(con: duckdb.DuckDBPyConnection, pseudo: Pseudonyms, keyed: set[str]) -> dict[str, int]:
    """`_pseudo_<level>(id, pseudo)` for every kept id, as text: a column's type
    may differ from one table to the next. Returns how many ids each level has."""
    import pyarrow as pa

    counts: dict[str, int] = {}
    for lvl in sorted(keyed):
        ids = [r[0] for r in con.execute(f"SELECT DISTINCT CAST(id AS VARCHAR) FROM _keep_{lvl} WHERE id IS NOT NULL").fetchall()]
        values = pseudonyms_for(pseudo.method, pseudo.key, lvl, ids)
        con.register("_pseudo_arrow", pa.table({"id": pa.array(ids, pa.string()), "pseudo": pa.array(values, pa.int64())}))
        con.execute(f"CREATE TEMP TABLE _pseudo_{lvl} AS SELECT * FROM _pseudo_arrow")
        con.unregister("_pseudo_arrow")
        counts[lvl] = len(ids)
    return counts


_CORRESPONDENCE_COLUMNS = [
    ("derivation_id", "VARCHAR"), ("derivation", "VARCHAR"), ("kind", "VARCHAR"),
    ("original_id", "VARCHAR"), ("pseudonym", "BIGINT"), ("built_at", "TIMESTAMP"),
]


def _write_correspondence(writer: derive_writers.Writer, pseudo: Pseudonyms, levels: list[str]) -> None:
    schema = _require_ident(pseudo.correspondence.schema, "schema name")
    table = _require_ident(pseudo.correspondence_table, "table name")
    writer.create_schema(schema, exist_ok=True)
    writer.ensure_table(schema, table, _CORRESPONDENCE_COLUMNS)
    # A rebuild replaces its own rows, and only those.
    writer.delete_where(schema, table, "derivation_id", pseudo.derivation_id)
    for lvl in levels:
        writer.insert_select(
            schema, table,
            f"SELECT CAST(? AS VARCHAR) AS derivation_id, CAST(? AS VARCHAR) AS derivation, CAST(? AS VARCHAR) AS kind, "
            f"id AS original_id, pseudo AS pseudonym, CAST(now() AS TIMESTAMP) AS built_at FROM _pseudo_{lvl}",
            [pseudo.derivation_id, pseudo.derivation, lvl],
        )


def _in_list(values: list[int], text: bool) -> str:
    return ", ".join(f"'{int(v)}'" if text else str(int(v)) for v in values)


def _copy_select(
    con: duckdb.DuckDBPyConnection,
    schema: str,
    table: str,
    columns: list[str],
    how: tuple[str, str] | None,
    key: TableKey,
    ids: IdColumns,
    minimization: Minimization,
    pseudo_levels: set[str] | None,
) -> str:
    """The SELECT a table is copied with: its kept rows, its ids pseudonymised,
    its dates truncated. Every name is checked against the table's columns."""
    by_lower = {c.lower(): c for c in columns}
    types = _column_types(con, schema, table) if (pseudo_levels is not None or key in minimization.dates) else {}

    def column(name: str) -> str:
        real = by_lower.get(str(name).lower())
        if real is None:
            raise ValueError(f"{table} has no column {name!r}")
        return _require_ident(real, "column name")

    replace: dict[str, str] = {}
    joins: list[str] = []
    if pseudo_levels is not None:
        for c in columns:
            if c.lower() in IDENTIFYING_SOURCE_VALUES:
                name = _require_ident(c, "column name")
                replace[name] = f"CAST(NULL AS {_safe_type(types.get(c, 'VARCHAR'))})"
                continue
            lvl = pseudonym_level(c, ids)
            if lvl is None:
                continue
            name = _require_ident(c, "column name")
            sql_type = _safe_type(types.get(c, "BIGINT"))
            if lvl in pseudo_levels:
                alias = f"p{len(joins)}"
                joins.append(f'LEFT JOIN _pseudo_{lvl} {alias} ON {alias}.id = CAST(s."{name}" AS VARCHAR)')
                replace[name] = f"CAST({alias}.pseudo AS VARCHAR)" if _is_text(sql_type) else f"{alias}.pseudo"
            else:
                # An internal number with no pseudonym drawn: never copied as it is.
                replace[name] = f"CAST(NULL AS {sql_type})"
    for name, precision in _with_birth_parts(minimization.dates.get(key) or {}, columns).items():
        if precision not in DATE_PRECISIONS:
            raise ValueError(f"unknown date precision {precision!r}")
        real = column(name)
        sql_type = _safe_type(types.get(real, "DATE"))
        replace[real] = (
            f"CAST(NULL AS {sql_type})" if precision == "null"
            else f'CAST(date_trunc(\'{precision}\', s."{real}") AS {sql_type})'
        )

    where: list[str] = []
    if how:
        where.append(f's."{_require_ident(how[1], "column name")}" IN (SELECT id FROM _keep_{_FILTER_LEVEL[how[0]]})')
    if key in minimization.variables:
        concept_columns, concepts = minimization.variables[key]
        if not concepts or not concept_columns:
            where.append("FALSE")
        else:
            if not types:
                types = _column_types(con, schema, table)
            where.append("(" + " OR ".join(
                f's."{column(c)}" IN ({_in_list(concepts, _is_text(types.get(column(c), "")))})' for c in concept_columns
            ) + ")")
    replaced = ", ".join(f'{e} AS "{c}"' for c, e in replace.items())
    select = f"s.* REPLACE ({replaced})" if replace else "s.*"
    src = f'"source"."{_require_ident(schema, "schema name")}"."{_require_ident(table, "table name")}"'
    return f"SELECT {select} FROM {src} s{''.join(' ' + j for j in joins)}" + (f" WHERE {' AND '.join(where)}" if where else "")


def derive(
    source: SourceSpec,
    target: TargetSpec,
    members,
    mapping: dict,
    level: str,
    copy_personless: bool,
    control: DeriveControl | None = None,
    minimization: Minimization | None = None,
    pseudonyms: Pseudonyms | None = None,
) -> list[dict]:
    """Phase 2: copy every table, filtered, into the target. Returns what was written."""
    control = control or DeriveControl()
    minimization = _normalized(source, minimization or Minimization())
    scope = check_scope(level, minimization.scope)
    ids = id_columns(mapping)
    keyed = keyed_levels(ids, level, scope)
    if target.schema is not None:
        _require_ident(target.schema, "schema name")
    same_file = source.spec.get("kind") == "file" and target.kind == "file" and _same_file(source.spec.get("path"), target.path)
    fresh = target.kind == "file" and target.fresh_file
    if fresh and same_file:
        raise ValueError("a database cannot be derived into a new copy of its own file")
    # A new database is written beside the old one and swapped in only once
    # complete: a failed or cancelled rebuild keeps the previous file. A schema
    # is not: its rebuild drops the previous build first (see replace_schema).
    writing = replace(target, path=f"{target.path}.tmp") if fresh else target
    if fresh:
        _remove_db_file(Path(writing.path))

    con = _connect()
    control._con = con
    schema_created = False
    complete = False
    writer: derive_writers.Writer | None = None
    corr_writer = None
    try:
        writer = _open_writer(con, writing, "target")
        if same_file:
            # DuckDB will not open one file twice: read the source through the
            # writable attach, via read-only views named `source` (the ETL's own
            # answer to a pipeline writing into the database it reads).
            _alias_role(con, "source", "target")
        else:
            _attach_role(con, "source", source.spec)
        if pseudonyms is not None and pseudonyms.correspondence is not None:
            # Before anything is written: an unreachable one fails the build early.
            corr_writer = _open_writer(con, pseudonyms.correspondence, "corr")
        # An external database's own views are its server's, not run by DuckDB.
        stored_in = [
            *(["source"] if source.spec.get("kind") != "external" else []),
            *(["target"] if target.kind == "file" else []),
        ]
        _lock_down_copy(con, source, [writer, corr_writer], stored_in)

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
            tables = [t for t in tables if source.is_default(t[0])]
        schemas = {s for s, _, _ in tables if not source.is_default(s)}

        con.register("_members_arrow", members)
        con.execute("CREATE TEMP TABLE _members AS SELECT * FROM _members_arrow")
        con.unregister("_members_arrow")
        _create_keep_tables(con, source, ids, level, scope, keyed)
        pseudo_levels = None
        if pseudonyms is not None:
            _create_pseudonym_maps(con, pseudonyms, keyed)
            pseudo_levels = keyed

        if target.schema is not None:
            if target.replace_schema:
                # The engines Linkr writes into cannot all rename a schema (SQL
                # Server, Oracle's), so no build-aside-and-swap: the previous
                # build goes now, as the rebuild dialog warns.
                writer.drop_schema(target.schema)
            writer.create_schema(target.schema)
            schema_created = True
        else:
            for s in sorted(schemas):
                writer.create_schema(_require_ident(s, "schema name"), exist_ok=True)

        unresolved = unresolved_tables(mapping, tables)
        written: list[dict] = []
        for done, (schema, table, columns) in enumerate(tables):
            control.check()
            if control.on_table:
                control.on_table(done, len(tables), table)
            key = (None if source.is_default(schema) else schema.lower(), table.lower())
            how = classify(columns, scope, ids, keyed)
            skipped = {"schema": schema, "table": table, "filter": None, "rows": None, "skipped": True}
            if how is None and (schema, table) in unresolved:
                written.append({**skipped, "unresolved": unresolved[(schema, table)]})
                continue
            why = None if how else _refused(table, columns, ids, mapping)
            opted_in = why == NO_KNOWN_ID and key in minimization.copy_unproven
            if why and not opted_in:
                written.append({**skipped, "unfilterable": why})
                continue
            chosen = key in minimization.tables if minimization.tables is not None else (how is not None or copy_personless)
            if not (chosen or opted_in):
                written.append({**skipped, "filter": how[0] if how else None})
                continue
            dest_schema = target.schema or ("main" if source.is_default(schema) else schema)
            select = _copy_select(con, schema, table, columns, how, key, ids, minimization, pseudo_levels)
            rows = writer.create_table_as(dest_schema, _require_ident(table, "table name"), select)
            written.append({
                "schema": None if dest_schema == "main" else dest_schema,
                "table": table,
                "filter": how[0] if how else None,
                "rows": int(rows),
                "skipped": False,
                **({"unproven": True} if opted_in else {}),
            })
        control.check()
        if corr_writer is not None:
            _write_correspondence(corr_writer, pseudonyms, sorted(keyed))
            corr_writer.checkpoint()
        writer.checkpoint()
        complete = True
    except Exception as exc:
        # A half-written copy is worse than none: it would read as a database
        # (or a schema) that exists and holds some of the cohort.
        if schema_created:
            with contextlib.suppress(Exception):  # the original error is the one to report
                writer.drop_schema(target.schema)
        if control.cancelled.is_set() and not isinstance(exc, DeriveCancelled):
            # The interrupt surfaces as a DuckDB error; say what really happened.
            raise DeriveCancelled("the derivation was cancelled") from exc
        raise
    finally:
        control._con = None
        _close(writer, corr_writer)
        con.close()
        # Once closed: the half-written file is attached until then.
        if fresh and not complete:
            _remove_db_file(Path(writing.path))
    if fresh:
        _swap_in(Path(writing.path), Path(target.path))
    return written


def _close(*writers) -> None:
    for w in writers:
        if w is not None:
            with contextlib.suppress(Exception):
                w.close()
