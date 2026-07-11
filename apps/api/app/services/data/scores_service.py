"""Server-side reads of a mapping project's suggestion-scores parquet.

Mirrors the browser `scores-engine.ts` / `scores-parser.ts` (DuckDB-WASM): the
same required columns, the same index shape, the same per-source query. In server
mode the parquet lives in the blob store and never reaches the browser — the
client sends (vocabulary, code) and gets back the matching score rows.
"""

import duckdb

from app.services.data.db_connect import _ext_dir

REQUIRED_COLUMNS = (
    "source_vocabulary_id",
    "source_concept_code",
    "concept_id",
    "method",
    "score",
)

DEFAULT_EQUIVALENCE = "skos:exactMatch"


def _category_for_method(method: str) -> str | None:
    """Filterable suggestion category for a raw method string. Mirrors
    `categoryForMethod` in syntactic-suggestions.ts (data_dictionary is handled
    separately, keyed on the concept-set link rather than the method)."""
    if method.startswith("ai/"):
        return "agentic"
    if method.startswith("statistical/"):
        return "statistical"
    if method.startswith("semantic/"):
        return "semantic"
    if method.startswith("syntactic/"):
        return "syntactic"
    return None


def _connect() -> duckdb.DuckDBPyConnection:
    con = duckdb.connect()
    con.execute(f"SET extension_directory = '{_ext_dir()}'")
    return con


def validate(path: str) -> tuple[bool, str | None]:
    """Check the parquet has the required columns and at least one row. Returns
    (ok, error)."""
    con = _connect()
    try:
        try:
            desc = con.execute("SELECT * FROM read_parquet(?) LIMIT 1", [path]).description
        except Exception as e:  # noqa: BLE001 — surface DuckDB's parse error to the client
            return False, str(e)
        cols = {d[0] for d in desc}
        missing = [c for c in REQUIRED_COLUMNS if c not in cols]
        if missing:
            return False, (
                f"Missing required columns: {', '.join(missing)}. "
                f"Expected: {', '.join(REQUIRED_COLUMNS)}."
            )
        total = con.execute("SELECT COUNT(*) FROM read_parquet(?)", [path]).fetchone()[0]
        if int(total) == 0:
            return False, "Scores file is empty."
        return True, None
    finally:
        con.close()


def build_index(project_id: str, path: str) -> dict:
    """Aggregate the parquet into the ScoresIndex shape the client expects. Sets
    are emitted as sorted lists (JSON has no set); the client rebuilds Sets."""
    con = _connect()
    try:
        row_count = int(con.execute("SELECT COUNT(*) FROM read_parquet(?)", [path]).fetchone()[0])

        methods = [
            r[0]
            for r in con.execute(
                "SELECT DISTINCT method FROM read_parquet(?) WHERE method IS NOT NULL "
                "AND method <> '' ORDER BY method",
                [path],
            ).fetchall()
        ]

        source_keys: set[str] = set()
        for v, c in con.execute(
            "SELECT DISTINCT source_vocabulary_id, source_concept_code FROM read_parquet(?)",
            [path],
        ).fetchall():
            if v and c:
                source_keys.add(f"{v}::{c}")

        category_keys: dict[str, set[str]] = {
            "syntactic": set(), "semantic": set(), "statistical": set(),
            "agentic": set(), "data_dictionary": set(),
        }
        for v, c, m in con.execute(
            "SELECT DISTINCT source_vocabulary_id, source_concept_code, method "
            "FROM read_parquet(?)",
            [path],
        ).fetchall():
            if not v or not c:
                continue
            cat = _category_for_method(str(m or ""))
            if cat:
                category_keys[cat].add(f"{v}::{c}")

        # concept_set_uid is absent in scores files produced before data-dictionary
        # support; a legacy parquet without it must not blank the method categories.
        try:
            for v, c in con.execute(
                "SELECT DISTINCT source_vocabulary_id, source_concept_code "
                "FROM read_parquet(?) WHERE concept_set_uid IS NOT NULL "
                "AND concept_set_uid <> ''",
                [path],
            ).fetchall():
                if v and c:
                    category_keys["data_dictionary"].add(f"{v}::{c}")
        except Exception:  # noqa: BLE001 — column absent in pre-dictionary files
            pass

        return {
            "projectId": project_id,
            "rowCount": row_count,
            "methods": methods,
            "sourceKeys": sorted(source_keys),
            "categorySourceKeys": {k: sorted(v) for k, v in category_keys.items()},
        }
    finally:
        con.close()


def query_scores(path: str, vocab_id: str, code: str) -> list[dict]:
    """Score rows for one (vocabulary, code). SELECT * so files written before the
    concept_set_* columns existed still load; missing fields default like the
    browser's rowToParsed."""
    if not vocab_id or not code:
        return []
    con = _connect()
    try:
        # SELECT * (not a column list) so legacy parquets without concept_set_*
        # still load; row_to_parsed fills the gaps.
        result = con.execute(
            "SELECT * FROM read_parquet(?) "
            "WHERE source_vocabulary_id = ? AND source_concept_code = ?",
            [path, vocab_id, code],
        )
        cols = [d[0] for d in result.description]
        rows = []
        for raw in result.fetchall():
            r = dict(zip(cols, raw))
            parsed = _row_to_parsed(r)
            if parsed:
                rows.append(parsed)
        return rows
    finally:
        con.close()


def _row_to_parsed(r: dict) -> dict | None:
    source_vocab = str(r.get("source_vocabulary_id") or "")
    source_code = str(r.get("source_concept_code") or "")
    concept_id = int(r.get("concept_id") or 0)
    method = str(r.get("method") or "")
    score = float(r.get("score") or 0)
    if not source_vocab or not source_code or not concept_id or not method:
        return None
    equivalence = str(r["equivalence"]) if r.get("equivalence") else DEFAULT_EQUIVALENCE
    comment = str(r["comment"]) if r.get("comment") else None
    created_at = str(r["created_at"]) if r.get("created_at") else None
    concept_set_uid = str(r["concept_set_uid"]) if r.get("concept_set_uid") else None
    concept_set_source_repo = (
        str(r["concept_set_source_repo"]) if r.get("concept_set_source_repo") else None
    )
    return {
        "source_vocabulary_id": source_vocab,
        "source_concept_code": source_code,
        "concept_id": concept_id,
        "method": method,
        "score": score,
        "equivalence": equivalence,
        "comment": comment,
        "created_at": created_at,
        "concept_set_uid": concept_set_uid,
        "concept_set_source_repo": concept_set_source_repo,
    }
