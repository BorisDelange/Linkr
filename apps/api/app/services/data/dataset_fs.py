"""Disk-source-of-truth datasets: the raw files under projects/<uid>/datasets/
are the single source of truth; a derived Parquet cache under
projects/<uid>/.cache/datasets/ powers pagination/stats/kernel injection
(the raw file stays authoritative, the columnar form is only a cache).

The cache is keyed by a hash of the dataset's relative path, invalidated when the
raw file's (mtime, size) change, and purged when the raw file disappears.
"""

import hashlib
import json
from pathlib import Path

from app.services import project_fs
from app.services.data import dataset_parser, dataset_rows

# A .parquet raw file is already columnar — no separate cache needed.
_NATIVE_PARQUET = {".parquet"}


def _cache_root(project_uid: str) -> Path:
    d = project_fs.cache_dir(project_uid) / "datasets"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _key(rel: str) -> str:
    return hashlib.sha1(rel.encode("utf-8")).hexdigest()[:16]


def _meta_path(project_uid: str, rel: str) -> Path:
    return _cache_root(project_uid) / f"{_key(rel)}.json"


def _colmeta_root(project_uid: str) -> Path:
    # Editorial column metadata (labels/descriptions/value labels). Lives under the
    # project root — NOT under the re-bindable datasets/ dir — so it is git-tracked
    # and travels on export regardless of where datasets/ is bound (mirrors how
    # environments/ sits under the project root, not the re-bindable scripts/).
    d = project_fs.project_dir(project_uid) / "dataset-meta"
    return d


def _colmeta_path(project_uid: str, rel: str) -> Path:
    return _colmeta_root(project_uid) / f"{_key(rel)}.json"


def read_column_meta(project_uid: str, rel: str) -> dict:
    """The editorial column-metadata sidecar for a dataset: {columnId: {label?,
    description?, valueLabels?}}. Empty dict when none has been set."""
    meta = _read_meta(_colmeta_path(project_uid, rel))
    cols = (meta or {}).get("columns")
    return cols if isinstance(cols, dict) else {}


def read_parse_options(project_uid: str, rel: str) -> dict | None:
    """The persisted parse options (columnTypes/columnFilterMode/delimiter/…) from
    the sidecar, or None. Durable — unlike the Parquet cache, it survives a raw
    change, so a reparse re-applies the user's column types instead of re-inferring."""
    meta = _read_meta(_colmeta_path(project_uid, rel))
    opts = (meta or {}).get("parseOptions")
    return opts if isinstance(opts, dict) and opts else None


def write_parse_options(project_uid: str, rel: str, parse_options: dict | None) -> None:
    """Persist the dataset's parse options into the sidecar (read-modify-write of
    the parseOptions section only; the columns section is left intact)."""
    path = _colmeta_path(project_uid, rel)
    current = _read_meta(path) or {}
    if parse_options:
        current["parseOptions"] = parse_options
        _write_meta(path, current)
    else:
        current.pop("parseOptions", None)
        if current:
            _write_meta(path, current)
        else:
            path.unlink(missing_ok=True)


def write_column_meta(project_uid: str, rel: str, columns: dict) -> None:
    """Replace the sidecar's editorial column metadata with the given authoritative
    set (the client sends the full desired state, so a cleared column drops out —
    no stale merge). Each value is {label?, description?, valueLabels?}; empty
    fields are stripped, and columns left with no fields are omitted. The sidecar
    file is deleted when nothing remains."""
    path = _colmeta_path(project_uid, rel)
    cleaned = {}
    for col_id, fields in (columns or {}).items():
        entry = {k: v for k, v in (fields or {}).items() if v not in (None, "", {}, [])}
        if entry:
            cleaned[col_id] = entry
    current = _read_meta(path) or {}
    if cleaned:
        current["columns"] = cleaned
        _write_meta(path, current)
    else:
        current.pop("columns", None)
        if current:
            _write_meta(path, current)
        else:
            path.unlink(missing_ok=True)


def merge_column_meta(columns: list[dict], sidecar: dict) -> list[dict]:
    """Overlay the sidecar's editorial fields onto derived columns, matched by id.
    Derived {id,name,type,order} stay authoritative; only label/description/
    valueLabels are added. Sidecar entries for unknown ids are ignored."""
    if not sidecar:
        return columns
    out = []
    for col in columns:
        extra = sidecar.get(col.get("id"))
        out.append({**col, **extra} if isinstance(extra, dict) else col)
    return out


def _cache_parquet(project_uid: str, rel: str) -> Path:
    return _cache_root(project_uid) / f"{_key(rel)}.parquet"


def _raw_signature(raw: Path) -> dict:
    st = raw.stat()
    return {"mtime": int(st.st_mtime_ns), "size": st.st_size}


def resolve_cache(
    project_uid: str, rel: str, parse_options: dict | None = None, force: bool = False
) -> dict:
    """Ensure a fresh Parquet cache for the raw dataset at ``datasets/<rel>`` and
    return {parquet: Path, columns: [...], rowCount: int}. Parses the raw file
    (CSV/XLSX/Parquet — DuckDB-backed) only when the cache is missing or the raw
    file changed (or `force`, e.g. a reimport with new parse options). A native
    .parquet raw file is used directly as its own cache."""
    raw = project_fs.dataset_path(project_uid, rel)
    if not raw.is_file():
        raise FileNotFoundError(rel)

    suffix = Path(rel).suffix.lower()
    sig = _raw_signature(raw)
    meta_path = _meta_path(project_uid, rel)

    # Fast path: native parquet raw — point stats/pagination straight at it. Parse
    # once (cheap: read_parquet) to get columns/types, cached in the meta sidecar.
    if suffix in _NATIVE_PARQUET:
        meta = _read_meta(meta_path)
        if force or meta is None or meta.get("sig") != sig:
            # Schema + COUNT from parquet metadata — no row materialization, so a
            # multi-GB parquet lists in milliseconds (parse_blob would fetchall()
            # every row and hang the whole event loop).
            columns, row_count = dataset_parser.parquet_schema(raw)
            meta = {"sig": sig, "columns": columns, "rowCount": row_count, "native": True}
            _write_meta(meta_path, meta)
        cols = merge_column_meta(meta["columns"], read_column_meta(project_uid, rel))
        return {"parquet": raw, "columns": cols, "rowCount": meta["rowCount"], "native": True,
                "parseOptions": read_parse_options(project_uid, rel)}

    # CSV/XLSX/etc: parse to a Parquet cache when missing/stale.
    parquet = _cache_parquet(project_uid, rel)
    meta = _read_meta(meta_path)
    if force or meta is None or meta.get("sig") != sig or not parquet.is_file():
        # A reimport passes explicit options → persist them; otherwise fall back to
        # the sidecar's stored options so a raw-change reparse keeps the user's
        # column types instead of re-inferring (the fragility this fixes).
        if parse_options is not None:
            write_parse_options(project_uid, rel, parse_options)
            effective_options = parse_options
        else:
            effective_options = read_parse_options(project_uid, rel)
        columns, rows, row_count = _parse(raw, rel, effective_options)
        parquet.parent.mkdir(parents=True, exist_ok=True)
        # Write the temp on the destination filesystem so the replace() below is a
        # same-device atomic rename (a mounted volume differs from /tmp in Docker).
        tmp = dataset_rows.write_parquet(rows, columns, dir=parquet.parent)
        Path(tmp).replace(parquet)
        meta = {"sig": sig, "columns": columns, "rowCount": row_count, "native": False}
        _write_meta(meta_path, meta)
    cols = merge_column_meta(meta["columns"], read_column_meta(project_uid, rel))
    return {"parquet": parquet, "columns": cols, "rowCount": meta["rowCount"], "native": False,
            "parseOptions": read_parse_options(project_uid, rel)}


def _parse(raw: Path, rel: str, parse_options: dict | None):
    # Column ids are now deterministic from the column name (col_<slug>), so
    # re-parsing the same file yields the same ids without a per-path stamp.
    return dataset_parser.parse_blob(raw, Path(rel).name, parse_options)


def _read_meta(p: Path) -> dict | None:
    if not p.is_file():
        return None
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (ValueError, OSError):
        return None


def _write_meta(p: Path, meta: dict) -> None:
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(meta), encoding="utf-8")


def purge_orphans(project_uid: str) -> None:
    """Delete cache entries whose raw dataset file no longer exists on disk."""
    root = _cache_root(project_uid)
    live_keys = {
        _key(n["path"]) for n in project_fs.scan_datasets(project_uid) if n["type"] == "file"
    }
    for entry in root.glob("*.json"):
        if entry.stem not in live_keys:
            entry.unlink(missing_ok=True)
            (root / f"{entry.stem}.parquet").unlink(missing_ok=True)
    # The editorial sidecar lives under the project root, not the cache; purge it
    # on the same live-key set so a deleted dataset leaves no metadata behind.
    colmeta_root = _colmeta_root(project_uid)
    if colmeta_root.is_dir():
        for entry in colmeta_root.glob("*.json"):
            if entry.stem not in live_keys:
                entry.unlink(missing_ok=True)
