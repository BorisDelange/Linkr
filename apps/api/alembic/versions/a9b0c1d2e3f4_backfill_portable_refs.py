"""backfill the portable pointers for links configured before they existed

``f8a9b0c1d2e3`` added the ``*_ref`` columns but deliberately did not backfill:
the pointer is stamped when the user picks the target, so nothing was known about
rows already configured. That left a real gap — every link chosen before the
upgrade exports with a blanked id and NO pointer, i.e. the reference is simply
lost on the next round trip, which is the very bug the pointers exist to fix.

It is filled here instead, because the one thing this instance CAN do is read its
own rows: an id that still resolves locally identifies a real entity, and that
entity's ``lineage_id`` / ``entity_id`` / ``name`` are exactly what the pointer
holds. So each link with an id but no pointer gets one derived from the row it
already points at.

Only ever fills a blank. A pointer that exists is left untouched (it records the
user's actual choice), and an id resolving to nothing — a deleted database, or a
foreign UUID from an old import — yields no pointer rather than a guess.

Revision ID: a9b0c1d2e3f4
Revises: f8a9b0c1d2e3
Create Date: 2026-08-31 12:00:00.000000

"""
import json
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "a9b0c1d2e3f4"
down_revision: Union[str, None] = "f8a9b0c1d2e3"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


# (owner table, id column, ref column, target table)
_SINGLE_LINKS = [
    ("etl_pipelines", "source_data_source_id", "source_data_source_ref", "data_sources"),
    ("etl_pipelines", "target_data_source_id", "target_data_source_ref", "data_sources"),
    ("etl_pipelines", "mapping_project_id", "mapping_project_ref", "mapping_projects"),
    ("dq_rule_sets", "data_source_id", "data_source_ref", "data_sources"),
    ("sql_script_collections", "default_data_source_id", "default_data_source_ref", "data_sources"),
    ("data_catalogs", "data_source_id", "data_source_ref", "data_sources"),
    ("mapping_projects", "data_source_id", "data_source_ref", "data_sources"),
    ("mapping_projects", "vocabulary_data_source_id", "vocabulary_data_source_ref", "data_sources"),
]


def _pointer(row) -> str | None:
    """The portable pointer for a resolved target row, or None when it carries no
    identity to point at (neither lineage nor slug), which nothing downstream
    could resolve anyway."""
    lineage = getattr(row, "lineage_id", None)
    entity_id = getattr(row, "entity_id", None)
    if not lineage and not entity_id:
        return None
    ref: dict = {}
    if lineage:
        ref["lineageId"] = lineage
    if entity_id:
        ref["entityId"] = entity_id
    # `name` is a LocalizedString column; it keeps the reference nameable in the
    # UI when the target is not installed on the receiving instance.
    name = getattr(row, "name", None)
    if isinstance(name, str):
        try:
            name = json.loads(name)
        except (ValueError, TypeError):
            name = None
    if isinstance(name, dict):
        ref["label"] = name
    return json.dumps(ref)


def _targets(bind, table: str) -> dict:
    rows = bind.execute(
        sa.text(f"SELECT id, entity_id, lineage_id, name FROM {table}")
    ).fetchall()
    return {r.id: r for r in rows}


def upgrade() -> None:
    bind = op.get_bind()
    cache: dict[str, dict] = {}

    for owner, id_col, ref_col, target_table in _SINGLE_LINKS:
        if target_table not in cache:
            cache[target_table] = _targets(bind, target_table)
        targets = cache[target_table]
        rows = bind.execute(
            sa.text(
                f"SELECT id, {id_col} AS target_id FROM {owner} "
                f"WHERE {ref_col} IS NULL AND {id_col} IS NOT NULL AND {id_col} <> ''"
            )
        ).fetchall()
        for row in rows:
            target = targets.get(row.target_id)
            if target is None:
                continue
            ref = _pointer(target)
            if ref is None:
                continue
            bind.execute(
                sa.text(f"UPDATE {owner} SET {ref_col} = :ref WHERE id = :id"),
                {"ref": ref, "id": row.id},
            )

    # Projects hold a LIST of databases; the pointers stay index-aligned with it,
    # so an entry whose database no longer resolves keeps a placeholder rather
    # than shifting every later pointer onto the wrong database.
    databases = cache.get("data_sources") or _targets(bind, "data_sources")
    rows = bind.execute(
        sa.text(
            "SELECT uid, linked_data_source_ids FROM projects "
            "WHERE linked_data_source_refs IS NULL AND linked_data_source_ids IS NOT NULL"
        )
    ).fetchall()
    for row in rows:
        ids = row.linked_data_source_ids
        if isinstance(ids, str):
            try:
                ids = json.loads(ids)
            except (ValueError, TypeError):
                continue
        if not isinstance(ids, list) or not ids:
            continue
        refs = []
        for ds_id in ids:
            target = databases.get(ds_id)
            ref = _pointer(target) if target is not None else None
            refs.append(json.loads(ref) if ref else {})
        if any(refs):
            bind.execute(
                sa.text(
                    "UPDATE projects SET linked_data_source_refs = :refs WHERE uid = :uid"
                ),
                {"refs": json.dumps(refs), "uid": row.uid},
            )


def downgrade() -> None:
    """Backfill only — the columns themselves belong to f8a9b0c1d2e3. Clearing
    them here would also discard pointers the user has since stamped by picking a
    target, so this is deliberately a no-op."""
