"""What a data-quality run is given (services/server_runs/dq.py), compiled by the
page (apps/web features/warehouse/data-quality/dq-run.ts)."""

from pydantic import Field, model_validator

from app.schemas.query_list import QueryListSpec

_CATEGORIES = ("conformance", "completeness", "plausibility")
_SEVERITIES = ("error", "warning", "notice")


class DqRunSpec(QueryListSpec):
    # The rule set's or the profile's database: the run reads that one only.
    data_source_id: str = Field(min_length=1)
    # Each check as the run's report keeps it (the browser's DqCheck: its SQL as
    # written, its threshold, its rule set when a profile runs it), in the order
    # of `items`, which carry the SQL as the database runs it.
    checks: list[dict] = Field(min_length=1)

    @model_validator(mode="after")
    def _one_check_per_item(self):
        if len(self.checks) != len(self.items):
            raise ValueError("one check per query")
        for check in self.checks:
            if not isinstance(check.get("id"), str) or not check["id"]:
                raise ValueError("a check has an id")
            threshold = check.get("threshold")
            if isinstance(threshold, bool) or not isinstance(threshold, int | float):
                # A ValueError, which pydantic reports as the spec's error (a TypeError it would not).
                raise ValueError("a check has a numeric threshold")  # noqa: TRY004
            if check.get("category") not in _CATEGORIES or check.get("severity") not in _SEVERITIES:
                raise ValueError("a check has a known category and severity")
        return self
