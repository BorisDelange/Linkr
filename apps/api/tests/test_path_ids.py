"""A row id the client later puts in a URL stays one path segment."""

import pytest


@pytest.mark.parametrize("value", ["../users/5", "..", ".", "a/b", "a\\b", "a?x=", "a#b", "%2e%2e", "a\tb"])
def test_a_row_id_stays_one_path_segment(value):
    from pydantic import ValidationError

    from app.schemas.cohort import CohortCreate

    with pytest.raises(ValidationError):
        CohortCreate(id=value, name={"en": "n"})


def test_a_minted_row_id_is_accepted():
    from pydantic import TypeAdapter

    from app.core.path_ids import SegmentId

    for value in ["6f1c2d3e-1111-4222-8333-abcdefabcdef", "tab_1", "a.b", "scope:code x"]:
        assert TypeAdapter(SegmentId).validate_python(value) == value
