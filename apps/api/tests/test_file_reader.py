"""Read-expression building for uploaded blobs (file_reader).

Covers the CSV encoding handling added when dataset preview/import moved fully
server-side: the dialog's encoding labels must map to tokens DuckDB accepts, and
Windows-1252 (which DuckDB's CSV reader can't handle) must be flagged for a
Python transcode upstream instead of being passed through."""

import duckdb

from app.services.data.file_reader import build_read_expr, python_decode_codec


def _con():
    return duckdb.connect()


def test_utf8_encoding_is_not_emitted():
    # UTF-8 is the reader default — no need to clutter the expression with it.
    expr = build_read_expr(_con(), "/tmp/x.csv", "x.csv", {"encoding": "UTF-8"})
    assert "encoding" not in expr


def test_iso_8859_1_maps_to_latin1():
    expr = build_read_expr(_con(), "/tmp/x.csv", "x.csv", {"encoding": "ISO-8859-1"})
    assert "encoding='latin-1'" in expr


def test_windows_1252_transcoded_then_read_as_utf8(tmp_path):
    # DuckDB's reader has no windows-1252 token; the blob is transcoded to UTF-8
    # in Python first and the expression reads that temp file (never the default
    # encoding token). Curly-quote 0x93/0x94 and € 0x80 round-trip correctly.
    src = tmp_path / "w1252.csv"
    # Raw cp1252 bytes: 0x93/0x94 = curly quotes, 0x80 = euro sign.
    src.write_bytes(b"a\n\x93hi\x94 \x80\n")
    con = _con()
    expr = build_read_expr(con, str(src), "w1252.csv", {"encoding": "Windows-1252"})
    # Reads a transcoded temp, not the original path, and not with a bogus token.
    assert str(src) not in expr
    assert "Windows-1252" not in expr
    val = con.execute(f"SELECT a FROM {expr}").fetchone()[0]
    assert val == "“hi” €"


def test_transcoded_temp_is_cleaned_up(tmp_path):
    # The UTF-8 temp created for a cp1252 read must not accumulate on the server.
    import os
    from app.services.data.file_reader import cleanup_transcoded

    src = tmp_path / "w1252.csv"
    src.write_bytes(b"a\n\x93hi\x94\n")
    con = _con()
    expr = build_read_expr(con, str(src), "w1252.csv", {"encoding": "Windows-1252"})
    tmp_path_read = expr.split("'")[1]  # the transcoded temp inside read_csv('...')
    assert os.path.exists(tmp_path_read)
    con.execute(f"SELECT a FROM {expr}").fetchall()
    cleanup_transcoded(con)
    assert not os.path.exists(tmp_path_read)


def test_python_decode_codec_only_for_windows_1252():
    assert python_decode_codec("Windows-1252") == "cp1252"
    assert python_decode_codec("ISO-8859-1") is None
    assert python_decode_codec("UTF-8") is None
    assert python_decode_codec(None) is None


def test_delimiter_and_skip_still_emitted():
    expr = build_read_expr(
        _con(), "/tmp/x.csv", "x.csv", {"delimiter": ";", "skipRows": 2}
    )
    assert "delim=';'" in expr
    assert "skip=2" in expr
