import logging
import sys

import structlog


def setup_logging(debug: bool = False) -> None:
    structlog.configure(
        processors=[
            structlog.contextvars.merge_contextvars,
            structlog.processors.add_log_level,
            structlog.processors.StackInfoRenderer(),
            structlog.dev.set_exc_info,
            structlog.processors.TimeStamper(fmt="iso"),
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
    handler.setFormatter(logging.Formatter("%(levelname)s:     [%(request_id)s] %(name)s: %(message)s"))
    app.addHandler(handler)
    app.setLevel(logging.INFO)
    app.propagate = False


def _with_request_id(record: logging.LogRecord) -> bool:
    """Stamp the line with the request that produced it (core/audit.request_id),
    bound by the audit middleware in structlog's context; "-" outside a request."""
    record.request_id = structlog.contextvars.get_contextvars().get("request_id", "-")
    return True
