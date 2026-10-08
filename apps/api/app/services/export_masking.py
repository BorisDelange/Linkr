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
  so is a cell that is not a JSON object, and one with no total — a count cell
  of its row, or the profile's `patients_count`/`rows_count` — reading as an
  integer of at least k (missing, "2e0", -1, "n/a" all fail closed);
- otherwise the profile loses its extremes (min/max, per-patient min/max,
  range, first and last event dates), p1/p5/p95/p99 under 100 values, and
  every histogram bin, category, hospital unit or year whose `count` (records)
  or `patients_count` is under k, or that has no readable `count` — a
  percentage alone does not say over how many records it was taken — then the
  smallest kept ones while the records dropped total under k;
- the histogram is first moved onto a round grid not anchored on the minimum,
  and its first and last bins go: each holds an extreme within one bin width;
- a cell keeps its records `count` but loses its `patients_count`, which only
  decided whether it could stay;
- a profile nested deeper than MAX_PROFILE_DEPTH is withheld, as Python's
  parser gives up on deep nesting where JSON.parse does not.
Bytes that cannot be read as text, or as CSV, raise SourceConceptsUnreadable:
never exported unmasked.
"""

import csv
import io
import json
import math
import re
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
            "The source concepts file is neither UTF-8 nor Windows-1252 text nor readable Parquet: "
            "it cannot be masked, so it is not exported."
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
_EXTREMES = ("min", "max")
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


def mask_profile(profile: dict, k: int, counted: bool = False) -> dict | None:
    """The profile as it may leave the instance, or None to withhold it. It leaves
    only over a total known to reach k: `counted` (a count cell of its row does)
    or its own `patients_count`/`rows_count` — a total that cannot be read could
    be one patient's."""
    if _small(profile.get("patients_count"), k) or _small(profile.get("rows_count"), k):
        return None
    if not (counted or _at_least(profile.get("patients_count"), k) or _at_least(profile.get("rows_count"), k)):
        return None
    out = dict(profile)
    out.pop("range", None)
    for key in ("numeric_data", "records_per_patient"):
        if isinstance(out.get(key), dict):
            out[key] = {k_: v for k_, v in out[key].items() if k_ not in _EXTREMES}
    total = profile.get("rows_count")

    def records(e: dict) -> float:
        return _number(e.get("count")) if "count" in e else math.nan

    def small_cell(e: dict) -> bool:
        n = records(e)
        return not math.isfinite(n) or _small(n, k) or _small(e.get("patients_count"), k)

    def cells(entries: list, small: Callable[[dict], bool] = small_cell) -> list:
        kept = _suppress(entries, small, records, k)
        return [{k_: v for k_, v in e.items() if k_ != "patients_count"} for e in kept]

    numeric = out.get("numeric_data")
    if isinstance(numeric, dict):
        sizes = [_number(numeric.get("numeric_count")), _number(total)]
        if isinstance(profile.get("histogram"), list):
            histogram_sum = 0.0
            for b in profile["histogram"]:
                histogram_sum += _number(b.get("count")) if isinstance(b, dict) else math.nan
            sizes.append(histogram_sum)
        known = [n for n in sizes if math.isfinite(n)]
        if not known or min(known) < _NEAR_EXTREMES_MIN_COUNT:
            out["numeric_data"] = {k_: v for k_, v in numeric.items() if k_ not in _NEAR_EXTREMES}
    if isinstance(out.get("histogram"), list):
        grid = _regrid(out["histogram"])
        if grid is None:
            del out["histogram"]
        else:
            first, last = grid[0], grid[-1]
            out["histogram"] = cells(grid, lambda b: b is first or b is last or small_cell(b))
    for key in ("categorical_data", "hospital_units"):
        if isinstance(out.get(key), list):
            out[key] = cells(out[key])
    temporal = out.get("temporal_distribution")
    if isinstance(temporal, dict):
        # The first and last dates are one patient's event each.
        rest = {k_: v for k_, v in temporal.items() if k_ not in ("start_date", "end_date")}
        if isinstance(rest.get("by_year"), list):
            rest["by_year"] = cells(rest["by_year"])
        out["temporal_distribution"] = rest
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


def mask_source_concepts_csv(text: str, column_mapping: dict | None = None, k: int | None = None) -> str:
    """`text` with every cell the rule masks rewritten; unchanged when nothing is."""
    k = settings.export_min_count if k is None else k
    text = text.removeprefix("\ufeff")
    if k <= 1 or not text or text.startswith("version https://git-lfs"):
        return text
    first_line = text.split("\n", 1)[0]
    delimiter = max((",", ";", "\t"), key=first_line.count)
    try:
        rows = list(csv.reader(io.StringIO(text, newline=""), delimiter=delimiter))
    except csv.Error as exc:
        raise SourceConceptsUnreadable() from exc
    if not rows:
        return text
    mapping = column_mapping or {}
    headers = rows[0]
    record_idx = _index(headers, mapping.get("recordCountColumn"), ("record_count", "rows_count"))
    patient_idx = _index(headers, mapping.get("patientCountColumn"), ("patient_count", "patients_count"))
    json_idx = _index(headers, mapping.get("infoJsonColumn"), _JSON_HEADERS)
    count_idx = [i for i in (record_idx, patient_idx) if i >= 0]
    if not count_idx and json_idx < 0:
        return text

    changed = False
    for cells in rows[1:]:
        withheld = any(i < len(cells) and _small(cells[i], k) for i in count_idx)
        counted = any(i < len(cells) and _at_least(cells[i], k) for i in count_idx)
        for i in count_idx:
            if i < len(cells) and _small(cells[i], k):
                cells[i] = f"<{k}"
                changed = True
        if 0 <= json_idx < len(cells) and cells[json_idx].strip():
            profile = _parse_profile(cells[json_idx])
            masked = None if withheld or not isinstance(profile, dict) else mask_profile(profile, k, counted)
            new = "" if masked is None else _js_json(masked)
            if masked != profile or masked is None:
                cells[json_idx] = new
                changed = True
    if not changed:
        return text
    body = "\n".join(delimiter.join(_cell(c, delimiter) for c in cells) for cells in rows)
    return body + "\n" if text.endswith("\n") else body
