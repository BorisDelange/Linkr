"""Add lineage_id / parent_lineage_id to schema presets.

Every other exportable entity (project, workspace, ETL pipeline, mapping project,
SQL collection, data catalog, DQ rule set) already carries a cross-instance lineage.
Schema presets were the only type without one, so a preset published to the catalog
could not be recognised as already installed except by its git remote — and an entity
imported from a ZIP, which carries no remote, was invisible to that test.

Guarded by an inspector check so a database whose schema was created straight from the
models (rather than by replaying the chain) upgrades cleanly too.

Revision ID: 392c0e7ae5b8
Revises: f1a2b3c4d5e6
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "392c0e7ae5b8"
down_revision: Union[str, None] = "f1a2b3c4d5e6"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

TABLE = "schema_presets"
COLUMNS = ("lineage_id", "parent_lineage_id")


def _existing() -> set[str]:
    inspector = sa.inspect(op.get_bind())
    return {col["name"] for col in inspector.get_columns(TABLE)}


def upgrade() -> None:
    present = _existing()
    for column in COLUMNS:
        if column not in present:
            op.add_column(TABLE, sa.Column(column, sa.String(length=36), nullable=True))


def downgrade() -> None:
    present = _existing()
    for column in COLUMNS:
        if column in present:
            op.drop_column(TABLE, column)
