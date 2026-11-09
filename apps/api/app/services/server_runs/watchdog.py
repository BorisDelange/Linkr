"""How long a run's batch query may take before it is taken as hung.

TCP's retransmission timeout (RFC 6298) applied to batches: a smoothed duration
and its smoothed variation, the deadline four variations above the mean, so that
batches as slow as the slowest seen so far pass and a query that hangs does not
hold the run for ever.
"""

from dataclasses import dataclass

FLOOR_S = 30.0
CAP_S = 1800.0
# Before any batch has ended there is nothing to scale: a first batch is also the
# slowest (cold files), and one killed too early costs a retry at twice the
# deadline, while a hang caught late costs one wait — and pause still works.
FIRST_S = CAP_S
# Below it a batch's time is mostly what any query costs (parsing, planning,
# opening the files), not its rows: a tiny batch's rate, scaled up to a large
# batch, would give it a deadline of hours.
ROW_FLOOR = 1_000_000
# Doublings past an expiry stop here: 4 × the cap.
MAX_DOUBLINGS = 2
ALPHA = 1 / 8
BETA = 1 / 4
K = 4


@dataclass
class Watchdog:
    """The deadline of the next batch, learnt from the batches that ended.

    Durations are smoothed per row, rows counted no lower than `row_floor`
    (n = max(rows, row_floor)), with RFC 6298's update on each sample
    r = seconds / n (the variation first, from the previous mean):

        rttvar ← (1 − β)·rttvar + β·|srtt − r|      (first sample: srtt = r, rttvar = r/2)
        srtt   ← (1 − α)·srtt + α·r

    and a batch of n rows gets

        deadline = clamp((srtt + K·rttvar)·n, floor_s, cap_s) · 2^min(doublings, MAX_DOUBLINGS)

    `first_s` before any sample. Each expiry doubles the next deadlines, until a
    batch ends again (Karn: the expired one is no sample, its duration unknown).
    A batch of unknown rows counts as the batches seen so far (their smoothed
    rows), or the floor before any."""

    floor_s: float = FLOOR_S
    cap_s: float = CAP_S
    first_s: float = FIRST_S
    row_floor: float = ROW_FLOOR
    srtt: float | None = None
    rttvar: float = 0.0
    rows: float | None = None
    doublings: int = 0

    def deadline(self, rows: float | None = None) -> float:
        """Seconds the next batch, of `rows` expected rows, may run."""
        if self.srtt is None:
            base = self.first_s
        else:
            base = min(max((self.srtt + K * self.rttvar) * self._rows(rows), self.floor_s), self.cap_s)
        return base * 2 ** min(self.doublings, MAX_DOUBLINGS)

    def observe(self, seconds: float, rows: float | None = None) -> None:
        """A batch of `rows` rows ended after `seconds`."""
        n = self._rows(rows)
        r = seconds / n
        if self.srtt is None:
            self.srtt, self.rttvar, self.rows = r, r / 2, n
        else:
            self.rttvar = (1 - BETA) * self.rttvar + BETA * abs(self.srtt - r)
            self.srtt = (1 - ALPHA) * self.srtt + ALPHA * r
            self.rows = (1 - ALPHA) * (self.rows or n) + ALPHA * n
        self.doublings = 0

    def expired(self) -> None:
        """A batch ran past its deadline."""
        self.doublings += 1

    def _rows(self, rows: float | None) -> float:
        if rows is None:
            return self.rows or self.row_floor
        return max(float(rows), self.row_floor)
