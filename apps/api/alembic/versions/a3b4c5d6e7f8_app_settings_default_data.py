"""app_settings records what the setup wizard did about the default data

The browser-side seed is gated on `localStorage`, which cannot answer "has this
instance been given its default data" — a second user on a second machine has an
empty one and re-triggers a seed that writes through the API. The answer has to
live where the instance does, so the wizard's decision is recorded here as
``{"entryId", "decidedAt", "installed", "workspaceId"}``.

Nullable with no backfill: NULL means "never asked", which is the truth for every
instance created before this. The wizard only runs when no user exists, so those
instances are never re-offered the question either way.

Revision ID: a3b4c5d6e7f8
Revises: e2f3a4b5c6d7
Create Date: 2026-08-27 12:00:00.000000

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

from app.models.base import JSONB_or_JSON

revision: str = "a3b4c5d6e7f8"
down_revision: Union[str, None] = "e2f3a4b5c6d7"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("app_settings", sa.Column("default_data", JSONB_or_JSON, nullable=True))


def downgrade() -> None:
    op.drop_column("app_settings", "default_data")
