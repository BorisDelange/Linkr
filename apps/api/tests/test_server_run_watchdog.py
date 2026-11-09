"""The adaptive deadline of a concept run's batches (RFC 6298 over durations per
row): generous before any batch ends, close to what batches take once they do,
scaled to the batch's rows, and doubled after an expiry until a batch ends."""

import pytest

from app.services.server_runs.watchdog import (
    CAP_S,
    FIRST_S,
    FLOOR_S,
    MAX_DOUBLINGS,
    ROW_FLOOR,
    Watchdog,
)

BIG = 4 * ROW_FLOOR


def test_a_first_batch_gets_the_generous_default():
    assert Watchdog().deadline(BIG) == FIRST_S
    assert Watchdog().deadline(None) == FIRST_S


def test_the_first_sample_sets_the_mean_and_half_of_it_as_variation():
    dog = Watchdog()
    dog.observe(100.0, BIG)
    # srtt = r, rttvar = r/2: the deadline is 3 × the sample, at the same rows.
    assert dog.deadline(BIG) == pytest.approx(300.0)


def test_the_variation_is_updated_from_the_previous_mean():
    dog = Watchdog()
    dog.observe(100.0, BIG)
    dog.observe(200.0, BIG)
    r1, r2 = 100.0 / BIG, 200.0 / BIG
    rttvar = 0.75 * (r1 / 2) + 0.25 * abs(r1 - r2)
    srtt = 0.875 * r1 + 0.125 * r2
    assert dog.srtt == pytest.approx(srtt)
    assert dog.rttvar == pytest.approx(rttvar)
    assert dog.deadline(BIG) == pytest.approx((srtt + 4 * rttvar) * BIG)


def test_steady_batches_narrow_the_deadline():
    dog = Watchdog()
    for _ in range(50):
        dog.observe(100.0, BIG)
    assert dog.deadline(BIG) == pytest.approx(100.0, rel=0.01)


def test_jittery_batches_widen_it():
    steady, jittery = Watchdog(), Watchdog()
    for i in range(20):
        steady.observe(100.0, BIG)
        jittery.observe(50.0 if i % 2 else 150.0, BIG)
    assert jittery.deadline(BIG) > steady.deadline(BIG) + 100


def test_the_deadline_scales_with_the_batch_rows():
    dog = Watchdog()
    dog.observe(100.0, BIG)
    assert dog.deadline(2 * BIG) == pytest.approx(2 * dog.deadline(BIG))


def test_a_tiny_batch_does_not_scale_up_to_an_absurd_deadline():
    # 20 s for 10 rows is the query's fixed cost, not 2 s per row.
    dog = Watchdog()
    dog.observe(20.0, 10)
    assert dog.deadline(BIG) == pytest.approx(3 * 20.0 * BIG / ROW_FLOOR)
    assert dog.deadline(BIG) < CAP_S


def test_a_small_batch_gets_at_least_the_floor():
    dog = Watchdog()
    dog.observe(0.2, BIG)
    assert dog.deadline(10) == FLOOR_S
    assert dog.deadline(BIG) == FLOOR_S


def test_a_slow_estimate_stops_at_the_cap():
    dog = Watchdog()
    dog.observe(1000.0, ROW_FLOOR)
    assert dog.deadline(BIG) == CAP_S


def test_unknown_rows_count_as_the_batches_seen():
    dog = Watchdog()
    dog.observe(100.0, BIG)
    assert dog.deadline(None) == pytest.approx(dog.deadline(BIG))
    fresh = Watchdog()
    fresh.observe(100.0, None)
    assert fresh.deadline(None) == pytest.approx(300.0)


def test_an_expiry_doubles_the_deadline_until_a_batch_ends():
    dog = Watchdog()
    dog.observe(100.0, BIG)
    base = dog.deadline(BIG)
    dog.expired()
    assert dog.deadline(BIG) == pytest.approx(2 * base)
    dog.expired()
    assert dog.deadline(BIG) == pytest.approx(4 * base)
    dog.observe(100.0, BIG)
    assert dog.deadline(BIG) < 2 * base


def test_doublings_stop():
    dog = Watchdog()
    for _ in range(MAX_DOUBLINGS + 5):
        dog.expired()
    assert dog.deadline(BIG) == FIRST_S * 2**MAX_DOUBLINGS
