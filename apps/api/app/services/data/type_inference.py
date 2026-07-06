"""Column type inference — a faithful Python port of the frontend's
``inferColumnType`` (apps/web/src/lib/dataset-utils.ts).

Parity matters: dashboards and analyses key dataset rows by columnId and rely on
the inferred type (boolean / number / date / string) for formatting and inputs.
If the server inferred a different type than the client would, the UI would
misrender. Keep the priority, token sets and date regex in lockstep with the TS.
"""

import re

# ISO date (YYYY-MM-DD) and datetime, optional fractional seconds and TZ offset.
DATE_DATETIME_RE = re.compile(
    r"^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?([+-]\d{2}:?\d{2}|Z)?)?$"
)

BOOL_TRUE = {"true", "1", "yes", "y", "t", "vrai", "oui", "o"}
BOOL_FALSE = {"false", "0", "no", "n", "f", "faux", "non"}

ColumnType = str  # 'string' | 'number' | 'boolean' | 'date' | 'unknown'


def parse_boolean(value: object) -> bool | None:
    if value is None:
        return None
    s = str(value).strip().lower()
    if s in BOOL_TRUE:
        return True
    if s in BOOL_FALSE:
        return False
    return None


def _is_number(s: str) -> bool:
    # Mirror JS Number(s): empty already filtered out; accept ints/floats/exp.
    try:
        float(s)
        return True
    except ValueError:
        return False


def infer_column_type(values: list[object]) -> ColumnType:
    """Priority: boolean > number > date > string. Samples up to 200 non-null."""
    non_null = [v for v in values if v is not None and v != ""]
    if not non_null:
        return "unknown"

    all_numbers = all_booleans = all_dates = True
    for v in non_null[:200]:
        s = str(v).strip()
        if all_numbers and not _is_number(s):
            all_numbers = False
        if all_booleans and parse_boolean(s) is None:
            all_booleans = False
        if all_dates and not DATE_DATETIME_RE.match(s):
            all_dates = False
        if not all_numbers and not all_booleans and not all_dates:
            return "string"

    if all_booleans:
        return "boolean"
    if all_numbers:
        return "number"
    if all_dates:
        return "date"
    return "string"
