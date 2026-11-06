"""Bounded decompression of archives that come from outside the process.

The bound is checked from the central directory before any member is inflated, and
each member is then read with a counter, so a member yields no more than was
accounted for.
"""
import io
import zipfile
from typing import BinaryIO

MAX_MEMBERS = 100_000
_CHUNK_BYTES = 1024 * 1024


class ZipTooLarge(ValueError):
    """The archive holds more than the caller's bound allows."""


def checked_members(
    zf: zipfile.ZipFile, *, max_bytes: int, max_members: int | None = None,
) -> list[zipfile.ZipInfo]:
    """The archive's file members, once their count and declared total are within bounds."""
    infos = zf.infolist()
    if len(infos) > (MAX_MEMBERS if max_members is None else max_members):
        raise ZipTooLarge(f"archive holds too many entries ({len(infos)})")
    members = [info for info in infos if not info.is_dir()]
    total = sum(info.file_size for info in members)
    if total > max_bytes:
        raise ZipTooLarge(f"archive expands to {total} bytes, above the {max_bytes} allowed")
    return members


def copy_member(zf: zipfile.ZipFile, info: zipfile.ZipInfo, dst: BinaryIO) -> None:
    """Stream one member into `dst`, refusing more bytes than its header declared."""
    written = 0
    with zf.open(info) as src:
        while chunk := src.read(_CHUNK_BYTES):
            written += len(chunk)
            if written > info.file_size:
                raise ZipTooLarge(f"archive member {info.filename} is larger than declared")
            dst.write(chunk)


def read_member(zf: zipfile.ZipFile, name: str, *, max_bytes: int) -> bytes:
    """One member's bytes, refused before inflating when it declares more than `max_bytes`."""
    info = zf.getinfo(name)
    if info.file_size > max_bytes:
        raise ZipTooLarge(f"archive member {name} expands to {info.file_size} bytes, above the {max_bytes} allowed")
    out = io.BytesIO()
    copy_member(zf, info, out)
    return out.getvalue()


def read_all(zip_bytes: bytes, *, max_bytes: int, max_members: int | None = None) -> dict[str, bytes]:
    """Every file member in memory, keyed by name, within the bounds."""
    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as zf:
        out: dict[str, bytes] = {}
        for info in checked_members(zf, max_bytes=max_bytes, max_members=max_members):
            buf = io.BytesIO()
            copy_member(zf, info, buf)
            out[info.filename] = buf.getvalue()
        return out
