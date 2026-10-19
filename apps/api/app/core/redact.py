"""Secrets a database driver echoes back in its error text."""
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
_URL_PASSWORD = re.compile(r"(\b[a-z][a-z0-9+.-]*://[^\s/:@]*:)[^\s@]+(?=@)", re.IGNORECASE)


def redact_secrets(text: str) -> str:
    return _URL_PASSWORD.sub(r"\1***", _DSN_PASSWORD.sub(r"\1***", text))
