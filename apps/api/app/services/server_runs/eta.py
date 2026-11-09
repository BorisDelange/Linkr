"""How long a run's statistics have left, learnt from its batches.

A batch costs a fixed time — a scan of its table, which a Parquet folder pays
whatever the concepts it keeps — plus a time per row it reads. Both are fitted
by least squares on the batches of this attempt, then applied to the rows and
batches left: the first batches hold the largest concepts and the last ones
many small concepts, so a share of rows alone would promise an end far too soon.
"""

MIN_BATCHES = 3
MIN_SECONDS = 20.0


class Eta:
    def __init__(self) -> None:
        self.samples: list[tuple[float, float]] = []

    def observe(self, rows: int | None, seconds: float) -> None:
        self.samples.append((float(max(0, rows or 0)), seconds))

    def seconds_left(self, rows_left: int, batches_left: int) -> float | None:
        """None until a few batches have told how long they take."""
        if len(self.samples) < MIN_BATCHES or sum(t for _, t in self.samples) < MIN_SECONDS:
            return None
        per_row, per_batch = self._fit()
        return max(0.0, per_row * rows_left + per_batch * batches_left)

    def _fit(self) -> tuple[float, float]:
        n = len(self.samples)
        rows = sum(r for r, _ in self.samples)
        seconds = sum(t for _, t in self.samples)
        mean_r, mean_t = rows / n, seconds / n
        sxx = sum((r - mean_r) ** 2 for r, _ in self.samples)
        sxy = sum((r - mean_r) * (t - mean_t) for r, t in self.samples)
        per_row = sxy / sxx if sxx > 0 else 0.0
        per_batch = mean_t - per_row * mean_r
        # Neither cost is negative: a fit that says so falls back on the other alone.
        if per_row < 0:
            return 0.0, mean_t
        if per_batch < 0:
            return seconds / rows if rows else 0.0, 0.0
        return per_row, per_batch
