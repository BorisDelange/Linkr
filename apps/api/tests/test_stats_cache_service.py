"""Two first saves of one stats-cache key must both succeed, the last one winning."""

from app.services import stats_cache_service


async def test_save_inserts_then_overwrites(db):
    await stats_cache_service.save(db, "database", "k", "t1", {"n": 1})
    await stats_cache_service.save(db, "database", "k", "t2", {"n": 2})
    row = await stats_cache_service.get(db, "database", "k")
    assert (row.computed_at, row.payload) == ("t2", {"n": 2})


async def test_a_concurrent_first_save_overwrites_instead_of_failing(db, monkeypatch):
    """The other request's insert lands between this one's update (0 rows) and its
    insert, which then hits the unique key."""
    await stats_cache_service.save(db, "database", "k", "t1", {"n": 1})
    real_execute = db.execute
    lost_race = []

    class _NoRows:
        rowcount = 0

    async def execute(stmt, *args, **kwargs):
        if not lost_race:
            lost_race.append(stmt)
            return _NoRows()
        return await real_execute(stmt, *args, **kwargs)

    monkeypatch.setattr(db, "execute", execute)
    await stats_cache_service.save(db, "database", "k", "t2", {"n": 2})
    monkeypatch.undo()

    row = await stats_cache_service.get(db, "database", "k")
    assert (row.computed_at, row.payload) == ("t2", {"n": 2})


async def test_a_retry_that_finds_no_row_is_logged_not_silent(db, monkeypatch):
    await stats_cache_service.save(db, "database", "k", "t1", {"n": 1})
    warnings = []

    async def no_rows(*args, **kwargs):
        return False

    monkeypatch.setattr(stats_cache_service, "_overwrite", no_rows)
    monkeypatch.setattr(stats_cache_service.logger, "warning", lambda event, **kw: warnings.append((event, kw)))
    await stats_cache_service.save(db, "database", "k", "t2", {"n": 2})
    assert warnings == [("stats_cache_save_dropped", {"scope": "database", "cache_key": "k"})]
