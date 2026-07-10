"""Server-side build + pagination of the concept-mapping "Cross project overview"
Table, replacing the browser's DuckDB-WASM temp table (which must not run in
fullstack mode).

The table merges three sources that live in two engines:
  - source concepts  → per-project DuckDB over the file blob / external DB source
  - concept mappings → the app DB (SQLite/Postgres)
  - assigned IDs      → the app DB (source_concept_id_entries)

Strategy (Option 1 + Option 3): compute the merged rows in Python — mirroring
`global-summary-queries.ts` exactly — write them to a per-(workspace, mode)
Parquet cache, then paginate/filter/sort that Parquet with DuckDB. The cache is
keyed by a signature of the inputs so it is rebuilt only when they change.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

import duckdb

from app.config import settings
from app.services.data import db_connect


# --- Row shapes (mirror the global_flat / global_dedup temp tables) ----------

_FLAT_COLUMNS = [
    "id", "project_id", "project_name", "is_unmapped", "source_vocabulary_id",
    "source_concept_id", "resolved_source_concept_id", "source_concept_code",
    "source_concept_name", "equivalence", "target_vocabulary_id",
    "target_concept_id", "target_concept_name", "status", "mapped_by",
    "created_at", "updated_at", "votes_approved", "votes_flagged",
    "votes_rejected", "reviews_json",
]

_DEDUP_COLUMNS = [
    "key", "is_unmapped", "resolved_source_concept_id", "source_vocabulary_id",
    "source_concept_name", "source_concept_code", "equivalence",
    "target_vocabulary_id", "target_concept_id", "target_concept_name",
    "votes_approved", "votes_flagged", "votes_rejected", "project_count",
    "badge_labels",
]


def _cache_dir() -> Path:
    d = settings.data_path / "_global_table_cache"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _is_artificial_id(project: dict) -> bool:
    """Registry-resolved id applies to database projects and file projects that
    have no real conceptIdColumn (mirrors global-summary-queries.ts)."""
    if project.get("source_type") == "database":
        return True
    fsd = project.get("file_source_data") or {}
    col_map = fsd.get("columnMapping") or {}
    return project.get("source_type") == "file" and not col_map.get("conceptIdColumn")


def _project_badges(project: dict) -> list[str]:
    return [b.get("label") for b in (project.get("badges") or []) if b.get("label")]


def _votes(reviews: list | None) -> tuple[int, int, int]:
    reviews = reviews or []
    va = sum(1 for r in reviews if r.get("status") == "approved")
    vf = sum(1 for r in reviews if r.get("status") == "flagged")
    vr = sum(1 for r in reviews if r.get("status") == "rejected")
    return va, vf, vr


# --- Flat (project mode): one row per mapping + one per unmapped source concept


def build_flat_rows(
    projects: list[dict],
    mappings_by_project: dict[str, list[dict]],
    source_concepts_by_project: dict[str, list[dict]],
    registry: dict[str, int],
) -> list[dict]:
    project_map = {p["id"]: p for p in projects}
    rows: list[dict] = []

    mapped_keys: dict[str, set[str]] = {}
    for pid, ms in mappings_by_project.items():
        keys = mapped_keys.setdefault(pid, set())
        for m in ms:
            keys.add(f"{m.get('source_vocabulary_id')}__{m.get('source_concept_code')}")

    for pid, ms in mappings_by_project.items():
        proj = project_map.get(pid)
        artificial = _is_artificial_id(proj) if proj else False
        name = _localized(proj.get("name")) if proj else pid
        for m in ms:
            resolved = (
                registry.get(f"{m.get('source_vocabulary_id')}__{m.get('source_concept_code')}")
                if artificial else m.get("source_concept_id")
            )
            va, vf, vr = _votes(m.get("reviews"))
            rows.append({
                "id": m.get("id"), "project_id": pid, "project_name": name,
                "is_unmapped": False,
                "source_vocabulary_id": m.get("source_vocabulary_id") or "",
                "source_concept_id": m.get("source_concept_id") or 0,
                "resolved_source_concept_id": resolved,
                "source_concept_code": m.get("source_concept_code") or "",
                "source_concept_name": m.get("source_concept_name") or "",
                "equivalence": m.get("equivalence") or "",
                "target_vocabulary_id": m.get("target_vocabulary_id") or "",
                "target_concept_id": m.get("target_concept_id") or 0,
                "target_concept_name": m.get("target_concept_name") or "",
                "status": m.get("status") or "",
                "mapped_by": m.get("mapped_by") or "",
                "created_at": m.get("created_at") or "",
                "updated_at": m.get("updated_at") or "",
                "votes_approved": va, "votes_flagged": vf, "votes_rejected": vr,
                "reviews_json": json.dumps(m.get("reviews") or []),
            })

    for pid, source_concepts in source_concepts_by_project.items():
        proj = project_map.get(pid)
        if not proj:
            continue
        artificial = _is_artificial_id(proj)
        name = _localized(proj.get("name"))
        mapped = mapped_keys.get(pid, set())
        for sc in source_concepts:
            key = f"{sc.get('vocabulary_id')}__{sc.get('concept_code')}"
            if key in mapped:
                continue
            resolved = registry.get(key) if artificial else (sc.get("concept_id") or None)
            rows.append({
                "id": f"unmapped__{pid}__{key}", "project_id": pid,
                "project_name": name, "is_unmapped": True,
                "source_vocabulary_id": sc.get("vocabulary_id") or "",
                "source_concept_id": sc.get("concept_id") or 0,
                "resolved_source_concept_id": resolved,
                "source_concept_code": sc.get("concept_code") or "",
                "source_concept_name": sc.get("concept_name") or "",
                "equivalence": "", "target_vocabulary_id": "",
                "target_concept_id": 0, "target_concept_name": "",
                "status": "unchecked", "mapped_by": "",
                "created_at": "", "updated_at": "",
                "votes_approved": 0, "votes_flagged": 0, "votes_rejected": 0,
                "reviews_json": "[]",
            })

    return rows


# --- Dedup (badge mode): one row per (source code, target, badge set) ---------


def build_dedup_rows(
    projects: list[dict],
    mappings_by_project: dict[str, list[dict]],
    source_concepts_by_project: dict[str, list[dict]],
    registry: dict[str, int],
) -> list[dict]:
    project_map = {p["id"]: p for p in projects}
    agg: dict[str, dict] = {}
    mapped_source_keys: set[str] = set()

    for pid, ms in mappings_by_project.items():
        proj = project_map.get(pid)
        badges = _project_badges(proj) if proj else []
        if not badges:
            continue
        badge_key = "|".join(sorted(badges))
        artificial = _is_artificial_id(proj) if proj else False
        for m in ms:
            src_code = m.get("source_concept_code") or str(m.get("source_concept_id"))
            source_key = f"{badge_key}__{m.get('source_vocabulary_id')}__{src_code}"
            mapped_source_keys.add(source_key)
            key = f"{src_code}__{m.get('target_concept_id')}__{badge_key}"
            resolved = (
                registry.get(f"{m.get('source_vocabulary_id')}__{m.get('source_concept_code')}")
                if artificial else m.get("source_concept_id")
            )
            row = agg.get(key)
            if row is None:
                row = {
                    "key": key, "is_unmapped": False,
                    "resolved_source_concept_id": resolved,
                    "source_vocabulary_id": m.get("source_vocabulary_id") or "",
                    "source_concept_name": m.get("source_concept_name") or "",
                    "source_concept_code": src_code,
                    "equivalence": m.get("equivalence") or "",
                    "target_vocabulary_id": m.get("target_vocabulary_id") or "",
                    "target_concept_id": m.get("target_concept_id") or 0,
                    "target_concept_name": m.get("target_concept_name") or "",
                    "votes_approved": 0, "votes_flagged": 0, "votes_rejected": 0,
                    "project_count": 0, "badge_labels": ",".join(badges),
                }
                agg[key] = row
            va, vf, vr = _votes(m.get("reviews"))
            row["votes_approved"] += va
            row["votes_flagged"] += vf
            row["votes_rejected"] += vr
            row["project_count"] += 1

    for pid, source_concepts in source_concepts_by_project.items():
        proj = project_map.get(pid)
        if not proj:
            continue
        badges = _project_badges(proj)
        if not badges:
            continue
        badge_key = "|".join(sorted(badges))
        artificial = _is_artificial_id(proj)
        for sc in source_concepts:
            source_key = f"{badge_key}__{sc.get('vocabulary_id')}__{sc.get('concept_code')}"
            if source_key in mapped_source_keys:
                continue
            mapped_source_keys.add(source_key)
            resolved = registry.get(f"{sc.get('vocabulary_id')}__{sc.get('concept_code')}") \
                if artificial else (sc.get("concept_id") or None)
            key = f"unmapped__{source_key}"
            agg[key] = {
                "key": key, "is_unmapped": True,
                "resolved_source_concept_id": resolved,
                "source_vocabulary_id": sc.get("vocabulary_id") or "",
                "source_concept_name": sc.get("concept_name") or "",
                "source_concept_code": sc.get("concept_code") or "",
                "equivalence": "", "target_vocabulary_id": "",
                "target_concept_id": 0, "target_concept_name": "",
                "votes_approved": 0, "votes_flagged": 0, "votes_rejected": 0,
                "project_count": 0, "badge_labels": ",".join(badges),
            }

    return list(agg.values())


def _localized(value: Any, lang: str = "en") -> str:
    if isinstance(value, dict):
        return str(value.get(lang) or next(iter(value.values()), ""))
    return str(value or "")


# --- Cache signature + materialization ---------------------------------------


# Bump when the cache row shape or build logic changes, so stale Parquet files
# (e.g. the pre-fix 10k-truncated ones) are rebuilt instead of reused.
_CACHE_VERSION = 2


def cache_signature(
    projects: list[dict],
    mappings_by_project: dict[str, list[dict]],
    registry: dict[str, int],
) -> str:
    """Stable hash of everything that changes the merged rows. Cheap to compute
    and independent of row order."""
    h = hashlib.sha256()
    h.update(f"v{_CACHE_VERSION}".encode())
    for p in sorted(projects, key=lambda x: x["id"]):
        h.update(p["id"].encode())
        h.update(str(p.get("updated_at") or "").encode())
        h.update(json.dumps(p.get("badges") or [], sort_keys=True).encode())
        h.update(str(p.get("raw_file_sha") or "").encode())
    for pid in sorted(mappings_by_project):
        ms = mappings_by_project[pid]
        h.update(pid.encode())
        h.update(str(len(ms)).encode())
        for m in ms:
            h.update(str(m.get("updated_at") or "").encode())
    h.update(str(len(registry)).encode())
    return h.hexdigest()[:16]


def cache_path(workspace_id: str, mode: str, signature: str) -> Path:
    return _cache_dir() / f"{workspace_id}__{mode}__{signature}.parquet"


def materialize(rows: list[dict], mode: str, dest: Path) -> None:
    """Write merged rows to a Parquet cache via DuckDB."""
    columns = _FLAT_COLUMNS if mode == "flat" else _DEDUP_COLUMNS
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".tmp")
    con = duckdb.connect()
    con.execute(f"SET extension_directory = '{db_connect._ext_dir()}'")
    try:
        # Register the Python rows as a DuckDB relation, then COPY to Parquet.
        col_defs = ", ".join(_col_ddl(c, mode) for c in columns)
        con.execute(f"CREATE TABLE t ({col_defs})")
        if rows:
            placeholders = ", ".join(["?"] * len(columns))
            con.executemany(
                f"INSERT INTO t VALUES ({placeholders})",
                [[r.get(c) for c in columns] for r in rows],
            )
        con.execute(f"COPY t TO '{tmp.as_posix()}' (FORMAT PARQUET)")
        tmp.replace(dest)
    finally:
        con.close()
        tmp.unlink(missing_ok=True)


def _col_ddl(col: str, mode: str) -> str:
    int_cols = {
        "source_concept_id", "resolved_source_concept_id", "target_concept_id",
        "votes_approved", "votes_flagged", "votes_rejected", "project_count",
    }
    bool_cols = {"is_unmapped"}
    if col in bool_cols:
        return f"{col} BOOLEAN"
    if col in int_cols:
        return f"{col} BIGINT"
    return f"{col} VARCHAR"


# --- Pagination over the Parquet cache ---------------------------------------


def _esc(s: str) -> str:
    return s.replace("'", "''")


def _where(filters: dict, mode: str) -> str:
    clauses: list[str] = []
    q = (filters.get("globalSearch") or "").strip()
    if q:
        like = f"LOWER('%{_esc(q)}%')"
        clauses.append(
            f"(LOWER(source_concept_name) LIKE {like} OR LOWER(source_concept_code) LIKE {like})"
        )
    status = filters.get("statusFilter") or []
    if status and len(status) < 2:
        if "unmapped" in status:
            clauses.append("is_unmapped = true")
        elif "mapped" in status:
            clauses.append("is_unmapped = false")
    groups = filters.get("groupLabels") or []
    if groups:
        if mode == "flat":
            vals = ",".join(f"'{_esc(g)}'" for g in groups)
            clauses.append(f"project_name IN ({vals})")
        else:
            # dedup groups by badge set (comma-joined labels) — match any selected label.
            parts = " OR ".join(
                f"list_contains(string_split(badge_labels, ','), '{_esc(g)}')" for g in groups
            )
            clauses.append(f"({parts})")
    for key, col in (
        ("sourceVocabularyId", "source_vocabulary_id"),
        ("equivalence", "equivalence"),
        ("targetVocabularyId", "target_vocabulary_id"),
    ):
        v = filters.get(key)
        if v:
            clauses.append(f"{col} = '{_esc(str(v))}'")
    for key, col in (
        ("sourceConceptCode", "source_concept_code"),
        ("sourceConceptName", "source_concept_name"),
        ("targetConceptName", "target_concept_name"),
    ):
        v = filters.get(key)
        if v:
            clauses.append(f"LOWER({col}) LIKE LOWER('%{_esc(str(v))}%')")
    return (" WHERE " + " AND ".join(clauses)) if clauses else ""


_SORT_COLS = {
    "status": "is_unmapped", "groupLabel": "project_name",
    "badgeLabels": "badge_labels", "projectCount": "project_count",
    "sourceVocabularyId": "source_vocabulary_id",
    "sourceConceptId": "resolved_source_concept_id",
    "sourceConceptCode": "source_concept_code",
    "sourceConceptName": "source_concept_name", "equivalence": "equivalence",
    "targetVocabularyId": "target_vocabulary_id",
    "targetConceptId": "target_concept_id",
    "targetConceptName": "target_concept_name",
    "votesApproved": "votes_approved", "votesFlagged": "votes_flagged",
    "votesRejected": "votes_rejected",
}


def _order_by(sort: dict | None, available: set[str]) -> str:
    if not sort or not sort.get("columnId"):
        return " ORDER BY is_unmapped ASC, source_concept_name ASC"
    col = _SORT_COLS.get(sort["columnId"], "source_concept_name")
    if col not in available:
        return " ORDER BY is_unmapped ASC, source_concept_name ASC"
    direction = "DESC" if sort.get("desc") else "ASC"
    return f" ORDER BY {col} {direction} NULLS LAST"


def query_page(
    path: Path, mode: str, filters: dict, sort: dict | None, limit: int, offset: int
) -> tuple[list[dict], int]:
    """Return (rows, total_count) for one page of the cached merged table."""
    available = set(_FLAT_COLUMNS if mode == "flat" else _DEDUP_COLUMNS)
    where = _where(filters, mode)
    order = _order_by(sort, available)
    con = duckdb.connect()
    con.execute(f"SET extension_directory = '{db_connect._ext_dir()}'")
    try:
        con.execute(
            f"CREATE VIEW g AS SELECT * FROM read_parquet('{path.as_posix()}')"
        )
        total = con.execute(f"SELECT COUNT(*) FROM g{where}").fetchone()[0]
        result = con.execute(
            f"SELECT * FROM g{where}{order} LIMIT {int(limit)} OFFSET {int(offset)}"
        )
        names = [d[0] for d in result.description]
        rows = [dict(zip(names, row)) for row in result.fetchall()]
        return rows, int(total)
    finally:
        con.close()


# --- Source concepts per project (file source only) --------------------------

_SOURCE_CONCEPTS_SQL = (
    "SELECT concept_id, concept_name, concept_code, "
    "COALESCE(vocabulary_id, '') AS vocabulary_id FROM source_concepts"
)


def load_file_source_concepts(project: dict) -> list[dict]:
    """All source concepts of a file-source project, read server-side via DuckDB
    (no WASM). Database-source projects return [] — the server has no
    schemaMapping query builder, so only their mappings show (unmapped rows are
    omitted, matching the pre-existing degraded behavior)."""
    from app.services import blob_store  # local import: avoid cycle at module load

    sha = project.get("raw_file_sha")
    if project.get("source_type") != "file" or not sha or not blob_store.exists(sha):
        return []
    fsd = project.get("file_source_data") or {}
    column_mapping = fsd.get("columnMapping", {})
    parse_options = fsd.get("parseOptions", {})
    select_sql = _source_concepts_select(column_mapping)
    path = str(blob_store.path_for(sha))
    try:
        rows = db_connect.query_file_source(
            path, project.get("raw_file_name"), parse_options, select_sql,
            _SOURCE_CONCEPTS_SQL, max_rows=None,  # full read: this feeds the cache
        )
    except Exception:
        return []
    # Dedup by (vocabulary_id, concept_code) — mirrors loadSourceConcepts' seen map.
    seen: dict[str, dict] = {}
    for r in rows:
        code = str(r.get("concept_code") or "")
        vocab = str(r.get("vocabulary_id") or _localized(project.get("name")))
        key = f"{vocab}__{code}"
        if key not in seen:
            seen[key] = {
                "vocabulary_id": vocab, "concept_code": code,
                "concept_name": str(r.get("concept_name") or ""),
                "concept_id": int(r.get("concept_id") or 0),
            }
    return list(seen.values())


def _source_concepts_select(column_mapping: dict) -> str:
    from app.services.data.file_source import build_source_concepts_select
    return build_source_concepts_select(column_mapping)


# --- Cache orchestration -----------------------------------------------------


def get_or_build_cache(
    workspace_id: str,
    mode: str,
    projects: list[dict],
    mappings_by_project: dict[str, list[dict]],
    registry: dict[str, int],
) -> Path:
    """Return the Parquet cache for (workspace, mode), rebuilding it (both modes)
    when the input signature changes. Reading the source concepts + writing the
    Parquet is the expensive part, done once per signature. Synchronous — call
    from a thread."""
    signature = cache_signature(projects, mappings_by_project, registry)
    dest = cache_path(workspace_id, mode, signature)
    if dest.exists():
        return dest

    # A changed signature obsoletes this workspace+mode's old caches — drop them
    # (keep the other mode's current-signature file untouched).
    prefix = f"{workspace_id}__{mode}__"
    for old in _cache_dir().glob(f"{prefix}*.parquet"):
        old.unlink(missing_ok=True)

    source_concepts_by_project = {
        p["id"]: load_file_source_concepts(p) for p in projects
    }
    if mode == "flat":
        rows = build_flat_rows(projects, mappings_by_project, source_concepts_by_project, registry)
    else:
        rows = build_dedup_rows(projects, mappings_by_project, source_concepts_by_project, registry)
    materialize(rows, mode, dest)
    return dest
