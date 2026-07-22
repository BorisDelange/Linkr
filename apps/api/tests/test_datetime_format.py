"""Pins the export datetime format to the frontend's ``Date.toISOString()``.

The pure builder + golden tests already assert the ms+Z bytes, but the assemble
tests deliberately normalize the ``.SSSZ`` suffix away (SQLite vs Postgres tz
artifact), so this is the one place that guards ``to_iso_ms_z`` independently: a
regression that reintroduced microseconds or dropped ``Z`` would keep those green.
"""

from datetime import datetime, timedelta, timezone

from app.core.datetime_format import normalize_iso_ms_z, to_iso_ms_z


def test_whole_second_emits_three_fractional_digits():
    # JS: new Date(Date.UTC(2026,6,22,10,0,0,0)).toISOString() === '...:00.000Z'
    assert to_iso_ms_z(datetime(2026, 7, 22, 10, 0, 0, tzinfo=timezone.utc)) == "2026-07-22T10:00:00.000Z"


def test_microseconds_truncate_to_milliseconds():
    # 123999 µs -> .123 (truncation, not rounding — matches JS ms precision)
    assert to_iso_ms_z(datetime(2026, 7, 22, 10, 0, 0, 123999, tzinfo=timezone.utc)) == "2026-07-22T10:00:00.123Z"


def test_naive_datetime_is_treated_as_utc():
    assert to_iso_ms_z(datetime(2026, 7, 22, 10, 0, 0, 500000)) == "2026-07-22T10:00:00.500Z"


def test_offset_aware_datetime_is_converted_to_utc():
    tz = timezone(timedelta(hours=2))
    assert to_iso_ms_z(datetime(2026, 7, 22, 12, 0, 0, tzinfo=tz)) == "2026-07-22T10:00:00.000Z"


def test_normalize_coerces_plain_date_and_zulu_and_passes_garbage_through():
    assert normalize_iso_ms_z("2026-07-22") == "2026-07-22T00:00:00.000Z"
    assert normalize_iso_ms_z("2026-07-22T10:00:00Z") == "2026-07-22T10:00:00.000Z"
    assert normalize_iso_ms_z("") == ""
    assert normalize_iso_ms_z(None) is None
    assert normalize_iso_ms_z("not-a-date") == "not-a-date"
