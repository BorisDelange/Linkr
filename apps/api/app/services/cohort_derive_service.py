"""Deriving a database from a cohort — the app side of services/data/cohort_derive:
resolving the source and the target, the permissions, and recording what was
built on the database it produced and on the cohort."""

import asyncio
import copy
import re
import uuid
from datetime import datetime, timezone

from sqlalchemy.ext.asyncio import AsyncSession

from app.models.cohort import Cohort
from app.models.data_source import DataSource
from app.schemas.data_source import DeriveRequest
from app.services import data_source_service
from app.services.data import cohort_derive, connection_pool, managed_db

_SCHEMA_NAME = re.compile(r"^[a-z_][a-z0-9_]{0,62}$")


class DeriveError(ValueError):
    """A derivation refused for a reason the user can act on (surfaced as 400)."""


async def _source_spec(db: AsyncSession, source: DataSource) -> cohort_derive.SourceSpec:
    specs = await data_source_service.role_attachments(db, {"source": source})
    if "source" not in specs:
        raise DeriveError("the database has no data to derive from")
    return cohort_derive.SourceSpec(specs["source"])


async def plan(db: AsyncSession, source: DataSource, level: str) -> list[dict]:
    spec = await _source_spec(db, source)
    connection_pool.invalidate(source.id)
    return await asyncio.to_thread(cohort_derive.plan, spec, source.schema_mapping or {}, level)


def _writable_target(target: DataSource, schema_name: str, replace: bool) -> cohort_derive.TargetSpec:
    config = dict(target.connection_config or {})
    if data_source_service.is_managed(target):
        path = data_source_service.managed_path(target)
        if not path.exists():
            raise DeriveError("the target database file is missing")
        return cohort_derive.TargetSpec("file", path=str(path), schema=schema_name, replace_schema=replace)
    if config.get("engine") == "postgresql":
        if not config.get("allowWrites"):
            raise DeriveError("this database does not allow Linkr to write into it")
        return cohort_derive.TargetSpec(
            "external",
            config=config,
            password=data_source_service.connection_password(target),
            schema=schema_name,
            replace_schema=replace,
        )
    raise DeriveError("a new schema can only be created in a database Linkr owns, or in Postgres")


async def derive(
    db: AsyncSession, source: DataSource, target: DataSource, body: DeriveRequest, cohort: Cohort | None
) -> dict:
    mapping = source.schema_mapping or {}
    spec = await _source_spec(db, source)
    t = body.target
    new_location: str | None = None
    if t.kind == "new-database":
        if not data_source_service.is_managed(target):
            raise DeriveError("the target must be a database Linkr creates")
        try:
            config, new_location = data_source_service.claim_managed_location(target, t.path)
        except ValueError as exc:
            raise DeriveError(str(exc)) from exc
        target_spec = cohort_derive.TargetSpec(
            "file", path=str(managed_db.path_of(target.id, config)), fresh_file=True
        )
    elif t.kind == "schema":
        if not t.schema_name or not _SCHEMA_NAME.match(t.schema_name):
            raise DeriveError("the schema name must be lowercase letters, digits and underscores")
        target_spec = _writable_target(target, t.schema_name, t.replace)
    else:
        raise DeriveError(f"unknown target kind {t.kind!r}")

    # A warm pooled connection holds these files READ_ONLY: DuckDB would refuse
    # to open them again in the same process.
    connection_pool.invalidate(source.id)
    connection_pool.invalidate(target.id)

    members = await asyncio.to_thread(cohort_derive.compute_members, spec, body.membership_sql)
    tables = await asyncio.to_thread(
        cohort_derive.derive, spec, target_spec, members, mapping, body.level, body.copy_personless
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
        registered_before.derived_from = derived_from
        registered_before.stats = {**(registered_before.stats or {}), "patientCount": patient_count}
        connection_pool.invalidate(registered_before.id)
        produced_id = registered_before.id
    elif t.register_name and target_spec.kind == "external":
        # The subset as a database of its own: same server and credentials, the
        # new schema as its scope. The password never passes through the client.
        registered = DataSource(
            workspace_id=target.workspace_id,
            alias=t.register_alias or t.schema_name,
            name=t.register_name if isinstance(t.register_name, dict) else {"en": t.register_name},
            source_type="database",
            connection_config={**{k: v for k, v in (target.connection_config or {}).items() if k != "allowWrites"}, "schema": t.schema_name},
            connection_secret=target.connection_secret,
            schema_mapping=copy.deepcopy(mapping),
            schema_source=source.schema_source,
            derived_from=derived_from,
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
