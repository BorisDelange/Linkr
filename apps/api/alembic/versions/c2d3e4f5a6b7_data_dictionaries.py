"""data dictionaries: workspace concept-set collections with their units

A data dictionary groups concept sets (concept_sets.dictionary_id) with the unit
conversions and recommended units of the repository they sync from. Existing
concept sets keep a null dictionary until the user organises them.

Revision ID: c2d3e4f5a6b7
Revises: b1c2d3e4f5a6
Create Date: 2026-09-28 12:00:00.000000

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

from app.models.base import JSONB_or_JSON

revision: str = "c2d3e4f5a6b7"
down_revision: Union[str, None] = "b1c2d3e4f5a6"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "data_dictionaries",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("workspace_id", sa.String(36), sa.ForeignKey("workspaces.id", ondelete="CASCADE"), nullable=False),
        sa.Column("name", sa.String(255), nullable=False, server_default=""),
        sa.Column("source_repo", sa.Text(), nullable=True),
        sa.Column("branch", sa.String(255), nullable=True),
        sa.Column("commit", sa.String(64), nullable=True),
        sa.Column("synced_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("unit_conversions", JSONB_or_JSON, nullable=True),
        sa.Column("recommended_units", JSONB_or_JSON, nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    with op.batch_alter_table("concept_sets") as batch:
        batch.add_column(sa.Column("dictionary_id", sa.String(36), nullable=True))
        batch.create_foreign_key(
            "fk_concept_sets_dictionary_id", "data_dictionaries", ["dictionary_id"], ["id"], ondelete="CASCADE"
        )


def downgrade() -> None:
    with op.batch_alter_table("concept_sets") as batch:
        batch.drop_constraint("fk_concept_sets_dictionary_id", type_="foreignkey")
        batch.drop_column("dictionary_id")
    op.drop_table("data_dictionaries")
