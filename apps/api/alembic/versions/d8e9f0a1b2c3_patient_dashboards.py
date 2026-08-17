"""Patient dashboards

Revision ID: d8e9f0a1b2c3
Revises: c7d8e9f0a1b2
Create Date: 2026-08-17

Patient-data boards: the Warehouse counterpart of `dashboards`, with the same
flat three-table shape (board / tabs / widgets keyed by parent id) so a project
can hold several patient-data boards, as the Lab holds several dashboards.

Until now this page persisted to a single global `localStorage` key, so its tabs
and widgets were browser-local — absent from the project export, from the server
and from git. These tables are what makes a board survive a machine change.

Two deliberate differences from `dashboards`:
- no `filter_config` / `default_dataset_file_id`: a patient widget reads OMOP
  tables for the selected patient, it does not bind to a dataset;
- no `parent_tab_id`: the board is the grouping level, so tabs stay a flat
  ordered list, and a widget always references a plugin (no inline-code variant),
  hence plugin_id/language/config as columns rather than a `source` union.

`custom_sql` is the user's SQL override for a widget's data query (NULL = the
query generated from its config), the same contract as `cohorts.custom_sql`.
"""

import sqlalchemy as sa
from alembic import op

from app.models.base import JSONB_or_JSON

revision = "d8e9f0a1b2c3"
down_revision = "c7d8e9f0a1b2"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "patient_dashboards",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column(
            "project_uid",
            sa.String(36),
            sa.ForeignKey("projects.uid", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("name", JSONB_or_JSON, nullable=True),
        sa.Column("description", JSONB_or_JSON, nullable=True),
        sa.Column("show_widget_titles", sa.Boolean(), nullable=True),
        sa.Column("widget_spacing", sa.Integer(), nullable=True),
        sa.Column("fit_to_height", sa.Boolean(), nullable=True),
        sa.Column("display_order", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("origin", sa.String(10), nullable=False, server_default="user"),
        sa.Column("version", sa.String(20), nullable=False, server_default="0.1.0"),
        sa.Column(
            "created_by_id",
            sa.Integer(),
            sa.ForeignKey("users.id"),
            nullable=True,
        ),
        sa.Column("created_by", sa.Text(), nullable=True),
        sa.Column("created_by_details", JSONB_or_JSON, nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )
    op.create_index(
        "ix_patient_dashboards_project_uid", "patient_dashboards", ["project_uid"]
    )

    op.create_table(
        "patient_dashboard_tabs",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column(
            "patient_dashboard_id",
            sa.String(36),
            sa.ForeignKey("patient_dashboards.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("name", JSONB_or_JSON, nullable=True),
        sa.Column("description", JSONB_or_JSON, nullable=True),
        sa.Column("display_order", sa.Integer(), nullable=False, server_default="0"),
    )
    op.create_index(
        "ix_patient_dashboard_tabs_dashboard_id",
        "patient_dashboard_tabs",
        ["patient_dashboard_id"],
    )

    op.create_table(
        "patient_dashboard_widgets",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column(
            "tab_id",
            sa.String(36),
            sa.ForeignKey("patient_dashboard_tabs.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("name", JSONB_or_JSON, nullable=True),
        sa.Column("description", JSONB_or_JSON, nullable=True),
        sa.Column("layout", JSONB_or_JSON, nullable=True),
        sa.Column("plugin_id", sa.String(100), nullable=False),
        sa.Column("language", sa.String(10), nullable=True),
        sa.Column("config", JSONB_or_JSON, nullable=True),
        sa.Column("custom_sql", sa.Text(), nullable=True),
        sa.Column("plugin_version", sa.String(20), nullable=True),
    )
    op.create_index(
        "ix_patient_dashboard_widgets_tab_id", "patient_dashboard_widgets", ["tab_id"]
    )


def downgrade() -> None:
    op.drop_index(
        "ix_patient_dashboard_widgets_tab_id", table_name="patient_dashboard_widgets"
    )
    op.drop_table("patient_dashboard_widgets")
    op.drop_index(
        "ix_patient_dashboard_tabs_dashboard_id", table_name="patient_dashboard_tabs"
    )
    op.drop_table("patient_dashboard_tabs")
    op.drop_index(
        "ix_patient_dashboards_project_uid", table_name="patient_dashboards"
    )
    op.drop_table("patient_dashboards")
