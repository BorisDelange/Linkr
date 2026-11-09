"""A data catalog's computation (`catalog`): the warehouse sized and cut into
patient slices, the base units (concept list, totals, rankings), then the
crossing units planned from the rankings (`compute`, the twin of the browser's
planning). A unit is one query and one step: a pause cuts the one in flight,
which a resume runs again.

The checkpoint is the catalog's results cache, as the browser writes it (its
`work` and `completedSteps`), stored with the catalog row (`computed_steps`,
`status`) in the transaction that renews the run's lease. A start that is not
fresh resumes from that cache — whichever side wrote it.

A unit cannot be split: it gets one generous deadline, the worker stops a hung
query sooner (`QueryStalled`), and a unit cut so is tried once more before the
run fails.

The size estimate of the crossings (`catalog_estimate`, `spec.mode` "estimate")
is the same planning cut short: the rankings over the whole warehouse, the top N
they keep, then one query per crossing. Each estimate is stored as it lands, by
its key, in the catalog's `catalog-estimate` cache, which the page reads; the
rankings' outcome (`state.fill`) and the next estimate (`state.next`) are the
checkpoint. It writes nothing of the catalog's results.
"""

import asyncio
import contextlib
import logging
from datetime import UTC, datetime

from sqlalchemy import insert, update
from sqlalchemy.exc import IntegrityError

from app.core import database
from app.models.data_catalog import DataCatalog
from app.models.stats_cache import StatsCache
from app.services import stats_cache_service
from app.services.server_runs import state
from app.services.server_runs.catalog import compute
from app.services.server_runs.executor import (
    Gone,
    QueryingExecutor,
    now_iso,
    short,
    took,
)
from app.services.server_runs.worker import QueryStalled, QueryTimedOut, WorkerDied

logger = logging.getLogger(__name__)

CACHE_SCOPE = "catalog"
ESTIMATE_SCOPE = "catalog-estimate"
# Estimates kept per catalog, the latest: a key names the parameters it was made
# for, and every change of them makes new ones.
ESTIMATES_KEPT = 500
# A unit's deadline: a query this long is past any slice a warehouse is cut in.
UNIT_DEADLINE_S = 6 * 3600.0
# The cache is written at most this often between phase boundaries — less often
# when writing it takes long (a large catalog's cache is tens of megabytes).
SAVE_EVERY_S = 5.0
SAVE_COST_FACTOR = 10


def _describe(info: dict) -> str:
    step = info["step"]
    if step == "concepts":
        what = f"Counting the concepts of {info.get('dictionary') or 'the dictionary'}"
    elif step == "totals":
        what = "Counting the totals"
    elif step == "ranking":
        what = f"Ranking the {info.get('ranked')}s"
    else:
        what = f"Crossing {' × '.join(info.get('crossing') or [])}"
    if info.get("chunk"):
        what += f", concepts {info['chunk'][0]} of {info['chunk'][1]}"
    if info.get("slice"):
        what += f", patients slice {info['slice'][0]} of {info['slice'][1]}"
    return what


class CatalogExecutor(QueryingExecutor):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.catalog_id = self.scope_id
        self.run_state: compute.RunState | None = None
        self.offset = 0
        self.saved_offset = -1
        self.base: dict = {}
        self.plan: compute.CrossingPlan | None = None
        self.prior_ms = 0
        self.started = 0.0
        self.saved_at = 0.0
        self.save_cost = 0.0

    @classmethod
    async def create(cls, db, run, attempt, spec, handle):
        if await db.get(DataCatalog, run.scope_id) is None:
            raise Gone("the data catalog no longer exists")
        return await super().create(db, run, attempt, spec, handle)

    def percent(self) -> int:
        total = self.state.get("total")
        return int(100 * self.state.get("offset", 0) / total) if total else 0

    def start_note(self) -> str:
        if self.attempt > 1 and self.state.get("offset"):
            return f"Resumed at unit {self.state['offset'] + 1}"
        return super().start_note()

    # --- the run ----------------------------------------------------------------

    async def body(self) -> None:
        if self.spec.mode == "estimate":
            await self._estimate()
            return
        loop = asyncio.get_running_loop()
        self.started = self.saved_at = loop.time()
        try:
            await self._compute()
        except asyncio.CancelledError:
            await asyncio.shield(self._final_save())
            raise
        except state.Fenced:
            raise
        except Exception as e:
            await asyncio.shield(self._final_save(str(e)[:4000]))
            raise

    async def _compute(self) -> None:
        spec = self.spec
        st = self.state
        # A fresh start reads nothing back until it has written its own cache.
        stored = None if spec.fresh and not st.get("saved") else await self._stored_cache()
        if stored is not None and stored.get("work") is not None:
            self.run_state = compute.state_from_cache(stored)
            self.offset = stored.get("completedSteps") or 0
            self.saved_offset = self.offset
            self.prior_ms = int(stored.get("durationMs") or 0)
            self.base = {"catalogId": self.catalog_id, "computedAt": stored.get("computedAt") or now_iso()}
            if self.attempt == 1:
                await self.note(f"Resuming the stored computation at unit {self.offset + 1}")
        else:
            self.run_state = compute.RunState()
            self.base = {"catalogId": self.catalog_id, "computedAt": now_iso()}
            self._phase("sizing")
            st["steps"] = {"sizing": {"done": 0, "total": 1}}
            await self.save()
            self.run_state.slices = await self._size()
            await self._checkpoint()

        sized = {"sizing": {"done": 1, "total": 1}}
        base = compute.base_units(spec, self.run_state.slices)
        st["total"] = None
        st["steps"] = {**compute.step_counts(base, self.offset, sized), "crossings": {"done": 0, "total": None}}
        await self._units(base, 0, lambda: base, sized)
        if self.offset > self.saved_offset:
            await self._checkpoint()

        self.plan = compute.plan_crossings(spec, self.run_state)
        everything = base + self.plan.units
        st["total"] = len(everything)
        st["steps"] = compute.step_counts(everything, self.offset, sized)
        await self._units(self.plan.units, len(base), lambda: everything, sized)

        self._phase("saving")
        st.pop("current", None)
        await self.save()
        await self._checkpoint(done=True)

    def _phase(self, phase: str) -> None:
        if self.state.get("phase") != phase:
            self.state["phase"] = phase
            self.state["phaseStartedAt"] = now_iso()

    async def _size(self) -> list[dict]:
        spec = self.spec
        rows = await self._rows(spec.size_sql, "Sizing the warehouse")
        wanted = compute.slices_wanted(rows, spec.slice_rows, spec.max_slices)
        if wanted < 2 or not spec.bounds_sql:
            return [{}]
        sql = compute.fill_catalog_sql(spec.bounds_sql, {"slices": wanted})
        return compute.slices_from_bounds(await self._rows(sql, f"Cutting the patients into {wanted} slices"))

    async def _units(self, units: list[compute.Unit], first: int, everything, sized: dict) -> None:
        st = self.state
        while self.offset < first + len(units):
            await self.boundary()
            unit = units[self.offset - first]
            self._phase(unit.info["step"])
            st["current"] = unit.info
            await self.save()
            rows = await self._rows(unit.sql, _describe(unit.info)) if unit.sql else []
            unit.apply(self.run_state, rows)
            self.offset += 1
            st["offset"] = self.offset
            st["steps"] = compute.step_counts(everything(), self.offset, sized)
            if st.get("total") is None:
                st["steps"]["crossings"] = {"done": 0, "total": None}
            if asyncio.get_running_loop().time() - self.saved_at >= max(SAVE_EVERY_S, SAVE_COST_FACTOR * self.save_cost):
                await self._checkpoint()
            else:
                await self.save()

    async def _rows(self, sql: str, what: str) -> list[dict]:
        for tried in (1, 2):
            started = asyncio.get_running_loop().time()
            try:
                rows = await self.query(sql, what, deadline=UNIT_DEADLINE_S)
            except (QueryTimedOut, QueryStalled, WorkerDied) as e:
                if tried == 2:
                    raise
                await self.note(f"{what}: {short(e)}, tried again")
                continue
            await self.note(f"{what}: {took(started)}")
            return rows
        raise AssertionError("unreachable")

    # --- the size estimate ------------------------------------------------------

    async def _estimate(self) -> None:
        spec = self.spec
        st = self.state
        ranking = compute.estimate_ranking_units(spec)
        st["total"] = len(ranking) + len(spec.estimates)
        if "fill" not in st:
            run_state = compute.RunState()
            self._phase("ranking")
            for i, unit in enumerate(ranking):
                await self.boundary()
                st["offset"] = i
                st["current"] = unit.info
                await self.save()
                unit.apply(run_state, await self._rows(unit.sql, _describe(unit.info)))
            st["fill"] = compute.plan_crossings(spec, run_state).fill
            st["next"] = 0
        self._phase("estimates")
        while st["next"] < len(spec.estimates):
            await self.boundary()
            item = spec.estimates[st["next"]]
            st["offset"] = len(ranking) + st["next"]
            st["current"] = {"step": "estimates", "crossing": list(item.variables)}
            await self.save()
            sql = compute.fill_catalog_sql(item.sql, st["fill"])
            estimate = compute.estimate_of_rows(await self._rows(sql, f"Estimating {' × '.join(item.variables)}"))
            st["next"] += 1
            st["offset"] = len(ranking) + st["next"]
            await self._store_estimate(item.key, estimate)

    async def _store_estimate(self, key: str, estimate: dict) -> None:
        """One estimate into the catalog's estimates, with the run's state."""
        async with database.async_session() as db:
            await state.fence(db, self.run_id, self.attempt, state=dict(self.state))
            row = await stats_cache_service.get(db, ESTIMATE_SCOPE, self.catalog_id)
            estimates = dict(((row.payload or {}).get("estimates") or {}) if row else {})
            estimates.pop(key, None)
            estimates[key] = estimate
            kept = dict(list(estimates.items())[-ESTIMATES_KEPT:])
            payload = {"estimates": kept}
            if row is None:
                db.add(StatsCache(scope=ESTIMATE_SCOPE, cache_key=self.catalog_id, computed_at=now_iso(), payload=payload))
            else:
                row.payload = payload
                row.computed_at = now_iso()
            await db.commit()

    # --- the checkpoint ---------------------------------------------------------

    def _cache(self, done: bool) -> dict:
        order = self.plan.crossings if self.plan else [list(c.variables) for c in self.spec.crossings]
        labels = self.plan.labels if self.plan else None
        elapsed = int((asyncio.get_running_loop().time() - self.started) * 1000)
        cache = compute.cache_from_state(
            {**self.base, "durationMs": self.prior_ms + elapsed, "labels": labels}, self.run_state, order, self.offset,
        )
        if done:
            cache["modalities"] = compute.order_modalities(self.spec.modalities, cache["crossings"])
            cache["computedAt"] = now_iso()
            del cache["work"]
        return cache

    async def _checkpoint(self, done: bool = False, error: str | None = None) -> None:
        started = asyncio.get_running_loop().time()
        cache = self._cache(done)
        values = {"status": "success" if done else "error" if error else "computing", "last_error": error}
        values["last_computed_at"] = cache["computedAt"]
        values["computed_steps"] = None if done else self.offset
        if done:
            values["last_compute_duration_ms"] = cache["durationMs"]
        await self._store(cache, values)
        self.saved_offset = self.offset
        self.saved_at = asyncio.get_running_loop().time()
        self.save_cost = self.saved_at - started

    async def _final_save(self, error: str | None = None) -> None:
        """What a pause or a failure keeps: every unit done, and the error."""
        with contextlib.suppress(state.Fenced):
            if self.run_state is not None and self.state.get("steps", {}).get("sizing", {}).get("done"):
                await self._checkpoint(error=error)
            elif error:
                await self._store(None, {"status": "error", "last_error": error})

    async def _stored_cache(self) -> dict | None:
        async with database.async_session() as db:
            row = await stats_cache_service.get(db, CACHE_SCOPE, self.catalog_id)
            if row is None:
                return None
            return {**(row.payload or {}), "catalogId": self.catalog_id, "computedAt": row.computed_at}

    async def _store(self, cache: dict | None, values: dict) -> None:
        """The results cache and the catalog row, written with the run's state —
        all of them, or none when this attempt is no longer the run's."""
        payload = None
        run_state = dict(self.state)
        if cache is not None:
            payload = {k: v for k, v in cache.items() if k not in ("catalogId", "computedAt")}
            # From now on a resume reads this cache back, not one from before the run.
            run_state["saved"] = True
        for tried in (1, 2):
            async with database.async_session() as db:
                await state.fence(db, self.run_id, self.attempt, state=run_state)
                if payload is not None:
                    stored = await db.execute(
                        update(StatsCache)
                        .where(StatsCache.scope == CACHE_SCOPE, StatsCache.cache_key == self.catalog_id)
                        .values(computed_at=cache["computedAt"], payload=payload, updated_at=datetime.now(UTC))
                        .execution_options(synchronize_session=False)
                    )
                    if stored.rowcount == 0:
                        await db.execute(insert(StatsCache).values(
                            scope=CACHE_SCOPE, cache_key=self.catalog_id, computed_at=cache["computedAt"], payload=payload,
                        ))
                written = await db.execute(
                    update(DataCatalog).where(DataCatalog.id == self.catalog_id).values(**values)
                    .execution_options(synchronize_session=False)
                )
                if written.rowcount != 1:
                    await db.rollback()
                    raise Gone("the data catalog no longer exists")
                try:
                    await db.commit()
                    self.state["saved"] = run_state.get("saved", False)
                    return
                except IntegrityError:
                    # Another first save of the cache committed meanwhile: it is overwritten now.
                    await db.rollback()
                    if tried == 2:
                        raise
