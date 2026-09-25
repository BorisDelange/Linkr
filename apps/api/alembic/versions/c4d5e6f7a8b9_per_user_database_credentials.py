"""Per-user database credentials

Each user reaches an external database with their own login: the shared
password (`data_sources.connection_secret`) and the username kept in
`connection_config` are deleted, not moved — Linkr cannot tell whose they were.
Every user enters their own on next use.

Also moves every other stored secret off the JWT-derived Fernet key onto
core/crypto's own key, sealed to its context: git tokens to (user, host), IDE
connection secrets to the connection. One that no longer opens (the secret key
changed since it was written) was unusable already and is dropped.

The concept detail-stats cache gains a `principal` in its key; being a cache, it
is recreated empty rather than migrated.

Revision ID: c4d5e6f7a8b9
Revises: 83e1d5666f0f
Create Date: 2026-09-25 12:00:00
"""
import json
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "c4d5e6f7a8b9"
down_revision: Union[str, None] = "83e1d5666f0f"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_LOGIN_KEYS = ("username", "password", "token")


def _as_dict(value) -> dict:
    if isinstance(value, dict):
        return value
    if isinstance(value, str) and value:
        try:
            parsed = json.loads(value)
        except ValueError:
            return {}
        return parsed if isinstance(parsed, dict) else {}
    return {}


def _reseal_secrets(bind) -> None:
    from app.config import settings
    from app.core import crypto

    for row_id, user_id, host, secret in bind.execute(
        sa.text("SELECT id, user_id, host, secret FROM git_credentials")
    ).all():
        plain = crypto.decrypt_legacy_fernet(secret, settings.secret_key)
        if plain is None:
            bind.execute(sa.text("DELETE FROM git_credentials WHERE id = :id"), {"id": row_id})
            continue
        bind.execute(
            sa.text("UPDATE git_credentials SET secret = :s WHERE id = :id"),
            {"s": crypto.encrypt(plain, f"git:{user_id}:{host}"), "id": row_id},
        )

    for row_id, secret in bind.execute(
        sa.text("SELECT id, connection_secret FROM ide_connections WHERE connection_secret IS NOT NULL")
    ).all():
        plain = crypto.decrypt_legacy_fernet(secret, settings.secret_key)
        bind.execute(
            sa.text("UPDATE ide_connections SET connection_secret = :s WHERE id = :id"),
            {"s": crypto.encrypt(plain, f"ide:{row_id}") if plain is not None else None, "id": row_id},
        )


def upgrade() -> None:
    op.create_table(
        "database_credentials",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("data_source_id", sa.String(length=36), nullable=False),
        sa.Column("username", sa.String(length=255), nullable=False),
        sa.Column("secret", sa.Text(), nullable=False),
        sa.Column("last_used_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("(CURRENT_TIMESTAMP)"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("(CURRENT_TIMESTAMP)"), nullable=False),
        sa.ForeignKeyConstraint(
            ["data_source_id"], ["data_sources.id"],
            name=op.f("fk_database_credentials_data_source_id"), ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["user_id"], ["users.id"], name=op.f("fk_database_credentials_user_id"), ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_database_credentials")),
        sa.UniqueConstraint("user_id", "data_source_id", name="uq_database_credential_user_source"),
    )
    with op.batch_alter_table("database_credentials", schema=None) as batch_op:
        batch_op.create_index(batch_op.f("ix_database_credentials_user_id"), ["user_id"], unique=False)
        batch_op.create_index(batch_op.f("ix_database_credentials_data_source_id"), ["data_source_id"], unique=False)

    bind = op.get_bind()
    for row_id, config in bind.execute(sa.text("SELECT id, connection_config FROM data_sources")).all():
        parsed = _as_dict(config)
        if not any(k in parsed for k in _LOGIN_KEYS):
            continue
        kept = {k: v for k, v in parsed.items() if k not in _LOGIN_KEYS}
        bind.execute(
            sa.text("UPDATE data_sources SET connection_config = :c WHERE id = :id"),
            {"c": json.dumps(kept), "id": row_id},
        )
    with op.batch_alter_table("data_sources", schema=None) as batch_op:
        batch_op.add_column(sa.Column("require_session_only", sa.Boolean(), server_default="0", nullable=False))
        batch_op.drop_column("connection_secret")

    _reseal_secrets(bind)

    op.drop_table("concept_stats_caches")
    op.create_table(
        "concept_stats_caches",
        sa.Column("data_source_id", sa.String(length=36), nullable=False),
        sa.Column("concept_id", sa.Integer(), nullable=False),
        sa.Column("principal", sa.String(length=40), server_default="", nullable=False),
        sa.Column("stats", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("(CURRENT_TIMESTAMP)"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("(CURRENT_TIMESTAMP)"), nullable=False),
        sa.ForeignKeyConstraint(
            ["data_source_id"], ["data_sources.id"],
            name=op.f("fk_concept_stats_caches_data_source_id"), ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("data_source_id", "concept_id", "principal", name=op.f("pk_concept_stats_caches")),
    )


def downgrade() -> None:
    op.drop_table("concept_stats_caches")
    op.create_table(
        "concept_stats_caches",
        sa.Column("data_source_id", sa.String(length=36), nullable=False),
        sa.Column("concept_id", sa.Integer(), nullable=False),
        sa.Column("stats", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("(CURRENT_TIMESTAMP)"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("(CURRENT_TIMESTAMP)"), nullable=False),
        sa.ForeignKeyConstraint(
            ["data_source_id"], ["data_sources.id"],
            name=op.f("fk_concept_stats_caches_data_source_id"), ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("data_source_id", "concept_id", name=op.f("pk_concept_stats_caches")),
    )
    with op.batch_alter_table("data_sources", schema=None) as batch_op:
        batch_op.add_column(sa.Column("connection_secret", sa.Text(), nullable=True))
        batch_op.drop_column("require_session_only")
    with op.batch_alter_table("database_credentials", schema=None) as batch_op:
        batch_op.drop_index(batch_op.f("ix_database_credentials_data_source_id"))
        batch_op.drop_index(batch_op.f("ix_database_credentials_user_id"))
    op.drop_table("database_credentials")
