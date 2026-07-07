import asyncio

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import crypto
from app.models.data_source import DataSource, DataSourceFile
from app.models.user import User
from app.schemas.data_source import (
    DataSourceCreate,
    DataSourceFileImportRequest,
    DataSourceUpdate,
)
from app.services import blob_store
from app.services.data import db_connect

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
    config = payload.get("connection_config")
    secret = _extract_secret(config)
    payload["connection_config"] = strip_secrets(config)
    source = DataSource(
        **payload,
        owner_id=owner.id,
        connection_secret=crypto.encrypt(secret) if secret else None,
    )
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
    for key, value in changes.items():
        setattr(source, key, value)
    await db.commit()
    await db.refresh(source)
    return source


async def delete(db: AsyncSession, source: DataSource) -> None:
    files = (
        await db.execute(
            select(DataSourceFile).where(DataSourceFile.data_source_id == source.id)
        )
    ).scalars().all()
    shas = {f.content_hash for f in files}
    await db.delete(source)  # cascades to data_source_files via FK
    await db.commit()
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
    return row


async def delete_file(db: AsyncSession, file: DataSourceFile) -> None:
    sha = file.content_hash
    await db.delete(file)
    await db.commit()
    if not await _sha_still_referenced(db, sha):
        await blob_store.delete(sha)


# --- Live connection test (external databases) -----------------------------

async def query(source: DataSource, sql: str) -> list[dict]:
    """Run read-only SQL against an external source, decrypting its stored
    password to open the connection. Rows come back as JSON-ready dicts."""
    config = dict(source.connection_config or {})
    engine = config.get("engine")
    if engine != "postgresql":
        raise ValueError(f"queries not supported for engine: {engine}")
    password = connection_password(source)
    return await asyncio.to_thread(
        db_connect.query_postgres, config, password, sql
    )


async def introspect(source: DataSource) -> list[dict]:
    """Introspect a stored external source's schema (tables + columns), using its
    decrypted password. Returns the IntrospectedTable[] shape."""
    config = dict(source.connection_config or {})
    if config.get("engine") != "postgresql":
        return []
    password = connection_password(source)
    return await asyncio.to_thread(db_connect.introspect_postgres, config, password)


async def test_connection_stored(
    source: DataSource,
) -> tuple[bool, str | None, list[dict]]:
    """Re-test a stored source using its decrypted password (no client secret)."""
    config = dict(source.connection_config or {})
    config["password"] = connection_password(source)
    return await test_connection(config)


async def test_connection(config: dict) -> tuple[bool, str | None, list[dict]]:
    """Open a live connection using the (unpersisted) password in `config`,
    introspect the schema, and return (ok, error, tables)."""
    engine = config.get("engine")
    if engine != "postgresql":
        return False, f"unsupported engine for server-side test: {engine}", []
    password = config.get("password")
    try:
        tables = await asyncio.to_thread(
            db_connect.introspect_postgres, config, password
        )
        return True, None, tables
    except Exception as e:  # noqa: BLE001 — surface driver/connection errors to the UI
        return False, str(e), []
