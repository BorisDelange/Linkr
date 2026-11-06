"""Decompressing client-supplied content is bounded before anything is inflated."""

import io
import zipfile

import pytest

from app.core import safe_zip


def _zip(files: dict[str, bytes]) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for name, content in files.items():
            zf.writestr(name, content)
    return buf.getvalue()


def _open(data: bytes) -> zipfile.ZipFile:
    return zipfile.ZipFile(io.BytesIO(data))


def test_read_all_returns_the_members_within_the_bound():
    assert safe_zip.read_all(_zip({"a": b"1", "d/b": b"22"}), max_bytes=3) == {"a": b"1", "d/b": b"22"}


def test_read_all_skips_folder_entries():
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("d/", b"")
        zf.writestr("d/a", b"1")
    assert safe_zip.read_all(buf.getvalue(), max_bytes=10) == {"d/a": b"1"}


def test_the_bound_counts_every_member_together():
    with pytest.raises(safe_zip.ZipTooLarge):
        safe_zip.read_all(_zip({"a": b"12", "b": b"34"}), max_bytes=3)


def test_the_bound_is_checked_before_any_member_is_inflated(monkeypatch):
    data = _zip({"a": b"1", "b": b"2" * 100})
    monkeypatch.setattr(zipfile.ZipFile, "open", lambda *a, **k: pytest.fail("inflated"))
    with pytest.raises(safe_zip.ZipTooLarge):
        safe_zip.read_all(data, max_bytes=10)


def test_the_member_count_is_bounded():
    with pytest.raises(safe_zip.ZipTooLarge):
        safe_zip.read_all(_zip({"a": b"", "b": b"", "c": b""}), max_bytes=10, max_members=2)


def _understating(data: bytes, name: str, declared: int) -> bytes:
    """`data` with `name`'s uncompressed size rewritten in both headers."""
    raw = bytearray(data)
    with _open(data) as zf:
        info = zf.getinfo(name)
    local = info.header_offset
    raw[local + 22:local + 26] = declared.to_bytes(4, "little")
    central = raw.rfind(b"PK\x01\x02")
    raw[central + 24:central + 28] = declared.to_bytes(4, "little")
    return bytes(raw)


def test_a_member_never_yields_more_than_its_header_declares():
    with pytest.raises((zipfile.BadZipFile, safe_zip.ZipTooLarge)):
        safe_zip.read_all(_understating(_zip({"a": b"\0" * 4096}), "a", 16), max_bytes=1024)


def test_copy_member_streams_within_the_bound():
    out = io.BytesIO()
    with _open(_zip({"a": b"xyz"})) as zf:
        safe_zip.copy_member(zf, zf.getinfo("a"), out)
    assert out.getvalue() == b"xyz"


def test_read_member_refuses_above_its_own_bound():
    with _open(_zip({"a": b"x" * 100})) as zf:
        assert safe_zip.read_member(zf, "a", max_bytes=100) == b"x" * 100
        with pytest.raises(safe_zip.ZipTooLarge):
            safe_zip.read_member(zf, "a", max_bytes=99)
