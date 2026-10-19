import logging
import sys

import structlog

from app.core.redact import redact_secrets


def setup_logging(debug: bool = False) -> None:
    structlog.configure(
        processors=[
            structlog.contextvars.merge_contextvars,
            structlog.processors.add_log_level,
            structlog.processors.StackInfoRenderer(),
            structlog.dev.set_exc_info,
            structlog.processors.TimeStamper(fmt="iso"),
            # JSON has no traceback of its own: rendered here, so it is redacted too.
            *([] if debug else [structlog.processors.format_exc_info]),
            _redact_event,
            (
                structlog.dev.ConsoleRenderer()
                if debug
                else structlog.processors.JSONRenderer()
            ),
        ],
        wrapper_class=structlog.make_filtering_bound_logger(
            structlog.get_config().get("min_level", 0)
        ),
        context_class=dict,
        logger_factory=structlog.PrintLoggerFactory(),
        cache_logger_on_first_use=True,
    )
    _setup_app_loggers()
    _redact_uvicorn_loggers()


def _setup_app_loggers() -> None:
    """The `app.*` modules log through the stdlib (`logging.getLogger(__name__)`),
    and several routes keep a diagnosis there on purpose — the driver's text
    behind a "Connection failed", which must not reach the client. Nothing
    configured those loggers: the root stays at WARNING with no handler, so
    every such INFO line was dropped and the server log held no trace of why a
    connection had failed. Only the `app` namespace is opened, not the root:
    third-party INFO (httpx prints every request URL) stays quiet."""
    app = logging.getLogger("app")
    if app.handlers:
        return
    handler = logging.StreamHandler(sys.stderr)
    handler.addFilter(_with_request_id)
    handler.addFilter(RedactSecrets())
    handler.setFormatter(logging.Formatter("%(levelname)s:     [%(request_id)s] %(name)s: %(message)s"))
    app.addHandler(handler)
    app.setLevel(logging.INFO)
    app.propagate = False


def _redact_uvicorn_loggers() -> None:
    """An unhandled route exception is logged by uvicorn ("Exception in ASGI
    application"), its traceback quoting whatever the driver raised. The filter
    sits on the logger, not a handler: it holds whatever handlers uvicorn's own
    logging config installs. The access line keeps its args, which its
    formatter unpacks."""
    for name, filter_ in (("uvicorn.error", RedactSecrets()), ("uvicorn.access", RedactSecretArgs())):
        logger = logging.getLogger(name)
        if not any(type(f) is type(filter_) for f in logger.filters):
            logger.addFilter(filter_)


def _with_request_id(record: logging.LogRecord) -> bool:
    """Stamp the line with the request that produced it (core/audit.request_id),
    bound by the audit middleware in structlog's context; "-" outside a request."""
    record.request_id = structlog.contextvars.get_contextvars().get("request_id", "-")
    return True


def _redact_event(_logger, _name, event_dict: dict) -> dict:
    return {k: redact_secrets(v) if isinstance(v, str) else v for k, v in event_dict.items()}


class RedactSecrets(logging.Filter):
    """A driver error quotes the DSN it was given, password included
    (core/redact): the line is rendered here, redacted, and its args cleared so
    the formatter cannot put them back. A traceback's text likewise."""

    def filter(self, record: logging.LogRecord) -> bool:
        try:
            message = record.getMessage()
        except Exception:  # noqa: BLE001
            # Args that do not fit the format: a filter raising would reach the
            # caller (only the handler's emit is guarded), so keep both, unformatted.
            message = f"{record.msg} {record.args!r}"
        record.msg = redact_secrets(message)
        record.args = None
        if record.exc_info and not record.exc_text:
            record.exc_text = logging.Formatter().formatException(record.exc_info)
        if record.exc_text:
            record.exc_text = redact_secrets(record.exc_text)
        return True


class RedactSecretArgs(logging.Filter):
    """`RedactSecrets` for a record whose formatter reads its args (uvicorn's
    access line): each string arg is redacted in place."""

    def filter(self, record: logging.LogRecord) -> bool:
        if isinstance(record.args, tuple):
            record.args = tuple(redact_secrets(a) if isinstance(a, str) else a for a in record.args)
        return True
