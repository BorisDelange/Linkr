"""A data-quality run (`dq_rule_set`, `dq_profile`): a rule set's or a quality
profile's checks, one query each on its database, as the page compiled them.
Each check's counts land in the checkpoint (`state.results`), small enough for
the page to show the run as it goes; a resume goes on at the first check not
done, the one a pause cut running again.

The run owns its history row (`dq_run_history`, id = the run's), written when
the last check lands with the report the page reads back, assembled here as the
browser assembles its own (`check_result`, `build_summary`, `run_outcome`: twins
of lib/duckdb/data-quality*.ts and dq-run.ts, held to a fixture the TypeScript
writes, `__fixtures__/dq-runs/`). Its rule set or profile takes the outcome.
"""

import asyncio
import math
from datetime import UTC, datetime

from app.core import database
from app.core.redact import scrub_row_values
from app.models.dq_rule_set import DqProfile, DqRuleSet, DqRunHistory
from app.schemas.dq_run import DqRunSpec
from app.services.server_runs.executor import RunExecutor, short, took
from app.services.server_runs.query_list import QueryListExecutor
from app.services.server_runs.worker import (
    QueryFailed,
    QueryStalled,
    QueryTimedOut,
    WorkerDied,
)

CATEGORIES = ("conformance", "completeness", "plausibility")
SEVERITIES = ("error", "warning", "notice")


def _iso() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def js_round(x: float) -> int:
    """Math.round: halves go up, not to even."""
    return math.floor(x + 0.5)


def _num(value) -> int | float:
    """JavaScript's Number(v ?? 0) for a count a query returned."""
    if value is None:
        return 0
    try:
        n = float(value)
    except (TypeError, ValueError):
        return 0
    return int(n) if n.is_integer() else n


def entry_of(rows: list[dict], ms: float) -> dict:
    """What the checkpoint keeps of a check's rows: its two counts, or none."""
    if not rows:
        return {"ms": js_round(ms), "empty": True}
    return {"ms": js_round(ms), "violated": _num(rows[0].get("violated_rows")), "total": _num(rows[0].get("total_rows"))}


def check_status(violated: float, total: float, threshold: float) -> str:
    if total == 0:
        return "not_applicable"
    if threshold == 0:
        return "fail" if violated > 0 else "pass"
    return "fail" if (violated / total) * 100 > threshold else "pass"


def check_result(check: dict, entry: dict | None) -> dict:
    """A check's verdict, as checkResult gives it from the same rows. A check the
    run has no entry for did not run: an error."""
    entry = entry if entry is not None else {"ms": 0, "error": "not run"}
    base = {"checkId": check["id"], "executionTimeMs": js_round(entry.get("ms", 0)), "sql": check.get("sql", "")}
    if "error" in entry:
        return {**base, "status": "error", "violatedRows": 0, "totalRows": 0, "pctViolated": 0, "errorMessage": entry["error"]}
    if entry.get("empty"):
        return {**base, "status": "not_applicable", "violatedRows": 0, "totalRows": 0, "pctViolated": 0}
    violated, total = entry["violated"], entry["total"]
    pct = (violated / total) * 100 if total > 0 else 0
    return {
        **base, "status": check_status(violated, total, check["threshold"]),
        "violatedRows": violated, "totalRows": total, "pctViolated": pct,
    }


def build_summary(checks: list[dict], results: list[dict]) -> dict:
    by_category = {c: {"total": 0, "passed": 0, "failed": 0} for c in CATEGORIES}
    by_severity = {s: {"total": 0, "passed": 0, "failed": 0} for s in SEVERITIES}
    counts = {"pass": 0, "fail": 0, "error": 0, "not_applicable": 0}
    check_map = {c["id"]: c for c in checks}
    for r in results:
        check = check_map.get(r["checkId"])
        if check is None:
            continue
        category, severity = by_category[check["category"]], by_severity[check["severity"]]
        category["total"] += 1
        severity["total"] += 1
        counts[r["status"]] += 1
        if r["status"] == "pass":
            category["passed"] += 1
            severity["passed"] += 1
        elif r["status"] == "fail":
            category["failed"] += 1
            severity["failed"] += 1
    return {
        "total": len(results), "passed": counts["pass"], "failed": counts["fail"], "errors": counts["error"],
        "notApplicable": counts["not_applicable"], "byCategory": by_category, "bySeverity": by_severity,
    }


def build_report(data_source_id: str, computed_at: str, checks: list[dict], entries: list[dict | None]) -> dict:
    results = [check_result(check, entry) for check, entry in zip(checks, entries, strict=True)]
    return {
        "dataSourceId": data_source_id, "computedAt": computed_at, "checks": checks,
        "results": results, "summary": build_summary(checks, results),
    }


def run_outcome(report: dict) -> tuple[int, int]:
    """Its score (passed / applicable checks, %) and the time its checks took."""
    summary = report["summary"]
    applicable = summary["total"] - summary["notApplicable"]
    score = js_round(summary["passed"] / applicable * 100) if applicable > 0 else 100
    return score, sum(r["executionTimeMs"] for r in report["results"])


class DqExecutor(QueryListExecutor):
    spec: DqRunSpec

    def __init__(self, run, *args, **kwargs):
        super().__init__(run, *args, **kwargs)
        self.kind = run.kind

    def ended(self, status: str) -> None:
        # The counts are in the checkpoint and the report in the history: no files to keep.
        RunExecutor.ended(self, status)

    def start_note(self) -> str:
        n = self.state.get("next", 0)
        if self.attempt > 1 and n > 0:
            return f"Resumed at check {n + 1} of {len(self.spec.items)}"
        return RunExecutor.start_note(self)

    async def body(self) -> None:
        st = self.state
        st.setdefault("startedAt", _iso())
        items = self.spec.items
        st["total"] = len(items)
        results = st.setdefault("results", {})
        try:
            while st.get("next", 0) < len(items):
                i = st.get("next", 0)
                await self.boundary()
                item = items[i]
                what = item.what or item.key
                st["current"] = {"key": item.key, "what": what}
                await self.save()
                started = asyncio.get_running_loop().time()
                try:
                    rows = await self._run(item.sql, what, item.pushdown)
                except (QueryFailed, QueryTimedOut, QueryStalled, WorkerDied) as e:
                    # Kept with the run, read by others: the error, not the row values it may quote.
                    error = scrub_row_values(short(e))
                    results[item.key] = {"ms": js_round((asyncio.get_running_loop().time() - started) * 1000), "error": error}
                    await self.note(f"{what}: failed — {error}")
                else:
                    results[item.key] = entry_of(rows, (asyncio.get_running_loop().time() - started) * 1000)
                    await self.note(f"{what}: {took(started)}")
                st["next"] = i + 1
                st.pop("current", None)
                await self.save()
        except asyncio.CancelledError:
            # The job's input showed the check in flight: say where the run stands instead.
            at = st.get("next", 0)
            stopped = "Stopped" if await self.requested() == "cancel" else "Paused"
            await asyncio.shield(self.handle.set_input(f"-- {stopped} at check {at + 1} of {len(items)}, after {at:,} checks"))
            raise
        await self._record()

    async def _record(self) -> None:
        """The run's history row and its owner's last outcome."""
        spec = self.spec
        results = self.state.get("results", {})
        completed_at = _iso()
        report = build_report(spec.data_source_id, completed_at, spec.checks, [results.get(item.key) for item in spec.items])
        summary = report["summary"]
        score, duration_ms = run_outcome(report)
        # The job's input showed the last check's SQL: the run's outcome instead.
        await self.handle.set_input(
            f"-- {summary['total']:,} checks run: {summary['passed']:,} passed, {summary['failed']:,} failed, "
            f"{summary['errors']:,} errors, {summary['notApplicable']:,} not applicable — score {score}%"
        )
        owner_model, owner_field = (DqProfile, "profile_id") if self.kind == "dq_profile" else (DqRuleSet, "rule_set_id")
        async with database.async_session() as db:
            owner = await db.get(owner_model, self.scope_id)
            if owner is None:
                # Deleted while it ran: its runs went with it.
                return
            row = await db.get(DqRunHistory, self.run_id)
            if row is None:
                row = DqRunHistory(id=self.run_id, **{owner_field: self.scope_id})
                db.add(row)
            row.workspace_id = self.workspace_id
            row.data_source_id = spec.data_source_id
            row.started_at = self.state["startedAt"]
            row.completed_at = completed_at
            row.status = "success"
            row.score = score
            row.total_checks = summary["total"]
            row.passed = summary["passed"]
            row.failed = summary["failed"]
            row.errors = summary["errors"]
            row.not_applicable = summary["notApplicable"]
            row.duration_ms = duration_ms
            row.report = report
            # The scan ran: failing checks are the score's business, not the status's.
            owner.status = "success"
            owner.last_run_at = completed_at
            owner.last_run_duration_ms = duration_ms
            owner.last_score = score
            await db.commit()
