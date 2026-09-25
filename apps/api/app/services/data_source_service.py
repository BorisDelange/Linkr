import asyncio
import contextlib
import threading
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import audit
from app.models.cohort import Cohort
from app.models.data_source import DataSource, DataSourceFile
from app.models.user import User
from app.schemas.data_source import (
    DatabaseConnectionInfo,
    DataSourceCreate,
    DataSourceFileImportRequest,
    DataSourceUpdate,
    ParquetTablePath,
)
from app.services import (
    author_provenance,
    blob_store,
    concept_stats_cache_service,
    database_credential_service,
    fs_browser,
    git_secret,
    stats_cache_service,
)
from app.services.database_credential_service import Login, pool_key, with_login
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


_PARQUET_SUFFIXES = (".parquet", ".pq")


def _server_path_files(path: str) -> list[tuple[str, str]]:
    """(file_name, absolute_path) for a `serverPath` source. A file is itself the
    single entry; a directory contributes its Parquet files, recursively — the
    layout ETL tools emit (one subfolder per table, possibly sharded).

    Unlike the blob store, these are real paths in a real folder, so the names
    carry their true extension and `_is_parquet_folder` / `group_parquet_tables`
    classify them exactly as they do an upload."""
    target = Path(path)
    if target.is_file():
        return [(target.name, str(target))]
    if not target.is_dir():
        return []
    found = sorted(
        (p for p in target.rglob("*") if p.is_file() and p.suffix.lower() in _PARQUET_SUFFIXES),
        key=lambda p: str(p).lower(),
    )
    # Relative names so a nested layout groups by table the way an upload's
    # webkitRelativePath does.
    return [(str(p.relative_to(target)), str(p)) for p in found]


async def _source_files(db: AsyncSession, source: DataSource) -> list[tuple[str, str]]:
    """(file_name, path) for each file backing the source, in insertion order.

    Three origins, one contract: a `serverPath` source reads the server filesystem
    in place, a managed database its own file, everything else the blob store."""
    path = server_path(source)
    if path:
        return _server_path_files(path)
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


def _file_size(path: Path | str) -> int | None:
    """Bytes on disk, or None when the file cannot be stat'd. None rather than 0
    so the UI can tell "missing" from "empty"."""
    try:
        return Path(path).stat().st_size
    except OSError:
        return None


def _parquet_table_entries(groups: dict[str, list[str]]) -> list[ParquetTablePath]:
    """Build the API rows for grouped Parquet tables, stat'ing each file once.

    Shared by the three branches of `connection_info` (server folder, blob store,
    single file) so the size and existence of a table are decided the same way in
    all of them — they used to each spell out the `exists` check.
    """
    entries: list[ParquetTablePath] = []
    for table, table_paths in sorted(groups.items()):
        # Unreadable or gone files are left out of the total rather than counted
        # as 0, so a partial table does not look complete.
        sizes = [n for n in (_file_size(p) for p in table_paths) if n is not None]
        entries.append(
            ParquetTablePath(
                table=table,
                paths=table_paths,
                exists=all(Path(p).is_file() for p in table_paths),
                size_bytes=sum(sizes) if sizes else None,
            )
        )
    return entries


# Connection-config keys holding a secret credential. Pulled out of the JSON
# config (which the API returns) before it is stored.
_SECRET_KEYS = ("password", "token")


def strip_secrets(config: dict | None) -> dict:
    """Return a copy of `config` with secret credentials removed."""
    if not config:
        return {}
    return {k: v for k, v in config.items() if k not in _SECRET_KEYS}


def _split_login(config: dict | None) -> tuple[dict, tuple[str, str] | None]:
    """A database's config never keeps a login: each user has their own. A
    username + password typed in the create/edit form become the author's own
    login; the stored config keeps only where the database is."""
    config = dict(config or {})
    username = config.get("username")
    password = _extract_secret(config)
    stored = {k: v for k, v in config.items() if k not in database_credential_service.LOGIN_KEYS}
    login = (str(username), password) if username and password else None
    return stored, login


def server_path(source_or_config) -> str | None:
    """The absolute server path this source points at, if it is a `serverPath`
    source (data already on the server, never uploaded). Accepts a DataSource or
    a raw config dict."""
    config = (
        source_or_config
        if isinstance(source_or_config, dict)
        else (source_or_config.connection_config or {})
    )
    raw = config.get("serverPath")
    return str(raw) if raw else None


def enforce_server_path(config: dict | None) -> None:
    """Re-enforce the browse-root boundary wherever a config is PERSISTED. The
    picker validates client-side, but create/update take a plain JSON config — so
    without this a hand-made request could point a source at any file the server
    can read (/etc/passwd, another tenant's data) and read it back through the
    query route. Raises FsBrowseError, surfaced as 400 by the routes."""
    path = server_path(config or {})
    if path:
        fs_browser.validate_source_path(path)


def _extract_secret(config: dict | None) -> str | None:
    """The first secret credential present in the config (password or token)."""
    if not config:
        return None
    for key in _SECRET_KEYS:
        if config.get(key):
            return str(config[key])
    return None


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
    enforce_server_path(config)
    if config is not None:
        config = _keep_managed_path(config, None)
    payload["connection_config"], login = _split_login(config)
    # The git access token never lands in the entity's JSON column (it would be
    # served straight back by the API); git_credential_service holds it per host.
    git_secret.apply_to_entity(None, payload)
    source = DataSource(**payload, owner_id=owner.id)
    await author_provenance.stamp_creator(db, source, payload, owner)
    db.add(source)
    await db.commit()
    await db.refresh(source)
    if login and database_credential_service.is_external(source):
        await database_credential_service.save(db, source, owner.id, *login, remember=True)
    return source


async def update(
    db: AsyncSession,
    source: DataSource,
    data: DataSourceUpdate,
    *,
    editor_id: int | None = None,
    managed_path_set: str | None = None,
) -> DataSource:
    """`managed_path_set` is create-from-ddl's alone: the validated location of the
    file it just created. Every other caller keeps the stored one.

    A login typed in the edit form becomes the editor's own (`editor_id`).
    Changing where the database points drops every user's login to it."""
    changes = data.model_dump(exclude_unset=True)
    login = None
    before = dict(source.connection_config or {})
    if "connection_config" in changes:
        enforce_server_path(changes["connection_config"])
        changes["connection_config"] = _keep_managed_path(
            changes["connection_config"] or {}, source.connection_config
        )
        if managed_path_set:
            changes["connection_config"]["managedPath"] = managed_path_set
        changes["connection_config"], login = _split_login(changes["connection_config"])
    retargeted = "connection_config" in changes and database_credential_service.target_changed(
        before, changes["connection_config"]
    )
    now_session_only = changes.get("require_session_only") and not source.require_session_only
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
    if retargeted or now_session_only:
        await database_credential_service.forget_all(db, source.id)
    if retargeted:
        await stats_cache_service.delete_with_prefix(db, "database", source.id)
    # A changed host/credential/file must not keep being served through a warm
    # connection opened against the old config.
    connection_pool.invalidate(source.id)
    # The concept caches reflect the old data; drop them so the next visitor
    # recomputes against the new config.
    concept_cache_fs.invalidate(source.id)
    await concept_stats_cache_service.delete_for_source(db, source.id)
    if login and editor_id is not None and database_credential_service.is_external(source):
        await database_credential_service.save(
            db, source, editor_id, *login, remember=not source.require_session_only
        )
    return source


def created_data(source: DataSource) -> str | None:
    """What Linkr created for this database and may remove with it: `file` for a
    DuckDB file in a server folder the user chose, `schema` for the SQL schema a
    cohort was derived into (a database declared on it). None for anything else
    — a connection someone added points at data Linkr never made. A file in
    Linkr's own folder is not listed: it always goes with its database."""
    config = source.connection_config or {}
    if is_managed(source) and config.get("managedPath"):
        return "file"
    derived = source.derived_from or {}
    # Only the schema the derivation itself recorded creating, and only while the
    # connection still points at it: a schema edited in by hand is not Linkr's.
    schema = derived.get("schemaName")
    if schema and config.get("schema") == schema and config.get("engine") not in (None, "duckdb"):
        return "schema"
    return None


async def _drop_created_data(source: DataSource, kind: str, login: Login | None) -> None:
    config = source.connection_config or {}
    if kind == "file":
        path = managed_path(source)
        for part in (path, path.with_name(path.name + ".wal")):
            part.unlink(missing_ok=True)
        return
    from app.services.data import cohort_derive

    target = cohort_derive.TargetSpec(
        "external", config=with_login(config, login), password=login.password if login else None,
        schema=config["schema"],
    )
    await asyncio.to_thread(cohort_derive.drop_schema, target)


async def delete(
    db: AsyncSession, source: DataSource, delete_data: bool = False, login: Login | None = None,
) -> None:
    """Remove a database. `delete_data` also removes what Linkr created for it
    (see `created_data`) — never data a connection merely points at; dropping a
    schema is done with `login`, the deleting user's own."""
    created = created_data(source) if delete_data else None
    if created:
        connection_pool.invalidate(source.id)
        # Before the row: dropping a schema needs the connection's credentials.
        await _drop_created_data(source, created, login)
    files = (
        await db.execute(
            select(DataSourceFile).where(DataSourceFile.data_source_id == source.id)
        )
    ).scalars().all()
    shas = {f.content_hash for f in files}
    # A file created in a server folder the user chose is left there: they put it
    # outside Linkr's data folder to keep it, and may still use it outside Linkr.
    owns_default_file = is_managed(source) and not (source.connection_config or {}).get("managedPath")
    source_id = source.id
    await _forget_derivations_into(db, source_id)
    await database_credential_service.forget_all(db, source_id)
    await db.delete(source)  # cascades to data_source_files via FK
    await db.commit()
    connection_pool.invalidate(source_id)
    concept_cache_fs.invalidate(source_id)
    # A managed file is owned by this source alone — nothing else references it.
    if owns_default_file:
        managed_db.delete(source_id)
    for sha in shas:
        if not await _sha_still_referenced(db, sha):
            await blob_store.delete(sha)


async def _forget_derivations_into(db: AsyncSession, source_id: str) -> None:
    """Drop the cohorts' records of derivations built into (or declared as)
    this database: once it is gone there is nothing to rebuild or open."""
    cohorts = (await db.execute(select(Cohort).where(Cohort.derivations.is_not(None)))).scalars().all()
    for cohort in cohorts:
        kept = [
            d for d in cohort.derivations or []
            if source_id not in (d.get("targetId"), d.get("registeredId"))
        ]
        if len(kept) != len(cohort.derivations or []):
            cohort.derivations = kept or None


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


def managed_path(source: DataSource) -> Path:
    """Where a managed source's file lives — Linkr's data folder, or the server
    folder it was created in."""
    return managed_db.path_of(source.id, source.connection_config)


def claim_managed_location(source: DataSource, requested: str | None) -> tuple[dict, str | None]:
    """The config a managed file is written under, and the location newly claimed.

    `requested` is a new `*.duckdb` in a server folder; omitted, the file stays
    where it was first created (or goes to Linkr's data folder). A location is
    claimed once here — moving it later is `move_managed_file`'s job; see
    `fs_browser.check_new_database_file` for why an existing file is refused. Raises ValueError with the reason."""
    config = dict(source.connection_config or {})
    if not requested:
        return config, None
    stored = config.get("managedPath")
    if stored:
        if Path(requested).expanduser().resolve() != Path(stored):
            raise ValueError("a database file cannot be moved once created")
        return config, None
    try:
        location = str(fs_browser.validate_new_database_file(requested))
    except fs_browser.FsBrowseError as exc:
        raise ValueError(str(exc)) from exc
    config["managedPath"] = location
    return config, location


def _move_file(src: Path, dest: Path) -> None:
    # `shutil.move` renames on one filesystem and copies then deletes across
    # two; DuckDB's write-ahead log goes with the file, or the move loses the
    # last writes that were not checkpointed yet.
    import shutil

    dest.parent.mkdir(parents=True, exist_ok=True)
    for suffix in ("", ".wal"):
        part = src.with_name(src.name + suffix)
        if part.exists():
            shutil.move(str(part), str(dest.with_name(dest.name + suffix)))


async def move_managed_file(db: AsyncSession, source: DataSource, requested: str | None) -> DataSource:
    """Move a Linkr-owned database file to a new `*.duckdb` in a server folder
    (`requested`), or back to Linkr's data folder (None), and point the source at
    it. The one sanctioned way to change `managedPath` after creation: the new
    location goes through the same check as a creation (a new file, inside the
    browse roots, in a writable folder). Raises ValueError with the reason."""
    if not is_managed(source):
        raise ValueError("only a database Linkr created can be moved")
    state = compaction_state(source.id)
    if state is not None and state.status == "running":
        raise ValueError("the database is being compacted; move it once that is done")
    current = managed_path(source)
    if requested:
        try:
            dest = fs_browser.validate_new_database_file(requested)
        except fs_browser.FsBrowseError as exc:
            raise ValueError(str(exc)) from exc
    else:
        dest = managed_db.path_for(source.id)
        if dest.exists() and dest.resolve() != current.resolve():
            raise ValueError("a file already exists in Linkr's data folder for this database")
    if dest.resolve() == current.resolve():
        return source
    # A pooled connection holds the file open; DuckDB must let go before it moves.
    connection_pool.invalidate(source.id)
    await asyncio.to_thread(_move_file, current, dest)
    config = dict(source.connection_config or {})
    if requested:
        config["managedPath"] = str(dest)
    else:
        config.pop("managedPath", None)
    source.connection_config = config
    await db.commit()
    await db.refresh(source)
    return source


def _keep_managed_path(config: dict, current: dict | None) -> dict:
    """`managedPath` as the server stored it, whatever the client sent.

    Only create-from-ddl sets it, once, after validating a NEW file inside the
    browse roots. Taking it from a plain create/PATCH would let a request point a
    source at any file the server can write — which the ETL then writes into and
    a rebuild deletes."""
    out = {k: v for k, v in config.items() if k != "managedPath"}
    stored = (current or {}).get("managedPath")
    if stored:
        out["managedPath"] = stored
    return out


@dataclass
class CompactionState:
    """Live state of one compaction, polled by the client.

    In memory rather than a `jobs` row: a Job is keyed by project, and a database
    belongs to the workspace, so persisting one would mean a schema change and a
    migration to carry a single integer. The cost of losing this on restart is
    that the UI stops reporting progress — the compaction itself is a temp file
    plus an atomic rename, which is safe to interrupt at any point.
    """

    status: str  # 'running' | 'done' | 'error'
    size_before: int
    #: Denominator for the bar: bytes the data occupies, free blocks excluded.
    #: None when DuckDB would not answer — the UI then shows bytes without a %.
    data_size: int | None
    bytes_written: int = 0
    size_after: int | None = None
    error: str | None = None


_compactions: dict[str, CompactionState] = {}
_compactions_lock = threading.Lock()
_compaction_tasks: set[asyncio.Task] = set()


def compaction_state(source_id: str) -> CompactionState | None:
    with _compactions_lock:
        return _compactions.get(source_id)


async def start_compaction(source: DataSource) -> CompactionState:
    """Begin compacting a managed database, returning once it is under way.

    Runs detached so the request returns immediately: a multi-GB rewrite outlives
    any sensible HTTP timeout, and the client polls `compaction_state` instead.
    Only for managed files — an uploaded blob is content-addressed (rewriting it
    would invalidate the sha every reference uses) and an external engine has no
    file here to compact.
    """
    if not is_managed(source):
        raise ValueError("only a server-owned database can be compacted")

    source_id = source.id
    path = managed_path(source)
    if not path.exists():
        raise ValueError("the database file is missing")

    size_before = path.stat().st_size
    data_size = await asyncio.to_thread(managed_db.data_size, path)

    # Checked and registered under one acquisition: two requests arriving together
    # would otherwise both see "not running" and start a second rewrite of the
    # same file, the loser's os.replace silently discarding the winner's work.
    state = CompactionState(
        status="running", size_before=size_before, data_size=data_size
    )
    with _compactions_lock:
        running = _compactions.get(source_id)
        if running is not None and running.status == "running":
            raise ValueError("a compaction is already running for this database")
        _compactions[source_id] = state

    # The compaction swaps a new file in under this path. A warm pooled handle
    # would go on serving the replaced inode — reads would silently keep working
    # against a file that is no longer on disk. `invalidate` waits for any
    # in-flight query before closing, so nothing is cut off mid-statement.
    connection_pool.invalidate(source_id)

    def _on_bytes(n: int) -> None:
        # Plain assignment of an int, and the only writer — the poll reads a
        # value that is either the old one or the new one, never a torn one.
        state.bytes_written = n

    def _run() -> None:
        try:
            before, after = managed_db.compact(path, _on_bytes)
        except Exception as e:  # noqa: BLE001 — reported through the polled state
            state.status = "error"
            state.error = str(e)
            return
        state.size_before = before
        state.size_after = after
        state.bytes_written = after
        state.status = "done"

    # Held in a module-level set: asyncio keeps only a weak reference to a task,
    # so one nobody holds can be collected mid-flight and the compaction would
    # stop silently part-way through.
    task = asyncio.create_task(asyncio.to_thread(_run))
    _compaction_tasks.add(task)
    task.add_done_callback(_compaction_tasks.discard)
    return state


def is_external_engine(engine: str | None) -> bool:
    """A network database (Postgres/MySQL) rather than a local file."""
    return engine in _EXTERNAL_ENGINES


async def connection_info(db: AsyncSession, source: DataSource, user_id: int) -> DatabaseConnectionInfo:
    """How to reach `source` from outside Linkr — never a password. For an
    external database the username is `user_id`'s own login, if they have one.

    Shared by GET /data-sources/{id}/connection-info and the per-project database
    listing the client libraries read, so a script and the UI are told the same
    thing about the same database. Callers must have checked `databases:read`.
    """
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
            username=(await database_credential_service.status_for(db, source, user_id))["username"],
        )

    if is_managed(source):
        path = managed_path(source)
        return DatabaseConnectionInfo(
            engine="duckdb",
            kind="file",
            path=str(path),
            exists=path.exists(),
            size_bytes=_file_size(path),
        )

    sp = server_path(source)
    if sp:
        target = Path(sp)
        pairs = _server_path_files(sp)
        if target.is_file():
            return DatabaseConnectionInfo(
                engine=engine,
                kind="file",
                path=sp,
                exists=True,
                file_names=[target.name],
                size_bytes=_file_size(target),
            )
        # A real folder, unlike the blob store: `path` is meaningful here (the
        # files keep their names and extensions), so a client library can glob it.
        groups = parquet_table_paths(source, pairs)
        return DatabaseConnectionInfo(
            engine=engine,
            kind="parquet-folder",
            path=sp,
            exists=target.is_dir(),
            file_names=[name for name, _ in pairs],
            tables=_parquet_table_entries(groups),
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
            tables=_parquet_table_entries(groups),
        )

    return DatabaseConnectionInfo(
        engine=engine,
        kind="file",
        path=str(paths[0]),
        exists=paths[0].is_file(),
        size_bytes=_file_size(paths[0]),
        # Content-addressed: the file is named by its sha, with no extension, so
        # a tool that keys off ".duckdb" needs telling.
        blob=True,
        file_names=names,
    )


async def role_attachments(
    db: AsyncSession, sources: dict[str, DataSource], user_id: int
) -> dict[str, dict]:
    """Describe how to ATTACH each role database for an ETL run, an external one
    with `user_id`'s own login (CredentialRequired if they have none).

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
            login = await database_credential_service.resolve_login(db, source, user_id)
            out[role] = {
                "kind": "external",
                "config": with_login(config, login),
                "password": login.password if login else None,
            }
            continue
        if is_managed(source):
            path = managed_path(source)
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
    user_id: int,
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
    target_path = managed_path(target)
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
    _audit(target, "etl_run", sql)

    attachments = await role_attachments(db, {k: v for k, v in roles.items() if k != "target"}, user_id)

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


async def client_recipe(db: AsyncSession, source: DataSource, login: Login | None) -> dict:
    """How the R/Python client libraries open this database themselves.

    Unlike `query`, which runs the SQL here and returns rows, this hands the script
    what it needs to hold its own DuckDB connection — so it gets a real DBI/DBAPI
    handle and everything built on one (dbplyr, joins against local Parquet). For an
    external engine that includes the caller's own password (`login`), since the
    ATTACH happens in the script's process; without a login the database is listed
    as not connectable. The caller MUST have checked `databases:read` first.
    """
    config = dict(source.connection_config or {})
    engine = config.get("engine")

    if engine in _EXTERNAL_ENGINES:
        if login is None:
            return {"engine": engine, "kind": "external", "connectable": False, "needs_login": True}
        # A password handed to user code: one line per database it went out for.
        audit.write({**audit.actor(), "method": "GET", "route": "client-recipe",
                     "action": "client_recipe", "data_source_id": source.id,
                     "workspace_id": source.workspace_id, "status": 200})
        recipe = db_connect.attach_recipe(with_login(config, login), login.password)
        return {
            "engine": engine,
            "kind": "external",
            "connectable": True,
            "attach_type": recipe["type"],
            "attach_dsn": recipe["dsn"],
            "attach_scope": recipe["scope"],
        }

    if is_managed(source):
        path = managed_path(source)
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

def _audit(source: DataSource, action: str, detail: str | None = None) -> None:
    audit.bind(action=action, data_source_id=source.id, workspace_id=source.workspace_id, detail=detail)


async def query(
    db: AsyncSession, source: DataSource, login: Login | None, sql: str, arrow: bool = False,
):
    """Run read-only SQL server-side: ATTACH a network DB with the caller's own
    `login` (see database_credential_service.resolve_login) or a local
    DuckDB/SQLite file from the blob store. JSON-ready rows, capped; or, with
    `arrow`, the whole result as an Arrow table. Logged (core/audit)."""
    _audit(source, "query", sql)
    try:
        result = await _query(db, source, login, sql, arrow)
    except Exception as exc:
        audit.bind(error=str(exc))
        raise
    audit.bind(row_count=result.num_rows if arrow else len(result))
    return result


async def _query(db: AsyncSession, source: DataSource, login: Login | None, sql: str, arrow: bool):
    config = dict(source.connection_config or {})
    engine = config.get("engine")
    if engine in _EXTERNAL_ENGINES:
        if login is None:
            raise database_credential_service.CredentialRequired(source)
        return await asyncio.to_thread(
            db_connect.query_external, with_login(config, login), login.password, sql,
            pool_key(source, login), arrow,
        )
    if is_managed(source):
        # Server-owned file: nothing in the blob store, read it where it lives.
        path = managed_path(source)
        if not path.exists():
            raise ValueError("the database file is missing; recreate it")
        return await asyncio.to_thread(
            db_connect.query_file, "duckdb", str(path), sql, source.id, arrow
        )
    if engine in _FILE_ENGINES:
        files = await _source_files(db, source)
        if not files:
            if server_path(source):
                raise ValueError(
                    "the server path holds no readable database file; check it still exists"
                )
            raise ValueError("no database file uploaded for this source")
        if _is_parquet_folder(config, files):
            known = _known_tables(source)
            return await asyncio.to_thread(
                db_connect.query_parquet_folder, files, known, sql, source.id, arrow
            )
        return await asyncio.to_thread(
            db_connect.query_file, engine, files[0][1], sql, source.id, arrow
        )
    raise ValueError(f"queries not supported for engine: {engine}")


async def refresh_concept_cache(
    db: AsyncSession, source: DataSource, login: Login | None, select_sql: str
) -> float:
    """Materialize the concept list (`select_sql`) to the Parquet cache of the
    source as `login` sees it, and return the new mtime. Gathers the same
    connection inputs as `query`."""
    _audit(source, "concept_cache_refresh", select_sql)
    config = dict(source.connection_config or {})
    engine = config.get("engine")
    password = None
    if engine in _EXTERNAL_ENGINES:
        if login is None:
            raise database_credential_service.CredentialRequired(source)
        config, password = with_login(config, login), login.password
    files = None
    known = None
    if is_managed(source):
        # Server-owned file: nothing in the blob store, so hand the materializer
        # the path where it lives — same single-DuckDB-file shape as an upload.
        path = managed_path(source)
        if not path.exists():
            raise ValueError("the database file is missing; recreate it")
        files = [(path.name, str(path))]
    elif engine in _FILE_ENGINES:
        files = await _source_files(db, source)
        if not files:
            raise ValueError("no database file uploaded for this source")
        known = _known_tables(source)
    return await asyncio.to_thread(
        concept_cache_fs.refresh, config, password, files, known, select_sql, source.id,
        login.principal if login else "",
    )


async def query_concept_cache(source_id: str, principal: str, sql: str) -> list[dict]:
    """Run a page query against the principal's cached concept Parquet."""
    return await asyncio.to_thread(concept_cache_fs.query_page, source_id, principal, sql)


async def introspect(db: AsyncSession, source: DataSource, login: Login | None) -> list[dict]:
    """Introspect a stored source's schema (tables + columns) server-side — for
    network DBs as `login` sees them (grants hide tables), for file DBs via the
    uploaded blob."""
    _audit(source, "introspect")
    config = dict(source.connection_config or {})
    engine = config.get("engine")
    if engine in _EXTERNAL_ENGINES:
        if login is None:
            raise database_credential_service.CredentialRequired(source)
        return await asyncio.to_thread(
            db_connect.introspect_external, with_login(config, login), login.password
        )
    if is_managed(source):
        # Server-owned file: nothing in the blob store, introspect it in place.
        path = managed_path(source)
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
    source: DataSource, login: Login | None,
) -> tuple[bool, str | None, list[dict]]:
    """Re-test a stored source with the caller's own login (no client secret)."""
    # A managed file has no credentials to re-send: the test is whether the file
    # is there and can be opened. Without this it fell through to the external
    # path and answered "unsupported engine", so a managed database that failed
    # once — a held lock, a run interrupted mid-write — stayed `error` forever,
    # its only offered way out being the rebuild that empties it.
    if is_managed(source):
        path = managed_path(source)
        if not path.exists():
            return False, f"database file not found: {path}", []
        try:
            tables = await asyncio.to_thread(
                db_connect.introspect_file, "duckdb", str(path)
            )
            return True, None, tables
        except Exception as e:  # noqa: BLE001 — the driver's message is the diagnosis
            return False, str(e), []

    if login is None:
        raise database_credential_service.CredentialRequired(source)
    config = with_login(dict(source.connection_config or {}), login)
    config["password"] = login.password
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
