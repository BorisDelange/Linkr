"""Deriving a database from a cohort — the app side of services/data/cohort_derive:
resolving the source and the target, the permissions, and recording what was
built on the database it produced and on the cohort."""

import asyncio
import contextlib
import copy
import re
import uuid
from collections.abc import Awaitable, Callable
from datetime import datetime, timezone

from sqlalchemy.ext.asyncio import AsyncSession

from app.models.cohort import Cohort
from app.models.data_source import DataSource
from app.schemas.data_source import DeriveRequest
from app.services import data_source_service, database_credential_service
from app.services.database_credential_service import Login
from app.services.data import cohort_derive, connection_pool, managed_db

_SCHEMA_NAME = re.compile(r"^[a-z_][a-z0-9_]{0,62}$")


class DeriveError(ValueError):
    """A derivation refused for a reason the user can act on (surfaced as 400)."""


async def _source_spec(db: AsyncSession, source: DataSource, user_id: int) -> cohort_derive.SourceSpec:
    specs = await data_source_service.role_attachments(db, {"source": source}, user_id)
    if "source" not in specs:
        raise DeriveError("the database has no data to derive from")
    return cohort_derive.SourceSpec(specs["source"])


async def plan(db: AsyncSession, source: DataSource, level: str, user_id: int) -> list[dict]:
    spec = await _source_spec(db, source, user_id)
    connection_pool.invalidate(source.id)
    return await asyncio.to_thread(cohort_derive.plan, spec, source.schema_mapping or {}, level)


def _writable_target(
    target: DataSource, schema_name: str, replace: bool, login: Login | None,
) -> cohort_derive.TargetSpec:
    config = dict(target.connection_config or {})
    if data_source_service.is_managed(target):
        path = data_source_service.managed_path(target)
        if not path.exists():
            raise DeriveError("the target database file is missing")
        return cohort_derive.TargetSpec("file", path=str(path), schema=schema_name, replace_schema=replace)
    if config.get("engine") == "postgresql":
        if not config.get("allowWrites"):
            raise DeriveError("this database does not allow Linkr to write into it")
        if login is None:
            raise database_credential_service.CredentialRequired(target)
        return cohort_derive.TargetSpec(
            "external",
            config=database_credential_service.with_login(config, login),
            password=login.password,
            schema=schema_name,
            replace_schema=replace,
        )
    raise DeriveError("a new schema can only be created in a database Linkr owns, or in Postgres")


async def _target_login(db: AsyncSession, target: DataSource, body: DeriveRequest, user_id: int) -> Login | None:
    """The launcher's login to the target — asked for only once the target is
    known to be one Linkr may write a schema into."""
    config = target.connection_config or {}
    if body.target.kind != "schema" or config.get("engine") != "postgresql" or not config.get("allowWrites"):
        return None
    return await database_credential_service.resolve_login(db, target, user_id)


def _target_spec(
    target: DataSource, body: DeriveRequest, login: Login | None,
) -> tuple[cohort_derive.TargetSpec, dict | None, str | None]:
    """Where the copy lands, and for a new database the config and newly claimed
    location it is written under. Raises DeriveError before anything runs."""
    t = body.target
    if t.kind == "new-database":
        if not data_source_service.is_managed(target):
            raise DeriveError("the target must be a database Linkr creates")
        try:
            config, new_location = data_source_service.claim_managed_location(target, t.path)
        except ValueError as exc:
            raise DeriveError(str(exc)) from exc
        spec = cohort_derive.TargetSpec("file", path=str(managed_db.path_of(target.id, config)), fresh_file=True)
        return spec, config, new_location
    if t.kind == "schema":
        if not t.schema_name or not _SCHEMA_NAME.match(t.schema_name):
            raise DeriveError("the schema name must be lowercase letters, digits and underscores")
        return _writable_target(target, t.schema_name, t.replace, login), None, None
    raise DeriveError(f"unknown target kind {t.kind!r}")


def _name(value) -> str:
    if isinstance(value, dict):
        return value.get("en") or next((v for v in value.values() if v), "")
    return str(value or "")


def job_label(source: DataSource, target: DataSource, body: DeriveRequest, cohort: Cohort | None) -> str:
    """What the jobs panel calls it: the cohort, and where it goes."""
    what = _name(cohort.name) if cohort is not None else _name(source.name)
    where = (
        f"{_name(target.name)}.{body.target.schema_name}" if body.target.kind == "schema" else _name(target.name)
    )
    return f"{what} → {where}"[:255]


async def validate(
    db: AsyncSession, source: DataSource, target: DataSource, body: DeriveRequest, user_id: int,
) -> None:
    """Every refusal a derivation can meet before it copies anything — so the
    request that starts the job answers 400 (or 428, a missing login) rather than
    queueing a job that fails."""
    await _source_spec(db, source, user_id)
    _target_spec(target, body, await _target_login(db, target, body, user_id))


async def _in_thread(fn, control: cohort_derive.DeriveControl):
    """Run `fn` in a worker thread; a cancelled caller stops it (the derivation's
    own interrupt) and waits for it to clean up before letting the cancel through."""
    fut = asyncio.get_running_loop().run_in_executor(None, fn)
    try:
        return await asyncio.shield(fut)
    except asyncio.CancelledError:
        control.cancel()
        with contextlib.suppress(BaseException):
            await fut
        raise


async def derive(
    db: AsyncSession,
    source: DataSource,
    target: DataSource,
    body: DeriveRequest,
    cohort: Cohort | None,
    user_id: int,
    progress: Callable[[int, str], Awaitable[None]] | None = None,
) -> dict:
    """Copy `source`, filtered on the cohort, into `target`, and record it —
    reading and writing with `user_id`'s own logins, resolved now (the job runs
    as its launcher, never with a secret copied into it).

    `progress(percent, line)` is told of each table as it starts. A new database
    that never held a build is removed again when this fails or is cancelled: it
    was created for this derivation and would only be an empty card."""
    mapping = source.schema_mapping or {}
    spec = await _source_spec(db, source, user_id)
    t = body.target
    target_login = await _target_login(db, target, body, user_id)
    target_spec, config, new_location = _target_spec(target, body, target_login)
    first_build = t.kind == "new-database" and target.derived_from is None
    target_id = target.id  # read now: a rollback expires the instance
    try:
        return await _derive(
            db, source, target, body, cohort, mapping, spec, target_spec, config, new_location, progress,
            user_id, target_login,
        )
    except BaseException:
        if first_build:
            await db.rollback()
            fresh = await db.get(DataSource, target_id)
            if fresh is not None:
                # The derivation's error is the one to report, not a cleanup's.
                with contextlib.suppress(Exception):
                    await data_source_service.delete(db, fresh)
        raise


async def _derive(
    db, source, target, body, cohort, mapping, spec, target_spec, config, new_location, progress,
    user_id: int, target_login: Login | None,
) -> dict:
    t = body.target
    loop = asyncio.get_running_loop()
    control = cohort_derive.DeriveControl()
    if progress is not None:
        def on_table(done: int, total: int, table: str) -> None:
            pct = 5 + int(90 * done / max(1, total))
            asyncio.run_coroutine_threadsafe(progress(pct, f"{done + 1}/{total} {table}"), loop)
        control.on_table = on_table

    # A warm pooled connection holds these files READ_ONLY: DuckDB would refuse
    # to open them again in the same process.
    connection_pool.invalidate(source.id)
    connection_pool.invalidate(target.id)

    members = await _in_thread(lambda: cohort_derive.compute_members(spec, body.membership_sql), control)
    if progress is not None:
        await progress(5, f"{members.num_rows} rows in the cohort")
    tables = await _in_thread(
        lambda: cohort_derive.derive(spec, target_spec, members, mapping, body.level, body.copy_personless, control),
        control,
    )
    patient_count = len(set(members.column("patient_id").to_pylist()))
    built_at = datetime.now(timezone.utc).isoformat()
    derived_from = {**(body.derived_from or {}), "builtAt": built_at, "patientCount": patient_count}

    produced_id: str | None = None
    # A rebuild of a schema declared before updates that database, rather than
    # declaring the same schema a second time.
    previous = next(
        (d for d in (cohort.derivations if cohort is not None else None) or []
         if d.get("targetId") == target.id and d.get("schemaName") == t.schema_name and d.get("registeredId")),
        None,
    )
    registered_before = await db.get(DataSource, previous["registeredId"]) if previous and t.kind == "schema" else None
    registered_new: DataSource | None = None
    if t.kind == "new-database":
        config["managed"] = True
        config.pop("inMemory", None)
        target.connection_config = config
        target.schema_mapping = copy.deepcopy(mapping)
        target.derived_from = derived_from
        target.status = "connected"
        target.error_message = None
        target.stats = {"patientCount": patient_count, "tableCount": len([x for x in tables if not x["skipped"]])}
        produced_id = target.id
    elif registered_before is not None:
        registered_before.derived_from = {**derived_from, "schemaName": t.schema_name}
        registered_before.stats = {**(registered_before.stats or {}), "patientCount": patient_count}
        connection_pool.invalidate(registered_before.id)
        produced_id = registered_before.id
    elif t.register_name and target_spec.kind == "external":
        # The subset as a database of its own: same server, the new schema as its
        # scope. The launcher's login comes along as their own login to it; every
        # other user enters theirs. The password never passes through the client.
        registered = DataSource(
            workspace_id=target.workspace_id,
            alias=t.register_alias or t.schema_name,
            name=t.register_name if isinstance(t.register_name, dict) else {"en": t.register_name},
            source_type="database",
            connection_config={**{k: v for k, v in (target.connection_config or {}).items() if k != "allowWrites"}, "schema": t.schema_name},
            schema_mapping=copy.deepcopy(mapping),
            schema_source=source.schema_source,
            # The schema this derivation created: the one deleting the database
            # may drop — never whatever the connection is later pointed at.
            derived_from={**derived_from, "schemaName": t.schema_name},
            status="connected",
            stats={"patientCount": patient_count},
            owner_id=target.owner_id,
            # Its own identity, like any database created here: a new work, whose
            # parentage is `derived_from`, not a lineage.
            entity_id=t.register_alias or t.schema_name,
            lineage_id=str(uuid.uuid4()),
        )
        db.add(registered)
        await db.flush()
        produced_id = registered.id
        registered_new = registered

    if cohort is not None:
        record = {
            "kind": t.kind,
            "targetId": target.id,
            **({"schemaName": t.schema_name} if t.schema_name else {}),
            **({"registeredId": produced_id} if produced_id and produced_id != target.id else {}),
            "builtAt": built_at,
            "patientCount": patient_count,
        }
        kept = [
            d for d in (cohort.derivations or [])
            if not (d.get("targetId") == target.id and d.get("schemaName") == t.schema_name)
        ]
        cohort.derivations = [*kept, record]

    await db.commit()
    if registered_new is not None and target_login is not None:
        remembered = (await database_credential_service.status_for(db, target, user_id))["remembered"]
        await database_credential_service.save(
            db, registered_new, user_id, target_login.username, target_login.password, remember=remembered,
        )
    if new_location:
        # Re-read after the commit: nothing else may have set the location.
        await db.refresh(target)
    return {
        "tables": tables,
        "patient_count": patient_count,
        "unit_count": members.num_rows,
        "built_at": built_at,
        "data_source_id": produced_id,
    }
