"""Render registry: spec validation + code building are pure logic (the security
boundary), so they get unit tests independent of the kernel."""

import pytest

from app.services.execution import render
from app.services.execution.render import (
    cox,
    key_indicator,
    regression,
    statistical_tests,
    survey_question,
    table1,
)


# The built-in analyses and a minimal valid spec for each (column names +
# options), enough for validate_spec to pass and build_code to emit runnable code.
_KINDS = {
    "table1": {"selected": [{"name": "age", "label": "Age", "numeric": True}], "group": None, "stat": "median_iqr"},
    "correlation-matrix": {"names": ["a", "b"], "method": "pearson"},
    "map": {"lat": "lat", "lon": "lon", "popup": []},
    "kaplan-meier": {"time": "t", "event": "e", "group": None, "confidenceLevel": 95},
    "cox": {"time": "t", "event": "e",
            "predictors": [{"name": "x", "numeric": True}], "confidenceLevel": 95},
    "sankey": {"sourceMode": "long", "entity": "id", "stage": "s"},
    "key-indicator": {"column": {"name": "x", "numeric": True}, "aggregate": "mean"},
    "regression": {"outcome": {"name": "y", "numeric": True},
                   "predictors": [{"name": "x", "numeric": True}], "regressionType": "auto"},
    "plot-builder": {"plotType": "scatter", "x": "a", "y": "b"},
    "statistical-tests": {"group": "g", "values": [{"name": "x", "type": "number"}]},
    "survey-question": {"kind": "numeric", "column": "x", "choices": []},
}


def test_registry_has_all_builtin_kinds():
    assert set(_KINDS) == set(render._BUILDERS), "registry drifted from the built-in analyses"
    assert not render.is_known_kind("nope")


@pytest.mark.parametrize("kind, spec", list(_KINDS.items()))
def test_each_kind_builds_runnable_code(kind, spec):
    """Every registered kind validates its minimal spec and emits Python that
    parses the spec via _json.loads (data embedded, never spliced as source)."""
    code = render.build_render_code(kind, spec)
    assert "_json.loads(" in code
    compile(code, f"<render:{kind}>", "exec")  # syntactically valid Python


@pytest.mark.parametrize("kind", list(_KINDS))
def test_each_kind_rejects_a_non_dict_spec(kind):
    with pytest.raises(ValueError):
        render.build_render_code(kind, "not-a-dict")


def test_build_render_code_unknown_kind_raises():
    with pytest.raises(ValueError):
        render.build_render_code("nope", {})


def test_table1_validate_spec_normalizes_and_filters():
    spec = table1.validate_spec({
        "selected": [{"name": "age", "label": "Age", "numeric": True}, {"name": "sex"}],
        "group": {"name": "arm"},
        "stat": "bogus",  # falls back rather than reaching the Python
    })
    assert spec["selected"] == [
        {"name": "age", "label": "Age", "numeric": True},
        # A variable with no label prints its storage name rather than nothing.
        {"name": "sex", "label": "sex", "numeric": False},
    ]
    assert spec["group"] == {"name": "arm", "label": "arm"}
    assert spec["stat"] == "median_iqr"


@pytest.mark.parametrize("bad", [
    {"selected": "not-a-list"},
    {"selected": [{"numeric": True}]},  # missing name
    {"selected": [{"name": 123}]},      # non-string name
    {"selected": [], "group": 5},       # group must be {name, label}
    {"selected": [], "group": {"label": "x"}},  # group without a name
    "not-a-dict",
])
def test_table1_validate_spec_rejects_malformed(bad):
    with pytest.raises(ValueError):
        table1.validate_spec(bad)


def test_table1_build_code_embeds_spec_as_json_not_source():
    # The spec must reach Python as a json.loads(...) string literal — data, never
    # spliced into the program. A name with quotes/newlines can't break out.
    code = render.build_render_code("table1", {
        "selected": [{"name": 'a"; import os#', "numeric": False}],
        "group": None, "metrics": ["n"],
    })
    assert "_json.loads(" in code
    assert "import os#" not in code.split("_json.loads(")[0]  # not in the program body
    assert "_linkr_print_table1(dataset" in code


# --- Crafted-spec numeric guards (a bad value must 400 or clamp, never 500) ---


@pytest.mark.parametrize("bad", ["inf", "-inf", "nan"])
def test_regression_confidence_rejects_non_finite(bad):
    with pytest.raises(ValueError):
        regression.validate_spec({
            "outcome": {"name": "y", "numeric": True},
            "predictors": [{"name": "x", "numeric": True}],
            "confidenceLevel": float(bad),
        })


def test_regression_confidence_clamps_out_of_range():
    out = regression.validate_spec({
        "outcome": {"name": "y", "numeric": True},
        "predictors": [{"name": "x", "numeric": True}],
        "confidenceLevel": 0,
    })
    assert out["confidenceLevel"] == 1e-6  # clamped away from 0 (alpha would be 1)


@pytest.mark.parametrize("bad", ["inf", "nan"])
def test_statistical_tests_alpha_rejects_non_finite(bad):
    with pytest.raises(ValueError):
        statistical_tests.validate_spec({
            "group": "g", "values": [{"name": "v", "type": "numeric"}], "alpha": float(bad),
        })


def test_statistical_tests_alpha_clamps():
    out = statistical_tests.validate_spec({
        "group": "g", "values": [{"name": "v", "type": "numeric"}], "alpha": 5,
    })
    assert out["alpha"] == 1 - 1e-6


def test_key_indicator_clamps_chart_bins_and_decimals():
    # chartBins=0 would be a div-by-zero; decimals=-1 a format() error — both 500s.
    out = key_indicator.validate_spec({
        "column": {"name": "c", "numeric": True},
        "aggregate": "mean", "chartType": "histogram", "chartBins": 0, "decimals": -3,
    })
    assert out["chartBins"] == 1
    assert out["decimals"] == 0


def _run_plot(spec_extra, df):
    """Execute the plot-builder render program against a DataFrame and return the
    parsed JSON result (the program prints one JSON line)."""
    import io
    import json
    from contextlib import redirect_stdout

    from app.services.execution.render import plot_builder

    spec = plot_builder.validate_spec(spec_extra)
    code = plot_builder.build_code(spec)
    buf = io.StringIO()
    ns = {"dataset": df}
    with redirect_stdout(buf):
        exec(code, ns)  # noqa: S102 — server-owned program, test-only
    return json.loads(buf.getvalue().strip().splitlines()[-1])


def test_plot_builder_unique_per_median_aggregates_per_entity():
    """uniquePer + median collapses multiple rows per entity to the per-entity
    median of the value column before plotting — and only the plotted columns need
    aggregating (the vectorised fast path must match the old per-column reduce)."""
    import pandas as pd

    # Entity E1 has vent values [10, 20] (median 15); E2 [4, 8] (median 6). A wide
    # 'noise' column must not affect the result nor slow it down.
    df = pd.DataFrame({
        "visit": ["E1", "E1", "E2", "E2"],
        "type": ["A", "A", "B", "B"],
        "vent": [10.0, 20.0, 4.0, 8.0],
        "noise": ["x", "y", "z", "w"],
    })
    res = _run_plot(
        {"plotType": "boxplot", "x": "type", "y": "vent",
         "uniquePer": "visit", "uniqueAggregation": "median"},
        df,
    )
    by_name = {d["name"]: d for d in res["data"]}
    # One aggregated value per entity → A has [15], B has [6].
    assert by_name["A"]["values"] == [15.0]
    assert by_name["B"]["values"] == [6.0]


def test_plot_builder_unique_per_keeps_non_numeric_first():
    """A non-numeric aggregated column keeps its first value (parity with the JS
    aggregateByEntity: numeric → stat, else first)."""
    import pandas as pd

    df = pd.DataFrame({
        "visit": ["E1", "E1"],
        "cat": ["A", "B"],          # non-numeric grouping/x column
        "val": [10.0, 30.0],
    })
    res = _run_plot(
        {"plotType": "boxplot", "x": "cat", "y": "val",
         "uniquePer": "visit", "uniqueAggregation": "mean"},
        df,
    )
    # visit E1 collapses to one row: cat = first ("A"), val = mean (20).
    assert res["data"] == [{"name": "A", "stats": pytest_approx_stats(20.0), "values": [20.0]}]


def pytest_approx_stats(v):
    return {"min": v, "q1": v, "median": v, "q3": v, "max": v, "mean": v}


# ---------------------------------------------------------------------------
# table1 (descriptive table)
#
# Parity with buildDescriptiveTable() in
# apps/web/src/lib/stats/descriptive-table.ts. The denominators are what must
# match: a level's percentage is over those who ANSWERED, while the missing row
# is over the group total.
# ---------------------------------------------------------------------------


def _run_table1(df, spec):
    """Execute the built render code against a DataFrame, as the kernel does."""
    import contextlib
    import io
    import json as _json

    code = table1.build_code(table1.validate_spec(spec))
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        exec(compile(code, "<render:table1>", "exec"), {"dataset": df})  # noqa: S102
    return _json.loads(buf.getvalue().strip())


def _svc_spec(**over):
    spec = {
        "selected": [{"name": "svc", "label": "Service", "numeric": False}],
        "group": None,
        "stat": "median_iqr",
        "showMissing": True,
        "missingLabel": "Missing",
        "maxLevels": 0,
        "othersLabel": "Other",
    }
    spec.update(over)
    return spec


def test_table1_emits_heading_then_indented_levels():
    import pandas as pd

    df = pd.DataFrame({"svc": ["ICU", "ICU", "ICU", "HDU", "HDU", None]})
    out = _run_table1(df, _svc_spec())
    assert [(r["label"], r["indent"]) for r in out["rows"]] == [
        ("Service", False),
        ("ICU", True),
        ("HDU", True),
        ("Missing", True),
    ]


def test_table1_level_percentages_are_over_those_who_answered():
    import pandas as pd

    # 5 answered of 6: ICU is 3/5 = 60%, not 3/6 = 50%.
    df = pd.DataFrame({"svc": ["ICU", "ICU", "ICU", "HDU", "HDU", None]})
    out = _run_table1(df, _svc_spec())
    assert out["rows"][1]["cells"][""]["text"] == "3 (60%)"
    # Missing is the exception: its denominator IS everyone.
    assert out["rows"][3]["cells"][""]["text"] == "1 (17%)"


def test_table1_rounds_half_up_like_javascript():
    """Python's round() is banker's rounding, Math.round() is not.

    1 of 8 is 12.5%: round() gives 12, Math.round gives 13. Left alone this
    prints a different number server-side than client-side on the same data.
    """
    import pandas as pd

    df = pd.DataFrame({"svc": ["a"] + ["b"] * 7})
    out = _run_table1(df, _svc_spec())
    assert out["rows"][2]["cells"][""]["text"] == "1 (13%)"


def test_table1_numeric_uses_sample_sd_and_r_type7_quartiles():
    import pandas as pd

    df = pd.DataFrame({"age": [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]})
    spec = _svc_spec(selected=[{"name": "age", "label": "Age", "numeric": True}])
    med = _run_table1(df, spec)["rows"][0]["cells"][""]["text"]
    assert med == "5.5 [3.3–7.8]"
    spec["stat"] = "mean_sd"
    # Sample SD is 3.0277; the population one would be 2.87.
    assert _run_table1(df, spec)["rows"][0]["cells"][""]["text"] == "5.5 ± 3.0"


def test_table1_groups_and_keeps_missing_group_as_its_own():
    import pandas as pd

    df = pd.DataFrame({
        "arm": ["A", "A", "A", "B", "B", None],
        "svc": ["ICU", "ICU", "HDU", "ICU", "HDU", "ICU"],
    })
    out = _run_table1(df, _svc_spec(group={"name": "arm", "label": "Arm"}))
    # Dropping the ungrouped row would change every other denominator.
    assert "—" in out["groups"]
    assert out["groupSizes"]["A"] == 3
    icu = next(r for r in out["rows"] if r["label"] == "ICU")
    assert icu["cells"]["A"]["text"] == "2 (67%)"
    assert icu["cells"]["B"]["text"] == "1 (50%)"


def test_table1_folds_the_tail_into_others():
    import pandas as pd

    df = pd.DataFrame({"svc": ["a", "a", "a", "b", "b", "c", "d"]})
    out = _run_table1(df, _svc_spec(maxLevels=2, othersLabel="Autres"))
    levels = [r["label"] for r in out["rows"] if r["indent"]]
    assert levels == ["a", "b", "Autres"]
    others = next(r for r in out["rows"] if r["label"] == "Autres")
    assert others["cells"][""]["text"] == "2 (29%)"


def test_table1_shows_a_dash_rather_than_nan():
    import pandas as pd

    df = pd.DataFrame({"age": [None, None]})
    spec = _svc_spec(selected=[{"name": "age", "label": "Age", "numeric": True}])
    assert _run_table1(df, spec)["rows"][0]["cells"][""]["text"] == "—"


def test_table1_rejects_a_malformed_group():
    with pytest.raises(ValueError):
        table1.validate_spec({"selected": [], "group": "arm"})


# ---------------------------------------------------------------------------
# survey-question
#
# The denominator rules are the whole point of this analysis and must match
# summarizeQuestion() in apps/web/src/lib/survey/survey-analysis.ts exactly:
# a mismatch shows up as different numbers in server vs client mode, on the same
# dataset, which is the kind of bug nobody notices until a report is wrong.
# ---------------------------------------------------------------------------


def _run_survey(df, spec):
    """Execute the built render code against a DataFrame, as the kernel does."""
    import contextlib
    import io
    import json as _json

    code = survey_question.build_code(survey_question.validate_spec(spec))
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        exec(compile(code, "<render:survey-question>", "exec"), {"dataset": df})  # noqa: S102
    return _json.loads(buf.getvalue())


@pytest.mark.parametrize("bad", [
    {"kind": "bogus", "column": "x", "choices": []},
    {"kind": "numeric", "column": None, "choices": []},
    {"kind": "select_multiple", "column": None, "choices": [{"code": "a", "label": "A"}]},
    {"kind": "select_one", "column": "x", "choices": [{"label": "no code"}]},
])
def test_survey_question_rejects_malformed(bad):
    with pytest.raises(ValueError):
        survey_question.validate_spec(bad)


def test_survey_question_multi_counts_a_respondent_once():
    """Percentages are over respondents, so they may sum past 100%; a row with no
    box ticked is non-response, not a respondent who chose nothing."""
    import pandas as pd

    df = pd.DataFrame({
        "q___a": [1, 1, 0, 1],
        "q___b": [1, 0, 0, 1],
        "q___c": [0, 0, 0, 1],
    })
    spec = {"kind": "select_multiple", "column": None, "choices": [
        {"code": c, "label": c.upper(), "column": f"q___{c}"} for c in "abc"
    ]}
    out = _run_survey(df, spec)
    assert out["total"] == 4
    assert out["respondents"] == 3  # the all-zero row is not a respondent
    assert out["missing"] == 1
    assert out["selections"] == 6
    assert out["meanSelections"] == pytest.approx(2.0)
    assert sum(c["proportion"] for c in out["counts"]) > 1  # legitimately >100%


def test_survey_question_multi_reads_limesurvey_values():
    """LimeSurvey ticks with a bare `Y`; with its Y/N conversion on, 1 is yes but
    **2 is no** — a "non-zero is ticked" rule would read every No as a Yes."""
    import pandas as pd

    df = pd.DataFrame({"q___a": [1, 2, 2], "q___b": ["Y", "", ""]})
    out = _run_survey(df, {"kind": "select_multiple", "column": None, "choices": [
        {"code": "a", "label": "A", "column": "q___a"},
        {"code": "b", "label": "B", "column": "q___b"},
    ]})
    assert [c["count"] for c in out["counts"]] == [1, 1]


def test_survey_question_single_keeps_declared_order_and_zero_counts():
    import pandas as pd

    df = pd.DataFrame({"v": ["chu", "chu", "ch", "", None]})
    out = _run_survey(df, {"kind": "select_one", "column": "v", "choices": [
        {"code": "chu", "label": "CHU"}, {"code": "ch", "label": "CH"},
        {"code": "esprv", "label": "Privé"},
    ]})
    assert out["respondents"] == 3  # blanks are non-response
    assert [c["code"] for c in out["counts"]] == ["chu", "ch", "esprv"]
    assert out["counts"][0]["proportion"] == pytest.approx(2 / 3)
    assert out["counts"][2]["count"] == 0  # a choice nobody picked still shows


def test_survey_question_single_surfaces_undeclared_values():
    """Dirty data stays visible rather than being silently dropped."""
    import pandas as pd

    out = _run_survey(pd.DataFrame({"v": ["zzz", "chu"]}), {
        "kind": "select_one", "column": "v",
        "choices": [{"code": "chu", "label": "CHU"}],
    })
    assert {c["code"] for c in out["counts"]} == {"chu", "zzz"}


def test_survey_question_single_matches_numeric_codes_read_as_floats():
    """pandas reads an integer-coded scale as 1.0; it must still match code "1"."""
    import pandas as pd

    out = _run_survey(pd.DataFrame({"s": [1, 2, 3, 2, 1]}), {
        "kind": "select_one", "column": "s",
        "choices": [{"code": str(i), "label": str(i)} for i in (1, 2, 3)],
    })
    assert [c["count"] for c in out["counts"]] == [2, 2, 1]


@pytest.mark.parametrize(
    "yes,no",
    [("oui", "non"), (True, False), ("Yes", "No")],
)
def test_survey_question_folds_yes_no_spellings(yes, no):
    """A yes/no question must not split into two rival pairs.

    `oui`/`non` are recognized boolean tokens, so the column may be typed boolean
    while the cells stay strings — and the declared codes may use a third
    spelling again. Matching on the raw string reported "True 0 / False 0 /
    oui 44 / non 137"; the spellings are folded to one key instead.
    """
    import pandas as pd

    df = pd.DataFrame({"v": [yes] * 44 + [no] * 137 + [None] * 33})
    out = _run_survey(df, {
        "kind": "select_one", "column": "v",
        "choices": [{"code": "oui", "label": "Oui"}, {"code": "non", "label": "Non"}],
    })
    assert (out["total"], out["respondents"], out["missing"]) == (214, 181, 33)
    assert len(out["counts"]) == 2  # never four
    assert [c["count"] for c in out["counts"]] == [44, 137]


def test_survey_question_numeric_matches_r_type7_quartiles():
    import pandas as pd

    out = _run_survey(pd.DataFrame({"x": [1, 2, 3, 4]}),
                      {"kind": "numeric", "column": "x", "choices": []})
    s = out["stats"]
    assert s["q1"] == pytest.approx(1.75)
    assert s["median"] == pytest.approx(2.5)
    assert s["q3"] == pytest.approx(3.25)


def test_survey_question_numeric_ignores_unparseable_and_uses_sample_sd():
    import pandas as pd

    out = _run_survey(pd.DataFrame({"x": [10, "20", 30, "", "n/a"]}),
                      {"kind": "numeric", "column": "x", "choices": []})
    assert out["respondents"] == 3
    assert out["missing"] == 2
    assert out["stats"]["mean"] == pytest.approx(20.0)
    # sample (n-1) sd, matching describe() on the client
    assert out["stats"]["sd"] == pytest.approx(10.0)


def test_survey_question_never_divides_by_zero():
    import pandas as pd

    out = _run_survey(pd.DataFrame({"v": [None, None]}), {
        "kind": "select_one", "column": "v", "choices": [{"code": "x", "label": "X"}],
    })
    assert out["responseRate"] == 0
    assert all(c["proportion"] == 0 for c in out["counts"])


def test_survey_question_reports_a_missing_column_rather_than_crashing():
    import pandas as pd

    out = _run_survey(pd.DataFrame({"other": [1]}),
                      {"kind": "numeric", "column": "absent", "choices": []})
    assert out["error"] == "no_column"


# ---------------------------------------------------------------------------
# Cox proportional hazards
# ---------------------------------------------------------------------------


def _run_cox(df, spec):
    """Execute the built render code against a DataFrame, as the kernel does."""
    import contextlib
    import io
    import json as _json

    code = cox.build_code(cox.validate_spec(spec))
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        exec(compile(code, "<render:cox>", "exec"), {"dataset": df})  # noqa: S102
    return _json.loads(buf.getvalue())


@pytest.mark.parametrize("bad", [
    {"time": "", "event": "e", "predictors": [{"name": "x", "numeric": True}]},
    {"time": "t", "event": "", "predictors": [{"name": "x", "numeric": True}]},
    {"time": "t", "event": "e", "predictors": []},
    {"time": "t", "event": "e", "predictors": "x"},
    # Every predictor is the outcome itself, so none survives deduplication.
    {"time": "t", "event": "e", "predictors": [{"name": "t", "numeric": True}]},
    {"time": "t", "event": "e", "predictors": [{"name": "x", "numeric": True}],
     "confidenceLevel": float("nan")},
])
def test_cox_rejects_malformed(bad):
    with pytest.raises(ValueError):
        cox.validate_spec(bad)


def test_cox_drops_duplicate_predictors():
    spec = cox.validate_spec({"time": "t", "event": "e", "predictors": [
        {"name": "x", "numeric": True}, {"name": "x", "numeric": True},
        {"name": "y", "numeric": False},
    ]})
    assert [p["name"] for p in spec["predictors"]] == ["x", "y"]


def _survival_frame():
    """A frame where the hazard rises with `x`, so the fitted HR must exceed 1.

    The groups deliberately OVERLAP — some high-x subjects survive and some
    low-x subjects die. Perfect separation sends the coefficient to infinity,
    which is a real case the program has to survive but a useless one to assert
    a finite interval against.
    """
    import pandas as pd

    times, events, xs = [], [], []
    for i in range(120):
        high = i % 2 == 0
        xs.append(10.0 if high else 1.0)
        # 1 in 5 of each group behaves like the other, so neither is perfectly
        # predicted by x.
        crossover = i % 10 in (0, 1)
        dies = (not crossover) if high else crossover
        times.append((2 + (i % 5)) if dies else (40 + (i % 7)))
        events.append(1 if dies else 0)
    return pd.DataFrame({"t": times, "e": events, "x": xs})


def test_cox_fits_and_recovers_the_direction_of_the_effect():
    out = _run_cox(_survival_frame(), {
        "time": "t", "event": "e",
        "predictors": [{"name": "x", "numeric": True}], "confidenceLevel": 95,
    })
    assert "error" not in out
    (coef,) = out["coefficients"]
    assert coef["name"] == "x"
    assert coef["hazardRatio"] > 1  # more x, more hazard
    assert coef["ciLow"] <= coef["hazardRatio"] <= coef["ciHigh"]
    assert coef["ciLow"] > 1  # the effect is significant, not merely positive
    assert out["nObs"] == 120
    assert 0 < out["nEvents"] < 120  # both events and censoring are present
    # The PH assumption is reported: it is the model's central claim.
    assert {d["name"] for d in out["proportionalHazards"]} == {"x"}


def test_cox_confidence_level_widens_the_interval():
    frame = _survival_frame()
    narrow = _run_cox(frame, {"time": "t", "event": "e", "confidenceLevel": 90,
                              "predictors": [{"name": "x", "numeric": True}]})
    wide = _run_cox(frame, {"time": "t", "event": "e", "confidenceLevel": 99,
                            "predictors": [{"name": "x", "numeric": True}]})
    n, w = narrow["coefficients"][0], wide["coefficients"][0]
    # The estimate is the same fit; only the interval around it should move.
    assert n["hazardRatio"] == pytest.approx(w["hazardRatio"])
    assert w["ciLow"] < n["ciLow"] and w["ciHigh"] > n["ciHigh"]


def test_cox_names_a_dummy_by_its_level():
    import pandas as pd

    frame = _survival_frame()
    frame["arm"] = ["A" if i % 2 else "B" for i in range(len(frame))]
    out = _run_cox(frame, {"time": "t", "event": "e", "confidenceLevel": 95,
                           "predictors": [{"name": "arm", "numeric": False}]})
    # Reference level A is omitted; the contrast carries its own level.
    assert [c["name"] for c in out["coefficients"]] == ["arm: B"]


def test_cox_skips_a_constant_predictor_rather_than_failing():
    frame = _survival_frame()
    frame["flat"] = 1.0
    out = _run_cox(frame, {"time": "t", "event": "e", "confidenceLevel": 95,
                           "predictors": [{"name": "x", "numeric": True},
                                          {"name": "flat", "numeric": True}]})
    assert [c["name"] for c in out["coefficients"]] == ["x"]
    assert any("flat" in w for w in out["warnings"])


def test_cox_reports_no_events_rather_than_crashing():
    frame = _survival_frame()
    frame["e"] = 0
    out = _run_cox(frame, {"time": "t", "event": "e", "confidenceLevel": 95,
                           "predictors": [{"name": "x", "numeric": True}]})
    assert "error" in out
    assert out["nEvents"] == 0
