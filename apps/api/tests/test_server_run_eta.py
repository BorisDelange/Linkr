"""The ETA of a run's statistics, learnt from its batches (server_runs/eta.py)."""

import pytest

from app.services.server_runs.eta import Eta


def test_nothing_is_promised_before_a_few_batches():
    eta = Eta()
    eta.observe(1_000_000, 30)
    eta.observe(1_000_000, 30)
    assert eta.seconds_left(10_000_000, 50) is None
    short = Eta()
    for _ in range(5):
        short.observe(10, 1)
    assert short.seconds_left(100, 10) is None


def test_a_scan_per_batch_and_a_cost_per_row_are_both_learnt():
    # 10 s a batch whatever it reads, plus 1 s a million rows.
    eta = Eta()
    for rows in (40_000_000, 20_000_000, 5_000_000, 1_000_000):
        eta.observe(rows, 10 + rows / 1_000_000)
    # The tail: many batches of few rows — the share of rows alone says ~0.
    assert eta.seconds_left(2_000_000, 60) == pytest.approx(60 * 10 + 2)


def test_batches_alike_in_rows_cost_their_mean():
    eta = Eta()
    for t in (9, 10, 11):
        eta.observe(5_000_000, t)
    assert eta.seconds_left(15_000_000, 4) == pytest.approx(40)


def test_no_cost_is_negative():
    # Larger batches went faster (a cache warming up): no negative cost per row.
    eta = Eta()
    for rows, t in ((1_000_000, 30), (10_000_000, 20), (20_000_000, 10)):
        eta.observe(rows, t)
    assert eta.seconds_left(50_000_000, 2) == pytest.approx(40)
    # Rows alone explain the time: no negative cost per batch.
    rows_only = Eta()
    for rows in (10_000_000, 20_000_000, 40_000_000):
        rows_only.observe(rows, rows / 1_000_000 - 5)
    left = rows_only.seconds_left(10_000_000, 100)
    assert left is not None and left > 0
