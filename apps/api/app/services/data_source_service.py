import asyncio
import contextlib
from collections.abc import Callable
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import crypto
from app.models.data_source import DataSource, DataSourceFile
from app.models.user import User
from app.schemas.data_source import (
    DatabaseConnectionInfo,
    DataSourceCreate,
    DataSourceFileImportRequest,
    DataSourceUpdate,
    ParquetTablePath,
)
from app.services import author_provenance, blob_store, concept_stats_cache_service, git_secret
from app.services.data import (
    concept_cache_fs,
    connection_pool,
    db_connect,
    managed_db,
)

# External network databases reached via DuckDB's ATTACH extensions.
_EXTERNAL_ENGINES = ("postgresql", "mysql")
# File databases uploaded to the blob store and attached from disk server-side.
_FILE_ENGINES = ("duckdb", "sqlite")


async def _source_files(db: AsyncSession, source: DataSource) -> list[tuple[str, str]]:
    """(file_name, blob_path) for each file backing the source, in insertion order."""
    files = await list_files(db, source.id)
    return [(f.file_name, str(blob_store.path_for(f.content_hash))) for f in files]


def _known_tables(source: DataSource) -> list[str]:
    mapping = source.schema_mapping or {}
    known = mapping.get("knownTables")
    return [str(t) for t in known] if isinstance(known, list) else []


def _is_parquet_folder(config: dict, files: list[tuple[str, str]]) -> bool:
    """Multiple files (or a Parquet-typed import) → a folder of Parquet tables
    rather than one attachable DuckDB/SQLite database file."""
    if len(files) > 1:
        return True
    return bool(files) and files[0][0].lower().endswith((".parquet", ".pq"))


def parquet_table_paths(
    source: DataSource, files: list[tuple[str, str]]
) -> dict[str, list[str]]:
    """Table name → blob path(s) for a Parquet source.

    Delegates the grouping to db_connect so the names shown match the ones the
    SQL editor resolves; a file whose name yields no safe identifier is dropped
    there, and is therefore absent here too.
    """
    return db_connect.group_parquet_tables(files, _known_tables(source))

# Connection-config keys holding a secret credential. Pulled out of the JSON
# config (which the API returns) and stored encrypted in `connection_secret`.
_SECRET_KEYS = ("password", "token")


def strip_secrets(config: dict | None) -> dict:
    """Return a copy of `config` with secret credentials removed."""
    if not config:
        return {}
    return {k: v for k, v in config.items() if k not in _SECRET_KEYS}


def _extract_secret(config: dict | None) -> str | None:
    """The first secret credential present in the config (password or token)."""
    if not config:
        return None
    for key in _SECRET_KEYS:
        if config.get(key):
            return str(config[key])
    return None


def connection_password(source: DataSource) -> str | None:
    """Decrypt the stored external-DB password for opening a connection."""
    return crypto.decrypt(source.connection_secret) if source.connection_secret else None


# --- Data sources ----------------------------------------------------------

async def list_all(db: AsyncSession) -> list[DataSource]:
    result = await db.execute(select(DataSource))
    return list(result.scalars().all())


async def list_for_workspace(db: AsyncSession, workspace_id: str) -> list[DataSource]:
    result = await db.execute(
        select(DataSource).where(DataSource.workspace_id == workspace_id)
    )
    return list(result.scalars().all())


async def get(db: AsyncSession, source_id: str) -> DataSource | None:
    return await db.get(DataSource, source_id)


async def create(db: AsyncSession, data: DataSourceCreate, owner: User) -> DataSource:
    payload = data.model_dump(exclude_none=True)
    # A foreign instance's created_by_id is meaningless here — never persist it;
    # stamp_creator derives the right local id (ORCID/email match, or NULL).
    payload.pop("created_by_id", None)
    config = payload.get("connection_config")
    secret = _extract_secret(config)
    payload["connection_config"] = strip_secrets(config)
    # The git access token never lands in the entity's JSON column (it would be
    # served straight back by the API); git_credential_service holds it per host.
    git_secret.apply_to_entity(None, payload)
    source = DataSource(
        **payload,
        owner_id=owner.id,
        connection_secret=crypto.encrypt(secret) if secret else None,
    )
    await author_provenance.stamp_creator(db, source, payload, owner)
    db.add(source)
    await db.commit()
    await db.refresh(source)
    return source


async def update(
    db: AsyncSession, source: DataSource, data: DataSourceUpdate
) -> DataSource:
    changes = data.model_dump(exclude_unset=True)
    if "connection_config" in changes:
        # A password present in the update re-encrypts; its absence leaves the
        # stored secret untouched (editing other fields won't wipe credentials).
        secret = _extract_secret(changes["connection_config"])
        if secret is not None:
            source.connection_secret = crypto.encrypt(secret)
        changes["connection_config"] = strip_secrets(changes["connection_config"])
    git_secret.apply_to_entity(source, changes)
    for key, value in changes.items():
        setattr(source, key, value)
    # A database is created from the workspace pointer, which publishes no author,
    # so the create stamped the importing user. The clone then writes the repo's
    # real author a moment later — without re-resolving the id, the UI kept
    # re-hydrating the importer's name over the snapshot it just stored.
    # After the setattr loop, like the other services: it must overwrite whatever
    # created_by_id the changes carried, not be overwritten by it.
    await author_provenance.relink_creator_on_update(db, source, changes)
    await db.commit()
    await db.refresh(source)
    # A changed host/credential/file must not keep being served through a warm
    # connection opened against the old config.
    connection_pool.invalidate(source.id)
    # The shared concept caches reflect the old data; drop them so the next
    # visitor recomputes against the new config.
    concept_cache_fs.invalidate(source.id)
    await concept_stats_cache_service.delete_for_source(db, source.id)
    return source


async def delete(db: AsyncSession, source: DataSource) -> None:
    files = (
        await db.execute(
            select(DataSourceFile).where(DataSourceFile.data_source_id == source.id)
        )
    ).scalars().all()
    shas = {f.content_hash for f in files}
    was_managed = is_managed(source)
    source_id = source.id
    await db.delete(source)  # cascades to data_source_files via FK
    await db.commit()
    connection_pool.invalidate(source_id)
    # A managed file is owned by this source alone — nothing else references it.
    if was_managed:
        managed_db.delete(source_id)
    for sha in shas:
        if not await _sha_still_referenced(db, sha):
            await blob_store.delete(sha)


# --- Files (blob-backed, deduplicated by sha) ------------------------------

async def list_files(db: AsyncSession, source_id: str) -> list[DataSourceFile]:
    result = await db.execute(
        select(DataSourceFile).where(DataSourceFile.data_source_id == source_id)
    )
    return list(result.scalars().all())


async def get_file(db: AsyncSession, file_id: str) -> DataSourceFile | None:
    return await db.get(DataSourceFile, file_id)


async def _sha_still_referenced(db: AsyncSession, sha: str) -> bool:
    q = select(DataSourceFile.id).where(DataSourceFile.content_hash == sha).limit(1)
    return (await db.execute(q)).first() is not None


async def import_file(
    db: AsyncSession, req: DataSourceFileImportRequest
) -> DataSourceFile:
    """Register an already-uploaded blob (by sha) as a file of the source. The
    blob store is content-addressed, so identical bytes are stored once."""
    row = DataSourceFile(
        data_source_id=req.data_source_id,
        file_name=req.file_name,
        file_size=req.file_size,
        content_hash=req.sha,
    )
    db.add(row)
    await db.commit()
    await db.refresh(row)
    # The source's file set changed — a warm connection holds views over the old
    # files, so drop it and let the next query rebuild from the new set.
    connection_pool.invalidate(req.data_source_id)
    concept_cache_fs.invalidate(req.data_source_id)
    await concept_stats_cache_service.delete_for_source(db, req.data_source_id)
    return row


async def delete_file(db: AsyncSession, file: DataSourceFile) -> None:
    sha = file.content_hash
    source_id = file.data_source_id
    await db.delete(file)
    await db.commit()
    connection_pool.invalidate(source_id)
    concept_cache_fs.invalidate(source_id)
    await concept_stats_cache_service.delete_for_source(db, source_id)
    if not await _sha_still_referenced(db, sha):
        await blob_store.delete(sha)


def is_managed(source: DataSource) -> bool:
    """A server-owned, writable DuckDB file (created from a schema's DDL)."""
    return bool((source.connection_config or {}).get("managed"))


def is_external_engine(engine: str | None) -> bool:
    """A network database (Postgres/MySQL) rather than a local file."""
    return engine in _EXTERNAL_ENGINES


async def connection_info(db: AsyncSession, source: DataSource) -> DatabaseConnectionInfo:
    """How to reach `source` from outside Linkr — never its password.

    Shared by GET /data-sources/{id}/connection-info and the per-project database
    listing the client libraries read, so a script and the UI are told the same
    thing about the same database. Callers must have checked `databases:read`.
    """
    from pathlib import Path

    config = dict(source.connection_config or {})
    engine = config.get("engine")

    if is_external_engine(engine):
        return DatabaseConnectionInfo(
            engine=engine,
            kind="external",
            host=config.get("host"),
            port=config.get("port"),
            database=config.get("database"),
            schema_name=config.get("schema"),
            username=config.get("username"),
        )

    if is_managed(source):
        path = managed_db.path_for(source.id)
        return DatabaseConnectionInfo(
            engine="duckdb", kind="file", path=str(path), exists=path.exists()
        )

    files = await list_files(db, source.id)
    if not files:
        return DatabaseConnectionInfo(engine=engine)

    paths = [blob_store.path_for(f.content_hash) for f in files]
    names = [f.file_name for f in files]
    # A Parquet source is addressed table by table, NOT by the directory holding
    # the blobs: that directory is the shared content-addressed store, so it mixes
    # in every other source's files and its entries have no .parquet suffix for a
    # glob to match. `path` is deliberately left unset.
    if len(files) > 1 or names[0].lower().endswith((".parquet", ".pq")):
        pairs = [(f.file_name, str(blob_store.path_for(f.content_hash))) for f in files]
        groups = parquet_table_paths(source, pairs)
        return DatabaseConnectionInfo(
            engine=engine,
            kind="parquet-folder",
            exists=all(p.is_file() for p in paths),
            blob=True,
            file_names=names,
            tables=[
                ParquetTablePath(
                    table=table,
                    paths=table_paths,
                    exists=all(Path(p).is_file() for p in table_paths),
                )
                for table, table_paths in sorted(groups.items())
            ],
        )

    return DatabaseConnectionInfo(
        engine=engine,
        kind="file",
        path=str(paths[0]),
        exists=paths[0].is_file(),
        # Content-addressed: the file is named by its sha, with no extension, so
        # a tool that keys off ".duckdb" needs telling.
        blob=True,
        file_names=names,
    )


async def role_attachments(
    db: AsyncSession, sources: dict[str, DataSource]
) -> dict[str, dict]:
    """Describe how to ATTACH each role database for an ETL run.

    Shape mirrors `db_connect.run_etl_sql`'s `roles` argument. A role whose
    source cannot be attached (no file uploaded yet) is skipped, so the script
    fails naming that role rather than failing to open the connection at all.
    """
    out: dict[str, dict] = {}
    for role, source in sources.items():
        if source is None:
            continue
        config = dict(source.connection_config or {})
        engine = config.get("engine")
        if engine in _EXTERNAL_ENGINES:
            out[role] = {
                "kind": "external",
                "config": config,
                "password": connection_password(source),
            }
            continue
        if is_managed(source):
            path = managed_db.path_for(source.id)
            if path.exists():
                out[role] = {"kind": "file", "engine": "duckdb", "path": str(path)}
            continue
        if engine in _FILE_ENGINES:
            files = await _source_files(db, source)
            if not files:
                continue
            if _is_parquet_folder(config, files):
                out[role] = {
                    "kind": "parquet",
                    "files": files,
                    "known": _known_tables(source),
                }
            else:
                out[role] = {
                    "kind": "file",
                    "engine": engine,
                    "path": files[0][1],
                }
    return out


async def run_etl(
    db: AsyncSession,
    target: DataSource,
    sql: str,
    roles: dict[str, DataSource],
    mapping_data: dict[str, str] | None = None,
    on_statement: Callable[[int, int, str], None] | None = None,
) -> list[dict]:
    """Run ETL SQL with the target writable and the other roles attached read-only.

    `on_statement(index, total, sql)` is invoked from the worker THREAD before
    each statement, so a streaming caller must marshal it back to the loop
    (`call_soon_threadsafe`) rather than await inside it."""
    if not is_managed(target):
        raise ValueError(
            "the pipeline target must be a database created from a schema"
        )
    target_path = managed_db.path_for(target.id)
    if not target_path.exists():
        raise ValueError("the target database file is missing; recreate it")

    # DuckDB refuses to attach the same FILE twice in one process, whatever the
    # alias. Browsing a managed database leaves a warm pooled connection holding
    # it READ_ONLY as `ext` (query_file), so a later ETL run asking for it as a
    # writable `target` failed with "Unique file handle conflict" — and stayed
    # broken until the server restarted, because the pool kept the handle.
    #
    # Evicting first hands the file to the run. `invalidate` waits for any
    # in-flight query on that connection, so nothing is closed mid-statement; the
    # next browse simply re-establishes a warm connection.
    for source in (target, *roles.values()):
        connection_pool.invalidate(source.id)

    attachments = await role_attachments(db, {k: v for k, v in roles.items() if k != "target"})

    # `asyncio.to_thread` cannot be cancelled: if the client goes away mid-run (a
    # browser reload), the await returns but the worker thread keeps going, holding
    # the target ATTACHed — every retry then failed with "Unique file handle
    # conflict ... already attached by database 'target'" until it finished.
    # The handle lets us interrupt the statement so the thread unwinds and frees
    # the file. Shielded so the cancellation reaches us here rather than tearing
    # down the await while the thread is still bound to the connection.
    handle = db_connect.EtlRunHandle()
    task = asyncio.create_task(
        asyncio.to_thread(
            db_connect.run_etl_sql,
            str(target_path),
            sql,
            attachments,
            mapping_data,
            handle,
            on_statement,
        )
    )
    try:
        return await asyncio.shield(task)
    except asyncio.CancelledError:
        handle.cancel()
        # Wait for the thread to actually release the file, so the next request
        # (the user retrying) does not race the attach it is about to drop.
        with contextlib.suppress(BaseException):
            await task
        raise


async def client_recipe(db: AsyncSession, source: DataSource) -> dict:
    """How the R/Python client libraries open this database themselves.

    Unlike `query`, which runs the SQL here and returns rows, this hands the script
    what it needs to hold its own DuckDB connection — so it gets a real DBI/DBAPI
    handle and everything built on one (dbplyr, joins against local Parquet). For an
    external engine that includes the decrypted password, since the ATTACH happens
    in the script's process. The caller MUST have checked `databases:read` first.
    """
    config = dict(source.connection_config or {})
    engine = config.get("engine")

    if engine in _EXTERNAL_ENGINES:
        recipe = db_connect.attach_recipe(config, connection_password(source))
        return {
            "engine": engine,
            "kind": "external",
            "connectable": True,
            "attach_type": recipe["type"],
            "attach_dsn": recipe["dsn"],
            "attach_scope": recipe["scope"],
        }

    if is_managed(source):
        path = managed_db.path_for(source.id)
        return {
            "engine": "duckdb",
            "kind": "managed",
            "connectable": path.exists(),
            "path": str(path),
        }

    if engine in _FILE_ENGINES:
        files = await _source_files(db, source)
        if not files:
            return {"engine": engine, "kind": "file", "connectable": False}
        if _is_parquet_folder(config, files):
            groups = parquet_table_paths(source, files)
            return {
                "engine": engine,
                "kind": "parquet-folder",
                "connectable": bool(groups),
                "tables": [
                    {
                        "table": table,
                        "paths": paths,
                        "exists": all(Path(p).is_file() for p in paths),
                    }
                    for table, paths in sorted(groups.items())
                ],
            }
        return {
            "engine": engine,
            "kind": "file",
            "connectable": Path(files[0][1]).is_file(),
            "path": files[0][1],
        }

    return {"engine": engine, "kind": None, "connectable": False}


# --- Live connection test (external databases) -----------------------------

async def query(db: AsyncSession, source: DataSource, sql: str) -> list[dict]:
    """Run read-only SQL server-side: ATTACH a network DB (decrypting its stored
    password) or a local DuckDB/SQLite file from the blob store. JSON-ready rows."""
    config = dict(source.connection_config or {})
    engine = config.get("engine")
    if engine in _EXTERNAL_ENGINES:
        password = connection_password(source)
        return await asyncio.to_thread(
            db_connect.query_external, config, password, sql, source.id
        )
    if is_managed(source):
        # Server-owned file: nothing in the blob store, read it where it lives.
        path = managed_db.path_for(source.id)
        if not path.exists():
            raise ValueError("the database file is missing; recreate it")
        return await asyncio.to_thread(
            db_connect.query_file, "duckdb", str(path), sql, source.id
        )
    if engine in _FILE_ENGINES:
        files = await _source_files(db, source)
        if not files:
            raise ValueError("no database file uploaded for this source")
        if _is_parquet_folder(config, files):
            known = _known_tables(source)
            return await asyncio.to_thread(
                db_connect.query_parquet_folder, files, known, sql, source.id
            )
        return await asyncio.to_thread(
            db_connect.query_file, engine, files[0][1], sql, source.id
        )
    raise ValueError(f"queries not supported for engine: {engine}")


async def refresh_concept_cache(
    db: AsyncSession, source: DataSource, select_sql: str
) -> float:
    """Materialize the concept list (`select_sql`) to the source's Parquet cache
    and return the new mtime. Gathers the same connection inputs as `query`."""
    config = dict(source.connection_config or {})
    engine = config.get("engine")
    password = connection_password(source) if engine in _EXTERNAL_ENGINES else None
    files = None
    known = None
    if is_managed(source):
        # Server-owned file: nothing in the blob store, so hand the materializer
        # the path where it lives — same single-DuckDB-file shape as an upload.
        path = managed_db.path_for(source.id)
        if not path.exists():
            raise ValueError("the database file is missing; recreate it")
        files = [(path.name, str(path))]
    elif engine in _FILE_ENGINES:
        files = await _source_files(db, source)
        if not files:
            raise ValueError("no database file uploaded for this source")
        known = _known_tables(source)
    return await asyncio.to_thread(
        concept_cache_fs.refresh, config, password, files, known, select_sql, source.id
    )


async def query_concept_cache(source_id: str, sql: str) -> list[dict]:
    """Run a page query against the source's cached concept Parquet."""
    return await asyncio.to_thread(concept_cache_fs.query_page, source_id, sql)


async def introspect(db: AsyncSession, source: DataSource) -> list[dict]:
    """Introspect a stored source's schema (tables + columns) server-side — for
    network DBs via their password, for file DBs via the uploaded blob."""
    config = dict(source.connection_config or {})
    engine = config.get("engine")
    if engine in _EXTERNAL_ENGINES:
        password = connection_password(source)
        return await asyncio.to_thread(db_connect.introspect_external, config, password)
    if is_managed(source):
        # Server-owned file: nothing in the blob store, introspect it in place.
        path = managed_db.path_for(source.id)
        if not path.exists():
            return []
        return await asyncio.to_thread(db_connect.introspect_file, "duckdb", str(path))
    if engine in _FILE_ENGINES:
        files = await _source_files(db, source)
        if not files:
            return []
        if _is_parquet_folder(config, files):
            known = _known_tables(source)
            return await asyncio.to_thread(db_connect.introspect_parquet_folder, files, known)
        return await asyncio.to_thread(db_connect.introspect_file, engine, files[0][1])
    return []


async def test_connection_stored(
    source: DataSource,
) -> tuple[bool, str | None, list[dict]]:
    """Re-test a stored source using its decrypted password (no client secret)."""
    # A managed file has no credentials to re-send: the test is whether the file
    # is there and can be opened. Without this it fell through to the external
    # path and answered "unsupported engine", so a managed database that failed
    # once — a held lock, a run interrupted mid-write — stayed `error` forever,
    # its only offered way out being the rebuild that empties it.
    if is_managed(source):
        path = managed_db.path_for(source.id)
        if not path.exists():
            return False, f"database file not found: {path}", []
        try:
            tables = await asyncio.to_thread(
                db_connect.introspect_file, "duckdb", str(path)
            )
            return True, None, tables
        except Exception as e:  # noqa: BLE001 — the driver's message is the diagnosis
            return False, str(e), []

    config = dict(source.connection_config or {})
    config["password"] = connection_password(source)
    return await test_connection(config)


async def test_connection(config: dict) -> tuple[bool, str | None, list[dict]]:
    """Open a live connection using the (unpersisted) password in `config`,
    introspect the schema, and return (ok, error, tables)."""
    engine = config.get("engine")
    if engine not in _EXTERNAL_ENGINES:
        return False, f"unsupported engine for server-side test: {engine}", []
    password = config.get("password")
    try:
        tables = await asyncio.to_thread(
            db_connect.introspect_external, config, password
        )
        return True, None, tables
    except Exception as e:  # noqa: BLE001 — surface driver/connection errors to the UI
        return False, str(e), []
