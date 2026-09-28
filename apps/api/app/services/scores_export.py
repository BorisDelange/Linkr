"""The similarity-scores files a mapping-project export carries.

Git and the default ZIP carry each *versioned* method as its own CSV (see
``scores_service.write_method_csv``); the ZIP can also carry any selection of
methods, as CSVs or as one parquet. Generating a CSV reads the whole parquet, and
the git status rebuilds the export on every refresh, so each CSV is cached on disk
under the scores file's sha: an unchanged file is never regenerated.
"""

import asyncio
import shutil
import tempfile
from pathlib import Path
from typing import Literal

from app.config import settings
from app.models.mapping_project import MappingProject
from app.services import blob_store
from app.services.data import scores_service

ScoresFormat = Literal["csv", "parquet"]

SCORES_PARQUET_FILE = "similarity-scores.parquet"

# Every write reads the project's scores file, merges, and stores a new one: two
# writes interleaved would each drop the other's rows. One worker serves the API,
# so an in-process lock per project is enough.
_scores_locks: dict[str, asyncio.Lock] = {}


def scores_lock(project_id: str) -> asyncio.Lock:
    return _scores_locks.setdefault(project_id, asyncio.Lock())


def _project_cache_root(project_id: str) -> Path:
    return settings.data_path / ".cache" / "scores-csv" / project_id


def _cache_dir(project_id: str, sha: str) -> Path:
    return _project_cache_root(project_id) / sha


def drop_csv_cache(project_id: str) -> None:
    shutil.rmtree(_project_cache_root(project_id), ignore_errors=True)


def _prune_other_shas(project_id: str, sha: str) -> None:
    root = _project_cache_root(project_id)
    if not root.is_dir():
        return
    for child in root.iterdir():
        if child.name != sha:
            shutil.rmtree(child, ignore_errors=True)


def _method_csv_bytes(project_id: str, sha: str, method: str) -> bytes | None:
    rel = scores_service.csv_path_for_method(method)
    if rel is None:
        return None
    cached = _cache_dir(project_id, sha) / rel
    if not cached.is_file():
        _prune_other_shas(project_id, sha)
        cached.parent.mkdir(parents=True, exist_ok=True)
        # Written beside the target then renamed, so a crash mid-write never
        # leaves a truncated CSV that later reads as the cached one.
        tmp = cached.with_suffix(".csv.tmp")
        count = scores_service.write_method_csv(str(blob_store.path_for(sha)), method, str(tmp))
        if count == 0:
            tmp.unlink(missing_ok=True)
            return None
        tmp.replace(cached)
    return cached.read_bytes()


def _scores_sha(project: MappingProject) -> str | None:
    sha = project.scores_file_sha
    return sha if sha and blob_store.exists(sha) else None


def _files_sync(
    project_id: str, sha: str, fmt: ScoresFormat, methods: list[str]
) -> dict[str, bytes]:
    if fmt == "parquet":
        path = str(blob_store.path_for(sha))
        present = {s["method"] for s in scores_service.method_stats(path)}
        if present <= set(methods):
            return {SCORES_PARQUET_FILE: blob_store.path_for(sha).read_bytes()}
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / SCORES_PARQUET_FILE
            if not scores_service.subset_parquet(path, methods, str(out)):
                return {}
            return {SCORES_PARQUET_FILE: out.read_bytes()}
    files: dict[str, bytes] = {}
    for method in sorted(set(methods)):
        rel = scores_service.csv_path_for_method(method)
        data = _method_csv_bytes(project_id, sha, method)
        if rel and data is not None:
            files[rel] = data
    return files


async def score_files(
    project: MappingProject,
    fmt: ScoresFormat = "csv",
    methods: list[str] | None = None,
) -> dict[str, bytes]:
    """`{tree path: bytes}` of the scores to export. `methods` defaults to the
    project's versioned ones — what git carries."""
    sha = _scores_sha(project)
    chosen = (project.versioned_score_methods or []) if methods is None else methods
    if not sha or not chosen:
        return {}
    return await asyncio.to_thread(_files_sync, project.id, sha, fmt, list(chosen))


async def replace_methods(
    db,
    project: MappingProject,
    csvs: list[tuple[str, str]],
    removed: list[str] | None = None,
) -> str | None:
    """Replace each (method, csv path)'s rows with the CSV's, drop the `removed`
    methods, and point the project at the new scores file. Returns its sha, None
    when nothing remains. The caller holds `scores_lock`."""
    from app.schemas.mapping_project import MappingProjectUpdate
    from app.services import mapping_project_service

    await db.refresh(project)
    existing = _scores_sha(project)
    existing_path = str(blob_store.path_for(existing)) if existing else None
    with tempfile.TemporaryDirectory() as tmp:
        merged = Path(tmp) / "merged.parquet"
        kept = Path(tmp) / "kept.parquet"
        source = existing_path
        if removed and source:
            _, remaining = await asyncio.to_thread(
                scores_service.remove_rows, source, removed, None, str(kept)
            )
            source = str(kept) if remaining else None
        if csvs:
            total = await asyncio.to_thread(
                scores_service.merge_method_csvs, source, csvs, str(merged)
            )
            source = str(merged) if total else None
        if source is None:
            sha = None
        elif source == existing_path:
            sha = existing
        else:
            sha = (await blob_store.store_file(Path(source)))[0]
    if sha != existing:
        await mapping_project_service.update(
            db,
            project,
            MappingProjectUpdate(
                scores_file_sha=sha,
                scores_file_name=(project.scores_file_name or SCORES_PARQUET_FILE) if sha else None,
            ),
        )
    return sha


async def method_stats(project: MappingProject) -> list[dict]:
    sha = _scores_sha(project)
    if not sha:
        return []
    return await asyncio.to_thread(scores_service.method_stats, str(blob_store.path_for(sha)))
