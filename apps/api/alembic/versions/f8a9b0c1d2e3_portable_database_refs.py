"""portable database pointers for ETL, DQ, SQL collections and projects

The same fix `data_source_ref` brought to mapping projects and data catalogs,
for the four scopes that still shipped raw UUIDs. A local database id addresses
nothing on another instance, so an exported entity came back pointing at a row
that does not exist — and a reimport into a fresh instance, where every row is
minted anew, broke the link for certain.

Each `*_ref` column holds {lineageId?, entityId?, label?}: the portable form the
export carries and the import resolves back to a local row. ETL pipelines get
three (source database, target database, mapping project), projects get a LIST
(one per linked database, index-aligned with `linked_data_source_ids`), and
mapping projects gain the one their vocabulary database was missing.

Nullable with no backfill: the pointer is stamped when the target is picked, and
an entity whose database was never re-picked has nothing to point at. The export
omits an absent key, so adding these columns changes no exported bytes for
existing rows.

Revision ID: f8a9b0c1d2e3
Revises: e7f8a9b0c1d2
Create Date: 2026-08-31 10:20:00.000000

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

from app.models.base import JSONB_or_JSON

revision: str = "f8a9b0c1d2e3"
down_revision: Union[str, None] = "e7f8a9b0c1d2"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


# (table, column) pairs, in the order the models declare them.
_COLUMNS = [
    ("etl_pipelines", "source_data_source_ref"),
    ("etl_pipelines", "target_data_source_ref"),
    ("etl_pipelines", "mapping_project_ref"),
    ("dq_rule_sets", "data_source_ref"),
    ("sql_script_collections", "default_data_source_ref"),
    ("mapping_projects", "vocabulary_data_source_ref"),
    ("projects", "linked_data_source_refs"),
]


def upgrade() -> None:
    for table, column in _COLUMNS:
        op.add_column(table, sa.Column(column, JSONB_or_JSON, nullable=True))


def downgrade() -> None:
    for table, column in reversed(_COLUMNS):
        op.drop_column(table, column)
