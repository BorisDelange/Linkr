"""Render registry: spec validation + code building are pure logic (the security
boundary), so they get unit tests independent of the kernel."""

import pytest

from app.services.execution import render
from app.services.execution.render import table1


def test_registry_knows_table1_only_for_now():
    assert render.is_known_kind("table1")
    assert not render.is_known_kind("nope")


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
