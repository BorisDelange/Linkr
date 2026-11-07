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


# These classes quote what the statement names (a column, a table), never a row.
_NAMES_ONLY = re.compile(r"\s*(?:Binder|Catalog|Parser|Syntax|Dependency|Permission)\b")
# First quote to last: a value may hold quotes of its own, and an unclosed one
# hides the rest. The text between two values says nothing the statement doesn't.
_SINGLE_QUOTED = re.compile(r"'.*'|'.*", re.DOTALL)
_DOUBLE_QUOTED = re.compile(r'".*"|".*', re.DOTALL)
_UNQUOTED_VALUE = (
    (re.compile(r"\bwith value \S+"), "with value ***"),
    (re.compile(r"\)=\([^)\n]*\)"), ")=(***)"),
    (re.compile(r"(Out of Range Error:)[^\n]*"), r"\1 ***"),
    (re.compile(r"(Original Line:)[^\n]*"), r"\1 ***"),
)


def scrub_row_values(text: str) -> str:
    """`text` fit for a log: no secret, and none of the row values a failed cast or
    constraint quotes. Whoever ran the statement still gets the original in the reply."""
    text = _SINGLE_QUOTED.sub("'***'", redact_secrets(text))
    if not _NAMES_ONLY.match(text):
        text = _DOUBLE_QUOTED.sub('"***"', text)
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
