"""What runs is what the checks read: one split statement is one statement for
DuckDB's parser, and no parse option or column id reaches SQL as anything else."""

import duckdb
import pytest

from app.services.data import cohort_derive, dataset_parser, dataset_rows, db_connect

HIDDEN = "SELECT 1 AS a$$; ATTACH '{path}' AS o (TYPE sqlite); SELECT 2 AS b$$"
HIDDEN_NO_CLOSE = "SELECT 1 AS a$$; ATTACH '{path}' AS o (TYPE sqlite); SELECT 2 -- $$"


def test_a_dollar_after_an_identifier_opens_no_block():
    assert len(db_connect._split_statements("SELECT 1 AS a$$; SELECT 2 AS b$$")) == 2
    assert len(db_connect._split_statements("SELECT 1 AS é$$; SELECT 2 AS b$$")) == 2
    assert db_connect._split_statements("SELECT $$a;b$$; SELECT $t$c;d$t$") == ["SELECT $$a;b$$", "SELECT $t$c;d$t$"]


@pytest.mark.parametrize("template", [HIDDEN, HIDDEN_NO_CLOSE])
def test_a_cohort_query_cannot_hold_another_statement(template):
    with pytest.raises(ValueError):
        cohort_derive._check_membership_sql(template.format(path="/tmp/x.db"))


@pytest.mark.parametrize("template", [HIDDEN, HIDDEN_NO_CLOSE])
def test_a_pipeline_script_cannot_attach_a_file(tmp_path, template):
    target = tmp_path / "target.duckdb"
    duckdb.connect(str(target)).close()
    other = tmp_path / "other.duckdb"
    with pytest.raises(ValueError, match="ATTACH"):
        db_connect.run_etl_sql(str(target), template.format(path=other))
    assert not other.exists()


def test_a_split_statement_the_parser_reads_as_several_is_refused():
    with pytest.raises(ValueError, match="single statement"):
        db_connect._reject_hidden_statements("SELECT 1; SELECT 2")
    db_connect._reject_hidden_statements("SELECT ';' -- ; comment")


def test_a_read_query_runs_one_statement_at_a_time():
    assert db_connect._run_statements(duckdb.connect(), "memory", "SELECT 1 AS a$$; SELECT 2 AS b$$") == [{"b$$": 2}]


INJECTED = "true); COPY (SELECT 1) TO '{out}' (FORMAT CSV); SELECT * FROM read_csv('{src}', header=true"


@pytest.fixture
def csv_file(tmp_path):
    path = tmp_path / "blob"
    path.write_text("a,b\n1,2\n")
    return path


@pytest.mark.parametrize("read", [
    lambda path, opts: dataset_parser.preview_blob(path, "x.csv", opts),
    lambda path, opts: dataset_parser.parse_blob(path, "x.csv", opts),
    lambda path, opts: dataset_parser.convert_to_parquet(path, "x.csv", opts, path.parent / "dest.parquet"),
    lambda path, opts: db_connect.file_source_columns(str(path), "x.csv", opts),
    lambda path, opts: db_connect.query_file_source(str(path), "x.csv", opts, "a AS concept_id", "concept_id", "SELECT 1 AS x"),
])
def test_a_parse_option_never_reaches_the_sql_as_text(tmp_path, csv_file, read):
    out = tmp_path / "written.csv"
    read(csv_file, {"hasHeader": INJECTED.format(out=out, src=csv_file)})
    assert not out.exists()


@pytest.mark.parametrize("has_header,row_count", [(True, 1), (False, 2)])
def test_has_header_still_reads_both_ways(csv_file, has_header, row_count):
    assert dataset_parser.parse_blob(csv_file, "x.csv", {"hasHeader": has_header})[2] == row_count


def test_a_reader_reaches_nothing_but_its_file(tmp_path, csv_file):
    secret = tmp_path / "secret.csv"
    secret.write_text("k\nv\n")
    con = duckdb.connect()
    from app.services.data.file_reader import confine_reader

    confine_reader(con, str(csv_file))
    assert con.execute(f"SELECT COUNT(*) FROM read_csv('{csv_file}')").fetchone()[0] == 1
    with pytest.raises(duckdb.Error):
        con.execute(f"SELECT * FROM read_csv('{secret}')")


@pytest.mark.parametrize("col_id", ['col_a"b', 'x": \'VARCHAR\'}); COPY (SELECT 1) TO \'/tmp/lk-audit-out.csv\' (FORMAT CSV); --'])
def test_a_column_id_stays_one_identifier(tmp_path, col_id):
    out = tmp_path / "rows"
    out.mkdir()
    path = dataset_rows.write_parquet([{col_id: "1"}], [{"id": col_id, "name": "n", "type": "string", "order": 0}], dir=out)
    assert duckdb.connect().execute(f"SELECT * FROM read_parquet('{path}')").fetchall() == [("1",)]
