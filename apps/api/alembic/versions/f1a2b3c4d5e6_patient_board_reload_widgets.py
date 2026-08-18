"""Add reload_widgets_on_tab_switch to patient dashboards.

Patient boards gained the keep-alive lever dashboards already had, so the board
needs the same persisted flag.

Guarded by an inspector check so a database whose schema was created straight
from the models (rather than by replaying the chain) upgrades cleanly too.

Revision ID: f1a2b3c4d5e6
Revises: e80a461ad95a
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "f1a2b3c4d5e6"
down_revision: Union[str, None] = "e80a461ad95a"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

TABLE = "patient_dashboards"
COLUMN = "reload_widgets_on_tab_switch"


def _has_column() -> bool:
    inspector = sa.inspect(op.get_bind())
    return COLUMN in {col["name"] for col in inspector.get_columns(TABLE)}


def upgrade() -> None:
    if not _has_column():
        op.add_column(TABLE, sa.Column(COLUMN, sa.Boolean(), nullable=True))


def downgrade() -> None:
    if _has_column():
        op.drop_column(TABLE, COLUMN)
