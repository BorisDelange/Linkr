from sqlalchemy import Boolean, Float, ForeignKey, Integer, String, Text
from sqlalchemy import false as sa_false
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import PortableJSON, Base, LocalizedText, TimestampMixin


class DqRuleSet(Base, TimestampMixin):
    """A workspace-scoped data-quality rule set (metadata; the checks are rows in
    DqCustomCheck). Cached run results (score/timings) are stored but derived."""

    __tablename__ = "dq_rule_sets"

    # Frontend keys rule sets by client-supplied UUID.
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    workspace_id: Mapped[str] = mapped_column(
        ForeignKey("workspaces.id", ondelete="CASCADE")
    )
    # Human-readable, URL-safe id set once at creation.
    entity_id: Mapped[str | None] = mapped_column(String(255))
    name: Mapped[dict] = mapped_column(PortableJSON, default=dict)  # LocalizedString
    description: Mapped[dict] = mapped_column(PortableJSON, default=dict)
    # Badges for grouping/tagging (list of {id, label, color}).
    badges: Mapped[list | None] = mapped_column(PortableJSON)
    readme: Mapped[dict | None] = mapped_column(PortableJSON)
    # Entity licence: {id, name?, text} — the text is snapshotted at pick time
    # so it travels with the export (LICENSE.md) independently of the picker.
    license: Mapped[dict | None] = mapped_column(PortableJSON)
    data_source_id: Mapped[str] = mapped_column(String(36))
    # Portable identity of the database above ({lineageId?, entityId?, label?}).
    # data_source_id is this instance's local UUID and means nothing elsewhere, so
    # this is what the export carries and the import resolves back to a local row.
    data_source_ref: Mapped[dict | None] = mapped_column(PortableJSON)
    # Schema preset the rule set was generated from, as a portable pointer only
    # ({lineageId?, entityId?, label?}): informative, resolved where it is shown.
    schema_preset_ref: Mapped[dict | None] = mapped_column(PortableJSON)
    status: Mapped[str] = mapped_column(String(20), default="draft")
    last_run_at: Mapped[str | None] = mapped_column(String(40))
    last_run_duration_ms: Mapped[int | None] = mapped_column(Integer)
    last_score: Mapped[float | None] = mapped_column(Float)
    origin: Mapped[str] = mapped_column(String(10), default="user", server_default="user")
    # User-facing semver, portable across export/import (see Project.version).
    version: Mapped[str] = mapped_column(String(20), default="0.1.0", server_default="0.1.0")
    # Stable creator identity (name resolved live from the directory); created_by /
    # created_by_details are the display snapshot kept for cross-instance imports.
    created_by_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"))
    created_by: Mapped[str | None] = mapped_column(Text)
    created_by_details: Mapped[dict | None] = mapped_column(PortableJSON)
    # Frozen provenance snapshot of the origin organization (not a live link).
    organization: Mapped[dict | None] = mapped_column(PortableJSON)
    # Stable cross-instance identity (separate from the local PK). Preserved across
    # export/import; a fork mints a new lineage_id and points parent_lineage_id at its source.
    lineage_id: Mapped[str | None] = mapped_column(String(36))
    parent_lineage_id: Mapped[str | None] = mapped_column(String(36))
    git_remote_config: Mapped[dict | None] = mapped_column(PortableJSON)
    # The groups its checks are filed under, in display order: [{key, name
    # (LocalizedString), parentKey}], a tree by parentKey. A check naming a key
    # declared nowhere sits in a top-level group of that name. Null when none.
    check_groups: Mapped[list | None] = mapped_column(PortableJSON)


class DqProfile(Base, TimestampMixin):
    """A quality profile: checks chosen from several rule sets, applied to one
    database. It points at its checks (rule set + checkKey), never copies them,
    so a check fixed in its rule set is fixed in every profile using it."""

    __tablename__ = "dq_profiles"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    workspace_id: Mapped[str] = mapped_column(
        ForeignKey("workspaces.id", ondelete="CASCADE")
    )
    entity_id: Mapped[str | None] = mapped_column(String(255))
    name: Mapped[dict] = mapped_column(PortableJSON, default=dict)  # LocalizedString
    description: Mapped[dict] = mapped_column(PortableJSON, default=dict)
    badges: Mapped[list | None] = mapped_column(PortableJSON)
    readme: Mapped[dict | None] = mapped_column(PortableJSON)
    license: Mapped[dict | None] = mapped_column(PortableJSON)
    data_source_id: Mapped[str] = mapped_column(String(36))
    data_source_ref: Mapped[dict | None] = mapped_column(PortableJSON)
    # [{ruleSetId, ruleSetRef?, mode: "all" | "selected", checkKeys?}]: "all" takes
    # the whole rule set, new checks included; "selected" only the keys listed.
    sources: Mapped[list] = mapped_column(PortableJSON, default=list)
    status: Mapped[str] = mapped_column(String(20), default="draft")
    last_run_at: Mapped[str | None] = mapped_column(String(40))
    last_run_duration_ms: Mapped[int | None] = mapped_column(Integer)
    last_score: Mapped[float | None] = mapped_column(Float)
    origin: Mapped[str] = mapped_column(String(10), default="user", server_default="user")
    version: Mapped[str] = mapped_column(String(20), default="0.1.0", server_default="0.1.0")
    created_by_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"))
    created_by: Mapped[str | None] = mapped_column(Text)
    created_by_details: Mapped[dict | None] = mapped_column(PortableJSON)
    organization: Mapped[dict | None] = mapped_column(PortableJSON)
    lineage_id: Mapped[str | None] = mapped_column(String(36))
    parent_lineage_id: Mapped[str | None] = mapped_column(String(36))
    git_remote_config: Mapped[dict | None] = mapped_column(PortableJSON)


class DqRunHistory(Base):
    """One persisted data-quality scan run, of a rule set or of a quality profile.
    `report` holds the full scan report (counts + SQL, no row data) so a past run
    can be reopened."""

    __tablename__ = "dq_run_history"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    rule_set_id: Mapped[str | None] = mapped_column(
        ForeignKey("dq_rule_sets.id", ondelete="CASCADE")
    )
    profile_id: Mapped[str | None] = mapped_column(
        ForeignKey("dq_profiles.id", ondelete="CASCADE")
    )
    workspace_id: Mapped[str | None] = mapped_column(String(36))
    data_source_id: Mapped[str] = mapped_column(String(36))
    started_at: Mapped[str] = mapped_column(String(40))
    completed_at: Mapped[str | None] = mapped_column(String(40))
    status: Mapped[str] = mapped_column(String(20))
    score: Mapped[float | None] = mapped_column(Float)
    total_checks: Mapped[int] = mapped_column(Integer, default=0)
    passed: Mapped[int] = mapped_column(Integer, default=0)
    failed: Mapped[int] = mapped_column(Integer, default=0)
    errors: Mapped[int] = mapped_column(Integer, default=0)
    not_applicable: Mapped[int] = mapped_column(Integer, default=0)
    duration_ms: Mapped[int | None] = mapped_column(Integer)
    report: Mapped[dict | None] = mapped_column(PortableJSON)


class DqCustomCheck(Base, TimestampMixin):
    """A single SQL data-quality check within a rule set, generated from a schema
    or written by hand. Name and description are LocalizedStrings. Category and
    subcategory follow Kahn et al. (2016)."""

    __tablename__ = "dq_custom_checks"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    rule_set_id: Mapped[str] = mapped_column(
        ForeignKey("dq_rule_sets.id", ondelete="CASCADE")
    )
    # Portable key, unique in the rule set, set at creation and never changed (a
    # rename keeps it): what an export and a quality profile point at.
    check_key: Mapped[str | None] = mapped_column(Text)
    name: Mapped[dict] = mapped_column(LocalizedText, default=dict)
    description: Mapped[dict] = mapped_column(LocalizedText, default=dict)
    category: Mapped[str] = mapped_column(String(20))
    subcategory: Mapped[str | None] = mapped_column(String(20))
    severity: Mapped[str] = mapped_column(String(10))
    threshold: Mapped[float] = mapped_column(Float, default=0)
    sql: Mapped[str] = mapped_column(Text, default="")
    # Lists the rows breaking the rule, to investigate a failure.
    explore_sql: Mapped[str | None] = mapped_column(Text)
    order: Mapped[int] = mapped_column(Integer, default=0)
    # ddl | mapping | manual
    origin: Mapped[str] = mapped_column(String(10), default="manual", server_default="manual")
    template_key: Mapped[str | None] = mapped_column(Text)
    # The group it is filed under (a check_groups key); null: "Other checks".
    group_key: Mapped[str | None] = mapped_column(String(255))
    disabled: Mapped[bool] = mapped_column(Boolean, default=False, server_default=sa_false())
