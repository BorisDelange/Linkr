"""Secrets a database driver echoes back in its error text."""
import re

# A DuckDB postgres/mysql ATTACH error quotes the whole DSN it was given,
# password included: `Unable to connect to Postgres at "host=… password=…"`.
# A DSN value is one token in which `\` escapes the next character, whitespace
# included (db_connect._dsn_value) — a newline too, hence DOTALL.
_DSN_PASSWORD = re.compile(r"(\bpassword\s*=\s*)(?:\\.|\S)+", re.IGNORECASE | re.DOTALL)


def redact_secrets(text: str) -> str:
    return _DSN_PASSWORD.sub(r"\1***", text)

