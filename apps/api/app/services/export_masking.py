"""Small-count masking of a mapping project's source-concepts.csv on export.

A mapping project is what travels from an SPE to the global instance, which
holds no patient data: whatever leaves in `source-concepts.csv` must carry no
count under the threshold and no single patient's value. One pass, applied to
every export (ZIP, workspace export, git push), twin of
`lib/concept-mapping/export-masking.ts` — both must emit the same bytes, or a
front-only and a server client pushing the same repo would fight over the file.

The rule, with k the threshold:
- a count column cell in 1..k-1 becomes "<k";
- the profile JSON of a concept under k patients (or records) is withheld;
- otherwise the profile loses its extremes (min/max, per-patient min/max,
  range) and every histogram bin, category, hospital unit or year that holds
  fewer than k records — directly, or implied by its percentage of the total.
"""

import csv
import io
import json
import math
import re
from collections.abc import Callable

from app.config import settings

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


def mask_frequency(value: object, k: int | None = None) -> object:
    """A mapping's source frequency as it may leave the instance: a small one is
    unknown (None) — the field is a number, so it cannot read "<k"."""
    return None if _small(value, settings.export_min_count if k is None else k) else value


def _implied_count(percentage: object, total: object) -> float:
    """Percentages are rounded to one decimal, so the count is taken at the lowest
    the rounding allows — and 0.0% may still hide a few records."""
    return max(0.0, _number(percentage) - 0.05) / 100 * _number(total)


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
    bin its centre falls in; a histogram already on the grid comes out unchanged."""
    bins = [(_number(b.get("x")), _number(b.get("count"))) if isinstance(b, dict) else None for b in histogram]
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
    for x, count in bins:  # type: ignore[misc]
        i = bin_index(x, m, e)
        counts[i] = counts.get(i, 0.0) + count
    return [{"x": bin_centre(i, m, e), "count": counts[i]} for i in sorted(counts)]


def _suppress(entries: list, small: Callable[[dict], bool], mass: Callable[[dict], float], k: int) -> list:
    """`entries` without the small ones. When what was dropped totals under k, the
    total minus the kept entries would give it back, so the smallest kept entries
    go too until the dropped mass reaches k (secondary suppression)."""

    def dropped(e: object) -> bool:
        return isinstance(e, dict) and small(e)

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


def mask_profile(profile: dict, k: int) -> dict | None:
    """The profile as it may leave the instance, or None to withhold it."""
    if _small(profile.get("patients_count"), k) or _small(profile.get("rows_count"), k):
        return None
    out = dict(profile)
    out.pop("range", None)
    for key in ("numeric_data", "records_per_patient"):
        if isinstance(out.get(key), dict):
            out[key] = {k_: v for k_, v in out[key].items() if k_ not in _EXTREMES}
    total = profile.get("rows_count")

    def counted(e: dict) -> float:
        return _number(e.get("count"))

    def implied(e: dict) -> float:
        return _implied_count(e.get("percentage"), total)

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
            out["histogram"] = _suppress(grid, lambda b: _small(b.get("count"), k), counted, k)
    if isinstance(out.get("categorical_data"), list):

        def category_mass(c: dict) -> float:
            return counted(c) if "count" in c else implied(c)

        out["categorical_data"] = _suppress(
            out["categorical_data"],
            lambda c: _small(c.get("count"), k) if "count" in c else category_mass(c) < k,
            category_mass,
            k,
        )
    if isinstance(out.get("hospital_units"), list):
        out["hospital_units"] = _suppress(out["hospital_units"], lambda u: implied(u) < k, implied, k)
    temporal = out.get("temporal_distribution")
    if isinstance(temporal, dict):
        # The first and last dates are one patient's event each.
        rest = {k_: v for k_, v in temporal.items() if k_ not in ("start_date", "end_date")}
        if isinstance(rest.get("by_year"), list):
            rest["by_year"] = _suppress(rest["by_year"], lambda y: implied(y) < k, implied, k)
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


def _parse_profile(text: str) -> object:
    """The cell as JSON.parse reads it, or None where JSON.parse would throw:
    NaN and Infinity are refused, and every integer becomes a double."""
    try:
        return json.loads(text, parse_constant=_reject, parse_int=float)
    except (ValueError, RecursionError):
        return None


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
    except csv.Error:
        return text
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
        for i in count_idx:
            if i < len(cells) and _small(cells[i], k):
                cells[i] = f"<{k}"
                changed = True
        if 0 <= json_idx < len(cells) and cells[json_idx].strip():
            profile = _parse_profile(cells[json_idx])
            masked = None if withheld or not isinstance(profile, dict) else mask_profile(profile, k)
            new = "" if masked is None else _js_json(masked)
            if masked != profile or masked is None:
                cells[json_idx] = new
                changed = True
    if not changed:
        return text
    body = "\n".join(delimiter.join(_cell(c, delimiter) for c in cells) for cells in rows)
    return body + "\n" if text.endswith("\n") else body
