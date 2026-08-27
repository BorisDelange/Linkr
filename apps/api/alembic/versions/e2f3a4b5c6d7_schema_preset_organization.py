"""schema presets gain an organization column, like every other exportable entity

Nine models carry the frozen `organization` provenance snapshot (project,
data_source, data_catalog, dq_rule_set, mapping_project, etl_pipeline,
sql_script, user_plugin); schema_presets was the only one without it, so a
preset had no organization of its own at all.

That is not merely a dropped field: `attachEntityOrganization` falls back to the
parent workspace's organization when the entity carries none, so every schema
preset exported as whoever owned the workspace — and re-exporting from an
instance with a different active organization silently re-attributed the entity
in its published repo. With the column present, the Attribution tab's choice is
stored and wins over the inherited value.

Nullable with no backfill: NULL keeps the existing inherit-from-workspace
behaviour, which is the right default for a preset nobody has re-attributed. The
export omits the key when empty, so adding the column changes no exported bytes.

Revision ID: e2f3a4b5c6d7
Revises: d1e2f3a4b5c6
Create Date: 2026-08-27 10:00:00.000000

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

from app.models.base import JSONB_or_JSON

revision: str = "e2f3a4b5c6d7"
down_revision: Union[str, None] = "d1e2f3a4b5c6"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("schema_presets", sa.Column("organization", JSONB_or_JSON, nullable=True))


def downgrade() -> None:
    op.drop_column("schema_presets", "organization")
