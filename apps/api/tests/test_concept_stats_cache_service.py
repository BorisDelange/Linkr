"""Two first saves of one concept-stats key must both succeed, the last one winning."""

from app.models.data_source import DataSource
from app.services import concept_stats_cache_service


async def _source(db) -> str:
    source = DataSource(
        alias="db", name={"en": "DB"}, source_type="database",
        connection_config={"engine": "duckdb"},
    )
    db.add(source)
    await db.commit()
    await db.refresh(source)
    return source.id


async def test_save_inserts_then_overwrites(db):
    sid = await _source(db)
    await concept_stats_cache_service.save(db, sid, 42, "user:a", {"n": 1})
    await concept_stats_cache_service.save(db, sid, 42, "user:a", {"n": 2})
    row = await concept_stats_cache_service.get(db, sid, 42, "user:a")
    assert row.stats == {"n": 2}


async def test_a_concurrent_first_save_overwrites_instead_of_failing(db, monkeypatch):
    """The other request's insert lands between this one's get (None) and its
    insert, which then hits the primary key."""
    sid = await _source(db)
    await concept_stats_cache_service.save(db, sid, 42, "user:a", {"n": 1})
    real_get = concept_stats_cache_service.get
    lost_race = []

    async def get(*args, **kwargs):
        if not lost_race:
            lost_race.append(args)
            return None
        return await real_get(*args, **kwargs)

    monkeypatch.setattr(concept_stats_cache_service, "get", get)
    await concept_stats_cache_service.save(db, sid, 42, "user:a", {"n": 2})
    monkeypatch.undo()

    row = await concept_stats_cache_service.get(db, sid, 42, "user:a")
    assert row.stats == {"n": 2}
