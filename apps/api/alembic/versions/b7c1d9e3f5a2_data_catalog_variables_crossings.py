"""data catalogs count variables and their crossings

A catalog's configuration was a list of dimensions plus a period table widened
by sex, age, services and concept categories. It is now a set of variables
(concept, period, service, age, sex), each with its parameters, and the
crossings to count them in. The period table was exactly the period × X
crossings, so each enabled enrichment becomes one; the old columns are then
dropped (the frontend twin is `convertLegacyCatalog` in lib/data-catalog/config.ts).

`computed_periods` (a resume offset into the period list) becomes
`computed_steps` (into the run's unit plan): an offset into the old plan means
nothing in the new one, so a paused run starts over. `pages_deployment` had no
migration of its own.

Revision ID: b7c1d9e3f5a2
Revises: d4f6b8c0e2a3
Create Date: 2026-09-27 12:00:00.000000

"""
import json
from typing import Any, Sequence, Union

import sqlalchemy as sa
from alembic import op

from app.models.base import JSONB_or_JSON

revision: str = "b7c1d9e3f5a2"
down_revision: Union[str, None] = "d4f6b8c0e2a3"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

ORDER = ["concept", "period", "service", "age", "sex"]
DEFAULT_BRACKETS = [10, 20, 30, 40, 50, 60, 70, 80, 90]


def _load(value: Any) -> Any:
    # SQLite hands JSON back as text.
    return json.loads(value) if isinstance(value, str) else value


def convert(dimensions: Any, category_column: str | None, subcategory_column: str | None, period_config: Any) -> tuple[dict, list]:
    dims = [d for d in (_load(dimensions) or []) if isinstance(d, dict)]
    pc = _load(period_config) or None

    def dim(kind: str) -> dict:
        return next((d for d in dims if d.get("type") == kind), {})

    service_labels = (pc or {}).get("serviceLabels") or []
    concept_categories = (pc or {}).get("conceptCategories") or []
    concept: dict = {
        "enabled": bool(concept_categories) and bool(category_column),
        "level": "category" if category_column else "concept",
        "scope": "all",
        "topN": 100,
    }
    if category_column:
        concept["categoryColumn"] = category_column
    if subcategory_column:
        concept["subcategoryColumn"] = subcategory_column
    variables = {
        "concept": concept,
        "period": {"enabled": bool(pc), "granularity": (pc or {}).get("granularity") or "month"},
        "service": {
            "enabled": bool(dim("care_site").get("enabled")),
            "level": (pc or {}).get("serviceLevel") or (dim("care_site").get("careSite") or {}).get("level") or "visit_detail",
            # A picked subset of services becomes groups of one, the rest "Other".
            "grouping": "manual" if service_labels else "all",
            "topN": 10,
            "groups": {label: label for label in service_labels},
            "unassigned": "other",
        },
        "age": {
            "enabled": bool(dim("age_group").get("enabled")),
            "brackets": (dim("age_group").get("ageGroup") or {}).get("brackets") or DEFAULT_BRACKETS,
        },
        "sex": {"enabled": bool(dim("sex").get("enabled"))},
    }
    crossings = []
    if variables["period"]["enabled"]:
        for v in ["concept", "service", "age", "sex"]:
            if variables[v]["enabled"]:
                crossings.append(sorted(["period", v], key=ORDER.index))
    return variables, crossings


def upgrade() -> None:
    with op.batch_alter_table("data_catalogs", schema=None) as batch_op:
        batch_op.add_column(sa.Column("variables", JSONB_or_JSON, nullable=True))
        batch_op.add_column(sa.Column("crossings", JSONB_or_JSON, nullable=True))
        batch_op.add_column(sa.Column("computed_steps", sa.Integer(), nullable=True))
        batch_op.add_column(sa.Column("pages_deployment", JSONB_or_JSON, nullable=True))

    bind = op.get_bind()
    table = sa.table(
        "data_catalogs",
        sa.column("id", sa.String),
        sa.column("dimensions", sa.JSON),
        sa.column("category_column", sa.String),
        sa.column("subcategory_column", sa.String),
        sa.column("period_config", sa.JSON),
        sa.column("variables", JSONB_or_JSON),
        sa.column("crossings", JSONB_or_JSON),
    )
    rows = bind.execute(sa.select(
        table.c.id, table.c.dimensions, table.c.category_column, table.c.subcategory_column, table.c.period_config,
    )).fetchall()
    for row in rows:
        variables, crossings = convert(row.dimensions, row.category_column, row.subcategory_column, row.period_config)
        bind.execute(table.update().where(table.c.id == row.id).values(variables=variables, crossings=crossings))

    with op.batch_alter_table("data_catalogs", schema=None) as batch_op:
        batch_op.drop_column("dimensions")
        batch_op.drop_column("category_column")
        batch_op.drop_column("subcategory_column")
        batch_op.drop_column("period_config")
        batch_op.drop_column("computed_periods")


def downgrade() -> None:
    # The old configuration is not rebuilt: a downgraded catalog is reconfigured by hand.
    with op.batch_alter_table("data_catalogs", schema=None) as batch_op:
        batch_op.add_column(sa.Column("dimensions", sa.JSON(), nullable=True))
        batch_op.add_column(sa.Column("category_column", sa.String(length=255), nullable=True))
        batch_op.add_column(sa.Column("subcategory_column", sa.String(length=255), nullable=True))
        batch_op.add_column(sa.Column("period_config", sa.JSON(), nullable=True))
        batch_op.add_column(sa.Column("computed_periods", sa.Integer(), nullable=True))
        batch_op.drop_column("pages_deployment")
        batch_op.drop_column("computed_steps")
        batch_op.drop_column("crossings")
        batch_op.drop_column("variables")
