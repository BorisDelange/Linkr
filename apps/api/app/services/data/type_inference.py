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

# Keep in lockstep with DEFAULT_NA_VALUES in dataset-utils.ts.
DEFAULT_NA_VALUES = ["na", "n/a", "null", "nan", "none", "#n/a"]

ColumnType = str  # 'string' | 'number' | 'boolean' | 'date' | 'unknown'


# The whitespace a cell is trimmed of before it is read. Deliberately the ASCII
# set and NOT Python's str.strip(), which also trims Unicode spaces (NBSP, the
# en/em spaces): the preview infers types in SQL, and DuckDB's trim() takes an
# explicit character set, so the two would disagree on a cell padded with NBSP —
# missing to the importer, present to the preview, and the preview would then
# advertise a type the import does not produce. _infer_types_sql builds the same
# set with chr(); keep the two in lockstep.
ASCII_WS = " \t\n\r\v\f"


def normalize_na_values(na_values: list[str] | None) -> set[str]:
    """Normalize a configured NA list for lookup (trimmed, lower-cased, no blanks)."""
    source = DEFAULT_NA_VALUES if na_values is None else na_values
    return {v.strip(ASCII_WS).lower() for v in source if v.strip(ASCII_WS) != ""}


def is_missing_value(value: object, na_set: set[str]) -> bool:
    """True when a raw cell reads as missing: null, empty, or an NA token."""
    if value is None:
        return True
    s = str(value).strip(ASCII_WS)
    return s == "" or s.lower() in na_set


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


def infer_column_type(
    values: list[object], na_values: list[str] | None = None
) -> ColumnType:
    """Priority: boolean > number > date > string. Scans ALL present values.

    Server-side we hold the whole column in memory already (parse_blob fetches
    every row), so we scan all of it rather than a 200-row sample: a column that
    is numeric for its first hundreds of rows but has an alphanumeric code later
    (e.g. MIMIC itemids then ICD codes like "G894") must be typed ``string``, not
    ``number`` — a wrong ``number`` verdict makes the Parquet cast fail and the
    whole import silently produce no columns.

    ``na_values`` tokens are read as missing alongside blanks, so a numeric column
    peppered with "NA" infers as ``number`` rather than ``string``."""
    na_set = normalize_na_values(na_values)
    non_null = [v for v in values if not is_missing_value(v, na_set)]
    if not non_null:
        return "unknown"

    all_numbers = all_booleans = all_dates = True
    for v in non_null:
        s = str(v).strip(ASCII_WS)
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
