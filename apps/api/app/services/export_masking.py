"""Small-count masking of a mapping project's source-concepts.csv on export.

A mapping project is what travels from an SPE to the global instance, which
holds no patient data: whatever leaves in `source-concepts.csv` must carry no
count under the threshold and no single patient's value. One pass, applied to
every export (ZIP, workspace export, git push), twin of
`lib/concept-mapping/export-masking.ts` — both must emit the same bytes, or a
front-only and a server client pushing the same repo would fight over the file.

The rule, with k the threshold:
- a count column cell in 1..k-1 becomes "<k" (a count is plain decimal text);
- the profile JSON of a concept under k patients (or records) is withheld, and
  so is a cell that is not a JSON object, and one whose totals do not reach k:
  every patient total given — the patients cell of its row, the profile's
  `patients_count` — must read as an integer of at least k, and records (the
  records cell, `rows_count`) vouch only when no patient total is given at all
  (missing, "2e0", -1, "n/a" all fail closed);
- its numeric block, and the histogram of the same values, leave only when
  `numeric_data.numeric_patients_count` reads as at least k (and `numeric_count`,
  when given): a concept can reach k with its values held by one patient, and
  no such count means they are withheld. A `numeric_data` or
  `records_per_patient` that is not an object is withheld too, and so is a
  `missing_rate` that gives back a number of records (with or without a value)
  under k, or that cannot be read over a known total;
- only the fields below were judged, so only they may leave, a value of the kind
  the field holds; anything else in a profile (at its top, in a block, in a cell)
  stays behind, whatever its name: PROFILE_FIELDS and the *_FIELDS beside it;
- otherwise the profile loses its extremes (min/max, per-patient min/max,
  range, first and last event dates), p1/p5/p95/p99 under 100 values, and
  every histogram bin, category, hospital unit or year whose `count` (records)
  or `patients_count` is under k, or that has no readable `count` — a
  percentage alone does not say over how many records it was taken — then the
  smallest kept ones while the records dropped total under k;
- the histogram is first moved onto a round grid not anchored on the minimum,
  and its first and last bins go: each holds an extreme within one bin width —
  once: the profile is stamped `masked_k` (the threshold applied), and a profile
  already stamped at k or more, holding nothing a pass removes, is not regridded
  nor trimmed again, else every export of an imported file (a pull, then a push)
  would erode it. A file can carry any stamp: every other rule runs again whatever
  it says, near-extreme percentiles included, on the counts that do not shrink;
- a cell keeps its records `count` but loses its `patients_count`, which only
  decided whether it could stay;
- a profile nested deeper than MAX_PROFILE_DEPTH is withheld, as Python's
  parser gives up on deep nesting where JSON.parse does not.

Every column is judged, not only the ones holding a role: a column not known to
be harmless does not leave unmasked. The concept's own columns (its code, name,
vocabulary… named by the mapping or by their usual header) stay as they are. In
any other:
- a column named after a value of the data (sample, min, first, mean…) is emptied;
- a count cell — of a role, or of a column named as a count — that is under k or
  is no plain number becomes "<k", and withholds the row's profiles;
- a cell holding JSON is masked as a profile, or emptied if it is not one;
- any other number under k, or text starting as a number, becomes "<k";
- other text stays only in a column the project chose (`extraColumns`), and
  never on a row under k.

The file is read row for row as the app reads it, or not at all: an unbalanced
quote, a row of another width or lines to skip that it does not have raise
SourceConceptsUnreadable, as do bytes that cannot be read as text or as CSV.
Line endings are read alike whichever they are.
"""

import csv
import io
import json
import math
import re
import unicodedata
from collections.abc import Callable

from app.config import settings

# The csv module refuses a field over 128 KiB, and one profile cell can be larger:
# the limit is process-wide, raised once (2^31 - 1 fits a C long everywhere).
csv.field_size_limit(2**31 - 1)

_JSON_HEADERS = ("info_json", "metadata_json", "json_metadata")


class SourceConceptsUnreadable(ValueError):
    """Source-concepts bytes that cannot be read, hence cannot be masked: the file
    is then not exported at all rather than exported as it is."""

    def __init__(self) -> None:
        super().__init__(
            "The source concepts file is not UTF-8 or Windows-1252 text with well-formed rows of one width, "
            "nor readable Parquet: it cannot be masked, so it is not exported."
        )


def decode_source_text(data: bytes) -> str | None:
    """Source bytes as text — UTF-8, else Windows-1252 (the usual export of a
    French hospital's spreadsheet) — or None when they are not text at all."""
    try:
        text = data.decode("utf-8-sig")
    except UnicodeDecodeError:
        try:
            text = data.decode("cp1252")
        except UnicodeDecodeError:
            return None
    return None if "\0" in text else text
# Under this many values, a 1st/5th percentile sits on one patient's value.
_NEAR_EXTREMES_MIN_COUNT = 100
_NEAR_EXTREMES = ("p1", "p5", "p95", "p99")


# Plain decimal only, read alike by both sides: float() also takes "1_0" and
# JavaScript's Number() "0x5", so a looser parse masked a cell on one side only.
_NUMBER_TEXT = re.compile(r"[0-9]+(\.[0-9]+)?")


def _number(value: object) -> float:
    if isinstance(value, bool):
        return math.nan
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        text = value.strip(" \t")
        return float(text) if _NUMBER_TEXT.fullmatch(text) else math.nan
    return math.nan


def _small(value: object, k: int) -> bool:
    return 0 < _number(value) < k


def _at_least(value: object, k: int) -> bool:
    n = _number(value)
    return math.isfinite(n) and n == int(n) and n >= k


def mask_frequency(value: object, k: int | None = None) -> object:
    """A mapping's source frequency as it may leave the instance: a small one is
    unknown (None) — the field is a number, so it cannot read "<k"."""
    return None if _small(value, settings.export_min_count if k is None else k) else value


def nice_step(width: float) -> tuple[int, int]:
    """A bin width of m × 10^e, m in {1, 2, 5}: the smallest one not under `width`."""
    e = math.floor(math.log10(width)) - 1
    while True:
        for m in (1, 2, 5):
            if _step_width(m, e) >= width * (1 - 1e-9):
                return m, e
        e += 1


def _step_width(m: int, e: int) -> float:
    return m * float(10**e) if e >= 0 else m / float(10**-e)


def bin_index(x: float, m: int, e: int) -> int:
    """Index of the bin of width m × 10^e holding `x`, bins starting at multiples of the width."""
    return math.floor(x / (m * float(10**e)) if e >= 0 else x * float(10**-e) / m)


def bin_centre(i: int, m: int, e: int) -> float:
    """Centre of bin `i` of width m × 10^e, written as the decimal it is."""
    if e >= 0:
        return (2 * i + 1) * m * float(10**e) / 2
    return (2 * i + 1) * m / (2 * float(10**-e))


def _regrid(histogram: list) -> list[dict] | None:
    """The histogram moved onto a grid of round widths whose edges are multiples
    of the width, or None when it cannot be (under two bins, a bin that is not
    {x, count}). A profile built before such grids anchored its bins on the
    minimum — centre = min + (i + ½)·(max − min)/bins — so its first and last
    centres gave the minimum and the maximum back. Each old bin joins the round
    bin its centre falls in; a histogram already on the grid keeps its bins."""
    bins = [
        (_number(b.get("x")), _number(b.get("count")), _number(b.get("patients_count"))) if isinstance(b, dict) else None
        for b in histogram
    ]
    if len(bins) < 2 or any(b is None or not (math.isfinite(b[0]) and math.isfinite(b[1])) for b in bins):
        return None
    xs = sorted(b[0] for b in bins)  # type: ignore[index]
    width = math.inf
    for a, b in zip(xs, xs[1:]):
        if 0 < b - a < width:
            width = b - a
    if not math.isfinite(width):
        return None
    m, e = nice_step(width)
    counts: dict[int, float] = {}
    # Distinct patients do not add up across merged bins: the largest is a floor.
    patients: dict[int, float] = {}
    for x, count, pts in bins:  # type: ignore[misc]
        i = bin_index(x, m, e)
        counts[i] = counts.get(i, 0.0) + count
        if math.isfinite(pts):
            patients[i] = max(patients.get(i, pts), pts)
    return [
        {"x": bin_centre(i, m, e), "count": counts[i], **({"patients_count": patients[i]} if i in patients else {})}
        for i in sorted(counts)
    ]


def _suppress(entries: list, small: Callable[[dict], bool], mass: Callable[[dict], float], k: int) -> list:
    """`entries` without the small ones (and without what is not an object). When
    what was dropped totals under k, the total minus the kept entries would give
    it back, so the smallest kept entries go too until the dropped mass reaches k
    (secondary suppression)."""

    def dropped(e: object) -> bool:
        return not isinstance(e, dict) or small(e)

    def weight(e: object) -> float:
        m = mass(e) if isinstance(e, dict) else math.nan
        return m if math.isfinite(m) else 0.0

    kept = [e for e in entries if not dropped(e)]
    if len(kept) == len(entries):
        return kept
    dropped_mass = 0.0
    for e in entries:
        if dropped(e):
            dropped_mass += weight(e)
    while dropped_mass < k and kept:
        smallest = 0
        for i in range(1, len(kept)):
            if weight(kept[i]) < weight(kept[smallest]):
                smallest = i
        dropped_mass += weight(kept.pop(smallest))
    return kept


def _vouched(patients: list[object], records: list[object], k: int) -> bool:
    """Whether the totals known for a concept reach k. Every patient total given
    must read as at least k; records vouch only when no patient total is given at
    all — many records can still be one patient's."""
    given = [v for v in patients if v is not None]
    if given:
        return all(_at_least(v, k) for v in given)
    return any(_at_least(v, k) for v in records if v is not None)


def _numeric_vouched(numeric: object, k: int) -> bool:
    """Whether the values a numeric block is computed on are known to come from at
    least k patients — the concept's own totals do not say."""
    if not isinstance(numeric, dict) or not _at_least(numeric.get("numeric_patients_count"), k):
        return False
    return numeric.get("numeric_count") is None or _at_least(numeric.get("numeric_count"), k)


def _rate_gives_small_count(rate: object, records: object, k: int) -> bool:
    """Whether a missing rate, over its records, gives back a count under k — of
    the records with a value or of those without — or cannot be read at all."""
    r, n = _number(rate), _number(records)
    if not (math.isfinite(r) and math.isfinite(n)):
        return True
    missing = n * r / 100
    return 0 < missing < k or 0 < n - missing < k


# Text a profile may carry: what names the concept, not what was recorded for it.
_PROFILE_TEXT_FIELDS = frozenset({"full_name", "data_source", "unit"})
_PROFILE_NUMBER_FIELDS = frozenset({"rows_count", "patients_count", "missing_rate", "masked_k"})
_PROFILE_BLOCKS = frozenset({
    "data_types", "measurement_frequency", "numeric_data", "histogram", "categorical_data",
    "records_per_patient", "temporal_distribution", "hospital_units",
})
PROFILE_FIELDS = _PROFILE_TEXT_FIELDS | _PROFILE_NUMBER_FIELDS | _PROFILE_BLOCKS
NUMERIC_FIELDS = frozenset({
    "p1", "p5", "p25", "median", "mean", "p75", "p95", "p99", "sd", "numeric_count", "numeric_patients_count",
})
PER_PATIENT_FIELDS = frozenset({"mean", "median"})
# A cell: its numbers, and the one text naming it.
_CELL_NUMBERS = frozenset({"count", "percentage"})
_HISTOGRAM_NUMBERS = frozenset({"x", "count"})
_YEAR_NUMBERS = frozenset({"year", "count", "percentage"})
_NAMED_CELLS = {"categorical_data": "category", "hospital_units": "unit"}


def _is_number(value: object) -> bool:
    return value is None or math.isfinite(_number(value))


def _is_text(value: object) -> bool:
    return isinstance(value, str) or (isinstance(value, (int, float)) and not isinstance(value, bool))


def _numbers_only(block: dict, fields: frozenset) -> dict:
    return {k_: v for k_, v in block.items() if k_ in fields and _is_number(v)}


def _judged_cell(cell: dict, numbers: frozenset, text: str | None = None) -> dict:
    return {
        k_: v for k_, v in cell.items()
        if (k_ in numbers and _is_number(v)) or (k_ == text and _is_text(v))
    }


def _went_through_a_pass(profile: dict, k: int) -> bool:
    """Whether its stamp can be what a pass left: at k or more, over a profile
    holding nothing a pass removes."""
    if not _number(profile.get("masked_k")) >= k or any(key not in PROFILE_FIELDS for key in profile):
        return False
    for key, fields in (("numeric_data", NUMERIC_FIELDS), ("records_per_patient", PER_PATIENT_FIELDS)):
        block = profile.get(key)
        if isinstance(block, dict) and any(name not in fields for name in block):
            return False
    temporal = profile.get("temporal_distribution")
    if isinstance(temporal, dict) and any(name != "by_year" for name in temporal):
        return False
    histogram = profile.get("histogram")
    return not (isinstance(histogram, list) and any(isinstance(b, dict) and "patients_count" in b for b in histogram))


def _data_types(value: object) -> object:
    if isinstance(value, str):
        return value
    return [v for v in value if isinstance(v, str)] if isinstance(value, list) else None


def _judged_fields(profile: dict) -> dict:
    """What of `profile` the rule has a judgement on, in its order."""
    out: dict = {}
    for key, value in profile.items():
        if key in _PROFILE_BLOCKS or (key in _PROFILE_NUMBER_FIELDS and _is_number(value)) or (
            key in _PROFILE_TEXT_FIELDS and isinstance(value, str)
        ):
            out[key] = value
    if "data_types" in out:
        types = _data_types(out["data_types"])
        if types:
            out["data_types"] = types
        else:
            del out["data_types"]
    if "measurement_frequency" in out:
        frequency = out["measurement_frequency"]
        interval = frequency.get("typical_interval") if isinstance(frequency, dict) else None
        if isinstance(interval, str):
            out["measurement_frequency"] = {"typical_interval": interval}
        else:
            del out["measurement_frequency"]
    return out


def mask_profile(
    profile: dict, k: int, row_patients: object = None, row_records: object = None,
) -> dict | None:
    """The profile as it may leave the instance, or None to withhold it. It leaves
    only over totals known to reach k (see `_vouched`): the count cells of its row
    (`row_patients`, `row_records`; None when absent) and its own
    `patients_count`/`rows_count` — a total that cannot be read could be one
    patient's."""
    if _small(profile.get("patients_count"), k) or _small(profile.get("rows_count"), k):
        return None
    if not _vouched([row_patients, profile.get("patients_count")], [row_records, profile.get("rows_count")], k):
        return None
    stamped = _went_through_a_pass(profile, k)
    out = _judged_fields(profile)
    if "numeric_data" in out and not _numeric_vouched(out["numeric_data"], k):
        out.pop("numeric_data")
        out.pop("histogram", None)
    if "records_per_patient" in out and not isinstance(out["records_per_patient"], dict):
        out.pop("records_per_patient")
    if isinstance(out.get("numeric_data"), dict):
        out["numeric_data"] = _numbers_only(out["numeric_data"], NUMERIC_FIELDS)
    if isinstance(out.get("records_per_patient"), dict):
        out["records_per_patient"] = _numbers_only(out["records_per_patient"], PER_PATIENT_FIELDS)
    total = profile.get("rows_count")
    if "missing_rate" in out and _rate_gives_small_count(out["missing_rate"], total if total is not None else row_records, k):
        out.pop("missing_rate")

    def records(e: dict) -> float:
        return _number(e.get("count")) if "count" in e else math.nan

    def small_cell(e: dict) -> bool:
        n = records(e)
        return not math.isfinite(n) or _small(n, k) or _small(e.get("patients_count"), k)

    def cells(
        entries: list, numbers: frozenset, text: str | None = None, small: Callable[[dict], bool] = small_cell,
    ) -> list:
        return [_judged_cell(e, numbers, text) for e in _suppress(entries, small, records, k)]

    numeric = out.get("numeric_data")
    if isinstance(numeric, dict):
        sizes = [_number(numeric.get("numeric_count")), _number(total)]
        # Counted before a pass only: it has lost bins since.
        if not stamped and isinstance(profile.get("histogram"), list):
            histogram_sum = 0.0
            for b in profile["histogram"]:
                histogram_sum += _number(b.get("count")) if isinstance(b, dict) else math.nan
            sizes.append(histogram_sum)
        known = [n for n in sizes if math.isfinite(n)]
        if not known or min(known) < _NEAR_EXTREMES_MIN_COUNT:
            out["numeric_data"] = {k_: v for k_, v in numeric.items() if k_ not in _NEAR_EXTREMES}
    if isinstance(out.get("histogram"), list):
        if stamped:
            # On its grid already, edges gone: regridding again would infer a wider
            # step from the gaps the suppression left, and move every bin.
            out["histogram"] = cells(out["histogram"], _HISTOGRAM_NUMBERS)
        else:
            grid = _regrid(out["histogram"])
            if grid is None:
                del out["histogram"]
            else:
                first, last = grid[0], grid[-1]
                out["histogram"] = cells(
                    grid, _HISTOGRAM_NUMBERS, small=lambda b: b is first or b is last or small_cell(b),
                )
    for key, text in _NAMED_CELLS.items():
        if isinstance(out.get(key), list):
            out[key] = cells(out[key], _CELL_NUMBERS, text)
    for key in ("histogram", "categorical_data", "hospital_units"):
        if key in out and not isinstance(out[key], list):
            del out[key]
    temporal = out.get("temporal_distribution")
    if isinstance(temporal, dict):
        # The first and last dates are one patient's event each, and any other
        # field of this block is judged by nothing.
        by_year = temporal.get("by_year")
        out["temporal_distribution"] = {"by_year": cells(by_year, _YEAR_NUMBERS)} if isinstance(by_year, list) else {}
    elif "temporal_distribution" in out:
        del out["temporal_distribution"]
    out["masked_k"] = k
    return out


def _js_number(value: float) -> str:
    """A float as JavaScript's JSON.stringify writes it."""
    if not math.isfinite(value):
        return "null"
    if value == int(value) and abs(value) < 1e21:
        return str(int(value))
    mantissa, _, exp = repr(value).partition("e")
    if not exp:
        return mantissa
    e = int(exp)
    digits = mantissa.replace("-", "").replace(".", "")
    sign = "-" if value < 0 else ""
    point = len(mantissa.replace("-", "").split(".")[0]) + e
    if -6 <= point - 1 < 21:
        if point <= 0:
            return f"{sign}0.{'0' * -point}{digits}"
        if point >= len(digits):
            return f"{sign}{digits}{'0' * (point - len(digits))}"
        return f"{sign}{digits[:point]}.{digits[point:]}"
    head = digits[0] + ("." + digits[1:] if len(digits) > 1 else "")
    return f"{sign}{head}e{'+' if point - 1 > 0 else '-'}{abs(point - 1)}"


def _js_json(value: object) -> str:
    """JSON.stringify(value), byte for byte."""
    if value is None or value is True or value is False:
        return json.dumps(value)
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        return _js_number(value)
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False)
    if isinstance(value, list):
        return "[" + ",".join(_js_json(v) for v in value) + "]"
    if isinstance(value, dict):
        return "{" + ",".join(f"{_js_json(str(k))}:{_js_json(v)}" for k, v in value.items()) + "}"
    raise TypeError(type(value))


def _reject(constant: str) -> None:
    raise ValueError(constant)


# A profile is three levels deep. Python's parser fails around a thousand levels
# where JSON.parse goes much further, so both sides withhold past this one.
MAX_PROFILE_DEPTH = 20


def _too_deep(value: object) -> bool:
    stack = [(value, 1)]
    while stack:
        node, depth = stack.pop()
        children = node.values() if isinstance(node, dict) else node if isinstance(node, list) else None
        if children is None:
            continue
        if depth > MAX_PROFILE_DEPTH:
            return True
        stack.extend((c, depth + 1) for c in children)
    return False


def _parse_profile(text: str) -> object:
    """The cell as JSON.parse reads it, or None where JSON.parse would throw or
    the nesting passes MAX_PROFILE_DEPTH: NaN and Infinity are refused, and
    every integer becomes a double."""
    try:
        value = json.loads(text, parse_constant=_reject, parse_int=float)
    except (ValueError, RecursionError):
        return None
    return None if _too_deep(value) else value


def _cell(value: str, delimiter: str) -> str:
    if delimiter in value or '"' in value or "\n" in value or "\r" in value:
        return '"' + value.replace('"', '""') + '"'
    return value


def _index(headers: list[str], mapped: str | None, guesses: tuple[str, ...]) -> int:
    lower = [h.strip().lower() for h in headers]
    if mapped and mapped.strip().lower() in lower:
        return lower.index(mapped.strip().lower())
    for name in guesses:
        if name in lower:
            return lower.index(name)
    return -1


def _positional_headers(width: int) -> list[str]:
    """The names DuckDB gives the columns of a file read with header=false —
    what a headerless project's column mapping refers to."""
    digits = len(str(max(width - 1, 0)))
    return [f"column{str(i).zfill(digits)}" for i in range(width)]


# A real pointer, not a file that merely starts like one.
_LFS_POINTER = re.compile(r"version https://git-lfs\S*\noid sha256:[0-9a-f]+\nsize [0-9]+\n?")
_MASKED_CELL = re.compile(r"<[0-9]+")
_STARTS_AS_NUMBER = re.compile(r"[^0-9A-Za-z]*[0-9]")
_DIGIT = re.compile(r"[0-9]")

# Headers are compared as `_slug` writes them, so `minValue`, `MIN VALUE` and
# `min_value` read alike, and `début` as `debut`.
_CONCEPT_ROLES = (
    "terminologyColumn", "conceptCodeColumn", "conceptIdColumn", "conceptNameColumn", "domainColumn",
    "conceptClassColumn", "categoryColumn", "subcategoryColumn", "targetConceptIdColumn",
)
_CONCEPT_HEADERS = frozenset({
    "terminology", "terminology_id", "vocabulary", "vocabulary_id", "code", "concept_code", "source_code", "id",
    "concept", "concept_id", "target_concept_id", "name", "concept_name", "label", "description", "domain",
    "domain_id", "concept_class", "concept_class_id", "category", "subcategory", "unit",
})
_COUNT_HEADER = re.compile(
    r"(^|_)(n|nb|nbr|num|number|nombre|count|counts|cnt|freq|frequency|frequence|total|effectifs?|recs?|records?"
    r"|enregistrements?|rows?|lignes?|patients?|pts|subjects?|persons?|stays?|sejours?|visits?|occurrences?)(_|$)"
)
_VALUE_HEADER = re.compile(
    r"(^|_)(samples?|examples?|exemples?|echantillons?|values?|valeurs?|min|max|minimum|maximum|range|first|last"
    r"|premier|premiere|dernier|derniere|start|end|debut|fin|earliest|latest|oldest|newest|top|mode|mean|avg|average"
    r"|moyenne|median|mediane|sd|std|stddev|percentiles?|p[0-9]{1,2}|q[0-9])(_|$)"
)


def _slug(header: str) -> str:
    plain = "".join(c for c in unicodedata.normalize("NFD", header) if not unicodedata.category(c).startswith("M"))
    return re.sub(r"[^a-z0-9]+", "_", re.sub(r"([a-z0-9])([A-Z])", r"\1_\2", plain).lower())


def _count_hidden(cell: str, k: int) -> bool:
    """Whether a count cell says or may say a count under k: one that cannot be
    read as a plain number, if it holds a digit, could be any."""
    text = cell.strip(" \t")
    if not text or _NUMBER_TEXT.fullmatch(text) and not _small(text, k):
        return False
    return _DIGIT.search(text) is not None


def _masked_json(cell: str, k: int, withheld: bool, row_patients: object, row_records: object) -> str:
    profile = _parse_profile(cell)
    masked = None if withheld or not isinstance(profile, dict) else mask_profile(profile, k, row_patients, row_records)
    if masked is None:
        return ""
    return cell if masked == profile else _js_json(masked)


def _masked_other(cell: str, k: int, chosen: bool, withheld: bool) -> str:
    text = cell.strip(" \t")
    if _small(text, k) or (not _NUMBER_TEXT.fullmatch(text) and _STARTS_AS_NUMBER.match(text)):
        return f"<{k}"
    if _NUMBER_TEXT.fullmatch(text):
        return "" if withheld else cell
    return cell if chosen and not withheld else ""


def _read_rows(table: str, delimiter: str, has_header: bool) -> list[list[str]]:
    """The rows of `table`, every one of the same width — a blank line aside — or
    SourceConceptsUnreadable: a row read otherwise than the app reads it would go
    unmasked, its counts in the wrong column or inside a field."""
    if delimiter in ('"', "\n", "\r"):
        raise SourceConceptsUnreadable()
    try:
        rows = list(csv.reader(io.StringIO(table, newline=""), delimiter=delimiter, strict=True))
    except csv.Error as exc:
        raise SourceConceptsUnreadable() from exc
    filled = [r for r in rows if r and r != [""]]
    width = len(filled[0]) if filled else 0
    if any(len(r) != width for r in filled) or (has_header and rows and not rows[0]):
        raise SourceConceptsUnreadable()
    return rows


def mask_source_concepts_csv(
    text: str, column_mapping: dict | None = None, k: int | None = None, parse_options: dict | None = None,
) -> str:
    """`text` with every cell the rule masks rewritten; unchanged when nothing is.

    The file is read as the app reads it (`parse_options`: skipRows lines kept as
    they are, the chosen delimiter, a header or positional names). A count or
    profile column the mapping names but the file does not have means the file
    was not read as it should be: it raises rather than leaves unmasked."""
    k = settings.export_min_count if k is None else k
    text = text.removeprefix("\ufeff")
    if k <= 1 or not text or _LFS_POINTER.fullmatch(text):
        return text
    opts = parse_options or {}
    try:
        skip = max(0, int(opts.get("skipRows") or 0))
    except (TypeError, ValueError) as exc:
        raise SourceConceptsUnreadable() from exc
    lines = re.sub(r"\r\n?", "\n", text).split("\n", skip)
    if len(lines) <= skip:
        raise SourceConceptsUnreadable()
    preamble = "".join(f"{line}\n" for line in lines[:skip])
    table = lines[skip]
    first_line = table.split("\n", 1)[0]
    delimiter = opts.get("delimiter") or max((",", ";", "\t", "|"), key=first_line.count)
    if not isinstance(delimiter, str) or len(delimiter) != 1:
        raise SourceConceptsUnreadable()
    has_header = opts.get("hasHeader", True) is not False
    rows = _read_rows(table, delimiter, has_header)
    if not rows:
        return text
    mapping = column_mapping or {}
    headers = rows[0] if has_header else _positional_headers(max(len(r) for r in rows))
    data = rows[1:] if has_header else rows
    record_idx = _index(headers, mapping.get("recordCountColumn"), ("record_count", "rows_count"))
    patient_idx = _index(headers, mapping.get("patientCountColumn"), ("patient_count", "patients_count"))
    json_idx = _index(headers, mapping.get("infoJsonColumn"), _JSON_HEADERS)
    roles = (("recordCountColumn", record_idx), ("patientCountColumn", patient_idx), ("infoJsonColumn", json_idx))
    if any(mapping.get(role) and idx < 0 for role, idx in roles):
        raise SourceConceptsUnreadable()

    lower = [h.strip().lower() for h in headers]
    slugs = [_slug(h.strip()) for h in headers]
    concept_names = {str(mapping[role]).strip().lower() for role in _CONCEPT_ROLES if mapping.get(role)}
    extra = mapping.get("extraColumns")
    chosen_names = {str(c).strip().lower() for c in extra} if isinstance(extra, list) else set()
    role_counts = {i for i in (record_idx, patient_idx) if i >= 0}
    concept_cols = {
        i for i in range(len(headers))
        if i not in role_counts and i != json_idx and (lower[i] in concept_names or slugs[i] in _CONCEPT_HEADERS)
    }
    judged = [i for i in range(len(headers)) if i not in concept_cols and i != json_idx]
    value_cols = {i for i in judged if i not in role_counts and _VALUE_HEADER.search(slugs[i])}
    count_cols = role_counts | {i for i in judged if i not in value_cols and _COUNT_HEADER.search(slugs[i])}

    changed = False
    for cells in data:
        if not cells or cells == [""]:
            continue
        withheld = any(_count_hidden(cells[i], k) for i in count_cols)
        row_patients, row_records = (
            cells[i] if i >= 0 and cells[i].strip() else None for i in (patient_idx, record_idx)
        )
        for i, cell in enumerate(cells):
            text_cell = cell.strip(" \t")
            if i in concept_cols or not cell.strip():
                continue
            if i == json_idx or (i not in role_counts and text_cell[0] in "{["):
                new = _masked_json(cell, k, withheld, row_patients, row_records)
            elif _MASKED_CELL.fullmatch(text_cell):
                continue
            elif i in value_cols:
                new = ""
            elif i in count_cols:
                if _count_hidden(cell, k):
                    new = f"<{k}"
                elif _NUMBER_TEXT.fullmatch(text_cell) or i in role_counts:
                    new = cell
                else:
                    new = _masked_other(cell, k, lower[i] in chosen_names, withheld)
            else:
                new = _masked_other(cell, k, lower[i] in chosen_names, withheld)
            if new != cell:
                cells[i] = new
                changed = True
    if not changed:
        return text
    body = "\n".join(delimiter.join(_cell(c, delimiter) for c in cells) for cells in rows)
    return preamble + (body + "\n" if table.endswith("\n") else body)
