"""Secrets and row values a database driver echoes back in its error text."""
import re

# A DuckDB postgres/mysql ATTACH error quotes the whole DSN it was given,
# password included: `Unable to connect to Postgres at "host=… password=…"`.
# A DSN value is one token in which `\` escapes the next character, whitespace
# included (db_connect._dsn_value) — a newline too, hence DOTALL — or a quoted
# string, hidden whole (an unclosed quote: to the end of the text).
_DSN_PASSWORD = re.compile(
    r"""(\bpassword\s*=\s*)(?:"(?:\\.|[^"\\])*"?|'(?:\\.|[^'\\])*'?|(?:\\.|\S)+)""",
    re.IGNORECASE | re.DOTALL,
)
# A connection URL's userinfo: `postgresql://user:pw@host` keeps the user only.
# Bounded runs keep it linear on long text (unbounded, `a.a.…` was quadratic);
# a password has no `/` (percent-encoded), so `http://host:8080/p@x` is no userinfo.
_URL_PASSWORD = re.compile(r"(\b[a-z][a-z0-9+.-]{0,30}://[^\s/:@]{0,256}:)[^\s/@]{1,256}(?=@)", re.IGNORECASE)


def redact_secrets(text: str) -> str:
    return _URL_PASSWORD.sub(r"\1***", _DSN_PASSWORD.sub(r"\1***", text))


# These classes quote what the statement or the code names (a table, a column, a
# variable), never a row — and the statement is in the access log already.
_NAMES_ONLY = re.compile(
    r"(?:Binder|Catalog|Parser|Syntax|Dependency|Permission) Error\b"
    r"|(?:NameError|UnboundLocalError|AttributeError|ModuleNotFoundError|ImportError):"
)
# Where such a class may open its part of the text: at the start, after a
# wrapper's `: ` (`Script “x” failed: Binder Error: …`) or on a line of its own.
_PART_START = re.compile(r"(?:^|(?<=: )|(?<=\n))[ \t]*")
# The next error on a line of its own ends a names-only part.
_NEXT_ERROR = re.compile(r"\n(?=[ \t]*[A-Za-z_][\w. ]{0,60}(?:Error|Exception)\b)")
# First quote to last, within one part: DuckDB echoes a value without escaping
# the quotes it holds (`'O'DUMMY'`), and an unclosed one hides the rest. The
# text between two values says nothing the statement doesn't.
_SINGLE_QUOTED = re.compile(r"'.*'|'.*", re.DOTALL)
_DOUBLE_QUOTED = re.compile(r'".*"|".*', re.DOTALL)
_UNQUOTED_VALUE = (
    (re.compile(r"\bwith value \S+"), "with value ***"),
    (re.compile(r"\)=\([^)\n]*\)"), ")=(***)"),
    (re.compile(r"(Out of Range Error:)[^\n]*"), r"\1 ***"),
    (re.compile(r"(Original Line:)[^\n]*"), r"\1 ***"),
)


def _names_only_start(text: str, pos: int) -> int | None:
    """Where the first names-only part after `pos` opens — only behind text whose
    quotes all close, so a row value can't open one by quoting a class name."""
    for start in _PART_START.finditer(text, pos):
        at = start.end()
        if _NAMES_ONLY.match(text, at):
            even = text.count("'", pos, at) % 2 == 0 and text.count('"', pos, at) % 2 == 0
            return at if even else None
    return None


def _scrub_quotes(text: str) -> str:
    parts: list[str] = []
    pos = 0
    while (at := _names_only_start(text, pos)) is not None:
        end = _NEXT_ERROR.search(text, at)
        stop = end.start() if end else len(text)
        parts += [_scrub_part(text[pos:at]), text[at:stop]]
        pos = stop
    return "".join(parts) + _scrub_part(text[pos:])


def _scrub_part(text: str) -> str:
    return _DOUBLE_QUOTED.sub('"***"', _SINGLE_QUOTED.sub("'***'", text))


def scrub_row_values(text: str) -> str:
    """`text` fit for a log: no secret, and none of the row values a failed cast or
    constraint quotes; the names a schema error quotes stay, wherever it sits in the
    text. Whoever ran the statement still gets the original in the reply."""
    text = _scrub_quotes(redact_secrets(text))
    for pattern, replacement in _UNQUOTED_VALUE:
        text = pattern.sub(replacement, text)
    return text


# What a scrubbed message may still say in full: shapes in which nothing is left
# that a row could have put there. Anything else keeps only its class.
_LINE_TAIL = r"(?:\n\nLINE \d+: [^\n]*\n *\^)?"
_VALUE_FREE = tuple(re.compile(shape, re.DOTALL) for shape in (
    r"(?:Binder|Catalog|Parser|Syntax|Dependency|Permission) Error: .*",
    r"Conversion Error: Could not convert string '\*\*\*' to [\w\[\](), ]+?"
    r"(?: when casting from source column \w+)?" + _LINE_TAIL,
    r'Conversion Error: invalid (?:date|timestamp|time) field format: "\*\*\*", expected format is \([\w:.+\- ]+\)'
    r"(?: when casting from source column \w+)?" + _LINE_TAIL,
    r"Conversion Error: Type \w+ with value \*\*\* can'\*\*\*'",
    r"Out of Range Error: \*\*\*" + _LINE_TAIL,
    r'Constraint Error: Duplicate key "\*\*\*" violates (?:primary key|unique) constraint[^\n"\']*',
    r"Constraint Error: NOT NULL constraint failed: [\w.]+",
    r"INTERRUPT Error: Interrupted!",
    r"Out of Memory Error: [^\n\d'\"]*",
))
_ERROR_CLASS = re.compile(r"[A-Za-z][A-Za-z ]{0,40} Error|[A-Za-z_][\w.]{0,80}(?:Error|Exception)")
WITHHELD = "[message withheld from the log]"


def log_safe_error(text: str) -> str:
    """A database error as the access log may hold it: in full only when its shape
    holds no row value, else its class alone. The log is read by people with no
    access to the database; whoever ran the statement gets the full text in the reply."""
    scrubbed = scrub_row_values(text).strip()
    if any(shape.fullmatch(scrubbed) for shape in _VALUE_FREE):
        return scrubbed
    head = scrubbed.split("\n", 1)[0].split(":", 1)[0].strip()
    return f"{head}: {WITHHELD}" if _ERROR_CLASS.fullmatch(head) else WITHHELD
