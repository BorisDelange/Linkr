"""JavaScript's reading and writing of values, for the Python twins of
TypeScript in this package (`profiles`): what `Number(x)`, `String(x)`,
`Math.round`, `.length`, `.trim()` and `JSON.stringify` give, where Python's
built-ins differ.
"""

import math
import re
from collections.abc import Callable, Iterable, Mapping, Sequence
from decimal import Decimal
from functools import cmp_to_key
from typing import Any


class _Undefined:
    __slots__ = ()

    def __repr__(self) -> str:
        return "undefined"


# A key a JavaScript object lacks reads as `undefined`, which differs from null:
# `Number(undefined)` is NaN, and `JSON.stringify` drops an undefined property.
UNDEFINED = _Undefined()

# One NaN object: `set`/`dict` find it by identity, as a JavaScript Set or Map
# finds NaN (SameValueZero).
_NAN = float("nan")

MAX_SAFE_INTEGER = 2**53 - 1

# WhiteSpace and LineTerminator of ECMA-262, what `String.prototype.trim` strips.
_JS_SPACE = (
    "\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007"
    "\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"
)
# StrDecimalLiteral and StrNonDecimalIntegerLiteral (`Number("…")`).
_DECIMAL_TEXT = re.compile(r"[+-]?(?:Infinity|(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?)")
_NON_DECIMAL_TEXT = re.compile(r"0[xX][0-9a-fA-F]+|0[oO][0-7]+|0[bB][01]+")
_ARRAY_INDEX = re.compile(r"0|[1-9][0-9]*")
_JSON_ESCAPES = {'"': '\\"', "\\": "\\\\", "\b": "\\b", "\f": "\\f", "\n": "\\n", "\r": "\\r", "\t": "\\t"}
_JSON_ESCAPED = re.compile(r'[\x00-\x1f"\\\ud800-\udfff]')
_SURROGATE = re.compile(r"[\ud800-\udfff]")


def _int_to_double(value: int) -> float:
    try:
        return float(value)
    except OverflowError:
        return math.inf if value > 0 else -math.inf


def _string_to_number(text: str) -> float:
    t = js_trim(text)
    if t == "":
        return 0
    if _DECIMAL_TEXT.fullmatch(t):
        return float(t)
    if _NON_DECIMAL_TEXT.fullmatch(t):
        return _int_to_double(int(t, 0))
    return _NAN


def js_number(value: Any) -> float:
    """`Number(value)`. Integral values within ±2**53 stay `int`, which a double
    holds exactly; NaN is always the same object."""
    if value is None:
        return 0
    if value is UNDEFINED:
        return _NAN
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, int):
        return value if -(2**53) <= value <= 2**53 else _int_to_double(value)
    if isinstance(value, float):
        return _NAN if math.isnan(value) else value
    if isinstance(value, Decimal):
        return js_number(float(value))
    if isinstance(value, str):
        return _string_to_number(value)
    if isinstance(value, (list, tuple)):
        return _string_to_number(js_string(value))
    return _NAN


def js_is_finite(value: Any) -> bool:
    """`Number.isFinite(value)`: a number, finite — a numeric string is not."""
    if isinstance(value, bool) or not isinstance(value, (int, float, Decimal)):
        return False
    return math.isfinite(js_number(value))


def js_trunc(value: float) -> float:
    return value if isinstance(value, int) or not math.isfinite(value) else math.trunc(value)


def js_round(value: float) -> float:
    """`Math.round`: half-way rounds up, towards +∞ (Python's `round` goes to even)."""
    if not math.isfinite(value):
        return value
    floor = math.floor(value)
    return floor + 1 if value - floor >= 0.5 else floor


def js_number_str(value: float) -> str:
    """`String(number)` (Number::toString): the shortest digits that round-trip,
    in plain notation from 1e-6 up to 1e21, exponent form outside."""
    if isinstance(value, int) and not isinstance(value, bool):
        if -(2**53) <= value <= 2**53:
            return str(value)
        value = _int_to_double(value)
    if math.isnan(value):
        return "NaN"
    if math.isinf(value):
        return "Infinity" if value > 0 else "-Infinity"
    if value == 0:
        return "0"
    mantissa, _, exponent = repr(abs(value)).partition("e")
    whole, _, fraction = mantissa.partition(".")
    digits = whole + fraction
    point = len(whole) + (int(exponent) if exponent else 0)
    significant = digits.lstrip("0")
    point -= len(digits) - len(significant)
    digits = significant.rstrip("0")
    k, n = len(digits), point
    if k <= n <= 21:
        body = digits + "0" * (n - k)
    elif 0 < n <= 21:
        body = f"{digits[:n]}.{digits[n:]}"
    elif -6 < n <= 0:
        body = "0." + "0" * -n + digits
    else:
        e = f"e{'+' if n - 1 >= 0 else '-'}{abs(n - 1)}"
        body = digits + e if k == 1 else f"{digits[0]}.{digits[1:]}{e}"
    return ("-" if value < 0 else "") + body


def js_string(value: Any) -> str:
    """`String(value)` for the values a row can hold."""
    if isinstance(value, str):
        return value
    if value is None:
        return "null"
    if value is UNDEFINED:
        return "undefined"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float, Decimal)):
        return js_number_str(js_number(value))
    if isinstance(value, (list, tuple)):
        return ",".join("" if v is None or v is UNDEFINED else js_string(v) for v in value)
    return "[object Object]"


def js_trim(text: str) -> str:
    """`text.trim()`: Python's `strip` takes other characters (U+001C…U+001F) and
    leaves the BOM."""
    return text.strip(_JS_SPACE)


def js_len(text: str) -> int:
    """`text.length`: UTF-16 code units, two for a character beyond the BMP."""
    if text.isascii():
        return len(text)
    return len(text) + sum(1 for c in text if ord(c) > 0xFFFF)


def js_truthy(value: Any) -> bool:
    if value is None or value is UNDEFINED or value is False:
        return False
    if isinstance(value, float):
        return not math.isnan(value) and value != 0
    if isinstance(value, int):
        return value != 0
    if isinstance(value, str):
        return value != ""
    return True


def nullish(value: Any, fallback: Any) -> Any:
    """`value ?? fallback`."""
    return fallback if value is None or value is UNDEFINED else value


def js_slice_head(items: Sequence, end: Any) -> list:
    """`items.slice(0, end)`."""
    n = js_number(end)
    if isinstance(n, float) and math.isnan(n):
        return []
    if math.isinf(n):
        return list(items) if n > 0 else []
    n = math.trunc(n)
    return list(items[: n if n >= 0 else max(len(items) + n, 0)])


def _quote(text: str) -> str:
    if _SURROGATE.search(text):
        # A pair kept as two code points is one character in JavaScript.
        text = text.encode("utf-16-le", "surrogatepass").decode("utf-16-le", "surrogatepass")

    def escape(m: re.Match) -> str:
        c = m.group()
        return _JSON_ESCAPES.get(c) or f"\\u{ord(c):04x}"

    return f'"{_JSON_ESCAPED.sub(escape, text)}"'


def _object_keys(obj: Mapping) -> list:
    """An object's keys in JavaScript's order: array indices first, ascending."""
    keys = [k if isinstance(k, str) else js_string(k) for k in obj]
    indices = {k for k in keys if _ARRAY_INDEX.fullmatch(k) and int(k) < 2**32 - 1}
    if not indices:
        return list(obj)
    by_text = dict(zip(keys, obj, strict=True))
    rest = [k for k in keys if k not in indices]
    return [by_text[k] for k in sorted(indices, key=int) + rest]


def js_json_dumps(value: Any) -> str:
    """`JSON.stringify(value)`: no spaces, non-ASCII kept, NaN and ±Infinity as
    null, an undefined property dropped."""
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, str):
        return _quote(value)
    if isinstance(value, (int, float, Decimal)):
        n = js_number(value)
        return js_number_str(n) if math.isfinite(n) else "null"
    if isinstance(value, Mapping):
        parts = [
            f"{_quote(k if isinstance(k, str) else js_string(k))}:{js_json_dumps(value[k])}"
            for k in _object_keys(value)
            if value[k] is not UNDEFINED
        ]
        return "{" + ",".join(parts) + "}"
    if isinstance(value, (list, tuple)):
        return "[" + ",".join("null" if v is UNDEFINED else js_json_dumps(v) for v in value) + "]"
    raise TypeError(f"not JSON-serializable: {type(value).__name__}")


def js_code_units(text: str) -> bytes:
    """A sort key ordering strings as JavaScript's `<` and default `sort()` do:
    by UTF-16 code units (Python's `<` goes by code points)."""
    return text.encode("utf-16-be", "surrogatepass")


def js_sorted(items: Iterable, compare: Callable[[Any, Any], float]) -> list:
    """`[...items].sort(compare)`: stable, read through `compare(a, b) < 0`."""
    return sorted(items, key=cmp_to_key(compare))
