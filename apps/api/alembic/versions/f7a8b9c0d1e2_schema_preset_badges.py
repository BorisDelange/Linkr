"""schema presets gain a badges column, like every other badged entity

Eight models carry `badges` (project, workspace, etl_pipeline, data_catalog,
dq_rule_set, mapping_project, sql_script, data_source); schema_presets was the
only badged entity without the column. The client type declares badges, the UI
offers them and the export writes them — but in server mode the API dropped
them silently on save, so a badge set on a schema never came back.

Nullable with no backfill: an existing preset genuinely has no badges, and NULL
is what every other table stores for that. The export omits the key when it is
empty, so adding the column changes no exported bytes.

Revision ID: f7a8b9c0d1e2
Revises: e6f7a8b9c0d1
Create Date: 2026-08-25 23:35:00.000000

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

from app.models.base import JSONB_or_JSON

revision: str = "f7a8b9c0d1e2"
down_revision: Union[str, None] = "e6f7a8b9c0d1"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("schema_presets", sa.Column("badges", JSONB_or_JSON, nullable=True))


def downgrade() -> None:
    op.drop_column("schema_presets", "badges")
