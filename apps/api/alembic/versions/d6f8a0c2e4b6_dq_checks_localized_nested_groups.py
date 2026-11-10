"""DQ checks: multilingual name and description, nested named groups

A check's name and description become LocalizedStrings, like every other
user-facing text; the existing plain strings are filed under 'en' (their real
language is unknown, and 'en' is what localized() falls back to).

A check's group was the `table_name` it shared with others, so a group had no
name of its own and could not nest. The column becomes `group_key`, the stable
key of a group, and `dq_rule_sets.check_groups` now declares the groups —
[{key, name, parentKey}] — instead of listing the bare keys of the empty ones.
A key no group declares still shows as a top-level group of that name, so the
existing checks need no declaration.

Revision ID: d6f8a0c2e4b6
Revises: c5e7a9b1d3f5
Create Date: 2026-11-10 09:00:00.000000

"""
import json
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

import app.models.base  # noqa: F401

revision: str = "d6f8a0c2e4b6"
down_revision: Union[str, None] = "c5e7a9b1d3f5"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_LEGACY_LANG = "en"

# Typed, so the JSON is (de)serialized by the dialect: a text parameter into a
# PostgreSQL json column is refused.
_rule_sets = sa.table("dq_rule_sets", sa.column("id", sa.String), sa.column("check_groups", sa.JSON(none_as_null=True)))


def _json_object(raw) -> dict | None:
    if isinstance(raw, dict):
        return raw
    try:
        value = json.loads(raw)
    except (ValueError, TypeError):
        return None
    return value if isinstance(value, dict) else None


def _json_list(raw) -> list | None:
    if raw is None or isinstance(raw, list):
        return raw
    try:
        value = json.loads(raw)
    except (ValueError, TypeError):
        return None
    return value if isinstance(value, list) else None


def upgrade() -> None:
    with op.batch_alter_table("dq_custom_checks", schema=None) as batch_op:
        batch_op.alter_column("name", existing_type=sa.String(length=255), type_=sa.Text())
        batch_op.alter_column("table_name", new_column_name="group_key", existing_type=sa.String(length=255))

    conn = op.get_bind()
    rows = conn.execute(sa.text("SELECT id, name, description FROM dq_custom_checks")).fetchall()
    for row_id, name, description in rows:
        updates = {}
        for column, raw in (("name", name), ("description", description)):
            if _json_object(raw) is not None:
                continue
            updates[column] = json.dumps({_LEGACY_LANG: raw} if raw else {})
        if updates:
            assignments = ", ".join(f"{col} = :{col}" for col in updates)
            conn.execute(sa.text(f"UPDATE dq_custom_checks SET {assignments} WHERE id = :id"), {**updates, "id": row_id})

    for row_id, raw in conn.execute(sa.select(_rule_sets.c.id, _rule_sets.c.check_groups)).fetchall():
        groups = _json_list(raw)
        if not groups or not any(isinstance(g, str) for g in groups):
            continue
        declared = [
            {"key": g, "name": {_LEGACY_LANG: g}, "parentKey": None} if isinstance(g, str) else g
            for g in groups
        ]
        conn.execute(_rule_sets.update().where(_rule_sets.c.id == row_id).values(check_groups=declared))


def downgrade() -> None:
    conn = op.get_bind()
    rows = conn.execute(sa.text("SELECT id, name, description FROM dq_custom_checks")).fetchall()
    for row_id, name, description in rows:
        updates = {}
        for column, raw in (("name", name), ("description", description)):
            value = _json_object(raw)
            if value is None:
                continue
            updates[column] = value.get(_LEGACY_LANG) or next(iter(value.values()), "")
        if updates:
            assignments = ", ".join(f"{col} = :{col}" for col in updates)
            conn.execute(sa.text(f"UPDATE dq_custom_checks SET {assignments} WHERE id = :id"), {**updates, "id": row_id})

    # Back to the bare keys of the groups holding no check; names and nesting are lost.
    used = {k for (k,) in conn.execute(sa.text("SELECT DISTINCT group_key FROM dq_custom_checks")).fetchall() if k}
    for row_id, raw in conn.execute(sa.select(_rule_sets.c.id, _rule_sets.c.check_groups)).fetchall():
        groups = _json_list(raw)
        if groups is None:
            continue
        keys = [g["key"] if isinstance(g, dict) else g for g in groups]
        empty = [k for k in keys if isinstance(k, str) and k not in used]
        conn.execute(_rule_sets.update().where(_rule_sets.c.id == row_id).values(check_groups=empty or None))

    with op.batch_alter_table("dq_custom_checks", schema=None) as batch_op:
        batch_op.alter_column("group_key", new_column_name="table_name", existing_type=sa.String(length=255))
        batch_op.alter_column("name", existing_type=sa.Text(), type_=sa.String(length=255))
