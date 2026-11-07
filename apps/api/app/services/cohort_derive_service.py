"""Deriving a database from a cohort — the app side of services/data/cohort_derive:
resolving the source and the target, the permissions, and recording what was
built on the database it produced and on the cohort."""

import asyncio
import base64
import concurrent.futures
import contextlib
import copy
import re
import secrets
import uuid
from collections.abc import Awaitable, Callable
from datetime import datetime, timezone

import duckdb
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import crypto
from app.models.cohort import Cohort
from app.models.data_source import DataSource
from app.models.pseudonym_key import PseudonymKey
from app.schemas.data_source import DeriveRequest
from app.services import data_source_service, database_binding, database_credential_service
from app.services.database_credential_service import Login
from app.services.data import cohort_derive, connection_pool, db_connect, managed_db
from app.services.execution import jobs

_SCHEMA_NAME = re.compile(r"^[a-z_][a-z0-9_]{0,62}$")


class DeriveError(ValueError):
    """A derivation refused for a reason the user can act on (surfaced as 400)."""


class DeriveBusy(DeriveError):
    """Another derivation into the same target has not finished (surfaced as 409)."""


async def _source_spec(db: AsyncSession, source: DataSource, user_id: int) -> cohort_derive.SourceSpec:
    specs = await data_source_service.role_attachments(db, {"source": source}, user_id)
    if "source" not in specs:
        raise DeriveError("the database has no data to derive from")
    return cohort_derive.SourceSpec(specs["source"])


async def plan(db: AsyncSession, source: DataSource, level: str, scope: str | None, user_id: int) -> list[dict]:
    spec = await _source_spec(db, source, user_id)
    connection_pool.invalidate(source.id)
    mapping = cohort_derive.effective_mapping(source.schema_mapping or {}, source.schema_overrides)
    return await asyncio.to_thread(cohort_derive.plan, spec, mapping, level, scope)


# The engines a derivation writes into with a login of its own (`write`): their
# read logins are checked read-only at every attach. Postgres writes with the
# user's own login, on a database whose owner allowed it.
WRITE_LOGIN_ENGINES = ("sqlserver", "doris", "oracle")
WRITABLE_ENGINES = ("postgresql", *WRITE_LOGIN_ENGINES)


def _engine(source: DataSource) -> str | None:
    return (source.connection_config or {}).get("engine")


def write_purpose(source: DataSource) -> str:
    """Which of the user's logins a derivation writes `source` with."""
    if _engine(source) in WRITE_LOGIN_ENGINES:
        return database_credential_service.WRITE
    return database_credential_service.READ


def takes_write_login(source: DataSource) -> bool:
    return _engine(source) in WRITE_LOGIN_ENGINES and bool((source.connection_config or {}).get("allowWrites"))


async def probe_write_login(config: dict, password: str | None) -> None:
    """Open the database writable with a write login, or raise — no read-only
    check: it is the derivation's, which only ever runs the statements it
    generates."""

    def probe() -> None:
        con = cohort_derive._connect()
        writer = None
        try:
            writer = cohort_derive.derive_writers.writer_for(
                con, cohort_derive.derive_writers.Destination("external", config=config, password=password), "probe",
            )
        finally:
            if writer is not None:
                writer.close()
            con.close()

    await asyncio.to_thread(probe)


def _writable_target(
    target: DataSource, schema_name: str, replace: bool, login: Login | None,
) -> cohort_derive.TargetSpec:
    config = dict(target.connection_config or {})
    if data_source_service.is_managed(target):
        path = data_source_service.managed_path(target)
        if not path.exists():
            raise DeriveError("the target database file is missing")
        return cohort_derive.TargetSpec("file", path=str(path), schema=schema_name, replace_schema=replace)
    if config.get("engine") in WRITABLE_ENGINES:
        if not config.get("allowWrites"):
            raise DeriveError("this database does not allow Linkr to write into it")
        if login is None:
            raise database_credential_service.CredentialRequired(target, write_purpose(target))
        return cohort_derive.TargetSpec(
            "external",
            config=database_credential_service.with_login(config, login),
            password=login.password,
            schema=schema_name,
            replace_schema=replace,
        )
    raise DeriveError(
        "a new schema can only be created in a database Linkr owns, or in a Postgres, SQL Server, Doris or "
        "Oracle database that allows Linkr to write"
    )


async def write_login(db: AsyncSession, target: DataSource, user_id: int) -> Login | None:
    """The launcher's login to write `target` with — asked for only once the
    target is known to be one Linkr may write a schema into."""
    config = target.connection_config or {}
    if config.get("engine") not in WRITABLE_ENGINES or not config.get("allowWrites"):
        return None
    return await database_credential_service.resolve_login(db, target, user_id, write_purpose(target))


async def _target_login(db: AsyncSession, target: DataSource, body: DeriveRequest, user_id: int) -> Login | None:
    if body.target.kind != "schema":
        return None
    return await write_login(db, target, user_id)


async def drop_login(db: AsyncSession, source: DataSource, user_id: int) -> Login | None:
    """The login that drops the SQL schema a derivation created, with the
    database declared on it: the write login of the database the schema is in,
    where reading takes a read-only one."""
    if _engine(source) not in WRITE_LOGIN_ENGINES:
        return await database_credential_service.resolve_login(db, source, user_id)
    target = await db.get(DataSource, (source.linkr_created or {}).get("targetId"))
    if target is None:
        raise DeriveError("the database this schema was derived into is gone: drop the schema there")
    return await database_credential_service.resolve_login(db, target, user_id, database_credential_service.WRITE)


def _created(source: DataSource) -> dict:
    return source.linkr_created or {}


def _same_database(source: DataSource, target: DataSource) -> bool:
    if source.id == target.id:
        return True
    if data_source_service.is_managed(source) and data_source_service.is_managed(target):
        return data_source_service.managed_path(source).resolve() == data_source_service.managed_path(target).resolve()
    s, t = source.connection_config or {}, target.connection_config or {}
    return s.get("engine") not in (None, "duckdb") and data_source_service.server_of(s) == data_source_service.server_of(t)


def _source_scope(source: DataSource) -> str:
    if data_source_service.is_managed(source):
        return "main"
    return db_connect._scope(source.connection_config or {})


async def _check_new_database(source: DataSource, target: DataSource) -> None:
    """A new database overwrites the target's file: only a file a derivation
    wrote before (a rebuild), or one that holds nothing yet."""
    if not data_source_service.is_managed(target):
        raise DeriveError("the target must be a database Linkr creates")
    if _same_database(source, target):
        raise DeriveError("a database cannot be derived into itself")
    if _created(target).get("file"):
        return
    connection_pool.invalidate(target.id)
    try:
        holds = await asyncio.to_thread(managed_db.holds_tables, data_source_service.managed_path(target))
    except duckdb.Error as exc:
        raise DeriveError("the target database file cannot be read; derive into a new database") from exc
    if holds:
        raise DeriveError("the target database already holds data; derive into a new database")


def _check_schema(source: DataSource, target: DataSource, schema_name: str | None, replace: bool) -> None:
    if not schema_name or not _SCHEMA_NAME.match(schema_name):
        raise DeriveError("the schema name must be lowercase letters, digits and underscores")
    if _same_database(source, target) and schema_name == _source_scope(source):
        raise DeriveError("a cohort cannot be derived into its source's own schema")
    # Replacing drops the schema with everything in it: only one a derivation
    # created in this very database.
    if replace and schema_name not in _created(target).get("schemas", []):
        raise DeriveError("only a schema a derivation created in this database can be replaced")


async def _target_spec(
    source: DataSource, target: DataSource, body: DeriveRequest, login: Login | None,
) -> tuple[cohort_derive.TargetSpec, dict | None, str | None]:
    """Where the copy lands, and for a new database the config and newly claimed
    location it is written under. Raises DeriveError before anything runs."""
    if database_binding.is_foreign(target, source.workspace_id):
        raise DeriveError(database_binding.FOREIGN_DATABASE)
    t = body.target
    if t.kind == "new-database":
        await _check_new_database(source, target)
        try:
            config, new_location = data_source_service.claim_managed_location(target, t.path)
        except ValueError as exc:
            raise DeriveError(str(exc)) from exc
        spec = cohort_derive.TargetSpec("file", path=str(managed_db.path_of(target.id, config)), fresh_file=True)
        return spec, config, new_location
    if t.kind == "schema":
        _check_schema(source, target, t.schema_name, t.replace)
        return _writable_target(target, t.schema_name, t.replace, login), None, None
    raise DeriveError(f"unknown target kind {t.kind!r}")


def derivation_id(target: DataSource, body: DeriveRequest) -> str:
    """What names one derivation: the database written, or `<database>.<schema>`."""
    t = body.target
    return target.id if t.kind == "new-database" else f"{target.id}.{t.schema_name}"


def _key_context(derivation: str) -> str:
    return f"pseudonym-key:{derivation}"


def _table_key(ref) -> cohort_derive.TableKey:
    return (ref.schema_name.lower() if ref.schema_name else None, ref.table.lower())


def _minimization(body: DeriveRequest) -> cohort_derive.Minimization:
    dates: dict[cohort_derive.TableKey, dict[str, str]] = {}
    for d in body.dates:
        dates.setdefault(_table_key(d), {})[d.column] = d.precision
    return cohort_derive.Minimization(
        scope=body.scope,
        tables=None if body.tables is None else {_table_key(t) for t in body.tables},
        copy_unproven={_table_key(t) for t in body.copy_unproven_tables},
        variables={_table_key(v): (v.columns, v.concept_ids) for v in body.variables},
        dates=dates,
    )


def unproven_copied(tables: list[dict]) -> list[str]:
    """The tables a build copied on the caller's explicit opt-in, where they landed."""
    return [f"{t['schema']}.{t['table']}" if t.get("schema") else t["table"] for t in tables if t.get("unproven")]


def _check_options(body: DeriveRequest) -> None:
    try:
        cohort_derive.check_scope(body.level, body.scope)
    except ValueError as exc:
        raise DeriveError(str(exc)) from exc
    if any(d.precision not in cohort_derive.DATE_PRECISIONS for d in body.dates):
        raise DeriveError("a date is kept to the year, to the month, or emptied")
    p = body.pseudonymization
    if p is not None and p.method not in ("hmac", "random"):
        raise DeriveError("pseudonyms are drawn by HMAC or at random")
    if p is not None and p.method == "random" and p.reuse_key_of:
        raise DeriveError("only an HMAC pseudonymisation reuses a key")


async def _correspondence_target(
    db: AsyncSession, source: DataSource, target: DataSource, body: DeriveRequest, user_id: int,
) -> cohort_derive.TargetSpec | None:
    """Where the correspondence goes: never into the derived database itself —
    the CNIL referential keeps it apart from the pseudonymised data (5.8)."""
    p = body.pseudonymization
    if p is None or p.correspondence is None:
        return None
    c = p.correspondence
    corr = await db.get(DataSource, c.data_source_id)
    if corr is None or corr.workspace_id != source.workspace_id:
        raise DeriveError("the correspondence database is not one of this workspace")
    if _same_database(target, corr):
        raise DeriveError("the correspondence cannot go into the derived database: keep it apart")
    if not _SCHEMA_NAME.match(c.schema_name or "") or not _SCHEMA_NAME.match(c.table_name or ""):
        raise DeriveError("the correspondence schema and table names must be lowercase letters, digits and underscores")
    if data_source_service.is_managed(corr) and data_source_service.is_managed(source) and _same_database(source, corr):
        raise DeriveError("the correspondence cannot go into the file the cohort is read from")
    return _writable_target(corr, c.schema_name, False, await write_login(db, corr, user_id))


def _open_key(row: PseudonymKey) -> bytes:
    raw = crypto.decrypt(row.sealed_key, _key_context(row.id))
    if raw is None:
        raise DeriveError("the kept pseudonymisation key cannot be opened on this server")
    return base64.b64decode(raw)


async def _own_key(db: AsyncSession, workspace_id: str | None, derivation: str) -> PseudonymKey | None:
    """The key kept under `derivation`'s name. Its name comes from a database id
    the client may choose: a key of another workspace is never this derivation's."""
    row = await db.get(PseudonymKey, derivation)
    if row is not None and row.workspace_id != workspace_id:
        raise DeriveError("this database id names a derivation of another workspace")
    return row


async def _hmac_key(db: AsyncSession, workspace_id: str | None, derivation: str, body: DeriveRequest) -> bytes:
    """The key to draw with: another derivation's (a cohort followed over time),
    else this one's own, kept from its last build — which also stands in for a
    followed derivation deleted since — else a new one."""
    p = body.pseudonymization
    own = await _own_key(db, workspace_id, derivation)
    if not p.keep_key:
        own = None
    if p.reuse_key_of:
        row = await db.get(PseudonymKey, p.reuse_key_of)
        if row is not None and row.workspace_id == workspace_id:
            return _open_key(row)
        if own is None:
            raise DeriveError("no key is kept for the derivation to follow")
    if own is not None:
        return _open_key(own)
    return secrets.token_bytes(32)


async def _pseudonyms(
    db: AsyncSession, source: DataSource, target: DataSource, body: DeriveRequest, user_id: int,
) -> cohort_derive.Pseudonyms | None:
    p = body.pseudonymization
    if p is None:
        return None
    derivation = derivation_id(target, body)
    key = await _hmac_key(db, source.workspace_id, derivation, body) if p.method == "hmac" else None
    return cohort_derive.Pseudonyms(
        p.method,
        key,
        await _correspondence_target(db, source, target, body, user_id),
        p.correspondence.table_name if p.correspondence else "linkr_pseudonyms",
        derivation,
        job_label(source, target, body, None),
    )


async def _keep_key(
    db: AsyncSession, source: DataSource, derivation: str, body: DeriveRequest, pseudonyms, user_id: int,
) -> None:
    """Kept, sealed, when asked; otherwise no key of an earlier build is left:
    its pseudonyms are no longer the ones in the database."""
    row = await _own_key(db, source.workspace_id, derivation)
    keep = pseudonyms is not None and pseudonyms.method == "hmac" and body.pseudonymization.keep_key
    if not keep:
        if row is not None:
            await db.delete(row)
        return
    sealed = crypto.encrypt(base64.b64encode(pseudonyms.key).decode("ascii"), _key_context(derivation))
    if row is None:
        db.add(PseudonymKey(id=derivation, workspace_id=source.workspace_id, sealed_key=sealed, created_by=user_id))
    else:
        row.sealed_key = sealed


# Target id → the job deriving into it (None while that job is being created).
# In memory: jobs run in this process, and none survives a restart.
_running: dict[str, str | None] = {}


def reserve(target_id: str) -> None:
    """Claim `target_id` for one derivation, or raise DeriveBusy: two builds into
    one target would overwrite each other's file or schema. Synchronous, so no
    other request can slip in between the check and the claim."""
    if target_id in _running:
        job_id = _running[target_id]
        if job_id is None or jobs.is_running(job_id):
            raise DeriveBusy("a derivation into this database is already queued or running")
    _running[target_id] = None


def bind_job(target_id: str, job_id: str) -> None:
    _running[target_id] = job_id


def building(target_id: str) -> bool:
    """Whether a derivation into `target_id` is queued or running in this process."""
    if target_id not in _running:
        return False
    job_id = _running[target_id]
    return job_id is None or jobs.is_running(job_id)


def release(target_id: str, job_id: str | None = None) -> None:
    if target_id in _running and _running[target_id] == job_id:
        del _running[target_id]


def mark_first_build(target: DataSource, may_remove: bool) -> None:
    """Flag a database whose first build is starting, so a restart that kills the
    job (none survives one) can tell its card from one merely being set up."""
    target.linkr_created = {**_created(target), "building": {"removable": may_remove}}


async def reconcile_interrupted_builds(db: AsyncSession) -> None:
    """At startup, no derivation is running: a first build still flagged was
    interrupted. Its card goes as a failed first build's does — removed when the
    launcher could remove it, else left in error."""
    rows = (await db.execute(select(DataSource).where(DataSource.linkr_created.is_not(None)))).scalars().all()
    for row in [r for r in rows if "building" in _created(r)]:
        building, row_id = _created(row)["building"], row.id
        if isinstance(building, dict) and building.get("removable") and not _created(row).get("file"):
            try:
                await data_source_service.delete(db, row)
                continue
            except Exception:
                await db.rollback()
                row = await db.get(DataSource, row_id)
                if row is None:
                    continue
        row.linkr_created = {k: v for k, v in _created(row).items() if k != "building"} or None
        row.status = "error"
        row.error_message = "The derivation was interrupted: the server restarted before it finished."
        await db.commit()


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
    _check_options(body)
    if database_binding.is_foreign(target, source.workspace_id):
        raise DeriveError(database_binding.FOREIGN_DATABASE)
    await _own_key(db, source.workspace_id, derivation_id(target, body))
    if body.target.kind == "new-database" and not _created(target).get("file"):
        # A build replaces the database's content: never one others filled.
        if await data_source_service.holds_files_or_cohorts(db, target.id):
            raise DeriveError("the target database already holds data; derive into a new database")
    await _source_spec(db, source, user_id)
    await _target_spec(source, target, body, await _target_login(db, target, body, user_id))
    await _pseudonyms(db, source, target, body, user_id)


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
    *,
    may_remove: bool = False,
) -> dict:
    """Copy `source`, filtered on the cohort, into `target`, and record it —
    reading and writing with `user_id`'s own logins, resolved now (the job runs
    as its launcher, never with a secret copied into it).

    `progress(percent, line)` is told of each table as it starts. A new database
    that never held a build is removed again when this fails or is cancelled —
    only when `may_remove`: the launcher may delete it, or it is the empty card
    they created for this derivation. Otherwise the row is left as it was.

    The derived database copies the EFFECTIVE mapping (base + the source's
    overrides) as its own base, as the app does (derivedDatabaseRow)."""
    mapping = cohort_derive.effective_mapping(source.schema_mapping or {}, source.schema_overrides)
    spec = await _source_spec(db, source, user_id)
    t = body.target
    target_login = await _target_login(db, target, body, user_id)
    target_spec, config, new_location = await _target_spec(source, target, body, target_login)
    pseudonyms = await _pseudonyms(db, source, target, body, user_id)
    first_build = may_remove and t.kind == "new-database" and not _created(target).get("file")
    target_id = target.id  # read now: a rollback expires the instance
    try:
        return await _derive(
            db, source, target, body, cohort, mapping, spec, target_spec, config, new_location, progress,
            user_id, target_login, pseudonyms,
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
    user_id: int, target_login: Login | None, pseudonyms: cohort_derive.Pseudonyms | None,
) -> dict:
    t = body.target
    loop = asyncio.get_running_loop()
    control = cohort_derive.DeriveControl()
    table_reports: list[concurrent.futures.Future] = []
    if progress is not None:
        def on_table(done: int, total: int, table: str) -> None:
            pct = 5 + int(90 * done / max(1, total))
            table_reports.append(asyncio.run_coroutine_threadsafe(progress(pct, f"{done + 1}/{total} {table}"), loop))
        control.on_table = on_table

    # A warm pooled connection holds these files READ_ONLY: DuckDB would refuse
    # to open them again in the same process.
    connection_pool.invalidate(source.id)
    connection_pool.invalidate(target.id)
    if body.pseudonymization is not None and body.pseudonymization.correspondence is not None:
        connection_pool.invalidate(body.pseudonymization.correspondence.data_source_id)

    try:
        members = await _in_thread(lambda: cohort_derive.compute_members(spec, body.membership_sql), control)
        if progress is not None:
            await progress(5, f"{members.num_rows} rows in the cohort")
        tables = await _in_thread(
            lambda: cohort_derive.derive(
                spec, target_spec, members, mapping, body.level, body.copy_personless, control,
                _minimization(body), pseudonyms,
            ),
            control,
        )
    finally:
        # Landed before the job's own end is written: a late one would put the
        # finished job's progress back under 100.
        await asyncio.gather(*(asyncio.wrap_future(f) for f in table_reports), return_exceptions=True)
    patient_count = len(set(members.column("patient_id").to_pylist()))
    built_at = datetime.now(timezone.utc).isoformat()
    derivation = derivation_id(target, body)
    # From what this build did: the client's `derived_from` says nothing about it.
    copied_unproven = unproven_copied(tables)
    derived_from = {
        **{k: v for k, v in (body.derived_from or {}).items() if k != "copiedUnproven"},
        "builtAt": built_at, "patientCount": patient_count, "derivationId": derivation,
        **({"copiedUnproven": copied_unproven} if copied_unproven else {}),
    }
    await _keep_key(db, source, derivation, body, pseudonyms, user_id)

    produced_id: str | None = None
    # A rebuild of a schema declared before updates that database, rather than
    # declaring the same schema a second time.
    previous = next(
        (d for d in (cohort.derivations if cohort is not None else None) or []
         if d.get("targetId") == target.id and d.get("schemaName") == t.schema_name and d.get("registeredId")),
        None,
    )
    registered_before = await db.get(DataSource, previous["registeredId"]) if previous and t.kind == "schema" else None
    if registered_before is not None and (
        registered_before.workspace_id != target.workspace_id
        or _created(registered_before).get("schema") != t.schema_name
        or _created(registered_before).get("targetId") != target.id
    ):
        registered_before = None
    registered_new: DataSource | None = None
    if t.kind == "schema":
        schemas = {*_created(target).get("schemas", []), t.schema_name}
        target.linkr_created = {**_created(target), "schemas": sorted(schemas)}
    if t.kind == "new-database":
        config["managed"] = True
        config.pop("inMemory", None)
        target.connection_config = config
        target.schema_mapping = copy.deepcopy(mapping)
        target.derived_from = derived_from
        target.linkr_created = {**{k: v for k, v in _created(target).items() if k != "building"}, "file": True}
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
            alias=await data_source_service.free_alias(db, target.workspace_id, t.register_alias or t.schema_name),
            name=t.register_name if isinstance(t.register_name, dict) else {"en": t.register_name},
            source_type="database",
            connection_config={**{k: v for k, v in (target.connection_config or {}).items() if k != "allowWrites"}, "schema": t.schema_name},
            schema_mapping=copy.deepcopy(mapping),
            schema_source=source.schema_source,
            derived_from={**derived_from, "schemaName": t.schema_name},
            # The schema this derivation created: the one deleting the database
            # may drop — never whatever the connection is later pointed at.
            linkr_created={
                "schema": t.schema_name, "targetId": target.id,
                "server": data_source_service.server_of(target.connection_config or {}),
            },
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
            "derivationId": derivation,
            # What it kept, so a rebuild from the dialog keeps the same.
            **({"options": derived_from["options"]} if derived_from.get("options") else {}),
            **({"copiedUnproven": copied_unproven} if copied_unproven else {}),
        }
        kept = [
            d for d in (cohort.derivations or [])
            if not (d.get("targetId") == target.id and d.get("schemaName") == t.schema_name)
        ]
        cohort.derivations = [*kept, record]

    await db.commit()
    for written in {target.id, produced_id} - {None}:
        await data_source_service.invalidate_concept_caches(db, written)
    # The launcher's own login comes along — never a write login, which would
    # read the new database with an account that may write it.
    if registered_new is not None and target_login is not None and write_purpose(target) == database_credential_service.READ:
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
