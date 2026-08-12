"""The two sync cursors move independently.

`synced_oid` says "we hold this commit's content" (the 3-way merge base);
`reviewed_oid` says "every item this commit brought got an explicit decision"
(the push gate). Conflating them made a partial pull inexpressible — see
models/git_sync_state.py.
"""

import pytest

from app.services import git_sync_state_service as svc

SCOPE, ENTITY, BRANCH = "mapping-projects", "mp-1", "main"


@pytest.mark.asyncio
async def test_set_oid_advances_both_cursors(db):
    """A push (or a complete pull) means we hold the content AND have nothing left
    to deliberate — leaving the review cursor behind would re-raise "behind" for a
    commit we fully hold."""
    row = await svc.set_oid(db, SCOPE, ENTITY, BRANCH, "a" * 40)
    assert row.synced_oid == "a" * 40
    assert row.reviewed_oid == "a" * 40


@pytest.mark.asyncio
async def test_set_reviewed_oid_leaves_the_content_anchor_alone(db):
    """The load-bearing invariant: a partial pull records the deliberation without
    claiming the content. If the anchor moved here, the next 3-way would be built
    against a commit whose declined items we never applied — burying them."""
    await svc.set_oid(db, SCOPE, ENTITY, BRANCH, "a" * 40)
    row = await svc.set_reviewed_oid(db, SCOPE, ENTITY, BRANCH, "b" * 40)
    assert row.synced_oid == "a" * 40  # unmoved
    assert row.reviewed_oid == "b" * 40


@pytest.mark.asyncio
async def test_reviewed_without_a_prior_anchor_claims_no_content(db):
    """Deliberating over a commit whose content we don't hold leaves no base: the
    anchor must stay empty rather than borrow the reviewed oid."""
    row = await svc.set_reviewed_oid(db, SCOPE, ENTITY, BRANCH, "b" * 40)
    assert row.synced_oid == ""
    assert row.reviewed_oid == "b" * 40


@pytest.mark.asyncio
async def test_a_later_complete_pull_catches_the_anchor_back_up(db):
    """After a partial pull, taking everything the next time re-aligns both."""
    await svc.set_oid(db, SCOPE, ENTITY, BRANCH, "a" * 40)
    await svc.set_reviewed_oid(db, SCOPE, ENTITY, BRANCH, "b" * 40)
    row = await svc.set_oid(db, SCOPE, ENTITY, BRANCH, "c" * 40)
    assert row.synced_oid == "c" * 40 and row.reviewed_oid == "c" * 40


@pytest.mark.asyncio
async def test_cursors_are_isolated_per_scope_entity_and_branch(db):
    """One shared table across every versionable scope — a mapping project's
    decision must not clear a project's banner, nor one branch another's."""
    await svc.set_oid(db, SCOPE, ENTITY, BRANCH, "a" * 40)
    await svc.set_oid(db, "projects", ENTITY, BRANCH, "b" * 40)
    await svc.set_oid(db, SCOPE, ENTITY, "dev", "c" * 40)

    assert (await svc.get(db, SCOPE, ENTITY, BRANCH)).synced_oid == "a" * 40
    assert (await svc.get(db, "projects", ENTITY, BRANCH)).synced_oid == "b" * 40
    assert (await svc.get(db, SCOPE, ENTITY, "dev")).synced_oid == "c" * 40


@pytest.mark.asyncio
async def test_get_returns_none_for_an_unanchored_entity(db):
    assert await svc.get(db, SCOPE, "never-synced", BRANCH) is None
