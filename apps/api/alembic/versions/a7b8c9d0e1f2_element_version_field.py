"""User-facing version field on versionable elements

Adds a portable semver `version` column (default '0.1.0') to the nine top-level
elements that live under a workspace: projects, mapping projects, ETL pipelines,
SQL script collections, data catalogs, DQ rule sets, schema presets, cohorts and
dashboards. server_default backfills existing rows. Organizations and workspaces
are intentionally excluded (reference entities, not versioned content); user
plugins keep their version inside the manifest, not a column.

Revision ID: a7b8c9d0e1f2
Revises: f5a6b7c8d9e0
Create Date: 2026-07-21 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

import app.models.base  # noqa: F401

# revision identifiers, used by Alembic.
revision: str = 'a7b8c9d0e1f2'
down_revision: Union[str, None] = 'f5a6b7c8d9e0'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_TABLES = (
    'projects',
    'mapping_projects',
    'etl_pipelines',
    'sql_script_collections',
    'data_catalogs',
    'dq_rule_sets',
    'schema_presets',
    'cohorts',
    'dashboards',
)


def upgrade() -> None:
    for table in _TABLES:
        op.add_column(
            table,
            sa.Column('version', sa.String(length=20), nullable=False, server_default='0.1.0'),
        )


def downgrade() -> None:
    for table in _TABLES:
        op.drop_column(table, 'version')
