"""A database's concept statistics (`stats`) and a mapping project's source
extraction (`extraction`): its counts, its ranking, then its concepts page by
page, each batch's profiles stored and the checkpoint written as it lands.

The SQL is the client's (`RunSpec`); the profiles are assembled here
(`profiles`), as the browser assembles them in client-only mode. A batch that
fails, runs past its deadline or hangs is cut in halves until the concept at
fault stands alone: recorded as failed, the run goes on without it.
"""

import asyncio
import logging
from datetime import UTC, datetime
from pathlib import Path

from app.core import database, deferred
from app.schemas.concept_run import IDS_TOKEN, POSITIONS_TOKEN, RunSpec
from app.services import (
    blob_store,
    concept_profile_service,
    data_source_service,
    mapping_project_service,
    upload_ledger,
)
from app.services.data import concept_cache_fs, query_cancel
from app.services.execution import jobs
from app.services.server_runs import state
from app.services.server_runs.concepts import profiles
from app.services.server_runs.eta import Eta
from app.services.server_runs.executor import (
    QueryingExecutor,
    now_iso,
    read_json,
    run_dir,
    short,
    took,
    write_json,
)
from app.services.server_runs.js_values import js_number
from app.services.server_runs.worker import (
    QueryFailed,
    QueryStalled,
    QueryTimedOut,
    WorkerDied,
)

logger = logging.getLogger(__name__)

# Concepts between two checkpoints: what a stop loses at most.
PAGE_SIZE = 500
# A batch holds at most this many records, and this many concepts (concept-profile.ts).
BATCH_ROWS = 5_000_000
BATCH_CONCEPTS = 100
UNSIZED_BATCH_CONCEPTS = 10
# A batch past its deadline caps the next ones at half its concepts; this many
# quick batches in a row raise the cap again by a quarter, never back to the
# smallest batch that failed so. A database can
# have a cliff — a plan that turns slow past some size of the batch's list of
# ids — that splitting each slow batch alone would pay again at every batch.
QUICK_TO_GROW = 20
# What a query costs besides its rows, for the weighted progress (extraction-runner.ts).
QUERY_COST_ROWS = 100_000
# The failed concepts a run lists; past it only their count.
FAILED_LISTED = 100
# Concepts failing one after another, none answering between: the database, not
# them — the run fails rather than try each of its concepts alone.
FAILED_IN_A_ROW = 5

def ranking_path(run_id: str) -> Path:
    return run_dir(run_id) / "ranking.json"


def fill(sql: str, ids: list[int]) -> str:
    """The client's SQL with a batch's or a page's ids, and their ranking."""
    listed = ", ".join(str(int(i)) for i in ids)
    positions = " ".join(f"WHEN {int(i)} THEN {n}" for n, i in enumerate(ids))
    return sql.replace(IDS_TOKEN, listed).replace(POSITIONS_TOKEN, positions)


def _concept_id(value) -> int:
    """A concept id as the database returned it — 422, 422.0, '422.0' — read as
    the browser reads it: Math.trunc(Number(value))."""
    return int(js_number(value))


def _table(event) -> str:
    """The event table as its schema names it, not its `linkr_event_*` view."""
    return event.relation.removeprefix("linkr_event_")


def _current(row: dict) -> dict:
    return {
        "conceptCode": "" if row.get("concept_code") is None else str(row["concept_code"]),
        "conceptName": "" if row.get("concept_name") is None else str(row["concept_name"]),
    }


class ConceptExecutor(QueryingExecutor):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        spec: RunSpec = self.spec
        learnt = self.state.get("learnt") or {}
        self.options = spec.options
        self.variant = profiles.variant_of(spec.options)
        self.failed_in_a_row = 0
        self.page_done = self.page_weight = self.page_batches = 0
        self.eta = Eta()
        self.rows_left = self.batches_left = 0
        self.dicts: list[dict] = []
        # What the attempts before learnt of the batches: nor batches the database chokes on.
        self.batch_cap = int(learnt.get("batchCap", BATCH_CONCEPTS))
        self.batch_ceiling = int(learnt.get("batchCeiling", BATCH_CONCEPTS + 1))
        self.quick_in_a_row = 0

    def percent(self) -> int:
        st = self.state
        if st.get("stage") == "counts":
            c = st.get("counts") or {}
            done = sum((c.get(s) or {}).get("done", 0) for s in ("records", "patients"))
            total = sum((c.get(s) or {}).get("total", 0) for s in ("records", "patients"))
            return int(100 * done / total) if total else 0
        total = st.get("totalWeight") or 0
        return int(100 * (st.get("doneWeight") or 0) / total) if total else 0

    def start_note(self) -> str:
        st = self.state
        if self.attempt > 1 and st.get("stage") == "batches":
            return f"Resumed ({st.get('done', 0):,} of {st.get('total', 0):,} concepts done)"
        return super().start_note()

    async def body(self) -> None:
        if self.spec.fresh and not self.state.get("cleared"):
            async with database.async_session() as db:
                await concept_profile_service.delete_for_source(db, self.source_id)
            self.state["cleared"] = True
            await self.save()
        if self.spec.counts and self.state.get("stage") in (None, "counts"):
            await self._counts()
        if self.spec.dictionaries:
            if self.state.get("stage") in (None, "counts", "ranking"):
                await self._rank()
            await self._walk()

    async def _query(self, sql: str, what: str, *, batch: bool = False, expected_rows: int | None = None) -> list[dict]:
        """A query of the run. A profile batch has a deadline learnt from the
        batches before it (`Watchdog`); the ranking and the pages, which read
        whole tables, have none."""
        deadline = self.watchdog.deadline(expected_rows) if batch else None
        started = asyncio.get_running_loop().time()
        rows = await self.query(sql, what, deadline=deadline)
        if batch:
            self.watchdog.observe(asyncio.get_running_loop().time() - started, expected_rows)
        return rows

    # --- counts -----------------------------------------------------------

    async def _counts(self) -> None:
        spec = self.spec.counts
        assert spec is not None
        status = concept_cache_fs.run_status(self.source_id) or {}
        done = set(status.get("done_units") or [])
        unit_keys = {s.step: [i.key for i in s.items if not i.key.startswith("assemble-")] for s in spec.steps}
        counts = self.state.setdefault("counts", {})
        for step, keys in unit_keys.items():
            counts[step] = {"done": sum(1 for k in keys if k in done), "total": len(keys)}
        self.state["stage"] = "counts"
        await self.save()
        tag = (f"job:{self.handle.job_id}", str(self.source.workspace_id or ""))
        assembled = False
        for step in spec.steps:
            self.state["phase"] = step.step
            await self.save()
            c = counts[step.step]
            if c["done"] < c["total"]:
                left = c["total"] - c["done"]
                await self.note(f"Counting the {step.step} of each concept: {left} {'query' if left == 1 else 'queries'}")
            for item in step.items:
                if item.key in done:
                    continue
                await self.boundary()
                assembling = item.key.startswith("assemble-")
                if assembling:
                    self.state["phase"] = "assembling"
                    await self.save()
                    what = "Assembling the counts done so far into the concept list"
                else:
                    what = f"Counting the {step.step} of each concept, query {c['done'] + 1} of {c['total']}"
                started = asyncio.get_running_loop().time()
                await self._in_process(tag, item.key, item.sql, assembling, what)
                await self.note(f"{what}: {took(started)}")
                if assembling:
                    assembled = True
                    self.state["assembled"] = self.state.get("assembled", 0) + 1
                    self.state["phase"] = step.step
                else:
                    done.add(item.key)
                    counts[step.step]["done"] += 1
                await self.save()
        if not assembled or any(c["done"] < c["total"] for c in counts.values()):
            self.state["phase"] = "assembling"
            await self.save()
            what = "Assembling the counts into the concept list"
            started = asyncio.get_running_loop().time()
            await self._in_process(tag, "assemble-final", spec.final_assemble_sql, True, what)
            await self.note(f"{what}: {took(started)}")
            self.state["assembled"] = self.state.get("assembled", 0) + 1
        await asyncio.to_thread(self._finish_manifest, spec.run_id)
        self.state.pop("phase", None)
        self.state["stage"] = "ranking"
        await self.save()

    def _finish_manifest(self, run_id: str) -> None:
        status = concept_cache_fs.run_status(self.source_id)
        manifest = dict((status or {}).get("manifest") or {})
        if manifest.get("runId") != run_id:
            return
        manifest.setdefault("finishedAt", datetime.now(UTC).isoformat())
        manifest.pop("job", None)
        concept_cache_fs.write_manifest(self.source_id, manifest, False)

    async def _in_process(self, tag, key: str, sql: str, assemble: bool, what: str) -> None:
        """A counting unit or an assembly: they write the concept cache's files
        themselves, in the API process (concept_cache_fs)."""
        await self.handle.set_input(f"-- {what}\n{sql}")
        token = query_cancel.current_query.set(tag)

        async def work() -> None:
            async with jobs.lane_slot("heavy_query"), database.async_session() as db:
                source = await data_source_service.get(db, self.source_id)
                if source is None:
                    raise ValueError("the database no longer exists")
                if assemble:
                    await data_source_service.assemble_concept_cache(db, source, self.login, sql)
                else:
                    run_id = self.spec.counts.run_id if self.spec.counts else ""
                    await data_source_service.write_concept_unit(db, source, self.login, key, sql, run_id)

        try:
            await deferred.until_stopped(work(), lambda: query_cancel.cancel(*tag))
        finally:
            query_cancel.current_query.reset(token)

    # --- ranking ----------------------------------------------------------

    async def _rank(self) -> None:
        self.state["stage"] = "ranking"
        self.state["phase"] = "ranking"
        await self.save()
        spec = self.spec
        sort = spec.sort.model_dump()
        dicts: list[dict] = []
        for d in spec.dictionaries:
            await self.boundary()
            counts_known = spec.needs_counts
            per_table: list[list[dict]] = []
            if counts_known:
                for event in d.events:
                    counted = None
                    if sort["key"] != "patients" and event.signature:
                        counted = await asyncio.to_thread(
                            concept_cache_fs.counted_records, self.source_id, event.relation, event.signature,
                        )
                    if counted is not None:
                        per_table.append([
                            {"concept_id": c["concept_id"], "record_count": c["record_count"], "patient_count": None}
                            for c in counted
                        ])
                    else:
                        what = f"Counting the records of each concept in {_table(event)}, to profile the largest first"
                        started = asyncio.get_running_loop().time()
                        per_table.append(await self._query(event.count_sql, what))
                        await self.note(f"{what}: {took(started)}")
            ids = profiles.dictionary_walk_ids(await self._query(d.ids_sql, f"Listing the concepts of {d.dict_key}"))
            if counts_known:
                counts, merged_homes = profiles.merge_table_counts(per_table)
                ranked = [int(i) for i in profiles.plan_concept_walk(counts, sort, ids, spec.only_with_records)]
                homes = {str(int(k)): v for k, v in merged_homes.items()}
                records = {str(int(c["concept_id"])): int(c["record_count"] or 0) for c in counts}
            else:
                ranked, homes, records = [int(i) for i in ids], {}, None
            dicts.append({"ids": ranked, "homes": homes, "records": records})
        path = ranking_path(self.run_id)
        await asyncio.to_thread(write_json, path, {"dicts": dicts})
        sizes = [len(d["ids"]) for d in dicts]
        order = "by records" if spec.needs_counts else "in the dictionary's order"
        await self.note(f"{sum(sizes):,} concepts to profile, {order}, in batches of up to {BATCH_CONCEPTS} concepts or {BATCH_ROWS:,} rows")
        weights = [
            sum((d["records"] or {}).get(str(i), 0) + QUERY_COST_ROWS for i in d["ids"]) for d in dicts
        ]
        self.state.update({
            "stage": "batches", "sizes": sizes, "total": sum(sizes), "done": 0, "dict": 0, "offset": 0,
            "totalWeight": sum(weights), "doneWeight": 0, "failed": [], "failedCount": 0,
        })
        self.state.pop("phase", None)
        await self.save()

    # --- the walk ---------------------------------------------------------

    async def _walk(self) -> None:
        ranking = await asyncio.to_thread(read_json, ranking_path(self.run_id))
        dicts = ranking["dicts"]
        st = self.state
        self.dicts = dicts
        if self.spec.metadata:
            self._plan_left(dicts)
        while st["dict"] < len(dicts):
            d_spec = self.spec.dictionaries[st["dict"]]
            d = dicts[st["dict"]]
            if st["offset"] >= len(d["ids"]):
                st["dict"] += 1
                st["offset"] = 0
                continue
            await self.boundary()
            page_ids = d["ids"][st["offset"]:st["offset"] + PAGE_SIZE]
            # The progress moves batch by batch; a resume redoes the page from
            # its start, the profiles it already stored read back, not computed,
            # and the progress waits there until the page passes it.
            start = st.setdefault("pageStart", {"done": st.get("done", 0), "doneWeight": st.get("doneWeight", 0)})
            self.page_done = self.page_weight = self.page_batches = 0
            await self._page(d_spec, d, page_ids)
            st["offset"] += len(page_ids)
            records = d["records"] or {}
            st["done"] = start["done"] + len(page_ids)
            st["doneWeight"] = start["doneWeight"] + sum(records.get(str(i), 0) + QUERY_COST_ROWS for i in page_ids)
            st.pop("pageStart")
            await self.save()
            if self.spec.extraction is None:
                await self._save_stats_run()
        st["stage"] = "done"

    def _plan_left(self, dicts: list[dict]) -> None:
        """The rows and the batches the walk has left, for its ETA: the pages
        packed as `_profile` packs them, all their concepts still to compute."""
        st = self.state
        rows = batches = 0
        for n in range(st["dict"], len(dicts)):
            d = dicts[n]
            ids = d["ids"][st["offset"]:] if n == st["dict"] else d["ids"]
            records = d["records"]
            rows_of = (lambda i, r=records: r.get(str(i), 0)) if records is not None else (lambda i: None)
            most = self._most(records)
            for at in range(0, len(ids), PAGE_SIZE):
                batches += len(profiles.pack_profile_batches(ids[at:at + PAGE_SIZE], rows_of, BATCH_ROWS, most))
            if records is not None:
                rows += sum(records.get(str(i), 0) for i in ids)
        self.rows_left, self.batches_left = rows, batches

    async def _page(self, d_spec, d: dict, page_ids: list[int]) -> None:
        first = self.state["pageStart"]["done"] + 1
        span = f"concepts {first:,}–{first + len(page_ids) - 1:,} of {self.state.get('total', 0):,}"
        page = await self._query(fill(d_spec.page_sql, page_ids), f"The names and codes of {span}")
        concepts: dict[int, dict] = {}
        for row in page:
            cid = _concept_id(row["concept_id"])
            concepts.setdefault(cid, row)
        present = [i for i in page_ids if i in concepts]
        outcomes: dict[int, dict] = {}
        if self.spec.metadata and present:
            outcomes = await self._profile(d_spec, d, present, concepts)
        if self.spec.extraction is not None:
            await self._append_csv(d, page, outcomes, self.state["pageStart"]["done"] + len(page_ids))
        last = concepts.get(present[-1]) if present else None
        if last is not None:
            self.state["current"] = _current(last)

    async def _profile(self, d_spec, d: dict, ids: list[int], concepts: dict[int, dict]) -> dict[int, dict]:
        options = self.options
        fingerprint = self.spec.fingerprint
        wanted = profiles.section_set(d_spec.sections)
        asked = profiles.sections_of(wanted)
        exact = profiles.exact_options({**options, "sections": wanted}, wanted)
        async with database.async_session() as db:
            stored = {
                int(p["conceptId"]): p
                for p in await concept_profile_service.read(db, self.source_id, d_spec.dict_key, ids)
            }
        reader = {**options, "sections": wanted}
        out: dict[int, dict] = {}
        lacking: dict[int, list[int]] = {}
        homes = d["homes"]
        for cid in ids:
            missing = profiles.missing_sections(stored.get(cid), wanted, self.variant, fingerprint)
            if not missing:
                out[cid] = profiles.filter_profile(stored[cid], reader)
            else:
                lacking.setdefault(int(homes.get(str(cid), 0)), []).append(cid)
        records = d["records"]
        if out:
            await self._advance(list(out), records)
        computed_at = now_iso()
        names = {cid: "" if concepts[cid].get("concept_name") is None else str(concepts[cid]["concept_name"]) for cid in ids}
        for home, group in lacking.items():
            event = d_spec.events[home] if home < len(d_spec.events) else d_spec.events[0]
            rows_of = (lambda i: records.get(str(i), 0)) if records is not None else (lambda i: None)
            while group:
                # Packed one at a time: a slow batch caps the next ones.
                batch = profiles.pack_profile_batches(group, rows_of, BATCH_ROWS, self._most(records))[0]
                group = group[len(batch):]
                expected = sum(records.get(str(i), 0) for i in batch) if records is not None else None
                rows = "" if expected is None else f", {expected:,} rows"
                what = f"Statistics of {len(batch)} concepts in {_table(event)}{rows} ({self.state.get('done', 0):,} of {self.state.get('total', 0):,} done)"
                started = asyncio.get_running_loop().time()
                done = await self._batch(event, batch, expected, names, profiles.section_set(event.sections), exact, what)
                await self.note(f"{what}: {took(started)}")
                self.eta.observe(expected, asyncio.get_running_loop().time() - started)
                self.rows_left = max(0, self.rows_left - (expected or 0))
                self.batches_left = max(0, self.batches_left - 1)
                self.page_batches += 1
                left = self.eta.seconds_left(self.rows_left, self.batches_left)
                if left is None:
                    self.state.pop("etaSeconds", None)
                else:
                    self.state["etaSeconds"] = round(left)
                kept: list[dict] = []
                for cid, outcome in done.items():
                    if outcome is None:
                        out[cid] = {"json": None, "rowsCount": (records or {}).get(str(cid), 0), "patientsCount": None}
                        continue
                    merged = profiles.merge_profile(
                        stored.get(cid), outcome, asked, {"dictKey": d_spec.dict_key, "conceptId": cid},
                        self.variant, fingerprint, computed_at,
                    )
                    if merged["rowsCount"] > 0:
                        kept.append(merged)
                    out[cid] = profiles.filter_profile(merged, reader)
                if kept:
                    async with database.async_session() as db:
                        await state.write(db, self.run_id, self.attempt)
                        await concept_profile_service.write(db, self.source_id, kept)
                last = concepts.get(batch[-1])
                if last is not None:
                    self.state["current"] = _current(last)
                await self._advance(batch, records)
        return out

    def _most(self, records: dict | None) -> int:
        """The most concepts the next batch may hold."""
        return min(BATCH_CONCEPTS if records is not None else UNSIZED_BATCH_CONCEPTS, self.batch_cap)

    async def _cap(self, cap: int, why: str) -> None:
        if cap == self.batch_cap:
            return
        self.batch_cap = cap
        await self.note(f"{why}: batches of up to {cap} concepts from now on")
        if self.spec.metadata and self.dicts:
            # Planned again from the page's start: less what the page has done.
            self._plan_left(self.dicts)
            self.rows_left = max(0, self.rows_left - (self.page_weight - QUERY_COST_ROWS * self.page_done))
            self.batches_left = max(0, self.batches_left - self.page_batches)

    async def _quick(self) -> None:
        self.quick_in_a_row += 1
        most = min(BATCH_CONCEPTS, self.batch_ceiling - 1)
        if self.quick_in_a_row >= QUICK_TO_GROW and self.batch_cap < most:
            self.quick_in_a_row = 0
            await self._cap(min(most, self.batch_cap + max(1, self.batch_cap // 4)), f"{QUICK_TO_GROW} quick batches in a row")

    async def _advance(self, ids: list[int], records: dict | None) -> None:
        """Concepts of the page done: the progress moves on, saved."""
        st = self.state
        start = st["pageStart"]
        self.page_done += len(ids)
        self.page_weight += sum((records or {}).get(str(i), 0) + QUERY_COST_ROWS for i in ids)
        st["done"] = max(st.get("done", 0), start["done"] + self.page_done)
        st["doneWeight"] = max(st.get("doneWeight", 0), start["doneWeight"] + self.page_weight)
        st["learnt"] = {**self.learnt(), "batchCap": self.batch_cap, "batchCeiling": self.batch_ceiling}
        await self.save()

    async def _batch(
        self, event, batch: list[int], expected: int | None, names: dict[int, str], sections: dict, exact: dict, what: str,
    ) -> dict[int, dict | None]:
        """The batch's outcomes; a concept that fails alone maps to None."""
        sql = fill(event.batch_sql, batch)
        try:
            try:
                rows = await self._query(sql, what, batch=True, expected_rows=expected)
            except (QueryTimedOut, QueryStalled) as e:
                # Several concepts: cut at once, the halves are likely quick.
                # One alone: once more — with more time when it was slow.
                stalled = isinstance(e, QueryStalled)
                if len(batch) > 1:
                    self.quick_in_a_row = 0
                    self.batch_ceiling = min(self.batch_ceiling, len(batch))
                    why = "stopped working" if stalled else "ran past its deadline"
                    await self._cap(max(1, len(batch) // 2), f"A batch of {len(batch)} concepts {why}")
                    raise
                await self.note(f"{what}: {e}, tried again" + ("" if stalled else " with more time"))
                if not stalled:
                    self.watchdog.expired()
                rows = await self._query(sql, what, batch=True, expected_rows=expected)
            # Rows it cannot read are the batch's failure too, as in the browser.
            outcomes = profiles.read_batch_profiles(rows, batch, names, sections, exact, event.empty_scalar, self.spec.data_source_label)
            self.failed_in_a_row = 0
            await self._quick()
            return outcomes
        except (QueryTimedOut, QueryStalled, QueryFailed, WorkerDied, TypeError, ValueError, KeyError) as e:
            if len(batch) == 1:
                await self.note(f"Concept {batch[0]} failed, left without statistics: {short(e)}")
                self._failed(batch[0], e)
                return {batch[0]: None}
            await self.note(f"{what}: {short(e)}, split in two")
            half = len(batch) // 2
            records = None if expected is None else expected / len(batch)
            first = await self._batch(
                event, batch[:half], None if records is None else int(records * half), names, sections, exact,
                f"Statistics of {half} concepts in {_table(event)} (a half of a failed batch)",
            )
            second = await self._batch(
                event, batch[half:], None if records is None else int(records * (len(batch) - half)), names, sections, exact,
                f"Statistics of {len(batch) - half} concepts in {_table(event)} (a half of a failed batch)",
            )
            return {**first, **second}

    def _failed(self, concept_id: int, error: Exception) -> None:
        self.failed_in_a_row += 1
        if self.failed_in_a_row >= FAILED_IN_A_ROW:
            raise RuntimeError(f"{FAILED_IN_A_ROW} concepts failed in a row: {error}") from error
        st = self.state
        st["failedCount"] = st.get("failedCount", 0) + 1
        listed = st.setdefault("failed", [])
        if len(listed) < FAILED_LISTED:
            listed.append({"conceptId": concept_id, "error": str(error)[:300]})
        logger.warning("concept run %s: concept %s failed: %s", self.run_id, concept_id, error)

    # --- extraction CSV -----------------------------------------------------

    async def _append_csv(self, d: dict, page: list[dict], outcomes: dict[int, dict], extracted: int) -> None:
        spec = self.spec
        assert spec.extraction is not None
        records = d["records"]
        rows = profiles.extracted_rows(
            page, outcomes, metadata=spec.metadata, counts=spec.count_columns,
            record_totals={int(k): v for k, v in records.items()} if records is not None else None,
        )
        st = self.state
        first = not st.get("csvStarted")
        body = profiles.extraction_csv_rows(rows)
        header = profiles.extraction_csv_header()
        text = (f"{header}\n{body}" if body else header) if first else (f"\n{body}" if body else "")
        st["csvRows"] = st.get("csvRows", 0) + len(rows)
        async with database.async_session() as db:
            await state.write(db, self.run_id, self.attempt)
            project = await mapping_project_service.get(db, self.scope_id)
            if project is None:
                raise ValueError("the mapping project no longer exists")
            if text:
                base = None if first else project.raw_file_sha
                if base and not blob_store.exists(base):
                    base = None
                sha, size = await blob_store.append_bytes(base, text.encode("utf-8"))
                await asyncio.to_thread(upload_ledger.record, self.user_id, sha, size)
                project.raw_file_sha = sha
                project.raw_file_name = "source-concepts.csv"
            st["csvStarted"] = True
            project.file_source_data = {**spec.extraction.file_source_data, "rows": [], "totalRowCount": st["csvRows"]}
            project.source_extraction = self._extraction_state(extracted)
            await db.commit()

    async def _save_stats_run(self) -> None:
        """The database's last statistics run, as the profile summary reports it:
        how far it went, with which sections (`finished`, `current` in the tab)."""
        spec = self.spec
        st = self.state
        run = {
            "dictionaryKeys": [d.dict_key for d in spec.dictionaries],
            "extracted": st.get("done", 0),
            "total": st.get("total", 0),
            "sizes": st.get("sizes", []),
            "options": spec.options,
            "sort": spec.sort.model_dump(),
            "onlyWithRecords": spec.only_with_records,
            "updatedAt": now_iso(),
        }
        async with database.async_session() as db:
            await concept_profile_service.save_run(db, self.source_id, run["updatedAt"], run)

    def _extraction_state(self, extracted: int) -> dict:
        st = self.state
        spec = self.spec
        assert spec.extraction is not None
        return {
            "dictionaryKeys": spec.extraction.dictionary_keys,
            "extracted": extracted,
            "total": st.get("total", 0),
            "sizes": st.get("sizes", []),
            "options": spec.options,
            "sort": spec.sort.model_dump(),
            "onlyWithRecords": spec.only_with_records,
            "updatedAt": now_iso(),
        }
