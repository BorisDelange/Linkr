"""dq_custom_checks.check_key: a data-quality check's portable key, set once

Until now the key was derived from the check's name at every export, so a
rename changed it. Quality profiles point at checks by key: existing checks get
the key an export would have given them, and keep it from now on.

Revision ID: a1c3e5f7b9d1
Revises: f8b0c2d4e6a8
Create Date: 2026-11-09 12:00:00.000000

"""
import unicodedata
from collections import defaultdict
from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

revision: str = "a1c3e5f7b9d1"
down_revision: Union[str, None] = "f8b0c2d4e6a8"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


# Frozen copies of app.services.dq_check_portable.check_keys and
# workspace_export._slugify as they were when this migration was written: the
# keys it stamps must not move when that code does.
def _slugify(name: str) -> str:
    decomposed = unicodedata.normalize("NFD", name)
    without_marks = "".join(c for c in decomposed if unicodedata.category(c) != "Mn")
    out: list[str] = []
    prev_dash = False
    for ch in without_marks.lower():
        if ch.isascii() and ch.isalnum():
            out.append(ch)
            prev_dash = False
        elif not prev_dash:
            out.append("-")
            prev_dash = True
    return "".join(out).strip("-") or "export"


def _name_text(name) -> str:
    if isinstance(name, str):
        return name
    if not isinstance(name, dict):
        return ""
    preferred = name.get("en")
    if isinstance(preferred, str) and preferred.strip():
        return preferred
    return next((v for v in name.values() if isinstance(v, str) and v.strip()), "")


def _check_keys(checks) -> list[str]:
    seen: set[str] = set()
    keys: list[str] = []
    for template_key, name in checks:
        base = template_key or _slugify(_name_text(name) or "check")
        key = base
        n = 2
        while key in seen:
            key = f"{base}#{n}"
            n += 1
        seen.add(key)
        keys.append(key)
    return keys


def upgrade() -> None:
    with op.batch_alter_table("dq_custom_checks") as batch:
        batch.add_column(sa.Column("check_key", sa.Text(), nullable=True))

    conn = op.get_bind()
    rows = conn.execute(sa.text(
        'SELECT id, rule_set_id, template_key, name, "order" FROM dq_custom_checks'
    )).fetchall()
    by_rule_set: dict[str, list] = defaultdict(list)
    for row in rows:
        by_rule_set[row.rule_set_id].append(row)
    update = sa.text("UPDATE dq_custom_checks SET check_key = :key WHERE id = :id")
    for checks in by_rule_set.values():
        # The order an export walks them in, so each check keeps the key its
        # last export gave it.
        checks.sort(key=lambda r: (r.order or 0, str(r.id)))
        keys = _check_keys((r.template_key, r.name) for r in checks)
        for row, key in zip(checks, keys):
            conn.execute(update, {"key": key, "id": row.id})


def downgrade() -> None:
    with op.batch_alter_table("dq_custom_checks") as batch:
        batch.drop_column("check_key")
