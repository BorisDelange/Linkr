"""Disk-source-of-truth datasets: the raw files under projects/<uid>/datasets/
are the single source of truth; a derived Parquet cache under
projects/<uid>/.cache/datasets/ powers pagination/stats/kernel injection
(Dataiku/Spark pattern — the raw stays king, the columnar form is a cache).

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


def _cache_parquet(project_uid: str, rel: str) -> Path:
    return _cache_root(project_uid) / f"{_key(rel)}.parquet"


def _raw_signature(raw: Path) -> dict:
    st = raw.stat()
    return {"mtime": int(st.st_mtime_ns), "size": st.st_size}


def resolve_cache(project_uid: str, rel: str, parse_options: dict | None = None) -> dict:
    """Ensure a fresh Parquet cache for the raw dataset at ``datasets/<rel>`` and
    return {parquet: Path, columns: [...], rowCount: int}. Parses the raw file
    (CSV/XLSX/Parquet — DuckDB-backed) only when the cache is missing or the raw
    file changed. A native .parquet raw file is used directly as its own cache."""
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
        if meta is None or meta.get("sig") != sig:
            columns, _, row_count = _parse(raw, rel, parse_options)
            meta = {"sig": sig, "columns": columns, "rowCount": row_count, "native": True}
            _write_meta(meta_path, meta)
        return {"parquet": raw, "columns": meta["columns"], "rowCount": meta["rowCount"]}

    # CSV/XLSX/etc: parse to a Parquet cache when missing/stale.
    parquet = _cache_parquet(project_uid, rel)
    meta = _read_meta(meta_path)
    if meta is None or meta.get("sig") != sig or not parquet.is_file():
        columns, rows, row_count = _parse(raw, rel, parse_options)
        tmp = dataset_rows.write_parquet(rows, columns)
        parquet.parent.mkdir(parents=True, exist_ok=True)
        Path(tmp).replace(parquet)
        meta = {"sig": sig, "columns": columns, "rowCount": row_count, "native": False}
        _write_meta(meta_path, meta)
    return {"parquet": parquet, "columns": meta["columns"], "rowCount": meta["rowCount"]}


def _parse(raw: Path, rel: str, parse_options: dict | None):
    # stamp keeps column ids stable per (path); reuse the path hash as the stamp
    # base so re-parsing the same file yields the same column ids.
    stamp = int(_key(rel), 16) % 1_000_000_000
    return dataset_parser.parse_blob(raw, Path(rel).name, parse_options, stamp)


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
