"""blob_store sha validation: client-supplied shas must not escape the store."""

import pytest

from app.services import blob_store

_TRAVERSAL = [
    "../../../../etc/passwd",
    "..%2f..%2fetc",
    "abc",  # too short
    "A" * 64,  # uppercase not allowed (digests are lowercase hex)
    "g" * 64,  # non-hex char
    "",
    "/etc/passwd",
]


@pytest.mark.parametrize("bad", _TRAVERSAL)
def test_path_for_rejects_non_sha(bad):
    with pytest.raises(ValueError):
        blob_store.path_for(bad)


@pytest.mark.parametrize("bad", _TRAVERSAL)
def test_exists_is_false_for_non_sha(bad):
    assert blob_store.exists(bad) is False


def test_path_for_accepts_valid_sha_and_stays_in_store():
    sha = "a" * 64
    p = blob_store.path_for(sha)
    assert p.name == sha
    assert ".." not in str(p)
    assert p.parent.name == "_files"
