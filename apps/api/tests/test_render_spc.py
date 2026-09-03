"""SPC render: spec validation, and the numbers the server program actually prints.

The generated Python is a port of the frontend `lib/spc/` modules, so the risk it
carries is silent DIVERGENCE — a chart whose limits move when a workspace goes
from client to server mode. These tests therefore run the emitted program and
assert on the values it prints, against the same references the TypeScript tests
use (`apps/web/src/lib/spc/*.test.ts`).
"""

import io
import json
import math
from contextlib import redirect_stdout

import pandas as pd
import pytest

from app.services.execution import render
from app.services.execution.render import spc


def run_spc(rows: list[dict], spec_overrides: dict) -> dict | None:
    """Execute the emitted program over `rows` and return the parsed result."""
    spec = {"date": "date", "value": "flag", **spec_overrides}
    code = render.build_render_code("spc", spec)
    scope: dict = {"dataset": pd.DataFrame(rows)}
    buffer = io.StringIO()
    with redirect_stdout(buffer):
        exec(compile(code, "<render:spc>", "exec"), scope)  # noqa: S102 - the program under test
    return json.loads(buffer.getvalue().strip())


def monthly(months: int, per_month: int, events: int) -> list[dict]:
    """`months` months of `per_month` rows, `events` of them flagged."""
    rows = []
    for m in range(months):
        year, month = 2024 + m // 12, (m % 12) + 1
        for k in range(per_month):
            rows.append({"date": f"{year}-{month:02d}-15", "flag": "Oui" if k < events else "Non"})
    return rows


# --- Spec validation -------------------------------------------------------


def test_validate_spec_requires_date_and_value():
    with pytest.raises(ValueError):
        spc.validate_spec({"value": "v"})
    with pytest.raises(ValueError):
        spc.validate_spec({"date": "d"})
    with pytest.raises(ValueError):
        spc.validate_spec({"date": "", "value": "v"})


def test_validate_spec_rejects_unknown_enum_values():
    for key, bad in [
        ("period", "fortnight"),
        ("chartType", "cusum"),
        ("statisticType", "guess"),
        ("denominatorMode", "vibes"),
        ("runsRules", "western-electric"),
        ("aggregation", "mode"),
    ]:
        with pytest.raises(ValueError):
            spc.validate_spec({"date": "d", "value": "v", key: bad})


@pytest.mark.parametrize("bad", [float("inf"), float("-inf"), float("nan")])
def test_validate_spec_rejects_non_finite_target(bad):
    with pytest.raises(ValueError):
        spc.validate_spec({"date": "d", "value": "v", "target": bad})


def test_validate_spec_clamps_out_of_range_numbers():
    # The config panel enforces min/max as HTML attributes only, with no
    # programmatic clamp, so an out-of-range value is a UI gap rather than a
    # hostile spec: clamp it instead of 400-ing.
    out = spc.validate_spec({"date": "d", "value": "v", "sigmaWidth": 99, "lambda": 0, "runLength": 1})
    assert out["sigmaWidth"] == 5
    assert out["lambda"] == 0.05
    assert out["runLength"] == 3


def test_validate_spec_rejects_malformed_event_values():
    with pytest.raises(ValueError):
        spc.validate_spec({"date": "d", "value": "v", "eventValues": "Oui"})
    with pytest.raises(ValueError):
        spc.validate_spec({"date": "d", "value": "v", "eventValues": [1, 2]})


def test_build_code_embeds_spec_as_json_not_source():
    code = render.build_render_code("spc", {"date": 'd"; import os#', "value": "v"})
    assert "_json.loads(" in code
    assert "import os#" not in code.split("_json.loads(")[0]
    assert "_linkr_print_spc(dataset" in code


# --- Parity with the TypeScript implementation -----------------------------


def test_p_chart_matches_the_hand_computed_reference():
    # Same reference as spc-limits.test.ts: p-bar = 62/1235, staircase limits.
    y = [5, 3, 8, 4, 6, 2, 7, 5, 4, 6, 9, 3]
    n = [100, 110, 95, 105, 100, 90, 115, 100, 105, 95, 120, 100]
    rows = []
    for m, (yi, ni) in enumerate(zip(y, n)):
        for k in range(ni):
            rows.append({"date": f"2024-{m + 1:02d}-15", "flag": "Oui" if k < yi else "Non"})

    result = run_spc(rows, {"statisticType": "proportion", "chartType": "p", "eventValues": ["Oui"]})

    p_bar = 62 / 1235
    assert result["centre"] == pytest.approx(p_bar, abs=1e-12)
    assert result["points"][0]["ucl"] == pytest.approx(p_bar + 3 * math.sqrt(p_bar * (1 - p_bar) / 100), abs=1e-10)
    # A smaller denominator must give a wider limit — the staircase.
    assert result["points"][2]["ucl"] > result["points"][0]["ucl"]
    assert all(pt["lcl"] >= 0 for pt in result["points"])


def test_i_chart_matches_the_moving_range_reference():
    # mean 12.3, MRbar 2.0, sigma 2/1.128 — as in spc-limits.test.ts.
    values = [10, 12, 11, 15, 13, 12, 14, 11, 13, 12]
    rows = [{"date": f"2024-{i + 1:02d}-15", "flag": v} for i, v in enumerate(values)]
    result = run_spc(rows, {"statisticType": "measurement", "chartType": "i-mr"})
    assert result["centre"] == pytest.approx(12.3, abs=1e-10)
    assert result["points"][0]["ucl"] == pytest.approx(12.3 + 3 * (2 / 1.128), abs=1e-8)


def test_g_chart_uses_the_geometric_sigma():
    # Intervals 40, 51, 105 between four events — as in spc-compute.test.ts.
    rows = [
        {"date": "2024-01-01", "flag": "Oui"},
        {"date": "2024-02-10", "flag": "Oui"},
        {"date": "2024-04-01", "flag": "Oui"},
        {"date": "2024-07-15", "flag": "Oui"},
        {"date": "2024-03-01", "flag": "Non"},
    ]
    result = run_spc(rows, {"statisticType": "rare-event", "eventValues": ["Oui"]})
    assert result["chartType"] == "g"
    assert [pt["value"] for pt in result["points"]] == [40, 51, 105]
    centre = (40 + 51 + 105) / 3
    assert result["points"][0]["ucl"] == pytest.approx(centre + 3 * math.sqrt(centre * (centre + 1)), abs=1e-8)


def test_patient_days_denominator_clips_stays_to_the_period():
    # Same fixture as spc-aggregate.test.ts: January 18 days, February 20.
    rows = [
        {"visit": "a", "adm": "2024-01-10", "dis": "2024-01-20", "date": "2024-01-15", "flag": "Oui"},
        {"visit": "b", "adm": "2024-01-25", "dis": "2024-02-05", "date": "2024-01-25", "flag": "Non"},
        {"visit": "c", "adm": "2024-02-01", "dis": "2024-02-15", "date": "2024-02-08", "flag": "Oui"},
    ]
    result = run_spc(rows, {
        "statisticType": "rate", "chartType": "u", "eventValues": ["Oui"],
        "denominatorMode": "patient-days", "admission": "adm", "discharge": "dis",
    })
    assert [pt["denominator"] for pt in result["points"]] == [18, 20]
    assert [pt["numerator"] for pt in result["points"]] == [1, 1]
    assert result["yUnit"] == "/1000"


def test_device_days_denominator_uses_the_device_window():
    rows = [{"date": "2024-01-15", "flag": "Oui", "line_in": "2024-01-10", "line_out": "2024-01-20"}]
    result = run_spc(rows, {
        "statisticType": "rate", "chartType": "u", "eventValues": ["Oui"],
        "denominatorMode": "device-days", "deviceStart": "line_in", "deviceEnd": "line_out",
    })
    assert result["points"][0]["denominator"] == 11


def test_ewma_follows_the_recursion():
    rows = monthly(12, 20, 2)
    result = run_spc(rows, {
        "statisticType": "proportion", "chartType": "ewma", "eventValues": ["Oui"], "lambda": 0.2,
    })
    assert result["chartType"] == "ewma"
    # Centre 0.1, every period 0.1: the smoothed series never leaves it.
    assert result["centre"] == pytest.approx(0.1, abs=1e-12)
    assert all(pt["value"] == pytest.approx(0.1, abs=1e-12) for pt in result["points"])
    assert result["points"][0]["denominator"] == 20
    assert result["points"][0]["numerator"] == 2


def test_baseline_freezes_the_limits_so_a_later_shift_signals():
    rows = monthly(12, 10, 1) + [
        {"date": f"2025-{m:02d}-15", "flag": "Oui" if k < 6 else "Non"}
        for m in range(1, 13) for k in range(10)
    ]
    result = run_spc(rows, {
        "statisticType": "proportion", "chartType": "p", "eventValues": ["Oui"],
        "baselineUntil": "2024-12-31",
    })
    assert result["baselineCount"] == 12
    assert result["centre"] == pytest.approx(0.1, abs=1e-9)
    assert all("beyond-limits" in pt["signals"] for pt in result["points"][12:])


def test_anhoj_rules_flag_a_long_run():
    # 12 alternating-level periods: a run of 8 above the centre must signal.
    rows = []
    for m in range(12):
        events = 8 if m < 8 else 1
        for k in range(20):
            rows.append({"date": f"2024-{m + 1:02d}-15", "flag": "Oui" if k < events else "Non"})
    result = run_spc(rows, {"statisticType": "proportion", "chartType": "p", "eventValues": ["Oui"]})
    assert "shift" in result["points"][0]["signals"]


def test_warns_when_a_denominator_cannot_apply_to_a_measurement():
    # The regression this plugin exists to prevent: the R scripts silently
    # ignored the denominator here and charted a median instead of a rate.
    rows = [{"date": f"2024-{m:02d}-15", "flag": 4 + m, "adm": f"2024-{m:02d}-01",
             "dis": f"2024-{m:02d}-10"} for m in range(1, 13)]
    result = run_spc(rows, {
        "statisticType": "measurement", "denominatorMode": "patient-days",
        "admission": "adm", "discharge": "dis",
    })
    codes = [w["code"] for w in result["warnings"]]
    assert "option-ignored" in codes
    assert result["chartType"] == "i-mr"


def test_laney_prime_widens_the_limits_when_overdispersed():
    rows = []
    for m in range(6):
        events = 100 if m % 2 == 0 else 800
        for k in range(1000):
            rows.append({"date": f"2024-{m + 1:02d}-15", "flag": "Oui" if k < events else "Non"})
    plain = run_spc(rows, {"statisticType": "proportion", "chartType": "p", "eventValues": ["Oui"]})
    prime = run_spc(rows, {"statisticType": "proportion", "chartType": "p-prime", "eventValues": ["Oui"]})
    assert prime["sigmaZ"] > 1
    assert prime["points"][0]["ucl"] > plain["points"][0]["ucl"]
    assert prime["centre"] == pytest.approx(plain["centre"], abs=1e-12)
    # The plain chart should have told the user a prime chart fits better.
    assert "overdispersion-prefer-prime" in [w["code"] for w in plain["warnings"]]


def test_returns_null_when_there_is_nothing_to_chart():
    assert run_spc([], {"statisticType": "proportion"}) is None
    assert run_spc([{"date": "bogus", "flag": "Oui"}], {"statisticType": "proportion"}) is None


def test_a_low_volume_unit_is_steered_off_a_monthly_proportion():
    """The shape of the real NeoCLIP data: a few patients a month, a handful of
    events a year. A monthly p-chart then flags nearly every period — not because
    the unit is unstable but because the statistic is noise — while the g-chart of
    the interval between events reads it as the stable process it is."""
    # 36 months of 4 patients, a death every third month or so — enough events
    # for intervals, far too few for a monthly proportion.
    death_months = {2, 5, 9, 12, 16, 19, 23, 26, 30, 33}
    rows = []
    for m in range(36):
        year, month = 2024 + m // 12, (m % 12) + 1
        for k in range(4):
            died = k == 0 and m in death_months
            rows.append({"date": f"{year}-{month:02d}-15", "flag": "Oui" if died else "Non"})

    monthly_chart = run_spc(rows, {"statisticType": "proportion", "chartType": "p", "eventValues": ["Oui"]})
    assert "rare-events-prefer-g" in [w["code"] for w in monthly_chart["warnings"]]

    g_chart = run_spc(rows, {"statisticType": "rare-event", "eventValues": ["Oui"]})
    assert g_chart["chartType"] == "g"
    assert len(g_chart["points"]) == len(death_months) - 1
    # Regular intervals in a stable process: nothing to flag, nothing to warn.
    assert not any(pt["signals"] for pt in g_chart["points"])
    assert not g_chart["warnings"]


def test_deduplicates_to_one_row_per_stay():
    rows = [
        {"visit": "a", "date": "2024-01-05", "flag": "Oui"},
        {"visit": "a", "date": "2024-01-06", "flag": "Oui"},
        {"visit": "b", "date": "2024-01-20", "flag": "Non"},
    ]
    result = run_spc(rows, {
        "statisticType": "proportion", "chartType": "p", "eventValues": ["Oui"], "deduplicateBy": "visit",
    })
    assert result["points"][0]["numerator"] == 1
    assert result["points"][0]["denominator"] == 2
