"""README + licence on every documentable entity; polymorphic README attachments

Revision ID: c9d0e1f2a3b4
Revises: b8c9d0e1f2a3
Create Date: 2026-08-10

Three changes, one migration because they are one feature:

1. ``readme`` + ``license`` JSON columns on the seven entities that gained them
   (mapping projects, SQL collections, ETL pipelines, DQ rule sets, data catalogs,
   schema presets, user plugins); ``license`` alone on workspaces and projects,
   which already had a README. A licence is ``{id, name?, text}`` — the text is
   snapshotted at pick time so it travels with the export as LICENSE.md.

2. ``readme_attachments`` becomes polymorphic: ``project_uid`` gives way to
   ``owner_type`` + ``owner_id`` (no FK — the owner can be any of nine entity
   types, so each entity's delete cleans its own attachments). ``workspace_id``
   stays with its cascade so deleting a workspace still collects them all;
   pre-existing project rows get theirs backfilled from ``projects``.

3. The legacy tree README is hoisted into the entity: a root ``README.md`` file
   row inside an ETL pipeline / SQL collection becomes that entity's ``readme``
   and the file row is dropped. The name is now reserved (the export writes the
   entity's README there), so leaving both would emit two competing files. The
   frontend does the equivalent in its IndexedDB v37 migration.

Written against ``op.get_bind()`` with plain SQLAlchemy text so it runs on both
SQLite (batch_alter_table for the ALTER limitations) and Postgres.
"""

import json

import sqlalchemy as sa
from alembic import op

from app.models.base import JSONB_or_JSON

revision = "c9d0e1f2a3b4"
down_revision = "b8c9d0e1f2a3"
branch_labels = None
depends_on = None

# Entities that gained BOTH columns (they had no README before).
_READMEABLE = (
    "mapping_projects",
    "sql_script_collections",
    "etl_pipelines",
    "dq_rule_sets",
    "data_catalogs",
    "schema_presets",
    "user_plugins",
)

# Entities that already had a README and only gained a licence.
_LICENSE_ONLY = ("workspaces", "projects")

# (file table, owner table, owner FK column, owner PK column)
_TREE_READMES = (
    ("etl_files", "etl_pipelines", "pipeline_id", "id"),
    ("sql_script_files", "sql_script_collections", "collection_id", "id"),
)


def _hoist_tree_readmes(bind) -> None:
    """Move a pipeline's/collection's root README.md file row into the entity's
    ``readme`` column, then delete the row."""
    for files_table, owner_table, fk_col, pk_col in _TREE_READMES:
        rows = bind.execute(
            sa.text(
                f"SELECT id, {fk_col} AS owner_id, content FROM {files_table} "
                f"WHERE lower(name) = 'readme.md' AND parent_id IS NULL "
                f"AND type = 'file'"
            )
        ).fetchall()
        for row in rows:
            # Only adopt the file when the entity has no README yet — an entity
            # edited through the new UI already owns the authoritative one.
            bind.execute(
                sa.text(
                    f"UPDATE {owner_table} SET readme = :readme "
                    f"WHERE {pk_col} = :owner_id AND readme IS NULL"
                ),
                {
                    "readme": json.dumps({"en": row.content or ""}),
                    "owner_id": row.owner_id,
                },
            )
            bind.execute(
                sa.text(f"DELETE FROM {files_table} WHERE id = :id"), {"id": row.id}
            )


def upgrade() -> None:
    for table in _READMEABLE:
        op.add_column(table, sa.Column("readme", JSONB_or_JSON, nullable=True))
    for table in _READMEABLE + _LICENSE_ONLY:
        op.add_column(table, sa.Column("license", JSONB_or_JSON, nullable=True))

    op.add_column(
        "readme_attachments",
        sa.Column("owner_type", sa.String(length=20), nullable=True),
    )
    op.add_column(
        "readme_attachments",
        sa.Column("owner_id", sa.String(length=64), nullable=True),
    )

    bind = op.get_bind()
    bind.execute(
        sa.text(
            "UPDATE readme_attachments SET owner_type = 'project', "
            "owner_id = project_uid WHERE project_uid IS NOT NULL"
        )
    )
    bind.execute(
        sa.text(
            "UPDATE readme_attachments SET owner_type = 'workspace', "
            "owner_id = workspace_id "
            "WHERE project_uid IS NULL AND workspace_id IS NOT NULL"
        )
    )
    # A project row carried no workspace_id before (the scope was one or the
    # other); stamp it now so a workspace delete still cascades those rows.
    bind.execute(
        sa.text(
            "UPDATE readme_attachments SET workspace_id = ("
            "SELECT p.workspace_id FROM projects p WHERE p.uid = readme_attachments.owner_id"
            ") WHERE owner_type = 'project' AND workspace_id IS NULL"
        )
    )
    # Rows with neither scope were already unreachable; drop them rather than
    # leave NOT NULL violations behind.
    bind.execute(sa.text("DELETE FROM readme_attachments WHERE owner_type IS NULL"))

    with op.batch_alter_table("readme_attachments") as batch:
        batch.drop_column("project_uid")
        batch.alter_column("owner_type", existing_type=sa.String(length=20), nullable=False)
        batch.alter_column("owner_id", existing_type=sa.String(length=64), nullable=False)

    op.create_index(
        "ix_readme_attachments_owner",
        "readme_attachments",
        ["owner_type", "owner_id"],
    )

    _hoist_tree_readmes(bind)


def downgrade() -> None:
    op.drop_index("ix_readme_attachments_owner", table_name="readme_attachments")
    op.add_column(
        "readme_attachments",
        sa.Column("project_uid", sa.String(length=36), nullable=True),
    )
    bind = op.get_bind()
    bind.execute(
        sa.text(
            "UPDATE readme_attachments SET project_uid = owner_id "
            "WHERE owner_type = 'project'"
        )
    )
    # Only project/workspace README attachments existed before; the rest have no
    # representable scope.
    bind.execute(
        sa.text("DELETE FROM readme_attachments WHERE owner_type NOT IN ('project', 'workspace')")
    )
    with op.batch_alter_table("readme_attachments") as batch:
        batch.drop_column("owner_id")
        batch.drop_column("owner_type")

    for table in _READMEABLE + _LICENSE_ONLY:
        op.drop_column(table, "license")
    for table in _READMEABLE:
        op.drop_column(table, "readme")
