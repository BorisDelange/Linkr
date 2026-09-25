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

**Downgrade is irreversible for secrets.** It restores the schema, not the data:
the deleted shared passwords are gone, and git tokens / IDE connection secrets
stay sealed under the new key, which the previous code cannot open — each user
re-enters them after a downgrade.

The crypto is vendored (``_legacy_fernet_decrypt``, ``_seal``), not imported
from ``app.core.crypto``: a migration must run the same forever, whatever that
module becomes. It is byte-compatible with crypto.py as of this revision
(``v2.<key id>.<b64 nonce||ciphertext+tag>``, AES-256-GCM, the context as
associated data, the same key source) — tests/test_migration_crypto.py pins it.

Revision ID: c4d5e6f7a8b9
Revises: 83e1d5666f0f
Create Date: 2026-09-25 12:00:00
"""
import base64
import hashlib
import json
import os
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


# --- Vendored crypto (frozen at this revision) --------------------------------

def _b64d(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def _b64e(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def _parse_key(value: str) -> bytes:
    key = _b64d(value.strip())
    if len(key) != 32:
        raise RuntimeError("LINKR_ENCRYPTION_KEY must be the urlsafe base64 of 32 bytes")
    return key


def _current_key(encryption_key: str | None, key_path) -> bytes:
    """LINKR_ENCRYPTION_KEY, else ``data_dir/secret.key``, created (0600, O_EXCL)
    when missing — the key the app then keeps using."""
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM

    if encryption_key:
        return _parse_key(encryption_key)
    if key_path.is_file():
        return _parse_key(key_path.read_text())
    key = AESGCM.generate_key(bit_length=256)
    try:
        fd = os.open(key_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        return _parse_key(key_path.read_text())
    with os.fdopen(fd, "w") as fh:
        fh.write(_b64e(key))
    return key


def _seal(plaintext: str, context: str, key: bytes) -> str:
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM

    nonce = os.urandom(12)
    sealed = AESGCM(key).encrypt(nonce, plaintext.encode("utf-8"), context.encode("utf-8"))
    return f"v2.{hashlib.sha256(key).hexdigest()[:8]}.{_b64e(nonce + sealed)}"


def _legacy_fernet_decrypt(token: str, secret_key: str) -> str | None:
    from cryptography.fernet import Fernet, InvalidToken

    digest = hashlib.sha256(secret_key.encode("utf-8")).digest()
    try:
        return Fernet(base64.urlsafe_b64encode(digest)).decrypt(token.encode("ascii")).decode("utf-8")
    except (InvalidToken, ValueError):
        return None


def _reseal_secrets(bind) -> None:
    from app.config import settings

    key: list[bytes] = []

    def seal(plain: str, context: str) -> str:
        # Loaded on first use, as crypto.py does: no secret, no key file created.
        if not key:
            key.append(_current_key(settings.encryption_key, settings.data_path / "secret.key"))
        return _seal(plain, context, key[0])

    for row_id, user_id, host, secret in bind.execute(
        sa.text("SELECT id, user_id, host, secret FROM git_credentials")
    ).all():
        plain = _legacy_fernet_decrypt(secret, settings.secret_key)
        if plain is None:
            bind.execute(sa.text("DELETE FROM git_credentials WHERE id = :id"), {"id": row_id})
            continue
        bind.execute(
            sa.text("UPDATE git_credentials SET secret = :s WHERE id = :id"),
            {"s": seal(plain, f"git:{user_id}:{host}"), "id": row_id},
        )

    for row_id, secret in bind.execute(
        sa.text("SELECT id, connection_secret FROM ide_connections WHERE connection_secret IS NOT NULL")
    ).all():
        plain = _legacy_fernet_decrypt(secret, settings.secret_key)
        bind.execute(
            sa.text("UPDATE ide_connections SET connection_secret = :s WHERE id = :id"),
            {"s": seal(plain, f"ide:{row_id}") if plain is not None else None, "id": row_id},
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
    """Schema only: the secrets are not restored (see the module docstring)."""
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
