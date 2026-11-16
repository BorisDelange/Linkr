from app.core.refusal import refusal_detail
from app.services.data.community_engines import LoginNotReadOnly
from app.services.data.db_connect import StatementRefused


def test_a_coded_refusal_reaches_the_client_with_its_code():
    detail = refusal_detail(StatementRefused("statement_not_single", "this statement could not be read as a single statement"))
    assert detail == {"code": "statement_not_single", "message": "this statement could not be read as a single statement"}


def test_a_coded_refusal_keeps_its_values():
    detail = refusal_detail(LoginNotReadOnly("sqlserver_login_not_read_only", "refused", held="ALTER"))
    assert detail["code"] == "sqlserver_login_not_read_only" and detail["held"] == "ALTER"


def test_any_other_error_is_its_text_without_secrets():
    detail = refusal_detail(ValueError("could not connect to postgresql://u:hunter2@db/x"))
    assert isinstance(detail, str) and "hunter2" not in detail
