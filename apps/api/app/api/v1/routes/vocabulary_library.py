"""A workspace's OHDSI vocabulary library: inventory, ATHENA import, removal.

The library itself is a data source (`connectionConfig.vocabularyLibrary`), which
the client creates with its schema mapping before the first import; its
`connectionConfig.vocabularies` is the inventory (one entry per vocabulary held).
See services/vocabulary_library.py.
"""

import asyncio
import zipfile
from datetime import datetime, timezone
from functools import partial
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm.attributes import flag_modified

from app.core import deferred
from app.core.database import async_session, get_db
from app.core.deps import get_current_user
from app.core.permissions import check_workspace_permission
from app.models.data_source import DataSource
from app.models.user import User
from app.schemas.base import CamelModel
from app.services import blob_store, data_source_service, fs_browser
from app.services import vocabulary_library as lib
from app.services.data import concept_cache_fs, connection_pool
from app.services.execution import jobs

router = APIRouter(prefix="/workspaces/{workspace_id}/vocabulary-library", tags=["vocabulary-library"])


class ExportFile(CamelModel):
    file_name: str
    sha: str


class ExportSource(CamelModel):
    """Where an ATHENA export is: uploaded files, files on the server, or an
    older per-project vocabulary database (to move it into the library). Either
    kind of file may be the download's zip."""

    files: list[ExportFile] | None = None
    server_paths: list[str] | None = None
    data_source_id: str | None = None


class ImportRequest(CamelModel):
    source: ExportSource
    vocabularies: list[str]


async def _library(db: AsyncSession, workspace_id: str) -> DataSource | None:
    res = await db.execute(
        select(DataSource).where(
            DataSource.workspace_id == workspace_id, DataSource.is_vocabulary_reference.is_(True)
        )
    )
    return next(
        (ds for ds in res.scalars().all() if (ds.connection_config or {}).get("vocabularyLibrary")),
        None,
    )


def _inventory(library: DataSource | None) -> list[dict]:
    return list((library.connection_config or {}).get("vocabularies") or []) if library else []


async def _export_files(db: AsyncSession, workspace_id: str, user: User, source: ExportSource) -> list[tuple[str, str]]:
    if source.files:
        out = []
        for f in source.files:
            if not blob_store.exists(f.sha):
                raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Uploaded file not found: {f.file_name}")
            out.append((f.file_name, str(blob_store.path_for(f.sha))))
        return out
    if source.server_paths:
        scope = await fs_browser.import_scope(db, None, user)
        out = []
        for server_path in source.server_paths:
            try:
                fs_browser.validate_source_path(server_path, scope)
            except fs_browser.FsBrowseError as e:
                raise HTTPException(e.status_code, str(e)) from e
            path = Path(server_path)
            if not path.is_file():
                raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Not a file: {server_path}")
            out.append((path.name, str(path)))
        return out
    if source.data_source_id:
        ds = await data_source_service.get(db, source.data_source_id)
        if ds is None or ds.workspace_id != workspace_id:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Database not found")
        return await data_source_service.source_files(db, ds)
    raise HTTPException(status.HTTP_400_BAD_REQUEST, "No source")


@router.get("")
async def get_library(
    workspace_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """The library data source and its vocabularies (with their size on disk);
    `dataSourceId` null before the first import."""
    await check_workspace_permission(db, workspace_id, user, "concept-mapping:read")
    library = await _library(db, workspace_id)
    return {
        "dataSourceId": library.id if library else None,
        "vocabularies": [
            {**v, "sizeBytes": lib.library_size(workspace_id, v["vocabularyId"])}
            for v in _inventory(library)
        ],
    }


@router.post("/inspect")
async def inspect_export(
    workspace_id: str,
    source: ExportSource,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """The vocabularies an ATHENA export holds, each with the version the
    library has of it (null when absent), so the client can preview the import."""
    await check_workspace_permission(db, workspace_id, user, "workspace-settings:write")
    files = await _export_files(db, workspace_id, user, source)
    held = {v["vocabularyId"]: v for v in _inventory(await _library(db, workspace_id))}

    async def work() -> dict:
        try:
            found = await asyncio.to_thread(lambda: lib.inspect_export(lib.expand_zips(files)))
        except (ValueError, zipfile.BadZipFile) as e:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, str(e))
        for v in found["vocabularies"]:
            v["libraryVersion"] = held.get(v["vocabularyId"], {}).get("vocabularyVersion")
            v["inLibrary"] = v["vocabularyId"] in held
        return found

    # A full ATHENA export is gigabytes to read: past `deferred.WAIT_SECONDS` the
    # inspection goes on as a job (core/deferred).
    return await deferred.respond(user.id, work, deferred.AsJob("Inspect vocabulary export", workspace_id=workspace_id))


@router.post("/import")
async def start_import(
    workspace_id: str,
    body: ImportRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Write the chosen vocabularies into the library, in the background; poll
    `GET /imports/{id}`. Replaces the vocabularies already held."""
    await check_workspace_permission(db, workspace_id, user, "workspace-settings:write")
    library = await _library(db, workspace_id)
    if library is None:
        raise HTTPException(status.HTTP_409_CONFLICT, "The workspace has no vocabulary library yet")
    files = await _export_files(db, workspace_id, user, body.source)
    library_id = library.id
    source_label = _source_label(body.source, files)

    async def start() -> dict:
        try:
            found = await asyncio.to_thread(lambda: lib.inspect_export(lib.expand_zips(files)))
        except (ValueError, zipfile.BadZipFile) as e:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, str(e))
        by_id = {v["vocabularyId"]: v for v in found["vocabularies"]}
        chosen = [v for v in body.vocabularies if v in by_id]
        if not chosen:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "None of these vocabularies is in the export")
        state = lib.start_import(workspace_id, partial(run, found, by_id, chosen))
        # A job of the panel, which can stop it: the library stays as it was
        # unless the swap had begun.
        async with deferred.session() as session:
            job = await jobs.create(
                session, None, user.id, "vocab-import", f"Import {', '.join(chosen)[:200]}", workspace_id=workspace_id,
            )
        await jobs.adopt(job.id, state.task)
        return state.as_dict()

    async def run(found: dict, by_id: dict, chosen: list[str], state: lib.ImportState) -> None:
        # The import rewrites files the pooled connection has open.
        connection_pool.invalidate(library_id)
        try:
            written = await asyncio.to_thread(
                lambda: lib.write_partitions(workspace_id, lib.expand_zips(files), chosen, state)
            )
        finally:
            await asyncio.to_thread(lib.discard_zip_expansions, files)
        connection_pool.invalidate(library_id)
        concept_cache_fs.invalidate(library_id)
        # The request's session is gone by now: a job opens its own.
        async with async_session() as session:
            ds = await session.get(DataSource, library_id)
            if ds is None:
                return
            now = datetime.now(timezone.utc).isoformat()
            inventory = {v["vocabularyId"]: v for v in _inventory(ds)}
            for w in written:
                meta = by_id[w["vocabularyId"]]
                inventory[w["vocabularyId"]] = {
                    "vocabularyId": w["vocabularyId"],
                    "vocabularyName": meta["vocabularyName"],
                    "vocabularyVersion": meta["vocabularyVersion"],
                    "release": found["release"],
                    "conceptCount": w["rowCounts"].get("concept", 0),
                    "rowCounts": w["rowCounts"],
                    "source": source_label,
                    "importedAt": now,
                }
            config = dict(ds.connection_config or {})
            config["vocabularies"] = sorted(inventory.values(), key=lambda v: v["vocabularyId"])
            ds.connection_config = config
            flag_modified(ds, "connection_config")
            _set_known_tables(ds, workspace_id)
            await session.commit()
        state.vocabularies = written

    # The export is read once more to check the choice: past
    # `deferred.WAIT_SECONDS` that goes on in the background too (core/deferred).
    return await deferred.respond(user.id, start)


def _source_label(source: ExportSource, files: list[tuple[str, str]]) -> str:
    if source.server_paths:
        if len(source.server_paths) == 1:
            return source.server_paths[0]
        parents = {str(Path(p).parent) for p in source.server_paths}
        return next(iter(parents)) if len(parents) == 1 else f"{len(files)} files"
    if source.files:
        if len(source.files) == 1:
            return source.files[0].file_name
        roots = {f.file_name.replace("\\", "/").split("/")[0] for f in source.files if "/" in f.file_name}
        return next(iter(roots)) if len(roots) == 1 else f"{len(files)} files"
    return "database"


@router.get("/imports/{import_id}")
async def get_import(
    workspace_id: str,
    import_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await check_workspace_permission(db, workspace_id, user, "concept-mapping:read")
    state = lib.import_state(import_id)
    if state is None or state.workspace_id != workspace_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Import not found")
    return state.as_dict()


@router.delete("/vocabularies/{vocabulary_id}", status_code=status.HTTP_204_NO_CONTENT)
async def remove_vocabulary(
    workspace_id: str,
    vocabulary_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await check_workspace_permission(db, workspace_id, user, "workspace-settings:write")
    library = await _library(db, workspace_id)
    if library is None:
        return
    # An import rewrites the inventory it read before writing its partitions:
    # a removal in between would be overwritten. Waiting for it here would hold
    # the request open for as long as the import runs — minutes.
    if lib.is_busy(workspace_id):
        raise HTTPException(status.HTTP_409_CONFLICT, "An import into this library is running; retry when it ends")
    async with lib.workspace_lock(workspace_id):
        await db.refresh(library)
        connection_pool.invalidate(library.id)
        await asyncio.to_thread(lib.remove_partitions, workspace_id, vocabulary_id)
        concept_cache_fs.invalidate(library.id)
        config = dict(library.connection_config or {})
        config["vocabularies"] = [v for v in _inventory(library) if v["vocabularyId"] != vocabulary_id]
        library.connection_config = config
        flag_modified(library, "connection_config")
        _set_known_tables(library, workspace_id)
        await db.commit()


def _set_known_tables(library: DataSource, workspace_id: str) -> None:
    mapping = dict(library.schema_mapping or {})
    mapping["knownTables"] = lib.present_tables(workspace_id)
    library.schema_mapping = mapping
    flag_modified(library, "schema_mapping")
