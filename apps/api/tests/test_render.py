"""Render registry: spec validation + code building are pure logic (the security
boundary), so they get unit tests independent of the kernel."""

import pytest

from app.services.execution import render
from app.services.execution.render import (
    cox,
    key_indicator,
    plot_builder,
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
    "spc": {"date": "d", "value": "v", "statisticType": "proportion", "chartType": "p"},
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


def _run_kpi(spec_extra, df):
    """Execute the key-indicator render program against a DataFrame and return the
    parsed JSON result (the program prints one JSON line)."""
    import io
    import json
    from contextlib import redirect_stdout

    spec = key_indicator.validate_spec(spec_extra)
    code = key_indicator.build_code(spec)
    buf = io.StringIO()
    ns = {"dataset": df}
    with redirect_stdout(buf):
        exec(code, ns)  # noqa: S102 — server-owned program, test-only
    return json.loads(buf.getvalue().strip().splitlines()[-1])


def test_key_indicator_proportion_matches_lowercase_boolean_target():
    """The Target value dropdown is fed by DuckDB (CAST AS VARCHAR → "true"), while
    pandas stringifies the same column as "True" — so a boolean target used to match
    nothing and every proportion rendered 0%."""
    import pandas as pd

    df = pd.DataFrame({"flag": [True, False, True, True]})
    out = _run_kpi(
        {"column": {"name": "flag", "numeric": False},
         "aggregate": "proportion", "targetValue": "true"},
        df,
    )
    assert out["matchCount"] == 3
    assert out["n"] == 4
    assert out["result"] == pytest.approx(75.0)


def test_key_indicator_proportion_auto_target_is_lowercase():
    """With no target the most frequent value is auto-detected; it is echoed back to
    the client and shown in the title, so it must use the same casing the client
    would have produced (String(v) → "false")."""
    import pandas as pd

    df = pd.DataFrame({"flag": [False, False, True]})
    out = _run_kpi(
        {"column": {"name": "flag", "numeric": False}, "aggregate": "proportion"},
        df,
    )
    assert out["resolvedTarget"] == "false"
    assert out["matchCount"] == 2


def test_key_indicator_any_row_keeps_entities_without_values_in_the_denominator():
    """A long table: one row per event, the infection flag only on infection rows.
    "% of patients with a BSI" must count every patient, and a patient matches as
    soon as one of their rows does — not only on their first row."""
    import pandas as pd

    df = pd.DataFrame({
        "patient_id": ["a", "a", "b", "b", "c", "d"],
        "bsi": [None, "Oui", "Non", None, None, "Non"],
    })
    out = _run_kpi(
        {"column": {"name": "bsi", "numeric": False}, "aggregate": "proportion",
         "targetValue": "Oui", "uniquePer": "patient_id", "uniqueAggregation": "any"},
        df,
    )
    assert out["n"] == 4
    assert out["matchCount"] == 1
    assert out["result"] == pytest.approx(25.0)


def test_key_indicator_any_row_without_target_counts_any_value():
    """"% of patients with at least one antibiotic": no target value, a patient
    matches as soon as one of their rows is filled."""
    import pandas as pd

    df = pd.DataFrame({
        "patient_id": [1, 1, 2, 3],
        "molecule": [None, "Amoxicilline", None, "Cefotaxime"],
    })
    out = _run_kpi(
        {"column": {"name": "molecule", "numeric": False}, "aggregate": "proportion",
         "uniquePer": "patient_id", "uniqueAggregation": "any"},
        df,
    )
    assert out["n"] == 3
    assert out["matchCount"] == 2


def test_key_indicator_any_row_reads_as_first_outside_a_proportion():
    import pandas as pd

    df = pd.DataFrame({"patient_id": ["a", "a", "b"], "los": [3.0, 3.0, 5.0]})
    out = _run_kpi(
        {"column": {"name": "los", "numeric": True}, "aggregate": "mean",
         "uniquePer": "patient_id", "uniqueAggregation": "any"},
        df,
    )
    assert out["result"] == pytest.approx(4.0)


def test_key_indicator_count_matches_boolean_target():
    """Same mismatch on the non-proportion branch: aggregate=count with a target
    counted 0 rows for a boolean column."""
    import pandas as pd

    df = pd.DataFrame({"flag": [True, False, True]})
    out = _run_kpi(
        {"column": {"name": "flag", "numeric": False},
         "aggregate": "count", "targetValue": "true"},
        df,
    )
    assert out["result"] == pytest.approx(2.0)


def test_key_indicator_string_column_keeps_its_casing():
    """Only the boolean literals are folded — a string column holding "True" as text
    is still matched exactly, and not confused with a lower-case "true"."""
    import pandas as pd

    df = pd.DataFrame({"label": ["True", "true", "other"]})
    out = _run_kpi(
        {"column": {"name": "label", "numeric": False},
         "aggregate": "proportion", "targetValue": "true"},
        df,
    )
    # Both "True" and "true" fold to "true" — the fold is by design symmetric, so a
    # dropdown value matches whichever casing the engine produced.
    assert out["matchCount"] == 2


def test_key_indicator_boxplot_uses_tukey_whiskers():
    """The whiskers pull back to 1.5*IQR, so one extreme value can't flatten the box.
    Mirrors computeBoxStats in KeyIndicatorComponent.tsx (same nearest-rank quartiles)."""
    import pandas as pd

    df = pd.DataFrame({"v": [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 500]})
    out = _run_kpi({"column": {"name": "v", "numeric": True},
                    "aggregate": "mean", "chartType": "boxplot"}, df)
    stats = out["chart"]["stats"]
    assert out["chart"]["type"] == "boxplot"
    assert out["chart"]["data"] == []  # described by stats, not a series
    assert (stats["q1"], stats["median"], stats["q3"]) == (3, 6, 9)
    assert stats["max"] == 18.0  # q3 + 1.5*iqr, not the raw 500
    assert stats["min"] == 1


def test_key_indicator_boxplot_on_a_constant_column():
    import pandas as pd

    out = _run_kpi({"column": {"name": "v", "numeric": True},
                    "aggregate": "mean", "chartType": "boxplot"},
                   pd.DataFrame({"v": [5, 5, 5, 5]}))
    stats = out["chart"]["stats"]
    assert stats["min"] == stats["max"] == stats["median"] == 5


def test_plot_builder_rejects_an_unknown_outlier_method():
    with pytest.raises(ValueError):
        plot_builder.validate_spec({"plotType": "scatter", "x": "a", "y": "b",
                                    "outlierMethod": "wat"})


def test_plot_builder_clamps_a_negative_outlier_coefficient():
    # A negative coefficient would invert the fence and drop every row.
    out = plot_builder.validate_spec({"plotType": "scatter", "x": "a", "y": "b",
                                      "outlierMethod": "iqr", "outlierCoef": -2})
    assert out["outlierCoef"] == 0


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


def _scatter_xs(out):
    return sorted(p["x"] for s in out["series"] for p in s["data"])


def test_plot_builder_outlier_iqr_drops_the_extreme_and_reports_it():
    """The fence must drop the outlier AND say how many rows went, so the chart can
    tell the reader the distribution is trimmed."""
    import pandas as pd

    df = pd.DataFrame({"a": list(range(1, 11)) + [1000], "b": list(range(1, 12))})
    out = _run_plot({"plotType": "scatter", "x": "a", "y": "b",
                     "outlierMethod": "iqr", "outlierCoef": 1.5}, df)
    assert out["outliersExcluded"] == 1
    assert 1000 not in _scatter_xs(out)
    assert len(_scatter_xs(out)) == 10


def test_plot_builder_outlier_none_keeps_everything():
    import pandas as pd

    df = pd.DataFrame({"a": list(range(1, 11)) + [1000], "b": list(range(1, 12))})
    out = _run_plot({"plotType": "scatter", "x": "a", "y": "b",
                     "outlierMethod": "none"}, df)
    assert out["outliersExcluded"] == 0
    assert 1000 in _scatter_xs(out)


def test_plot_builder_outlier_percentile_trims_both_tails():
    import pandas as pd

    df = pd.DataFrame({"a": list(range(1, 101)), "b": list(range(1, 101))})
    out = _run_plot({"plotType": "scatter", "x": "a", "y": "b",
                     "outlierMethod": "percentile", "outlierCoef": 10}, df)
    xs = _scatter_xs(out)
    assert 1 not in xs and 100 not in xs
    assert 50 in xs


def test_plot_builder_outlier_flat_column_excludes_nothing():
    """Zero spread: a naive fence would reject every value but the centre. Both ends
    return no bounds instead (mirror of the outliers.ts test)."""
    import pandas as pd

    df = pd.DataFrame({"a": [7] * 6, "b": list(range(6))})
    for method, coef in (("iqr", 1.5), ("sd", 3)):
        out = _run_plot({"plotType": "scatter", "x": "a", "y": "b",
                         "outlierMethod": method, "outlierCoef": coef}, df)
        assert out["outliersExcluded"] == 0, method


def test_plot_builder_outlier_ignores_a_non_numeric_axis():
    """A categorical X has no fence to fail; only the numeric axis is filtered."""
    import pandas as pd

    df = pd.DataFrame({"a": ["x", "y", "z", "w"], "b": [1, 2, 3, 900]})
    out = _run_plot({"plotType": "scatter", "x": "a", "y": "b",
                     "outlierMethod": "iqr", "outlierCoef": 1.5}, df)
    assert out["outliersExcluded"] == 1


def test_plot_builder_zoom_rebins_the_selected_range():
    """Zooming re-bins the values inside the window into the configured bin count,
    rather than showing the original bars wider — the bars must get FINER."""
    import pandas as pd

    df = pd.DataFrame({"v": [i * 0.1 for i in range(1000)]})  # 0.0 .. 99.9
    full = _run_plot({"plotType": "histogram", "hist": "v", "bins": 20}, df.copy())
    zoomed = _run_plot({"plotType": "histogram", "hist": "v", "bins": 20,
                        "zoomLo": 40, "zoomHi": 50}, df.copy())

    assert len(zoomed["data"]) == 20  # still the configured count
    full_width = full["data"][0]["hi"] - full["data"][0]["lo"]
    zoom_width = zoomed["data"][0]["hi"] - zoomed["data"][0]["lo"]
    assert zoom_width < full_width  # the whole point: finer bins
    assert zoomed["data"][0]["lo"] == pytest.approx(40, abs=0.5)
    assert zoomed["data"][-1]["hi"] == pytest.approx(50, abs=0.5)


def test_plot_builder_zoom_on_a_date_column_keeps_its_rows():
    """Bin bounds express datetimes in MILLISECONDS (what _linkr_to_num produces).
    Filtering the zoom with pd.to_numeric instead yielded nanoseconds, so the bounds
    were off by 10^6, every row was filtered away and the chart came back empty."""
    import pandas as pd

    df = pd.DataFrame({"d": pd.date_range("2150-01-01", periods=2000, freq="D")})
    full = _run_plot({"plotType": "histogram", "hist": "d", "bins": 20}, df.copy())
    lo, hi = full["data"][5]["lo"], full["data"][9]["hi"]

    zoomed = _run_plot({"plotType": "histogram", "hist": "d", "bins": 20,
                        "zoomLo": lo, "zoomHi": hi}, df.copy())
    assert len(zoomed["data"]) > 0
    total = sum(d["count"] for d in zoomed["data"])
    assert total > 0
    assert total < sum(d["count"] for d in full["data"])


def test_plot_builder_zoom_on_date_strings_keeps_its_rows():
    """Same for dates stored as text, which _linkr_to_num parses per value."""
    import pandas as pd

    days = [str(d.date()) for d in pd.date_range("2150-01-01", periods=500, freq="D")]
    df = pd.DataFrame({"d": days})
    full = _run_plot({"plotType": "histogram", "hist": "d", "bins": 10}, df.copy())
    lo, hi = full["data"][2]["lo"], full["data"][5]["hi"]

    zoomed = _run_plot({"plotType": "histogram", "hist": "d", "bins": 10,
                        "zoomLo": lo, "zoomHi": hi}, df.copy())
    assert sum(d["count"] for d in zoomed["data"]) > 0


def test_plot_builder_zoom_caps_bins_at_distinct_values():
    """20 bins over the integers 1..10 would leave every other bar empty — a comb
    implying gaps the data doesn't have."""
    import pandas as pd

    df = pd.DataFrame({"age": [i % 40 + 1 for i in range(800)]})
    out = _run_plot({"plotType": "histogram", "hist": "age", "bins": 20,
                     "zoomLo": 1, "zoomHi": 10}, df)
    assert len(out["data"]) == 10
    assert all(d["count"] > 0 for d in out["data"])


def test_plot_builder_histogram_bars_carry_numeric_bounds():
    """The bin label is rounded for display; lo/hi are what a drag maps back onto."""
    import pandas as pd

    out = _run_plot({"plotType": "histogram", "hist": "v", "bins": 5},
                    pd.DataFrame({"v": list(range(100))}))
    for bar in out["data"]:
        assert isinstance(bar["lo"], (int, float))
        assert bar["hi"] > bar["lo"]


def test_plot_builder_zoom_ignores_start_at_zero():
    """Padding the axis down to 0 inside a zoom would pull the view back out to the
    origin and undo it."""
    import pandas as pd

    df = pd.DataFrame({"v": list(range(100, 200))})
    out = _run_plot({"plotType": "histogram", "hist": "v", "bins": 10,
                     "xAxisStartZero": True, "zoomLo": 150, "zoomHi": 160}, df)
    assert out["data"][0]["lo"] >= 149


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


def _box_frame(n_categories):
    import pandas as pd

    # Category c<i> holds [i, i, i]: its median is i, so first-seen order is ascending.
    cats, vals = [], []
    for i in range(n_categories):
        cats += [f"c{i}"] * 3
        vals += [float(i)] * 3
    return pd.DataFrame({"cat": cats, "val": vals})


def test_plot_builder_boxplot_keeps_first_seen_order_by_default():
    res = _run_plot({"plotType": "boxplot", "x": "cat", "y": "val"}, _box_frame(3))
    assert [d["name"] for d in res["data"]] == ["c0", "c1", "c2"]


def test_plot_builder_boxplot_sorts_by_descending_median():
    res = _run_plot({"plotType": "boxplot", "x": "cat", "y": "val", "categoryOrder": "value-desc"}, _box_frame(3))
    assert [d["name"] for d in res["data"]] == ["c2", "c1", "c0"]
    assert [len(d["values"]) for d in res["data"]] == [3, 3, 3]


def test_plot_builder_boxplot_sorts_before_the_category_cap():
    """Mirror of buildBoxplotGroups: with 25 categories the sorted chart keeps the
    20 highest medians, not the first 20 met."""
    res = _run_plot({"plotType": "boxplot", "x": "cat", "y": "val", "categoryOrder": "value-desc"}, _box_frame(25))
    names = [d["name"] for d in res["data"]]
    assert len(names) == 20
    assert names[0] == "c24" and names[-1] == "c5"


def test_plot_builder_boxplot_custom_order_then_descending_median_before_the_cap():
    res = _run_plot({"plotType": "violin", "x": "cat", "y": "val", "categoryOrder": "custom",
                     "categoryOrderCustom": ["c3", "gone", "c1"]}, _box_frame(25))
    names = [d["name"] for d in res["data"]]
    assert len(names) == 20
    assert names[:3] == ["c3", "c1", "c24"]


# Mirror of plot-category-order.test.ts (orderCategories).
_ORDER_ITEMS = [("b", 2), ("Class 10", 5), ("a", 2), ("Class 2", 9)]


def _order(order, custom=()):
    from app.services.execution.render.plot_builder import _PLOT_PY

    ns = {}
    exec(_PLOT_PY, ns)  # noqa: S102 — server-owned program, test-only
    items = ns["_linkr_order_categories"](_ORDER_ITEMS, lambda kv: kv[0], lambda kv: kv[1], order, list(custom))
    return [k for k, _ in items]


def test_order_categories_by_value_keeps_first_appearance_between_ties():
    assert _order("value-desc") == ["Class 2", "Class 10", "b", "a"]
    assert _order("value-asc") == ["b", "a", "Class 10", "Class 2"]


def test_order_categories_alphabetical_compares_numbers_as_numbers():
    assert _order("alpha") == ["a", "b", "Class 2", "Class 10"]


def test_order_categories_alphabetical_ignores_case_and_accents():
    from app.services.execution.render.plot_builder import _PLOT_PY

    ns = {}
    exec(_PLOT_PY, ns)  # noqa: S102 — server-owned program, test-only
    names = ns["_linkr_order_categories"](["Éa", "b", "a", "ea", "B"], lambda s: s, lambda s: 0, "alpha")
    assert names == ["a", "b", "B", "Éa", "ea"]


def test_order_categories_data_and_custom():
    assert _order("data") == ["b", "Class 10", "a", "Class 2"]
    assert _order("custom", ["a", "gone", "b"]) == ["a", "b", "Class 2", "Class 10"]
    assert _order("custom") == _order("value-desc")


def _cat_frame():
    import pandas as pd

    # First seen: b, a, c. Counts: a=3, b=1, c=2.
    return pd.DataFrame({"cat": ["b", "a", "c", "a", "c", "a"], "val": [10.0, 1.0, 5.0, 1.0, 7.0, 1.0]})


def test_plot_builder_default_orders_follow_each_plot():
    df = _cat_frame()
    hist = _run_plot({"plotType": "histogram", "x": "cat", "hist": "cat"}, df)
    assert [d["bin"] for d in hist["data"]] == ["a", "c", "b"]
    pie = _run_plot({"plotType": "pie", "x": "cat", "hist": "cat"}, df)
    assert [d["bin"] for d in pie["data"]] == ["a", "c", "b"]
    bar_count = _run_plot({"plotType": "bar", "x": "cat"}, df)
    assert [d["name"] for d in bar_count["data"]] == ["a", "c", "b"]
    # A bar chart that averages a Y keeps the categories as met.
    bar_mean = _run_plot({"plotType": "bar", "x": "cat", "y": "val"}, df)
    assert [d["name"] for d in bar_mean["data"]] == ["b", "a", "c"]


def test_plot_builder_bar_mean_orders_on_the_mean():
    df = _cat_frame()
    res = _run_plot({"plotType": "bar", "x": "cat", "y": "val", "categoryOrder": "value-desc"}, df)
    assert [d["name"] for d in res["data"]] == ["b", "c", "a"]
    res = _run_plot({"plotType": "bar", "x": "cat", "y": "val", "categoryOrder": "alpha"}, df)
    assert [d["name"] for d in res["data"]] == ["a", "b", "c"]


def test_plot_builder_bar_orders_before_the_30_bar_cap():
    import pandas as pd

    cats = [f"k{i:02d}" for i in range(35) for _ in range(i + 1)]
    res = _run_plot({"plotType": "bar", "x": "cat", "categoryOrder": "value-asc"}, pd.DataFrame({"cat": cats}))
    names = [d["name"] for d in res["data"]]
    assert len(names) == 30
    assert names[0] == "k00" and names[-1] == "k29"


def test_plot_builder_histogram_categories_in_data_order():
    res = _run_plot({"plotType": "histogram", "x": "cat", "hist": "cat", "categoryOrder": "data"}, _cat_frame())
    assert [d["bin"] for d in res["data"]] == ["b", "a", "c"]


def test_plot_builder_rejects_an_unknown_category_order():
    with pytest.raises(ValueError):
        plot_builder.validate_spec({"plotType": "bar", "x": "a", "categoryOrder": "random"})
    with pytest.raises(ValueError):
        plot_builder.validate_spec({"plotType": "bar", "x": "a", "categoryOrderCustom": [1, 2]})


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


def test_table1_counts_each_entity_once_with_unique_per():
    import pandas as pd

    # Patient 1 has three event rows: without uniquePer, ICU would count 3 times.
    df = pd.DataFrame({
        "pid": [1, 1, 1, 2, 3],
        "svc": ["ICU", "ICU", "ICU", "HDU", "HDU"],
    })
    out = _run_table1(df, _svc_spec(uniquePer="pid"))
    assert out["groupSizes"][""] == 3
    cells = {r["label"]: r["cells"][""]["text"] for r in out["rows"]}
    assert cells["ICU"] == "1 (33%)"
    assert cells["HDU"] == "2 (67%)"


def test_table1_unique_per_reduces_numeric_variables_only():
    import pandas as pd

    df = pd.DataFrame({
        "pid": [1, 1, 2],
        "los": [2, 4, 10],
        "dead": [False, True, False],
    })
    spec = _svc_spec(
        selected=[
            {"name": "los", "label": "LOS", "numeric": True},
            {"name": "dead", "label": "Dead", "numeric": False},
        ],
        uniquePer="pid",
        uniqueAggregation="max",
    )
    out = _run_table1(df, spec)
    # max per patient: 4 and 10 → median 7; the boolean keeps the first row.
    assert out["rows"][0]["cells"][""]["text"].startswith("7")
    labels = [r["label"] for r in out["rows"]]
    assert "True" not in labels and "true" not in labels


def test_table1_validate_spec_defaults_unique_aggregation():
    spec = table1.validate_spec({"selected": [], "uniquePer": "pid", "uniqueAggregation": "bogus"})
    assert spec["uniquePer"] == "pid"
    assert spec["uniqueAggregation"] == "first"
    with pytest.raises(ValueError):
        table1.validate_spec({"selected": [], "uniquePer": 5})


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


# ---------------------------------------------------------------------------
# Statistical tests: per-variable overrides
# ---------------------------------------------------------------------------


def _run_stats(df, spec):
    """Execute the statistical-tests render code against a DataFrame."""
    import contextlib
    import io
    import json as _json

    code = statistical_tests.build_code(statistical_tests.validate_spec(spec))
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        exec(compile(code, "<render:statistical-tests>", "exec"), {"dataset": df})  # noqa: S102
    return _json.loads(buf.getvalue())


def _two_group_frame(groups=2):
    import pandas as pd

    n = 40 * groups
    return pd.DataFrame({
        "g": [f"G{i % groups}" for i in range(n)],
        "x": [float((i * 7) % 23) + (i % groups) * 3 for i in range(n)],
    })


def test_stats_override_keeps_only_known_test_names():
    spec = statistical_tests.validate_spec({
        "group": "g", "values": [{"name": "x", "type": "number"}],
        "overrides": {"x": "mann-whitney", "y": "not-a-test", "z": 7},
    })
    assert spec["overrides"] == {"x": "mann-whitney"}


def test_stats_override_rejects_a_non_object():
    with pytest.raises(ValueError):
        statistical_tests.validate_spec({
            "group": "g", "values": [{"name": "x", "type": "number"}], "overrides": "welch-t",
        })


def test_stats_override_forces_the_pinned_test():
    frame = _two_group_frame()
    base = {"group": "g", "values": [{"name": "x", "type": "number"}], "alpha": 0.05}
    assert _run_stats(frame, base)[0]["testName"] == "welch-t"
    pinned = _run_stats(frame, {**base, "overrides": {"x": "mann-whitney"}})
    assert pinned[0]["testName"] == "mann-whitney"


def test_stats_override_is_ignored_when_it_cannot_apply():
    # The case the applicability rule exists for: a k-sample test pinned on two
    # groups, and a two-sample test pinned on five. Both must fall back to the
    # automatic choice rather than run on data that cannot support them.
    two = _two_group_frame(2)
    five = _two_group_frame(5)
    base2 = {"group": "g", "values": [{"name": "x", "type": "number"}], "alpha": 0.05}

    assert _run_stats(two, {**base2, "overrides": {"x": "anova"}})[0]["testName"] == "welch-t"
    assert _run_stats(five, {**base2, "overrides": {"x": "welch-t"}})[0]["testName"] == "anova"
    # ...while the k-sample pin DOES apply on five groups.
    assert _run_stats(five, {**base2, "overrides": {"x": "kruskal-wallis"}})[0]["testName"] == "kruskal-wallis"


def test_stats_override_outranks_the_global_preference():
    frame = _two_group_frame()
    out = _run_stats(frame, {
        "group": "g", "values": [{"name": "x", "type": "number"}],
        "preference": "nonparametric", "overrides": {"x": "welch-t"},
    })
    assert out[0]["testName"] == "welch-t"


def test_plot_builder_scatter_samples_past_the_point_cap():
    """66k raw points stalled the browser; the program sends a sample and the real
    total so the chart can say it is sampled."""
    import pandas as pd

    n = 12_000
    df = pd.DataFrame({"a": range(n), "b": range(n), "g": ["p", "q"] * (n // 2)})
    out = _run_plot({"plotType": "scatter", "x": "a", "y": "b", "group": "g"}, df)
    assert out["pointsTotal"] == n
    sizes = {s["name"]: len(s["data"]) for s in out["series"]}
    assert sum(sizes.values()) == 5000
    # Interleaved groups must not alias with the sampling: each keeps about half.
    assert abs(sizes["p"] - sizes["q"]) < 300
    assert out == _run_plot({"plotType": "scatter", "x": "a", "y": "b", "group": "g"}, df)


def test_plot_builder_line_samples_after_sorting_on_x():
    import pandas as pd

    n = 10_000
    df = pd.DataFrame({"a": list(range(n))[::-1], "b": range(n)})
    out = _run_plot({"plotType": "line", "x": "a", "y": "b"}, df)
    xs = [p["x"] for p in out["series"][0]["data"]]
    assert xs == sorted(xs)
    assert xs[0] == 0 and xs[-1] == n - 2


def test_plot_builder_scatter_under_the_cap_is_not_sampled():
    import pandas as pd

    df = pd.DataFrame({"a": [1, 2, None, "x"], "b": [1, 2, 3, 4]})
    out = _run_plot({"plotType": "scatter", "x": "a", "y": "b", "excludeNA": False}, df)
    assert "pointsTotal" not in out
    assert _scatter_xs(out) == [1, 2]


def test_plot_builder_pie_counts_categories_largest_first():
    import pandas as pd

    df = pd.DataFrame({"ward": ["ICU", "ED", "ICU", "Ward", "ICU", "ED", None, ""]})
    out = _run_plot({"plotType": "pie", "x": "ward", "hist": "ward"}, df)
    assert out["data"] == [
        {"bin": "ICU", "count": 3},
        {"bin": "ED", "count": 2},
        {"bin": "Ward", "count": 1},
    ]
    assert out["series"] == ["count"]


def test_plot_builder_pie_counts_once_per_entity():
    """uniquePer collapses each entity to one row before counting, so a patient
    with several stays counts once."""
    import pandas as pd

    df = pd.DataFrame({
        "patient": ["P1", "P1", "P1", "P2", "P3"],
        "sex": ["F", "F", "F", "M", "M"],
    })
    out = _run_plot({"plotType": "pie", "x": "sex", "hist": "sex", "uniquePer": "patient"}, df)
    assert out["data"] == [{"bin": "M", "count": 2}, {"bin": "F", "count": 1}]


def test_plot_builder_pie_ignores_a_missing_column():
    import pandas as pd

    out = _run_plot({"plotType": "pie", "x": "gone", "hist": "gone"}, pd.DataFrame({"a": [1]}))
    assert out["data"] == []


def test_key_indicator_unique_per_aggregates_the_metric_per_entity():
    """uniquePer + mean: one value per entity (its mean), then the KPI over them.
    Entities with no numeric value keep their first one."""
    import pandas as pd

    df = pd.DataFrame({
        "visit": ["E1", "E1", "E2", "E2", "E3", None],
        "hr": [80, 100, 60, 70, "na", 999],
        "noise": list("abcdef"),
    })
    out = _run_kpi(
        {"column": {"name": "hr", "numeric": True}, "aggregate": "mean",
         "uniquePer": "visit", "uniqueAggregation": "mean"},
        df,
    )
    # E1 → 90, E2 → 65, E3 → "na" (dropped as empty); the null entity row is gone.
    assert out["allStats"]["n"] == 2
    assert out["result"] == pytest.approx(77.5)


def test_key_indicator_unique_per_last_takes_the_last_row():
    import pandas as pd

    df = pd.DataFrame({"visit": ["E1", "E1", "E2"], "hr": [80, 100, 60]})
    out = _run_kpi(
        {"column": {"name": "hr", "numeric": True}, "aggregate": "sum",
         "uniquePer": "visit", "uniqueAggregation": "last"},
        df,
    )
    assert out["result"] == pytest.approx(160.0)


def test_dataset_preamble_converts_types_without_fragmenting(tmp_path):
    """Converting ~50 columns one assignment at a time fragmented the frame, and
    pandas' PerformanceWarning then landed on stderr — shown as the widget's error."""
    import warnings

    import pandas as pd

    from app.services.execution import injection

    n = 150
    raw = pd.DataFrame({f"col_{i}": ["1", "2", "x"] for i in range(n)} | {"col_d": ["2024-01-02"] * 3})
    path = tmp_path / "d.parquet"
    raw.to_parquet(path)
    columns = [{"id": f"col_{i}", "name": f"c{i}", "type": "number"} for i in range(n)]
    columns.append({"id": "col_d", "name": "d", "type": "date"})
    code = injection.python_preamble_from(path.as_posix(), columns, None)
    ns: dict = {}
    with warnings.catch_warnings():
        warnings.simplefilter("error")
        exec(code, ns)  # noqa: S102 — server-owned program, test-only
        ns["dataset"].groupby("c0", as_index=False).last()
    ds = ns["dataset"]
    assert list(ds.columns) == [f"c{i}" for i in range(n)] + ["d"]
    assert ds["c0"].tolist()[:2] == [1, 2] and pd.isna(ds["c0"].iloc[2])
    assert pd.api.types.is_datetime64_any_dtype(ds["d"])
    assert "_linkr_conv" not in ns


def _run_map(spec_extra, df):
    import io
    import json
    from contextlib import redirect_stdout

    from app.services.execution.render import map as map_render

    code = map_render.build_code(map_render.validate_spec(spec_extra))
    buf = io.StringIO()
    with redirect_stdout(buf):
        exec(code, {"dataset": df})  # noqa: S102 — server-owned program, test-only
    return json.loads(buf.getvalue().strip().splitlines()[-1])


def test_map_keeps_valid_coordinates_and_resolves_fields():
    import pandas as pd

    df = pd.DataFrame({
        "lat": [48.1, " 43.3 ", None, 95.0, 45.0],
        "lon": [-1.6, 5.4, 2.0, 2.0, "x"],
        "site": ["Rennes", None, "a", "b", "c"],
        "n": [10, None, 1, 1, 1],
        "day": pd.to_datetime(["2024-01-02", None, "2024-01-01", "2024-01-01", "2024-01-01"]),
    })
    out = _run_map({"lat": "lat", "lon": "lon", "color": "site", "size": "n",
                    "label": "site", "popup": ["day", "missing"]}, df)
    # Missing, out-of-range and unparseable coordinates are dropped.
    assert [(r["lat"], r["lon"]) for r in out["rows"]] == [(48.1, -1.6), (43.3, 5.4)]
    first, second = out["rows"]
    assert first["colorCat"] == "Rennes" and first["label"] == "Rennes"
    assert first["sizeVal"] == 10.0
    assert first["popup"] == [{"key": "day", "value": "2024-01-02 00:00:00"}]
    # A missing value reads as empty, never "None"/"nan"/"NaT".
    assert second["colorCat"] == "" and second["sizeVal"] is None
    assert second["popup"] == [{"key": "day", "value": ""}]
    assert out["colorCats"] == ["Rennes"]
    assert (out["sizeMin"], out["sizeMax"]) == (10.0, 10.0)


def test_map_without_optional_fields():
    import pandas as pd

    out = _run_map({"lat": "lat", "lon": "lon"}, pd.DataFrame({"lat": [1.0], "lon": [2.0]}))
    assert out["rows"] == [{"lat": 1.0, "lon": 2.0, "colorCat": None, "sizeVal": None,
                            "label": None, "popup": None}]
    assert out["colorCats"] == []
