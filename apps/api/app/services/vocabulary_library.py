"""A workspace's OHDSI vocabulary library (server side).

One library per workspace, held once per vocabulary: `concept/vocab-<key>.parquet`,
`concept_relationship/vocab-<key>.parquet`, … under
``data_dir/vocabularies/<workspace>/``. It is exposed as a plain Parquet-folder
data source (``connectionConfig.vocabularyLibrary``), so every reader — mapping
editor, concept detail, ETL ``vocab.`` role, IDE client recipes — sees the union
views ``concept``, ``concept_ancestor``, … without knowing about vocabularies.

An import reads an ATHENA export (CSV or Parquet, uploaded, on a server folder,
or an older per-project vocabulary database) and writes the partitions of the
vocabularies the user picked, replacing those already there. A row belongs to
the vocabulary of the concept that owns it: ``concept`` and ``vocabulary`` by
their own ``vocabulary_id``, ``concept_relationship`` by ``concept_id_1``,
``concept_ancestor`` by the ancestor, ``concept_synonym`` by its concept,
``drug_strength`` by the drug. ``domain`` / ``concept_class`` / ``relationship``
are shared: the union of every import, the latest import winning.

Twin of apps/web/src/lib/vocabulary-library/ (the front-only library, which
reaches the same views without rewriting rows).
"""

import asyncio
import re
import shutil
import tempfile
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path

import duckdb

from app.config import settings
from app.services.data.db_connect import _ext_dir

# Column types of the OMOP CDM v5.4 vocabulary tables. Every import is cast to
# them, so partitions written from a CSV (all text) and from a Parquet (typed)
# union cleanly.
TABLE_COLUMNS: dict[str, list[tuple[str, str]]] = {
    "concept": [
        ("concept_id", "BIGINT"), ("concept_name", "VARCHAR"), ("domain_id", "VARCHAR"),
        ("vocabulary_id", "VARCHAR"), ("concept_class_id", "VARCHAR"),
        ("standard_concept", "VARCHAR"), ("concept_code", "VARCHAR"),
        ("valid_start_date", "DATE"), ("valid_end_date", "DATE"), ("invalid_reason", "VARCHAR"),
    ],
    "concept_relationship": [
        ("concept_id_1", "BIGINT"), ("concept_id_2", "BIGINT"), ("relationship_id", "VARCHAR"),
        ("valid_start_date", "DATE"), ("valid_end_date", "DATE"), ("invalid_reason", "VARCHAR"),
    ],
    "concept_ancestor": [
        ("ancestor_concept_id", "BIGINT"), ("descendant_concept_id", "BIGINT"),
        ("min_levels_of_separation", "INTEGER"), ("max_levels_of_separation", "INTEGER"),
    ],
    "concept_synonym": [
        ("concept_id", "BIGINT"), ("concept_synonym_name", "VARCHAR"), ("language_concept_id", "BIGINT"),
    ],
    "drug_strength": [
        ("drug_concept_id", "BIGINT"), ("ingredient_concept_id", "BIGINT"),
        ("amount_value", "DOUBLE"), ("amount_unit_concept_id", "BIGINT"),
        ("numerator_value", "DOUBLE"), ("numerator_unit_concept_id", "BIGINT"),
        ("denominator_value", "DOUBLE"), ("denominator_unit_concept_id", "BIGINT"),
        ("box_size", "INTEGER"), ("valid_start_date", "DATE"), ("valid_end_date", "DATE"),
        ("invalid_reason", "VARCHAR"),
    ],
    "vocabulary": [
        ("vocabulary_id", "VARCHAR"), ("vocabulary_name", "VARCHAR"),
        ("vocabulary_reference", "VARCHAR"), ("vocabulary_version", "VARCHAR"),
        ("vocabulary_concept_id", "BIGINT"),
    ],
    "domain": [("domain_id", "VARCHAR"), ("domain_name", "VARCHAR"), ("domain_concept_id", "BIGINT")],
    "concept_class": [
        ("concept_class_id", "VARCHAR"), ("concept_class_name", "VARCHAR"),
        ("concept_class_concept_id", "BIGINT"),
    ],
    "relationship": [
        ("relationship_id", "VARCHAR"), ("relationship_name", "VARCHAR"),
        ("is_hierarchical", "VARCHAR"), ("defines_ancestry", "VARCHAR"),
        ("reverse_relationship_id", "VARCHAR"), ("relationship_concept_id", "BIGINT"),
    ],
}
LIBRARY_TABLES = tuple(TABLE_COLUMNS)

# Per-vocabulary tables → the column naming the owning concept (None: the table
# carries `vocabulary_id` itself).
OWNED_BY: dict[str, str | None] = {
    "concept": None,
    "vocabulary": None,
    "concept_relationship": "concept_id_1",
    "concept_ancestor": "ancestor_concept_id",
    "concept_synonym": "concept_id",
    "drug_strength": "drug_concept_id",
}
# Shared tables → their key, for "latest import wins".
SHARED_KEYS = {"domain": "domain_id", "concept_class": "concept_class_id", "relationship": "relationship_id"}

SHARED_FILE = "shared.parquet"
# The row ATHENA writes for the export itself: its version is the release.
RELEASE_VOCABULARY_ID = "None"

_DATA_SUFFIXES = (".csv", ".tsv", ".txt", ".parquet", ".pq")


def library_dir(workspace_id: str) -> Path:
    return settings.data_path / "vocabularies" / workspace_id


def file_key(vocabulary_id: str) -> str:
    """File-name-safe key of a vocabulary (`Nebraska Lexicon` → `Nebraska_Lexicon`).
    Prefixed so a vocabulary named like a table (`Domain`, `Relationship`, which
    OMOP ships) is never read as one."""
    return "vocab-" + re.sub(r"[^A-Za-z0-9_-]", "_", vocabulary_id)


def partition_path(workspace_id: str, table: str, vocabulary_id: str) -> Path:
    return library_dir(workspace_id) / table / f"{file_key(vocabulary_id)}.parquet"


def library_files(workspace_id: str) -> list[tuple[str, str]]:
    """(relative name, absolute path) of every partition — what the library data
    source reads, grouped by table through its directory."""
    root = library_dir(workspace_id)
    if not root.is_dir():
        return []
    found = sorted(root.rglob("*.parquet"), key=lambda p: str(p).lower())
    return [(str(p.relative_to(root)), str(p)) for p in found]


def present_tables(workspace_id: str) -> list[str]:
    """The tables the library holds — its `knownTables`, which the ETL script
    generator reads to skip the parts a missing table would break."""
    return sorted({name.split("/", 1)[0] for name, _ in library_files(workspace_id) if "/" in name})


def table_of(file_name: str) -> str | None:
    """Which vocabulary table a file of an ATHENA export holds (`CONCEPT.csv`,
    `concept/part-0.parquet`), or None."""
    parts = [p for p in file_name.replace("\\", "/").split("/") if p]
    if not parts or not parts[-1].lower().endswith(_DATA_SUFFIXES):
        return None
    for seg in reversed(parts):
        stem = re.sub(r"\.[^.]+$", "", seg).lower()
        if stem in TABLE_COLUMNS:
            return stem
    return None


# (file name, path): the name tells CSV from Parquet — a blob-store path has no
# extension.
ExportFiles = list[tuple[str, str]]


def group_export_files(files: ExportFiles) -> dict[str, ExportFiles]:
    groups: dict[str, ExportFiles] = {}
    for name, path in files:
        table = table_of(name)
        if table:
            groups.setdefault(table, []).append((name, path))
    return groups


def _lit(value: str) -> str:
    return "'" + value.replace("\0", "").replace("'", "''") + "'"


def _reader(files: ExportFiles) -> str:
    """A reader over one table's files. ATHENA CSVs are tab-separated and never
    quoted (a concept name may hold a lone `"`), so a tab header switches quoting
    off; everything is read as text and cast by `_typed_select`."""
    paths = [p for _, p in files]
    if all(n.lower().endswith((".parquet", ".pq")) for n, _ in files):
        return f"read_parquet([{', '.join(_lit(p) for p in paths)}], union_by_name=true)"
    with open(paths[0], encoding="utf-8", errors="replace") as fh:
        header = fh.readline()
    opts = "delim='\\t', quote='', escape=''" if "\t" in header else "auto_detect=true"
    return (
        f"read_csv([{', '.join(_lit(p) for p in paths)}], header=true, all_varchar=true, "
        f"union_by_name=true, {opts})"
    )


def _typed_column(name: str, sql_type: str, present: set[str]) -> str:
    if name not in present:
        return f"CAST(NULL AS {sql_type}) AS {name}"
    if sql_type == "DATE":
        # ATHENA writes 19700101; a typed Parquet already has a DATE.
        return (
            f"COALESCE(TRY_CAST({name} AS DATE), "
            f"TRY_STRPTIME(CAST({name} AS VARCHAR), '%Y%m%d')::DATE) AS {name}"
        )
    return f"TRY_CAST({name} AS {sql_type}) AS {name}"


def _typed_select(con: duckdb.DuckDBPyConnection, table: str, files: ExportFiles) -> str:
    reader = _reader(files)
    present = {d[0].lower() for d in con.execute(f"SELECT * FROM {reader} LIMIT 0").description}
    cols = ", ".join(_typed_column(n, t, present) for n, t in TABLE_COLUMNS[table])
    return f"SELECT {cols} FROM {reader}"


def _connect(work_dir: str | None = None) -> duckdb.DuckDBPyConnection:
    # A file-backed database under a temp dir, so a full ATHENA (40 M relationship
    # rows) spills to disk rather than to memory.
    con = duckdb.connect(str(Path(work_dir) / "import.duckdb")) if work_dir else duckdb.connect()
    con.execute(f"SET extension_directory = '{_ext_dir()}'")
    if work_dir:
        con.execute(f"SET temp_directory = {_lit(str(Path(work_dir) / 'spill'))}")
    return con


# --- Inspect -----------------------------------------------------------------


def inspect_export(files: ExportFiles) -> dict:
    """What an ATHENA export holds: its release and, per vocabulary present in
    CONCEPT, its name, version and concept count."""
    groups = group_export_files(files)
    if "concept" not in groups:
        raise ValueError("The export has no CONCEPT table.")
    con = _connect()
    try:
        con.execute(f"CREATE TEMP TABLE c AS {_typed_select(con, 'concept', groups['concept'])}")
        counts = dict(
            con.execute(
                "SELECT vocabulary_id, COUNT(*) FROM c WHERE vocabulary_id IS NOT NULL GROUP BY 1"
            ).fetchall()
        )
        meta: dict[str, tuple[str | None, str | None]] = {}
        release = None
        if "vocabulary" in groups:
            for vid, name, version in con.execute(
                f"SELECT vocabulary_id, vocabulary_name, vocabulary_version FROM "
                f"({_typed_select(con, 'vocabulary', groups['vocabulary'])})"
            ).fetchall():
                if vid == RELEASE_VOCABULARY_ID:
                    release = version
                meta[vid] = (name, version)
    finally:
        con.close()
    return {
        "release": release,
        "tables": sorted(groups),
        "vocabularies": [
            {
                "vocabularyId": vid,
                "vocabularyName": meta.get(vid, (None, None))[0],
                "vocabularyVersion": meta.get(vid, (None, None))[1],
                "conceptCount": int(n),
            }
            for vid, n in sorted(counts.items())
        ],
    }


# --- Import ------------------------------------------------------------------


@dataclass
class ImportState:
    id: str
    workspace_id: str
    status: str = "running"  # running | done | error
    step: str = ""
    done: int = 0
    total: int = 0
    error: str | None = None
    vocabularies: list[dict] = field(default_factory=list)
    started_at: float = field(default_factory=time.time)
    finished_at: float | None = None

    def as_dict(self) -> dict:
        return {
            "id": self.id, "status": self.status, "step": self.step, "done": self.done,
            "total": self.total, "error": self.error, "vocabularies": self.vocabularies,
        }


_imports: dict[str, ImportState] = {}
_import_tasks: set[asyncio.Task] = set()
_workspace_locks: dict[str, asyncio.Lock] = {}
_FINISHED_IMPORT_TTL = 3600.0


def workspace_lock(workspace_id: str) -> asyncio.Lock:
    """Held while the workspace's library is written: an import, a removal."""
    return _workspace_locks.setdefault(workspace_id, asyncio.Lock())


def _prune_imports(now: float) -> None:
    for import_id, state in list(_imports.items()):
        if state.finished_at is not None and now - state.finished_at > _FINISHED_IMPORT_TTL:
            del _imports[import_id]
    # A queued import holds its lock without having acquired it yet.
    busy = {state.workspace_id for state in _imports.values() if state.finished_at is None}
    for workspace_id, lock in list(_workspace_locks.items()):
        if not lock.locked() and workspace_id not in busy:
            del _workspace_locks[workspace_id]


def import_state(import_id: str) -> ImportState | None:
    return _imports.get(import_id)


def write_partitions(
    workspace_id: str,
    files: ExportFiles,
    vocabularies: list[str],
    progress: ImportState | None = None,
) -> list[dict]:
    """Write the partitions of `vocabularies` from the export, replacing those
    already in the library, and merge the shared tables. Returns, per vocabulary
    written, its row counts by table. Built in a temp dir, then swapped in file
    by file: a failure while staging leaves the library as it was, but one
    during the swap (a crash, a full disk) can leave some tables at the new
    release and others at the old one — importing again repairs it."""
    groups = group_export_files(files)
    if "concept" not in groups:
        raise ValueError("The export has no CONCEPT table.")
    chosen = sorted(set(vocabularies))
    if not chosen:
        return []
    root = library_dir(workspace_id)
    work = tempfile.mkdtemp(prefix="vocab-import-")
    staged = Path(work) / "out"
    con = _connect(work)
    try:
        in_list = ", ".join(_lit(v) for v in chosen)
        per_vocab_tables = [t for t in OWNED_BY if t in groups]
        shared_tables = [t for t in SHARED_KEYS if t in groups]
        if progress:
            progress.total = len(per_vocab_tables) + len(shared_tables)
        counts: dict[str, dict[str, int]] = {v: {} for v in chosen}

        con.execute(
            f"CREATE TABLE c AS SELECT * FROM ({_typed_select(con, 'concept', groups['concept'])}) "
            f"WHERE vocabulary_id IN ({in_list})"
        )
        con.execute("CREATE TABLE owner AS SELECT concept_id, vocabulary_id AS _v FROM c")

        for table in per_vocab_tables:
            if progress:
                progress.step = table
            col = OWNED_BY[table]
            if table == "concept":
                src = "SELECT *, vocabulary_id AS _v FROM c"
            elif col is None:
                src = (
                    f"SELECT *, vocabulary_id AS _v FROM ({_typed_select(con, table, groups[table])}) "
                    f"WHERE vocabulary_id IN ({in_list})"
                )
            else:
                src = (
                    f"SELECT t.*, o._v FROM ({_typed_select(con, table, groups[table])}) t "
                    f"JOIN owner o ON o.concept_id = t.{col}"
                )
            con.execute(f"CREATE OR REPLACE TABLE part AS {src}")
            for vocab, n in con.execute("SELECT _v, COUNT(*) FROM part GROUP BY 1").fetchall():
                counts[vocab][table] = int(n)
            for vocab in chosen:
                out = staged / table / f"{file_key(vocab)}.parquet"
                out.parent.mkdir(parents=True, exist_ok=True)
                con.execute(
                    f"COPY (SELECT * EXCLUDE (_v) FROM part WHERE _v = {_lit(vocab)}) "
                    f"TO {_lit(str(out))} (FORMAT PARQUET)"
                )
            con.execute("DROP TABLE part")
            if progress:
                progress.done += 1

        for table in shared_tables:
            if progress:
                progress.step = table
            key = SHARED_KEYS[table]
            incoming = _typed_select(con, table, groups[table])
            current = root / table / SHARED_FILE
            union = f"SELECT *, 1 AS _rank FROM ({incoming})"
            if current.is_file():
                union += f" UNION ALL BY NAME SELECT *, 2 AS _rank FROM read_parquet({_lit(str(current))})"
            out = staged / table / SHARED_FILE
            out.parent.mkdir(parents=True, exist_ok=True)
            con.execute(
                f"COPY (SELECT * EXCLUDE (_rank) FROM ({union}) "
                f"QUALIFY row_number() OVER (PARTITION BY {key} ORDER BY _rank) = 1) "
                f"TO {_lit(str(out))} (FORMAT PARQUET)"
            )
            if progress:
                progress.done += 1
        con.close()

        # Swap in: every staged file replaces its counterpart; a table this export
        # lacks keeps the vocabulary's older partition out — it would describe
        # another release of the same vocabulary.
        for vocab in chosen:
            for table in OWNED_BY:
                target = partition_path(workspace_id, table, vocab)
                staged_file = staged / table / f"{file_key(vocab)}.parquet"
                if staged_file.is_file():
                    target.parent.mkdir(parents=True, exist_ok=True)
                    staged_file.replace(target)
                else:
                    target.unlink(missing_ok=True)
        for table in shared_tables:
            target = root / table / SHARED_FILE
            target.parent.mkdir(parents=True, exist_ok=True)
            (staged / table / SHARED_FILE).replace(target)
        return [{"vocabularyId": v, "rowCounts": counts[v]} for v in chosen]
    finally:
        try:
            con.close()
        except Exception:  # noqa: BLE001 — already closed
            pass
        shutil.rmtree(work, ignore_errors=True)


def remove_partitions(workspace_id: str, vocabulary_id: str) -> None:
    for table in OWNED_BY:
        partition_path(workspace_id, table, vocabulary_id).unlink(missing_ok=True)


def library_size(workspace_id: str, vocabulary_id: str) -> int:
    return sum(
        p.stat().st_size
        for p in (partition_path(workspace_id, t, vocabulary_id) for t in OWNED_BY)
        if p.is_file()
    )


def start_import(workspace_id: str, run) -> ImportState:
    """Run `run(state)` (a coroutine function) in the background, one import per
    workspace at a time; the client polls `import_state`."""
    _prune_imports(time.time())
    state = ImportState(id=str(uuid.uuid4()), workspace_id=workspace_id)
    _imports[state.id] = state
    lock = workspace_lock(workspace_id)

    async def _job() -> None:
        async with lock:
            try:
                await run(state)
                state.status = "done"
            except Exception as e:  # noqa: BLE001 — reported through the polled state
                state.status = "error"
                state.error = str(e)
            finally:
                state.finished_at = time.time()

    # Held: asyncio keeps only a weak reference to a task.
    task = asyncio.create_task(_job())
    _import_tasks.add(task)
    task.add_done_callback(_import_tasks.discard)
    return state
