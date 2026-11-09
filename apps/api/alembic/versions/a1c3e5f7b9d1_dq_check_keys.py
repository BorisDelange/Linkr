"""dq_custom_checks.check_key: a data-quality check's portable key, set once

Until now the key was derived from the check's name at every export, so a
rename changed it. Quality profiles point at checks by key: existing checks get
the key an export would have given them, and keep it from now on.

Revision ID: a1c3e5f7b9d1
Revises: e6a8c0e2b4d6
Create Date: 2026-11-09 12:00:00.000000

"""
from collections import defaultdict
from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op
from app.services.dq_check_portable import check_keys

revision: str = "a1c3e5f7b9d1"
down_revision: Union[str, None] = "e6a8c0e2b4d6"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


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
        keys = check_keys((None, r.template_key, r.name) for r in checks)
        for row, key in zip(checks, keys):
            conn.execute(update, {"key": key, "id": row.id})


def downgrade() -> None:
    with op.batch_alter_table("dq_custom_checks") as batch:
        batch.drop_column("check_key")
