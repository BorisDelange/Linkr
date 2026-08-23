"""Render registry: spec validation + code building are pure logic (the security
boundary), so they get unit tests independent of the kernel."""

import pytest

from app.services.execution import render
from app.services.execution.render import (
    key_indicator,
    regression,
    statistical_tests,
    survey_question,
    table1,
)


# The built-in analyses and a minimal valid spec for each (column names +
# options), enough for validate_spec to pass and build_code to emit runnable code.
_KINDS = {
    "table1": {"selected": [{"name": "age", "numeric": True}], "group": None, "metrics": ["n"]},
    "correlation-matrix": {"names": ["a", "b"], "method": "pearson"},
    "map": {"lat": "lat", "lon": "lon", "popup": []},
    "kaplan-meier": {"time": "t", "event": "e", "group": None, "confidenceLevel": 95},
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
        "selected": [{"name": "age", "numeric": True}, {"name": "sex"}],
        "group": "arm",
        "metrics": ["n", "mean_sd", "bogus"],  # bogus dropped
    })
    assert spec["selected"] == [
        {"name": "age", "numeric": True},
        {"name": "sex", "numeric": False},
    ]
    assert spec["group"] == "arm"
    assert spec["metrics"] == ["n", "mean_sd"]  # unknown metric filtered out


@pytest.mark.parametrize("bad", [
    {"selected": "not-a-list"},
    {"selected": [{"numeric": True}]},  # missing name
    {"selected": [{"name": 123}]},      # non-string name
    {"selected": [], "group": 5},       # non-string group
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
