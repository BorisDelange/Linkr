"""Server-side reads of a mapping project's suggestion-scores parquet.

Mirrors the browser `scores-engine.ts` / `scores-parser.ts` (DuckDB-WASM): the
same required columns, the same index shape, the same per-source query. In server
mode the parquet lives in the blob store and never reaches the browser — the
client sends (vocabulary, code) and gets back the matching score rows.
"""

import re

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


SCORE_COLUMNS = (
    "source_vocabulary_id",
    "source_concept_code",
    "concept_id",
    "method",
    "score",
    "equivalence",
    "comment",
    "created_at",
    "concept_set_uid",
    "concept_set_source_repo",
)

_KEY = "source_vocabulary_id, source_concept_code, concept_id, method"


def append_rows(existing_path: str | None, rows: list[dict], out_path: str) -> tuple[int, int]:
    """Write `existing_path` plus the new `rows` to `out_path` as one parquet.
    Rows are keyed on (vocabulary, code, concept_id, method); a key already in
    the file — or repeated in `rows` — is skipped, never overwritten, so a
    reviewer's view of a suggestion does not change under them. Returns
    (added, skipped)."""
    con = _connect()
    try:
        con.execute(
            "CREATE TEMP TABLE incoming (source_vocabulary_id VARCHAR, source_concept_code VARCHAR, "
            "concept_id BIGINT, method VARCHAR, score DOUBLE, equivalence VARCHAR, comment VARCHAR, "
            "created_at VARCHAR, concept_set_uid VARCHAR, concept_set_source_repo VARCHAR)"
        )
        con.executemany(
            "INSERT INTO incoming VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            [[r.get(c) for c in SCORE_COLUMNS] for r in rows],
        )
        con.execute(
            f"CREATE TEMP TABLE fresh AS SELECT * FROM incoming "
            f"QUALIFY row_number() OVER (PARTITION BY {_KEY}) = 1"
        )
        if existing_path:
            con.execute(
                f"DELETE FROM fresh WHERE ({_KEY}) IN "
                f"(SELECT ({_KEY}) FROM read_parquet(?))",
                [existing_path],
            )
            source = "SELECT * FROM read_parquet(?) UNION ALL BY NAME SELECT * FROM fresh"
            params = [existing_path]
        else:
            source = "SELECT * FROM fresh"
            params = []
        added = int(con.execute("SELECT COUNT(*) FROM fresh").fetchone()[0])
        escaped = out_path.replace("'", "''")
        con.execute(f"COPY ({source}) TO '{escaped}' (FORMAT PARQUET)", params)
        return added, len(rows) - added
    finally:
        con.close()


def remove_rows(
    path: str, methods: list[str], source_keys: list[tuple[str, str]] | None, out_path: str
) -> tuple[int, int]:
    """Write `path` minus the rows of `methods` (only for `source_keys` when
    given) to `out_path`. Returns (removed, remaining); the caller drops the file
    when nothing remains."""
    con = _connect()
    try:
        con.execute("CREATE TEMP TABLE methods (method VARCHAR)")
        con.executemany("INSERT INTO methods VALUES (?)", [[m] for m in methods])
        cond = "method IN (SELECT method FROM methods)"
        if source_keys is not None:
            con.execute("CREATE TEMP TABLE sources (v VARCHAR, c VARCHAR)")
            con.executemany("INSERT INTO sources VALUES (?, ?)", [list(k) for k in source_keys])
            cond += " AND (source_vocabulary_id, source_concept_code) IN (SELECT (v, c) FROM sources)"
        total = int(con.execute("SELECT COUNT(*) FROM read_parquet(?)", [path]).fetchone()[0])
        removed = int(
            con.execute(f"SELECT COUNT(*) FROM read_parquet(?) WHERE {cond}", [path]).fetchone()[0]
        )
        remaining = total - removed
        if remaining:
            escaped = out_path.replace("'", "''")
            con.execute(
                f"COPY (SELECT * FROM read_parquet(?) WHERE NOT ({cond})) TO '{escaped}' (FORMAT PARQUET)",
                [path],
            )
        return removed, remaining
    finally:
        con.close()


def query_by_targets(
    path: str, concept_ids: list[int], min_score: float, methods: list[str] | None, limit: int
) -> list[dict]:
    """Score rows pointing at any of `concept_ids` — which source concepts were
    matched to these targets, best first (the reverse of `query_scores`)."""
    if not concept_ids:
        return []
    con = _connect()
    try:
        con.execute("CREATE TEMP TABLE targets (id BIGINT)")
        con.executemany("INSERT INTO targets VALUES (?)", [[i] for i in concept_ids])
        where = "concept_id IN (SELECT id FROM targets) AND score >= ?"
        params: list = [path, min_score]
        if methods:
            con.execute("CREATE TEMP TABLE methods (method VARCHAR)")
            con.executemany("INSERT INTO methods VALUES (?)", [[m] for m in methods])
            where += " AND method IN (SELECT method FROM methods)"
        result = con.execute(
            f"SELECT * FROM read_parquet(?) WHERE {where} ORDER BY score DESC LIMIT {int(limit)}",
            params,
        )
        cols = [d[0] for d in result.description]
        return [p for p in (_row_to_parsed(dict(zip(cols, raw))) for raw in result.fetchall()) if p]
    finally:
        con.close()


# --- Per-method CSV: the versionable form of the scores ------------------------
#
# A parquet cannot be diffed or merged, so a method the user marks "versioned"
# travels as `similarity-scores/<method>.csv` (e.g. similarity-scores/ai/
# claude-opus-4-8.csv). One file per method keeps a diff local to the method that
# changed, and removing a method removes a file. Twin of scores-csv.ts: the SQL
# below is the same text on both sides, so a front-only and a server instance
# write the same bytes.

SCORES_CSV_DIR = "similarity-scores"

# `method` is not a column: the file path carries it.
CSV_REQUIRED_COLUMNS = ("source_vocabulary_id", "source_concept_code", "concept_id", "score")
# Written only when the method has at least one non-empty value in them, so an
# all-blank column does not cost a comma per row.
CSV_OPTIONAL_COLUMNS = (
    "equivalence",
    "comment",
    "created_at",
    "concept_set_uid",
    "concept_set_source_repo",
)

# A method becomes a path, so each `/`-separated segment must be a plain name —
# no `..`, no leading dot, nothing a filesystem or git would reinterpret.
_METHOD_SEGMENT_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._@+-]*$")


def csv_path_for_method(method: str) -> str | None:
    """`similarity-scores/<method>.csv`, or None when the method cannot be a path."""
    segments = method.split("/")
    # fullmatch, not match: `$` would accept a trailing newline the TS twin rejects.
    if not all(_METHOD_SEGMENT_RE.fullmatch(s) for s in segments):
        return None
    return f"{SCORES_CSV_DIR}/{method}.csv"


def method_for_csv_path(path: str) -> str | None:
    """Inverse of `csv_path_for_method`; None for any other path."""
    prefix = f"{SCORES_CSV_DIR}/"
    if not path.startswith(prefix) or not path.endswith(".csv"):
        return None
    method = path[len(prefix):-len(".csv")]
    return method if csv_path_for_method(method) == path else None


def _sql_literal(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def _parquet_columns(con: duckdb.DuckDBPyConnection, path: str) -> set[str]:
    return {d[0] for d in con.execute("SELECT * FROM read_parquet(?) LIMIT 0", [path]).description}


def _csv_select_list(present_optional: list[str]) -> str:
    cols = [
        "source_vocabulary_id",
        "source_concept_code",
        "CAST(concept_id AS VARCHAR) AS concept_id",
        "printf('%.4f', score) AS score",
    ]
    cols += [f"NULLIF(CAST({c} AS VARCHAR), '') AS {c}" for c in present_optional]
    return ", ".join(cols)


def method_stats(path: str) -> list[dict]:
    """Per method: row count and the byte size its CSV would have (exact up to
    quoting), for the "versioned" toggles."""
    con = _connect()
    try:
        cols = _parquet_columns(con, path)
        optional = [c for c in CSV_OPTIONAL_COLUMNS if c in cols]
        # Every optional column is counted as written: an estimate the user reads
        # as "≈ N MB", not a promise.
        lengths = " + ".join(
            [
                "strlen(source_vocabulary_id)",
                "strlen(source_concept_code)",
                "strlen(CAST(concept_id AS VARCHAR))",
                "strlen(printf('%.4f', score))",
            ]
            + [f"coalesce(strlen(CAST({c} AS VARCHAR)), 0)" for c in optional]
        )
        separators = len(CSV_REQUIRED_COLUMNS) + len(optional)  # commas + newline
        rows = con.execute(
            f"SELECT method, COUNT(*), SUM({lengths} + {separators}) FROM read_parquet(?) "
            "WHERE method IS NOT NULL AND method <> '' GROUP BY method ORDER BY method",
            [path],
        ).fetchall()
        return [
            {
                "method": m,
                "rowCount": int(n),
                "csvBytes": int(b or 0),
                "versionable": csv_path_for_method(m) is not None,
            }
            for m, n, b in rows
        ]
    finally:
        con.close()


def write_method_csv(path: str, method: str, out_path: str) -> int:
    """Write the rows of `method` to `out_path` as its versioned CSV; returns the
    row count. Rows are sorted on the full key and the score is rounded to four
    decimals, so an unchanged method rewrites the same bytes."""
    con = _connect()
    try:
        cols = _parquet_columns(con, path)
        where = f"method = {_sql_literal(method)}"
        present = [
            c
            for c in CSV_OPTIONAL_COLUMNS
            if c in cols
            and con.execute(
                f"SELECT COUNT(*) FROM read_parquet(?) WHERE {where} "
                f"AND NULLIF(CAST({c} AS VARCHAR), '') IS NOT NULL",
                [path],
            ).fetchone()[0]
        ]
        count = int(
            con.execute(f"SELECT COUNT(*) FROM read_parquet(?) WHERE {where}", [path]).fetchone()[0]
        )
        con.execute(
            f"COPY (SELECT {_csv_select_list(present)} FROM read_parquet({_sql_literal(path)}) "
            f"WHERE {where} ORDER BY source_vocabulary_id, source_concept_code, concept_id) "
            f"TO {_sql_literal(out_path)} "
            "(FORMAT CSV, HEADER true, DELIMITER ',', QUOTE '\"', ESCAPE '\"', NULL '')"
        )
        return count
    finally:
        con.close()


def merge_method_csvs(
    existing_path: str | None, csvs: list[tuple[str, str]], out_path: str
) -> int:
    """Write `existing_path` with the rows of each (method, csv_path) REPLACED by
    that CSV's rows to `out_path`; returns the resulting row count (the caller
    drops the file when it is 0). A method absent from `csvs` is left untouched —
    local, unversioned methods survive a pull. An empty `csvs` is refused: it
    would read as "no rows left" and the caller would drop the whole file."""
    if not csvs:
        raise ValueError("merge_method_csvs needs at least one method CSV")
    con = _connect()
    try:
        parts: list[str] = []
        for method, csv_path in csvs:
            source = f"read_csv({_sql_literal(csv_path)}, header=true, all_varchar=true)"
            cols = {d[0] for d in con.execute(f"SELECT * FROM {source} LIMIT 0").description}
            missing = [c for c in CSV_REQUIRED_COLUMNS if c not in cols]
            if missing:
                raise ValueError(f"{method}: missing required columns: {', '.join(missing)}")
            optional = ", ".join(
                f"{c if c in cols else 'NULL'}::VARCHAR AS {c}" for c in CSV_OPTIONAL_COLUMNS
            )
            parts.append(
                "SELECT source_vocabulary_id, source_concept_code, "
                "CAST(concept_id AS BIGINT) AS concept_id, "
                f"{_sql_literal(method)} AS method, CAST(score AS DOUBLE) AS score, {optional} "
                f"FROM {source}"
            )
        if existing_path:
            replaced = ", ".join(_sql_literal(m) for m, _ in csvs)
            parts.insert(
                0,
                f"SELECT * FROM read_parquet({_sql_literal(existing_path)}) "
                f"WHERE method NOT IN ({replaced})",
            )
        union = " UNION ALL BY NAME ".join(f"({p})" for p in parts)
        con.execute(f"CREATE TEMP TABLE merged AS {union}")
        total = int(con.execute("SELECT COUNT(*) FROM merged").fetchone()[0])
        if total:
            con.execute(f"COPY merged TO {_sql_literal(out_path)} (FORMAT PARQUET)")
        return total
    finally:
        con.close()


def subset_parquet(path: str, methods: list[str], out_path: str) -> int:
    """Write only the rows of `methods` to `out_path` (the ZIP's parquet variant
    with a method selection); returns the row count."""
    con = _connect()
    try:
        cond = "method IN (" + (", ".join(_sql_literal(m) for m in methods) or "NULL") + ")"
        total = int(con.execute(f"SELECT COUNT(*) FROM read_parquet(?) WHERE {cond}", [path]).fetchone()[0])
        if total:
            con.execute(
                f"COPY (SELECT * FROM read_parquet({_sql_literal(path)}) WHERE {cond}) "
                f"TO {_sql_literal(out_path)} (FORMAT PARQUET)"
            )
        return total
    finally:
        con.close()
