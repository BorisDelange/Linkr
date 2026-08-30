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


@pytest.mark.asyncio
async def test_append_bytes_builds_on_the_previous_blob(tmp_path, monkeypatch):
    """The source-concept extraction grows one CSV over a run. Re-uploading the
    whole file at every save point was quadratic and froze the browser tab, so
    the client now sends only the new rows and the server appends them."""
    from app.config import settings

    monkeypatch.setattr(settings, "data_path", tmp_path)

    sha1, size1 = await blob_store.append_bytes(None, b"header\n")
    assert size1 == 7
    assert await blob_store.read_bytes(sha1) == b"header\n"

    sha2, size2 = await blob_store.append_bytes(sha1, b"row1\n")
    assert await blob_store.read_bytes(sha2) == b"header\nrow1\n"
    assert size2 == 12
    # Content-addressed: appending yields a NEW blob and leaves the old one, so
    # a run interrupted mid-append never corrupts what was already stored.
    assert sha2 != sha1
    assert blob_store.exists(sha1)


@pytest.mark.asyncio
async def test_append_bytes_leaves_no_temp_files(tmp_path, monkeypatch):
    """A run writes hundreds of these; a leaked temp per append would fill the
    disk with copies of a growing multi-megabyte CSV."""
    from app.config import settings

    monkeypatch.setattr(settings, "data_path", tmp_path)

    sha, _ = await blob_store.append_bytes(None, b"a")
    await blob_store.append_bytes(sha, b"b")
    leftovers = [p.name for p in (tmp_path / "_files").iterdir() if not blob_store.is_sha(p.name)]
    assert leftovers == []
