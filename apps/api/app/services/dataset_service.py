import asyncio
import time

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.dataset import DatasetAnalysis, DatasetFile
from app.models.user import User
from app.schemas.dataset import (
    DatasetAnalysisCreate,
    DatasetAnalysisUpdate,
    DatasetFileCreate,
    DatasetFileUpdate,
    DatasetImportRequest,
)
from app.services import blob_store
from app.services.data import dataset_rows
from app.services.data.dataset_parser import parse_blob


# --- Dataset files ---------------------------------------------------------

async def list_for_project(db: AsyncSession, project_uid: str) -> list[DatasetFile]:
    result = await db.execute(
        select(DatasetFile).where(DatasetFile.project_uid == project_uid)
    )
    return list(result.scalars().all())


async def get(db: AsyncSession, file_id: str) -> DatasetFile | None:
    return await db.get(DatasetFile, file_id)


async def create(db: AsyncSession, data: DatasetFileCreate, owner: User) -> DatasetFile:
    payload = data.model_dump(exclude_none=True)
    node = DatasetFile(**payload, owner_id=owner.id)
    # Stamp creator provenance: the id is always the authenticated user; the
    # display snapshot falls back to the current user when the payload (import)
    # didn't carry one.
    node.created_by_id = owner.id
    if not payload.get("created_by"):
        full = f"{owner.first_name or ''} {owner.last_name or ''}".strip()
        node.created_by = full or owner.username
    if not payload.get("created_by_details"):
        node.created_by_details = {
            k: v
            for k, v in {
                "firstName": owner.first_name,
                "lastName": owner.last_name,
                "affiliation": owner.affiliation,
                "profession": owner.profession,
                "orcid": owner.orcid,
            }.items()
            if v
        }
    db.add(node)
    await db.commit()
    await db.refresh(node)
    return node


async def duplicate(
    db: AsyncSession, node: DatasetFile, name: str, owner: User
) -> DatasetFile:
    """Copy a dataset file. The blob store is content-addressed, so the copy just
    re-points the same data_sha/raw_sha — no bytes are duplicated on disk."""
    copy = DatasetFile(
        project_uid=node.project_uid,
        name=name,
        type=node.type,
        parent_id=node.parent_id,
        columns=node.columns,
        row_count=node.row_count,
        parse_options=node.parse_options,
        data_sha=node.data_sha,
        raw_sha=node.raw_sha,
        raw_file_name=node.raw_file_name,
        origin=node.origin,
        owner_id=owner.id,
    )
    db.add(copy)
    await db.commit()
    await db.refresh(copy)
    return copy


async def update(
    db: AsyncSession, node: DatasetFile, data: DatasetFileUpdate
) -> DatasetFile:
    for key, value in data.model_dump(exclude_unset=True).items():
        setattr(node, key, value)
    await db.commit()
    await db.refresh(node)
    return node


async def _sha_still_referenced(db: AsyncSession, sha: str, exclude_id: str) -> bool:
    q = select(DatasetFile.id).where(
        (DatasetFile.data_sha == sha) | (DatasetFile.raw_sha == sha),
        DatasetFile.id != exclude_id,
    ).limit(1)
    return (await db.execute(q)).first() is not None


async def delete(db: AsyncSession, node: DatasetFile) -> None:
    # Gather this subtree's blob shas before the cascade removes the rows.
    shas: set[str] = set()

    async def collect(n: DatasetFile) -> None:
        if n.data_sha:
            shas.add(n.data_sha)
        if n.raw_sha:
            shas.add(n.raw_sha)
        children = (
            await db.execute(select(DatasetFile).where(DatasetFile.parent_id == n.id))
        ).scalars().all()
        for c in children:
            await collect(c)

    await collect(node)
    node_id = node.id
    await db.delete(node)  # cascades to children + analyses via FK
    await db.commit()

    # Free blobs no longer referenced by any remaining row.
    for sha in shas:
        if not await _sha_still_referenced(db, sha, node_id):
            await blob_store.delete(sha)


# --- Import / re-import (parse a blob into a file) -------------------------

async def _write_rows_blob(rows: list[dict], columns: list[dict] | None) -> str:
    """Serialise rows to a typed Parquet blob (see data/dataset_rows.py)."""
    path = await asyncio.to_thread(dataset_rows.write_parquet, rows, columns or [])
    sha, _ = await blob_store.store_file(path)
    return sha


class DatasetParseError(Exception):
    """A blob could not be parsed into a dataset (bad format / options)."""


async def import_file(
    db: AsyncSession, req: DatasetImportRequest, owner: User
) -> DatasetFile:
    stamp = int(time.time() * 1000)
    try:
        columns, rows, row_count = parse_blob(
            blob_store.path_for(req.sha), req.file_name, req.parse_options, stamp
        )
    except Exception as e:  # noqa: BLE001 — normalize parser/DuckDB errors
        raise DatasetParseError(str(e)) from e
    data_sha = await _write_rows_blob(rows, columns)
    node = DatasetFile(
        project_uid=req.project_uid,
        name=req.name,
        type="file",
        parent_id=req.parent_id,
        columns=columns,
        row_count=row_count,
        parse_options=req.parse_options,
        data_sha=data_sha,
        raw_sha=req.sha,
        raw_file_name=req.file_name,
        owner_id=owner.id,
    )
    db.add(node)
    await db.commit()
    await db.refresh(node)
    return node


async def reimport_file(
    db: AsyncSession, node: DatasetFile, parse_options: dict | None
) -> DatasetFile:
    if not node.raw_sha:
        raise ValueError("no raw file to re-parse")
    stamp = int(time.time() * 1000)
    try:
        columns, rows, row_count = parse_blob(
            blob_store.path_for(node.raw_sha),
            node.raw_file_name or "data.csv",
            parse_options,
            stamp,
        )
    except Exception as e:  # noqa: BLE001
        raise DatasetParseError(str(e)) from e
    old_data_sha = node.data_sha
    node.columns = columns
    node.row_count = row_count
    node.parse_options = parse_options
    node.data_sha = await _write_rows_blob(rows, columns)
    await db.commit()
    await db.refresh(node)
    if old_data_sha and old_data_sha != node.data_sha:
        if not await _sha_still_referenced(db, old_data_sha, node.id):
            await blob_store.delete(old_data_sha)
    return node


# --- Row data (heavy, blob-backed) -----------------------------------------

async def read_rows(node: DatasetFile) -> list[dict]:
    if not node.data_sha or not blob_store.exists(node.data_sha):
        return []
    return await asyncio.to_thread(
        dataset_rows.read_parquet, blob_store.path_for(node.data_sha)
    )


def _col_types(node: DatasetFile) -> dict[str, str]:
    return {c["id"]: c.get("type", "string") for c in (node.columns or [])}


async def query_rows(
    node: DatasetFile,
    *,
    offset: int,
    limit: int,
    sort: dict | None,
    filters: list[dict] | None,
    na: list[dict] | None,
) -> tuple[list[dict], int]:
    """A page of rows + total-after-filters, computed server-side on the Parquet."""
    if not node.data_sha or not blob_store.exists(node.data_sha):
        return [], 0
    return await asyncio.to_thread(
        dataset_rows.query_page,
        blob_store.path_for(node.data_sha),
        _col_types(node),
        offset=offset,
        limit=limit,
        sort=sort,
        filters=filters,
        na=na,
    )


async def column_stats(node: DatasetFile, col_id: str) -> dict:
    if not node.data_sha or not blob_store.exists(node.data_sha):
        return {}
    col_type = _col_types(node).get(col_id, "string")
    return await asyncio.to_thread(
        dataset_rows.column_stats, blob_store.path_for(node.data_sha), col_id, col_type
    )


async def write_rows(db: AsyncSession, node: DatasetFile, rows: list[dict]) -> None:
    old = node.data_sha
    node.data_sha = await _write_rows_blob(rows, node.columns)
    node.row_count = len(rows)
    await db.commit()
    if old and old != node.data_sha and not await _sha_still_referenced(db, old, node.id):
        await blob_store.delete(old)


# --- Analyses --------------------------------------------------------------

async def list_analyses(
    db: AsyncSession, project_uid: str, dataset_path: str
) -> list[DatasetAnalysis]:
    result = await db.execute(
        select(DatasetAnalysis).where(
            DatasetAnalysis.project_uid == project_uid,
            DatasetAnalysis.dataset_path == dataset_path,
        )
    )
    return list(result.scalars().all())


async def reconcile_analyses(db: AsyncSession, project_uid: str) -> None:
    """Delete analyses whose dataset path no longer exists under datasets/ on disk
    (e.g. the raw file was removed outside the app). Run on dataset scan/refresh."""
    from app.services import project_fs

    live = {
        n["path"] for n in project_fs.scan_datasets(project_uid) if n["type"] == "file"
    }
    result = await db.execute(
        select(DatasetAnalysis).where(DatasetAnalysis.project_uid == project_uid)
    )
    removed = False
    for a in result.scalars().all():
        if a.dataset_path not in live:
            await db.delete(a)
            removed = True
    if removed:
        await db.commit()


async def get_analysis(db: AsyncSession, analysis_id: str) -> DatasetAnalysis | None:
    return await db.get(DatasetAnalysis, analysis_id)


async def create_analysis(db: AsyncSession, data: DatasetAnalysisCreate) -> DatasetAnalysis:
    a = DatasetAnalysis(**data.model_dump(exclude_none=True))
    db.add(a)
    await db.commit()
    await db.refresh(a)
    return a


async def update_analysis(
    db: AsyncSession, a: DatasetAnalysis, data: DatasetAnalysisUpdate
) -> DatasetAnalysis:
    for key, value in data.model_dump(exclude_unset=True).items():
        setattr(a, key, value)
    await db.commit()
    await db.refresh(a)
    return a


async def delete_analysis(db: AsyncSession, a: DatasetAnalysis) -> None:
    await db.delete(a)
    await db.commit()
