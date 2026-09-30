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

from app.config import settings

_JSON_HEADERS = ("info_json", "metadata_json", "json_metadata")
_EXTREMES = ("min", "max")


def _small(value: object, k: int) -> bool:
    if isinstance(value, bool) or value is None or value == "":
        return False
    try:
        n = float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return False
    return 0 < n < k


def mask_frequency(value: object, k: int | None = None) -> object:
    """A mapping's source frequency as it may leave the instance: a small one is
    unknown (None) — the field is a number, so it cannot read "<k"."""
    return None if _small(value, settings.export_min_count if k is None else k) else value


def _implied_small(percentage: object, total: object, k: int) -> bool:
    try:
        return _small(float(percentage) / 100 * float(total), k)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return False


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
    if isinstance(out.get("histogram"), list):
        out["histogram"] = [b for b in out["histogram"] if not (isinstance(b, dict) and _small(b.get("count"), k))]
    if isinstance(out.get("categorical_data"), list):
        out["categorical_data"] = [
            c for c in out["categorical_data"]
            if not (isinstance(c, dict) and (
                _small(c.get("count"), k)
                or ("count" not in c and _implied_small(c.get("percentage"), total, k))
            ))
        ]
    if isinstance(out.get("hospital_units"), list):
        out["hospital_units"] = [
            u for u in out["hospital_units"]
            if not (isinstance(u, dict) and _implied_small(u.get("percentage"), total, k))
        ]
    temporal = out.get("temporal_distribution")
    if isinstance(temporal, dict) and isinstance(temporal.get("by_year"), list):
        out["temporal_distribution"] = {
            **temporal,
            "by_year": [
                y for y in temporal["by_year"]
                if not (isinstance(y, dict) and _implied_small(y.get("percentage"), total, k))
            ],
        }
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
            try:
                profile = json.loads(cells[json_idx])
            except ValueError:
                continue
            if not isinstance(profile, dict):
                continue
            masked = None if withheld else mask_profile(profile, k)
            new = "" if masked is None else _js_json(masked)
            if masked != profile or masked is None:
                cells[json_idx] = new
                changed = True
    if not changed:
        return text
    body = "\n".join(delimiter.join(_cell(c, delimiter) for c in cells) for cells in rows)
    return body + "\n" if text.endswith("\n") else body
