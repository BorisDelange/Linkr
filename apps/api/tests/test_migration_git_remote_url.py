"""Migration a1d3f5b7c9e0 removes the credentials stored inside git remote URLs."""

import json

import sqlalchemy as sa

from tests.test_migration_projects_workspace import alembic_at  # noqa: F401  -- fixture


def test_stored_urls_lose_their_credentials_the_rest_stays(alembic_at):  # noqa: F811
    upgrade, engine = alembic_at
    upgrade("d5f7a9b1c3e2")
    dirty = {"url": "https://oauth2:DUMMY@gitlab.example/r.git", "branch": "main", "syncedOid": "abc"}
    clean = {"url": "git@host.example:group/r.git", "branch": "dev"}
    with engine.begin() as c:
        c.execute(sa.text(
            "INSERT INTO workspaces (id, name, description, origin, git_remote_config) "
            "VALUES ('a', '{}', '{}', 'user', :d), ('b', '{}', '{}', 'user', :c), ('n', '{}', '{}', 'user', NULL)"
        ), {"d": json.dumps(dirty), "c": json.dumps(clean)})
        c.execute(sa.text("INSERT INTO app_settings (id, git_remote_config) VALUES ('app', :d)"), {"d": json.dumps(dirty)})
    upgrade("a1d3f5b7c9e0")

    with engine.connect() as c:
        stored = dict(c.execute(sa.text("SELECT id, git_remote_config FROM workspaces")).all())
        setting = c.execute(sa.text("SELECT git_remote_config FROM app_settings")).scalar_one()
    assert json.loads(stored["a"]) == {"url": "https://gitlab.example/r.git", "branch": "main", "syncedOid": "abc"}
    assert json.loads(stored["b"]) == clean
    assert stored["n"] is None or json.loads(stored["n"]) is None
    assert "DUMMY" not in setting
