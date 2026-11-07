"""Only members whose decompression can be bounded are ever inflated."""

import io
import zipfile

import pytest

from app.core import safe_zip

_UNBOUNDED_METHODS = [zipfile.ZIP_BZIP2, zipfile.ZIP_LZMA]


def _zip(method: int, files: dict[str, bytes]) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", method) as zf:
        for name, content in files.items():
            zf.writestr(name, content)
    return buf.getvalue()


def _never_open(monkeypatch) -> None:
    monkeypatch.setattr(zipfile.ZipFile, "open", lambda *a, **k: pytest.fail("inflated"))


@pytest.mark.parametrize("method", _UNBOUNDED_METHODS)
def test_a_member_whose_output_cannot_be_bounded_is_refused_before_it_is_inflated(monkeypatch, method):
    data = _zip(method, {"a.json": b"1"})
    _never_open(monkeypatch)
    with pytest.raises(safe_zip.ZipTooLarge):
        safe_zip.read_all(data, max_bytes=1024)
    with zipfile.ZipFile(io.BytesIO(data)) as zf:
        with pytest.raises(safe_zip.ZipTooLarge):
            safe_zip.checked_members(zf, max_bytes=1024)
        with pytest.raises(safe_zip.ZipTooLarge):
            safe_zip.read_member(zf, "a.json", max_bytes=1024)
        with pytest.raises(safe_zip.ZipTooLarge):
            safe_zip.copy_member(zf, zf.getinfo("a.json"), io.BytesIO())


@pytest.mark.parametrize("method", [zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED])
def test_stored_and_deflated_members_are_read(method):
    assert safe_zip.read_all(_zip(method, {"a.json": b"12"}), max_bytes=10) == {"a.json": b"12"}


def test_an_archive_mixing_methods_is_refused_as_a_whole(monkeypatch):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("ok.txt", b"1", compress_type=zipfile.ZIP_DEFLATED)
        zf.writestr("no.txt", b"2", compress_type=zipfile.ZIP_BZIP2)
    _never_open(monkeypatch)
    with pytest.raises(safe_zip.ZipTooLarge):
        safe_zip.read_all(buf.getvalue(), max_bytes=10)
