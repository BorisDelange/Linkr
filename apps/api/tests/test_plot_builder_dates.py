"""Date strings on a plot-builder axis (_linkr_num_series) become epoch ms."""

import pandas as pd

from app.services.execution.render import plot_builder


def _num_series(values):
    ns: dict = {}
    exec(plot_builder._PLOT_PY, ns)  # noqa: S102 — server-owned program, test-only
    return ns["_linkr_num_series"](pd.Series(values, dtype=object)).tolist()


def test_mixed_offsets_across_a_dst_change_parse_to_their_instants():
    assert _num_series(["2024-03-31T01:00:00+01:00", "2024-03-31T03:00:00+02:00"]) == [
        1711843200000,
        1711846800000,
    ]


def test_mixed_iso_formats_each_parse_and_naive_strings_read_as_utc():
    out = _num_series(["2024-06-30", "2024-06-30 10:00:00", "not a date", None])
    assert out[:2] == [1719705600000, 1719741600000]
    assert all(pd.isna(v) for v in out[2:])
