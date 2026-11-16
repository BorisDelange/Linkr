"""What a lock would install from the server's own files: every local source a
`uv.lock` names, wherever it sits, except the project's virtual root."""

from app.services.execution.uv_provisioner import _lock_local_sources


def test_every_local_source_of_a_lock_is_found_but_the_virtual_root():
    lock = {
        "package": [
            {"name": "app", "source": {"virtual": "."}},
            {"name": "lib", "source": {"path": "../lib"}},
            {"name": "tool", "source": {"editable": "/srv/tool"}},
            {"name": "data", "source": {"directory": "vendor/data"}},
            {"name": "other", "source": {"virtual": "../other"}},
            {"name": "pandas", "source": {"registry": "https://pypi.org/simple"}},
        ],
    }
    assert sorted(_lock_local_sources(lock)) == ["../lib", "../other", "/srv/tool", "vendor/data"]


def test_a_lock_with_registry_sources_only_names_none():
    assert _lock_local_sources({"package": [{"name": "numpy", "source": {"registry": "https://pypi.org/simple"}}]}) == []
    assert _lock_local_sources("text") == []
