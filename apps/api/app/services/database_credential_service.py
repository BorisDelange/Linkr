"""Each user's own login to an external database — the only way Linkr opens one.

There is no shared account: `databases:read` lets a user *try* a database, and
the database's own grants decide what their login *gets*. Everything that opens
an external database goes through `resolve_login`, which answers the acting
user's login or raises `CredentialRequired` (HTTP 428, so the front asks for it).

A login is either **remembered** (a `DatabaseCredential` row, sealed to the user
and to the database's target) or **session-only** (in this process's memory,
forgotten on logout, idle expiry or restart). A database with
`require_session_only` accepts only the second kind.

Changing where a database points (engine, host, port, database, sslmode) drops
every login to it — see `forget_all` — so nobody can re-point a database at a
server they control and collect the next password sent to it.
"""

import threading
import time
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from fastapi import HTTPException, status
from sqlalchemy import delete as sa_delete
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.core import audit, crypto
from app.models.data_source import DataSource
from app.models.database_credential import DatabaseCredential
from app.services.data import db_connect

EXTERNAL_ENGINES = db_connect.EXTERNAL_ENGINES
# The connection settings that decide which server a login is sent to.
TARGET_KEYS = ("engine", "host", "port", "database", "sslmode")
# Credential fields that never belong in a database's stored config.
LOGIN_KEYS = ("username", "password", "token")

_LAST_USED_RESOLUTION = timedelta(hours=1)


# What a login is for. `read`: the user's own account, the only one Linkr reads a
# database with — read-only on SQL Server, Oracle and Doris, checked at every
# attach. `write`: a second account a cohort derivation writes with, into a
# database whose owner allowed it (`allowWrites`); never used to read.
READ = "read"
WRITE = "write"
PURPOSES = (READ, WRITE)


@dataclass(frozen=True)
class Login:
    username: str
    password: str
    principal: str


class CredentialRequired(HTTPException):
    """The acting user has no usable login for this database. 428 with a
    machine-readable code: the front opens the credential dialog, the MCP tells
    the model to ask the user."""

    def __init__(self, source: DataSource, purpose: str = READ):
        audit.bind(
            data_source_id=source.id, workspace_id=source.workspace_id,
            error="no login for this database" if purpose == READ else "no write login for this database",
        )
        super().__init__(
            status.HTTP_428_PRECONDITION_REQUIRED,
            {
                "code": "database_credential_required",
                "dataSourceId": source.id,
                "sessionOnly": bool(source.require_session_only),
                "purpose": purpose,
                "message": (
                    "Enter your own account for this database in Linkr to use it." if purpose == READ
                    else "Enter the account Linkr writes this database's derivations with."
                ),
            },
        )


def is_external(source: DataSource) -> bool:
    return (source.connection_config or {}).get("engine") in EXTERNAL_ENGINES


def principal_for(source: DataSource, user_id: int) -> str:
    """Whose view of the database a connection or cache holds: "" for a file
    database (the same for everyone), `user:<id>` for an external one."""
    return f"user:{user_id}" if is_external(source) else ""


def target_of(config: dict | None) -> tuple:
    config = config or {}
    return tuple(str(config.get(k) or "") for k in TARGET_KEYS)


# Also decide where a login is sent (Doris' Flight port, and its Stream Load
# port and scheme for a write login), but kept out of TARGET_KEYS: those seal every stored
# password, and adding one would make the existing ones unreadable. A change
# still forgets the logins.
_RETARGET_KEYS = ("flightPort", "httpPort", "httpTls", "sslrootcert")


def target_changed(before: dict | None, after: dict | None) -> bool:
    def other(config: dict | None) -> tuple:
        return tuple(str((config or {}).get(k) or "") for k in _RETARGET_KEYS)

    return target_of(before) != target_of(after) or other(before) != other(after)


def secret_context(user_id: int, source: DataSource, purpose: str = READ) -> str:
    """What a password is sealed to: this user, this database, this target — and
    a write login apart, so a read login's secret never opens as a write one."""
    return ":".join(("db" if purpose == READ else "dbw", str(user_id), source.id, *target_of(source.connection_config)))


def pool_key(source: DataSource, login: Login | None) -> str:
    return f"{source.id}:{login.principal}" if login else source.id


def with_login(config: dict, login: Login | None) -> dict:
    """The connection config for opening the database as `login`. Postgres also
    gets `application_name`, so the database's own activity views and logs show
    the connection came through Linkr."""
    out = dict(config)
    if login is None:
        return out
    out["username"] = login.username
    if out.get("engine") == "postgresql":
        out["application_name"] = "linkr"
    return out


# --- Session-only logins ---------------------------------------------------

@dataclass
class _SessionLogin:
    username: str
    password: str
    target: tuple
    expires: float


# (user id, database id, purpose) → login.
_session: dict[tuple[int, str, str], _SessionLogin] = {}
_session_lock = threading.Lock()


def _session_ttl() -> float:
    return settings.kernel_token_expire_minutes * 60


def _session_get(user_id: int, source: DataSource, purpose: str = READ) -> _SessionLogin | None:
    key = (user_id, source.id, purpose)
    now = time.monotonic()
    with _session_lock:
        entry = _session.get(key)
        if entry is None:
            return None
        if entry.expires < now or entry.target != target_of(source.connection_config):
            del _session[key]
            return None
        entry.expires = now + _session_ttl()
        return entry


def forget_session_logins(user_id: int) -> None:
    """Drop every session-only login of a user (logout)."""
    with _session_lock:
        for key in [k for k in _session if k[0] == user_id]:
            del _session[key]


async def forget_user(db: AsyncSession, user_id: int) -> None:
    """Drop everything kept for a deleted account outside its own rows: its
    session-only logins, the connections opened as it and the statistics
    computed through them."""
    from app.models.stats_cache import StatsCache
    from app.services.data import connection_pool

    forget_session_logins(user_id)
    principal = f"user:{user_id}"
    connection_pool.invalidate_principal(principal)
    await db.execute(sa_delete(StatsCache).where(StatsCache.cache_key.endswith(f":{principal}", autoescape=True)))
    await db.commit()


def _forget_session(source_id: str, user_id: int | None = None, purpose: str | None = None) -> None:
    with _session_lock:
        for key in [
            k for k in _session
            if k[1] == source_id and (user_id is None or k[0] == user_id) and (purpose is None or k[2] == purpose)
        ]:
            del _session[key]


# --- Resolution ------------------------------------------------------------

async def _row(db: AsyncSession, user_id: int, source_id: str, purpose: str = READ) -> DatabaseCredential | None:
    result = await db.execute(
        select(DatabaseCredential).where(
            DatabaseCredential.user_id == user_id,
            DatabaseCredential.data_source_id == source_id,
            DatabaseCredential.purpose == purpose,
        )
    )
    return result.scalar_one_or_none()


async def resolve_login(db: AsyncSession, source: DataSource, user_id: int, purpose: str = READ) -> Login | None:
    """The acting user's login to `source` for `purpose`; None for a database
    that has no login (a file). Raises CredentialRequired when the user has none."""
    if not is_external(source):
        return None
    principal = principal_for(source, user_id) + ("" if purpose == READ else f":{purpose}")
    if (entry := _session_get(user_id, source, purpose)) is not None:
        return Login(entry.username, entry.password, principal)
    if source.require_session_only:
        raise CredentialRequired(source, purpose)
    row = await _row(db, user_id, source.id, purpose)
    if row is None:
        raise CredentialRequired(source, purpose)
    password = crypto.decrypt(row.secret, secret_context(user_id, source, purpose))
    if password is None:
        # Sealed for another target, or with a key this server lost: useless.
        await db.delete(row)
        await db.commit()
        raise CredentialRequired(source, purpose)
    if crypto.needs_reseal(row.secret):
        row.secret = crypto.encrypt(password, secret_context(user_id, source, purpose))
    now = datetime.now(timezone.utc)
    last = row.last_used_at
    if last is not None and last.tzinfo is None:
        last = last.replace(tzinfo=timezone.utc)
    if last is None or now - last > _LAST_USED_RESOLUTION or row in db.dirty:
        row.last_used_at = now
        await db.commit()
    return Login(row.username, password, principal)


# --- Management ------------------------------------------------------------

def _invalidate_derived(source: DataSource, user_id: int) -> None:
    from app.services.data import connection_pool

    connection_pool.invalidate(f"{source.id}:{principal_for(source, user_id)}")


async def _drop_user_caches(db: AsyncSession, source: DataSource, user_id: int) -> None:
    """Another login may have other grants: nothing computed through the old one
    may be served under the new one. The concept cache is not the user's own but
    the database's (`concept_cache_fs`), so it stays."""
    from app.services import stats_cache_service

    _invalidate_derived(source, user_id)
    await stats_cache_service.delete(db, "database", f"{source.id}:{principal_for(source, user_id)}")


async def save(
    db: AsyncSession, source: DataSource, user_id: int, username: str, password: str, remember: bool,
    purpose: str = READ,
) -> None:
    """Store (or replace) the user's login for `purpose`. `remember=False`, or a
    database that requires it, keeps it in memory only."""
    if not is_external(source):
        raise ValueError("only an external database takes a login")
    await forget(db, source, user_id, purpose)
    if remember and not source.require_session_only:
        db.add(DatabaseCredential(
            user_id=user_id,
            data_source_id=source.id,
            purpose=purpose,
            username=username,
            secret=crypto.encrypt(password, secret_context(user_id, source, purpose)),
        ))
        await db.commit()
        return
    with _session_lock:
        _session[(user_id, source.id, purpose)] = _SessionLogin(
            username, password, target_of(source.connection_config), time.monotonic() + _session_ttl()
        )


async def forget(db: AsyncSession, source: DataSource, user_id: int, purpose: str = READ) -> None:
    _forget_session(source.id, user_id, purpose)
    await db.execute(
        sa_delete(DatabaseCredential).where(
            DatabaseCredential.user_id == user_id,
            DatabaseCredential.data_source_id == source.id,
            DatabaseCredential.purpose == purpose,
        )
    )
    await db.commit()
    if purpose == READ:
        await _drop_user_caches(db, source, user_id)


async def forget_all(db: AsyncSession, source_id: str) -> int:
    """Drop every login to a database (its target changed, or it now requires
    session-only logins). Returns how many remembered logins were removed."""
    _forget_session(source_id)
    result = await db.execute(
        sa_delete(DatabaseCredential).where(DatabaseCredential.data_source_id == source_id)
    )
    await db.commit()
    return result.rowcount or 0


async def count_for_source(db: AsyncSession, source_id: str) -> int:
    rows = await db.execute(
        select(DatabaseCredential.id).where(DatabaseCredential.data_source_id == source_id)
    )
    with _session_lock:
        in_memory = sum(1 for k in _session if k[1] == source_id)
    return len(rows.all()) + in_memory


async def status_for(db: AsyncSession, source: DataSource, user_id: int, purpose: str = READ) -> dict:
    """What the user has for this database — never the password."""
    if (entry := _session_get(user_id, source, purpose)) is not None:
        return {"hasLogin": True, "username": entry.username, "remembered": False, "lastUsedAt": None}
    row = None if source.require_session_only else await _row(db, user_id, source.id, purpose)
    if row is None:
        return {"hasLogin": False, "username": None, "remembered": False, "lastUsedAt": None}
    return {"hasLogin": True, "username": row.username, "remembered": True, "lastUsedAt": row.last_used_at}


async def list_for_user(db: AsyncSession, user_id: int) -> list[dict]:
    """Every login the user holds: remembered rows plus live session-only ones."""
    rows = (
        await db.execute(
            select(DatabaseCredential, DataSource)
            .join(DataSource, DataSource.id == DatabaseCredential.data_source_id)
            .where(DatabaseCredential.user_id == user_id)
        )
    ).all()
    out = [
        {
            "dataSourceId": source.id,
            "name": source.name,
            "workspaceId": source.workspace_id,
            "username": cred.username,
            "purpose": cred.purpose,
            "remembered": True,
            "lastUsedAt": cred.last_used_at,
            "sessionOnly": bool(source.require_session_only),
        }
        for cred, source in rows
    ]
    with _session_lock:
        live = [(k[1], k[2], v.username) for k, v in _session.items() if k[0] == user_id]
    for source_id, purpose, username in live:
        source = await db.get(DataSource, source_id)
        if source is not None:
            out.append({
                "dataSourceId": source.id,
                "name": source.name,
                "workspaceId": source.workspace_id,
                "username": username,
                "purpose": purpose,
                "remembered": False,
                "lastUsedAt": None,
                "sessionOnly": bool(source.require_session_only),
            })
    return out
