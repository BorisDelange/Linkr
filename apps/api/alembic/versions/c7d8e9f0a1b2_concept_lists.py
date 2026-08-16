"""Concept lists

Revision ID: c7d8e9f0a1b2
Revises: d0e1f2a3b4c5
Create Date: 2026-08-16

Project-scoped, user-authored lists of concepts, built while browsing the
Concepts page.

Deliberately NOT the same thing as `concept_sets`: a concept *set* is an
imported data dictionary (workspace-scoped, read-only, carrying an OHDSI
expression), while a concept *list* is hand-built and travels with its project
through export / versioning / import. Hence the project FK and the
LocalizedString name/description used by every other user-authored entity.

`items` denormalizes each concept (id, name, code, vocabulary, dict key) so a
list stays readable after the source database is detached.
"""

import sqlalchemy as sa
from alembic import op

from app.models.base import JSONB_or_JSON

revision = "c7d8e9f0a1b2"
down_revision = "d0e1f2a3b4c5"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "concept_lists",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column(
            "project_uid",
            sa.String(36),
            sa.ForeignKey("projects.uid", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("name", JSONB_or_JSON, nullable=True),
        sa.Column("description", JSONB_or_JSON, nullable=True),
        sa.Column("items", JSONB_or_JSON, nullable=True),
        sa.Column("data_source_id", sa.String(36), nullable=True),
        sa.Column("version", sa.String(20), nullable=False, server_default="0.1.0"),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )
    op.create_index("ix_concept_lists_project_uid", "concept_lists", ["project_uid"])


def downgrade() -> None:
    op.drop_index("ix_concept_lists_project_uid", table_name="concept_lists")
    op.drop_table("concept_lists")
