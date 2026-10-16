"""Compute pushdown: run an app query on the external database itself.

DuckDB pushes filters and projections into an ATTACHed Postgres/MySQL/Doris
table, never aggregates: a `GROUP BY` over the warehouse pulls every row over
the wire and groups them here (24 s for 3.4 M rows on Doris, against 0.16 s
when Doris groups them — docs/planning/doris-plan.md §1.2). This module turns a
query the app wrote in DuckDB SQL into the external engine's own SQL, to be run
through the extension's passthrough function (`postgres_query` / `mysql_query`).

Only a portable subset is translated: a single SELECT made of the nodes in
`_ALLOWED`, with the typed rules of `_check_node` where a node's meaning depends
on its operands (a cast to text is the same for an integer, not for a double).
Types come from the remote catalogue, through the query's CTEs and subqueries.
Anything else raises `NotPortable` and the caller runs the query through the
ATTACH as before, so a query is never answered differently, only faster or
not. The subset is also what makes the passthrough safe: a tree of SELECT nodes
with no function outside the list cannot write, read a file or call into the
engine.
"""

from __future__ import annotations

import re
from collections.abc import Callable
from dataclasses import dataclass

import sqlglot
from sqlglot import exp
from sqlglot.optimizer.annotate_types import annotate_types
from sqlglot.optimizer.qualify import qualify

# Engine → sqlglot dialect of the SQL sent to it. MySQL is left out: its default
# collations compare text case-insensitively, so `x = 'abc'` would also match
# 'ABC' there and not in DuckDB.
_DIALECTS = {"postgresql": "postgres", "doris": "doris"}

# Engines whose queries are pushed down. Postgres is translated but not pushed:
# DuckDB's postgres scanner reads fast, and Postgres counts DISTINCT on one core
# — measured on 3.4 M local rows, a patient-count unit took 3.2 s pushed down
# against 0.5 s through the ATTACH. Doris won every unit (×3 to ×30).
PUSHDOWN_ENGINES = frozenset({"doris"})

_ALLOWED: tuple[type[exp.Expression], ...] = (
    exp.Select, exp.Union, exp.With, exp.CTE, exp.Subquery, exp.From, exp.Join,
    exp.Where, exp.Group, exp.Having, exp.Order, exp.Ordered, exp.Limit, exp.Offset,
    exp.Table, exp.TableAlias, exp.Alias, exp.Column, exp.Identifier, exp.Star,
    exp.Literal, exp.Null, exp.Boolean, exp.Paren, exp.Tuple, exp.Var,
    exp.Cast, exp.DataType,
    exp.EQ, exp.NEQ, exp.GT, exp.GTE, exp.LT, exp.LTE, exp.Is, exp.Not, exp.And, exp.Or,
    exp.In, exp.Between, exp.NullSafeEQ, exp.NullSafeNEQ,
    exp.Add, exp.Sub, exp.Mul, exp.Div, exp.Mod, exp.Neg, exp.Round,
    exp.Case, exp.If, exp.Coalesce, exp.Nullif, exp.Trim, exp.DPipe, exp.Like, exp.Lower, exp.Upper,
    exp.Count, exp.Sum, exp.Min, exp.Max, exp.Avg, exp.Distinct,
    exp.Window, exp.RowNumber, exp.Median, exp.PercentileCont,
    exp.Extract, exp.Year, exp.Quarter, exp.Month, exp.Day,
    exp.DateDiff, exp.Interval, exp.TimeToStr,
    # Admitted only in the shapes `_check_node` recognises and `_doris` rewrites.
    exp.Anonymous,
)

_AGGREGATES = (exp.Count, exp.Sum, exp.Min, exp.Max, exp.Avg)

T = exp.DataType.Type
_INTEGER = {T.TINYINT, T.SMALLINT, T.MEDIUMINT, T.INT, T.BIGINT, T.INT128, T.UTINYINT, T.USMALLINT, T.UMEDIUMINT, T.UINT, T.UBIGINT, T.UINT128}
_NUMERIC = _INTEGER | {T.FLOAT, T.DOUBLE, T.DECIMAL}
_TEXT = {T.VARCHAR, T.TEXT, T.CHAR, T.NCHAR, T.NVARCHAR}
_TEMPORAL = {T.DATE, T.DATETIME, T.TIMESTAMP, T.TIMESTAMPNTZ, T.TIMESTAMP_S, T.TIMESTAMP_MS, T.TIMESTAMP_NS}
_NULL = {T.NULL}

# What each cast target accepts, so that the value is the same on every engine:
# an integer or a date prints the same everywhere, a double or a timestamp not.
_CAST_FROM: dict[frozenset, set] = {
    frozenset(_NUMERIC): _NUMERIC | _NULL | {T.BOOLEAN},
    frozenset(_TEXT): _INTEGER | _TEXT | _NULL | {T.DATE},
    frozenset({T.DATE}): _TEMPORAL | _NULL,
    frozenset(_TEMPORAL - {T.DATE}): _TEMPORAL | _NULL,
}

_DATE_UNITS = {"YEAR", "QUARTER", "MONTH", "DAY"}
# `DATE '2020-01-01'` / `TIMESTAMP '2020-01-01 10:00:00'`: the one date spelling
# every engine reads alike. DuckDB also takes 'epoch', '2020-1-5' or a T
# separator, which Doris does not.
_ISO_DATETIME = re.compile(r"\d{4}-\d{2}-\d{2}( \d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?)?")
# STRFTIME formats whose tokens mean the same to MySQL's DATE_FORMAT.
_PORTABLE_TIME_FORMAT = re.compile(r"(%[Ymd]|[-/ ._:])*")

# The catalog's patient key (lib/data-catalog/perturbation.ts): md5_number_lower
# reads the md5's last 8 bytes little-endian; mod 2^32 keeps its first 4.
_KEY_SPACE = 2**32


class NotPortable(ValueError):
    """The query holds something whose meaning is DuckDB's own."""


@dataclass(frozen=True)
class RemoteQuery:
    sql: str
    # The result's column names as DuckDB would give them, in order: re-applied
    # by position, since an engine may name a column otherwise (Doris names a
    # grouped column after the base column it collapsed it into).
    columns: tuple[str, ...]


@dataclass(frozen=True)
class RemoteTable:
    """A table as the remote catalogue spells it, with its columns lower-cased
    and their types as SQL type names."""
    schema: str
    name: str
    columns: dict[str, str]


# `(schema, table)` → the remote table, or None when the database has no such
# table. `schema` is None for a bare name: the lookup applies the default schema.
TableLookup = Callable[[str | None, str], RemoteTable | None]


def dialect_of(engine: str) -> str | None:
    return _DIALECTS.get(engine)


# --- Rewrites to standard forms (any engine) ----------------------------------


def _unfilter(node: exp.Expression) -> exp.Expression:
    """`AGG(x) FILTER (WHERE c)` → `AGG(CASE WHEN c THEN x END)`: an aggregate
    skips the NULLs the CASE leaves for the rows outside the filter."""
    if not isinstance(node, exp.Filter) or not isinstance(node.this, _AGGREGATES):
        return node
    agg = node.this.copy()
    cond = node.expression.this
    target = agg.this
    distinct = isinstance(target, exp.Distinct)
    if distinct:
        if len(target.expressions) != 1:
            raise NotPortable("COUNT(DISTINCT a, b) with a filter")
        target = target.expressions[0]
    value = exp.Literal.number(1) if isinstance(target, exp.Star) or target is None else target
    case = exp.Case(ifs=[exp.If(this=cond.copy(), true=value.copy())])
    agg.set("this", exp.Distinct(expressions=[case]) if distinct else case)
    return agg


def _ungroup_all(node: exp.Expression) -> exp.Expression:
    """`GROUP BY ALL` → the non-aggregate select expressions, as DuckDB reads it."""
    if not isinstance(node, exp.Select):
        return node
    group = node.args.get("group")
    if not group or not group.args.get("all"):
        return node
    keys = [
        (e.this if isinstance(e, exp.Alias) else e).copy()
        for e in node.expressions
        if not e.find(*_AGGREGATES)
    ]
    node.set("group", exp.Group(expressions=keys) if keys else None)
    return node


def _within_group(node: exp.Expression) -> exp.Expression:
    """`PERCENTILE_CONT(p) WITHIN GROUP (ORDER BY x)` → `QUANTILE_CONT(x, p)`."""
    if not isinstance(node, exp.WithinGroup) or not isinstance(node.this, exp.PercentileCont):
        return node
    order = node.expression.expressions if isinstance(node.expression, exp.Order) else []
    if len(order) != 1 or order[0].args.get("desc"):
        raise NotPortable("WITHIN GROUP")
    return exp.PercentileCont(this=order[0].this.copy(), expression=node.this.this.copy())


def _unnest_pair(node: exp.Expression) -> exp.Expression:
    """`SELECT UNNEST(CASE WHEN c THEN [a, b] ELSE [a] END) AS x, … FROM t` → the
    rows naming `a`, then those naming `b` where `c`: one row per id named. Lists
    are DuckDB's; a second scan of a columnar table is cheap next to a transfer."""
    if not isinstance(node, exp.Select):
        return node
    unnested = [
        i for i, e in enumerate(node.expressions)
        if isinstance(e, exp.Alias) and isinstance(e.this, exp.Explode)
    ]
    if not unnested:
        return node
    case = node.expressions[unnested[0]].this.this
    ifs = case.args.get("ifs") if isinstance(case, exp.Case) else None
    default = case.args.get("default") if isinstance(case, exp.Case) else None
    pair = ifs[0].args.get("true") if ifs and len(ifs) == 1 else None
    if (
        len(unnested) != 1 or node.args.get("group") or any(e.find(*_AGGREGATES) for e in node.expressions)
        or not isinstance(pair, exp.Array) or len(pair.expressions) != 2
        or not isinstance(default, exp.Array) or len(default.expressions) != 1
        or pair.expressions[0] != default.expressions[0]
    ):
        raise NotPortable("UNNEST")
    i, alias = unnested[0], node.expressions[unnested[0]].alias

    def naming(value: exp.Expression, condition: exp.Expression | None) -> exp.Select:
        select = node.copy()
        select.expressions[i] = exp.alias_(value.copy(), alias)
        return select.where(condition.copy()) if condition is not None else select

    first, second = pair.expressions
    return exp.union(naming(first, None), naming(second, ifs[0].this), distinct=False)


def _date_part(node: exp.Expression) -> exp.Expression:
    """`DATE_PART('year', x)` → `EXTRACT(YEAR FROM x)`, the standard spelling."""
    if not (isinstance(node, exp.Anonymous) and node.name.lower() == "date_part"):
        return node
    args = node.expressions
    if len(args) != 2 or not (isinstance(args[0], exp.Literal) and args[0].is_string):
        raise NotPortable("DATE_PART")
    return exp.Extract(this=exp.var(args[0].this.upper()), expression=args[1].copy())


def _unpad(lookup: TableLookup) -> Callable[[exp.Expression], exp.Expression]:
    """The class relations read a table as
    `(SELECT * FROM t UNION ALL BY NAME SELECT NULL AS "c", … WHERE false) e`,
    so a mapped column the table lacks reads as NULL. `BY NAME` is DuckDB's:
    rewrite it as `(SELECT c, NULL AS d FROM t) e` from the table's real columns —
    or, for a relation's hand-written SQL (`FROM (<sql>) _src`), from the columns
    that SQL names."""

    def transform(node: exp.Expression) -> exp.Expression:
        if not isinstance(node, exp.Subquery) or not isinstance(node.this, exp.Union):
            return node
        union = node.this
        if not union.args.get("by_name"):
            return node
        left, right = union.this, union.expression
        where = right.args.get("where") if isinstance(right, exp.Select) else None
        is_padding = (
            isinstance(left, exp.Select)
            and len(left.expressions) == 1 and isinstance(left.expressions[0], exp.Star)
            and isinstance(left.args.get("from_"), exp.From)
            and isinstance(left.args["from_"].this, (exp.Table, exp.Subquery))
            and where is not None and isinstance(where.this, exp.Boolean) and where.this.this is False
            and all(isinstance(e, exp.Alias) and isinstance(e.this, exp.Null) for e in right.expressions)
        )
        if not is_padding:
            raise NotPortable("UNION BY NAME")
        table = left.args["from_"].this
        if isinstance(table, exp.Subquery):
            present = {name.lower() for name in _output_names(table.this)}
        else:
            remote = lookup(table.text("db") or None, table.name)
            if remote is None:
                raise NotPortable(f"unknown columns of {table.name}")
            present = remote.columns
        projection = [
            exp.column(e.alias, quoted=True) if e.alias.lower() in present
            else exp.alias_(exp.Null(), e.alias, quoted=True)
            for e in right.expressions
        ]
        select = exp.select(*projection).from_(table.copy())
        return exp.Subquery(this=select, alias=node.args.get("alias"))

    return transform


def _scope_tables(tree: exp.Expression, lookup: TableLookup) -> list[RemoteTable]:
    """Drop the ATTACH's catalog (`ext.<schema>.t`), put every base table read in
    its remote schema — the default one for a bare name — and list them. A table
    in another catalog, or one the remote catalogue lacks, is not ours to read."""
    ctes = {cte.alias_or_name.lower() for cte in tree.find_all(exp.CTE)}
    found: list[RemoteTable] = []
    for table in tree.find_all(exp.Table):
        db, catalog = table.text("db"), table.text("catalog")
        if not db and table.name.lower() in ctes:
            continue
        if catalog and catalog.lower() != "ext":
            raise NotPortable(f"table in catalog {catalog}")
        if not table.name:
            raise NotPortable("a table function")
        remote = lookup(db or None, table.name)
        if remote is None:
            raise NotPortable(f"unknown table {db + '.' if db else ''}{table.name}")
        table.set("catalog", None)
        table.set("db", exp.to_identifier(remote.schema))
        found.append(remote)
    return found


def _require_named_columns(tree: exp.Expression) -> None:
    """The result's column names are read by the caller: an unnamed expression is
    named by each engine its own way (`count_star()` in DuckDB)."""
    select = tree
    while isinstance(select, exp.Union):
        select = select.this
    if not isinstance(select, exp.Select):
        raise NotPortable("not a SELECT")
    for column in select.expressions:
        if not isinstance(column, (exp.Alias, exp.Column, exp.Star)):
            raise NotPortable("an unnamed result column")


# --- Types and the portable subset -------------------------------------------


def _typed(tree: exp.Expression, tables: list[RemoteTable]) -> exp.Expression:
    """The tree with every column qualified and every expression typed, from the
    remote catalogue: what the typed rules read."""
    schema: dict[str, dict[str, dict[str, str]]] = {}
    for table in tables:
        schema.setdefault(table.schema, {})[table.name] = table.columns
    try:
        tree = qualify(tree, schema=schema, dialect="duckdb", validate_qualify_columns=True)
        return annotate_types(tree, schema=schema, dialect="duckdb")
    except Exception as exc:  # anything the optimizer cannot type stays local
        raise NotPortable(f"untyped: {exc}") from exc


def _type(node: exp.Expression | None) -> T:
    return node.type.this if node is not None and node.type is not None else T.UNKNOWN


def _is_iso_literal(node: exp.Expression) -> bool:
    return isinstance(node, exp.Literal) and node.is_string and _ISO_DATETIME.fullmatch(node.this) is not None


def _is_patient_key(node: exp.Expression, typed: bool = True) -> bool:
    """`md5_number_lower(x) % 2^32`, x text: the catalog's patient key."""
    return (
        isinstance(node, exp.Mod)
        and isinstance(node.this, exp.Anonymous) and node.this.name.lower() == "md5_number_lower"
        and len(node.this.expressions) == 1
        and (not typed or _type(node.this.expressions[0]) in _TEXT)
        and isinstance(node.expression, exp.Literal) and node.expression.this == str(_KEY_SPACE)
    )


def _typed_patient_key(node: exp.Expression) -> exp.Expression:
    """A patient key as a BIGINT (it is below 2^32): the type checker cannot see
    through md5_number_lower, and the sums and casts around the key need one."""
    if _is_patient_key(node, typed=False) and not isinstance(node.parent, exp.Cast):
        return exp.cast(node.copy(), exp.DataType.build("BIGINT"))
    return node


def _is_age_years(node: exp.Expression) -> bool:
    """`EXTRACT(YEAR FROM AGE(a, b))`: whole years from b to a."""
    age = node.expression if isinstance(node, exp.Extract) else None
    return (
        isinstance(age, exp.Anonymous) and age.name.lower() == "age"
        and node.this.name.upper() == "YEAR" and len(age.expressions) == 2
        and all(_type(a) in _TEMPORAL for a in age.expressions)
    )


def _check_node(node: exp.Expression) -> None:
    if isinstance(node, exp.Union) and node.args.get("by_name"):
        raise NotPortable("UNION BY NAME")
    if isinstance(node, exp.Group) and node.args.get("all"):
        raise NotPortable("GROUP BY ALL")
    if isinstance(node, exp.Tuple) and not isinstance(node.parent, exp.In):
        # COUNT(DISTINCT (a, b)) counts NULL members in DuckDB, skips them elsewhere.
        raise NotPortable("row value")
    if isinstance(node, exp.Cast):
        if _is_patient_key(node.this) and node.to.this in _INTEGER:
            return
        # A NULL is one whatever its type: the typed blank of a column a query
        # leaves empty (the concept list's counts before any count).
        if isinstance(node.this, exp.Null):
            return
        target, source = node.to.this, _type(node.this)
        if target in _TEMPORAL and _is_iso_literal(node.this):
            return
        accepted = next((ok for targets, ok in _CAST_FROM.items() if target in targets), None)
        if accepted is None or source not in accepted:
            raise NotPortable(f"CAST {source.value} to {target.value}")
    elif isinstance(node, (exp.Year, exp.Quarter, exp.Month, exp.Day)):
        if _type(node.this) not in _TEMPORAL:
            raise NotPortable(f"{type(node).__name__} of a non-date")
    elif isinstance(node, exp.Extract):
        if _is_age_years(node):
            return
        if node.this.name.upper() not in _DATE_UNITS or _type(node.expression) not in _TEMPORAL:
            raise NotPortable("EXTRACT")
    elif isinstance(node, exp.DateDiff):
        unit = node.args.get("unit")
        if not unit or unit.name.upper() != "DAY" or not all(_type(a) in _TEMPORAL for a in (node.this, node.expression)):
            raise NotPortable("DATE_DIFF")
    elif isinstance(node, exp.Interval):
        unit = node.args.get("unit")
        amount = node.this
        if (not unit or unit.name.upper().rstrip("S") not in _DATE_UNITS
                or not isinstance(amount, exp.Literal) or not amount.this.isdigit()):
            raise NotPortable("INTERVAL")
        if not isinstance(node.parent, (exp.Add, exp.Sub)) or _type(node.parent.this) not in _TEMPORAL:
            raise NotPortable("INTERVAL off a date")
    elif isinstance(node, exp.TimeToStr):
        fmt = node.args.get("format")
        if _type(node.this) not in _TEMPORAL or not isinstance(fmt, exp.Literal) or not _PORTABLE_TIME_FORMAT.fullmatch(fmt.this):
            raise NotPortable("STRFTIME")
    elif isinstance(node, exp.Like):
        # Doris reads `\` in a pattern as an escape, DuckDB as a character.
        pattern = node.expression
        if (_type(node.this) not in _TEXT or not isinstance(pattern, exp.Literal) or not pattern.is_string
                or "\\" in pattern.this):
            raise NotPortable("LIKE")
    elif isinstance(node, (exp.Lower, exp.Upper)):
        if _type(node.this) not in _TEXT:
            raise NotPortable(f"{type(node).__name__} of a non-text")
    elif isinstance(node, exp.Trim):
        if node.args.get("expression") is not None or node.args.get("position"):
            raise NotPortable("TRIM of other characters")
    elif isinstance(node, exp.Mod):
        if not _is_patient_key(node) and not (_type(node.this) in _INTEGER and _type(node.expression) in _INTEGER):
            raise NotPortable("modulo")
    elif isinstance(node, exp.Div):
        if not (_type(node.this) in _NUMERIC and _type(node.expression) in _NUMERIC):
            raise NotPortable("division")
    elif isinstance(node, exp.Window):
        if node.args.get("spec") is not None:
            raise NotPortable("window frame")
    elif isinstance(node, (exp.Median, exp.PercentileCont)):
        # Interpolated alike on an integer or a double; DuckDB keeps a decimal's scale.
        if _type(node.this) not in _INTEGER | {T.DOUBLE, T.FLOAT}:
            raise NotPortable("percentile of a non-number")
        fraction = node.args.get("expression")
        if isinstance(node, exp.PercentileCont) and not (
            isinstance(fraction, exp.Literal) and fraction.is_number and 0 <= float(fraction.this) <= 1
        ):
            raise NotPortable("percentile at other than one fraction")
    elif isinstance(node, exp.Anonymous):
        parent = node.parent
        if not ((node.name.lower() == "md5_number_lower" and _is_patient_key(parent))
                or (node.name.lower() == "age" and isinstance(parent, exp.Extract) and _is_age_years(parent))):
            raise NotPortable(f"function {node.name}")


def _check_portable(tree: exp.Expression) -> None:
    for node in tree.walk():
        if not isinstance(node, _ALLOWED):
            raise NotPortable(type(node).__name__)
        _check_node(node)


# --- Doris spellings ----------------------------------------------------------


def _hex_byte(md5: exp.Expression, at: int) -> exp.Expression:
    return exp.Substring(this=md5.copy(), start=exp.Literal.number(at), length=exp.Literal.number(2))


def _doris(node: exp.Expression) -> exp.Expression:
    """The DuckDB functions the typed rules admit, in Doris' own terms."""
    if isinstance(node, exp.Median):
        return exp.Anonymous(this="PERCENTILE", expressions=[node.this.copy(), exp.Literal.number(0.5)])
    if isinstance(node, exp.PercentileCont):
        return exp.Anonymous(this="PERCENTILE", expressions=[node.this.copy(), node.expression.copy()])
    if isinstance(node, exp.Mod) and _is_patient_key(node):
        md5 = exp.MD5(this=node.this.expressions[0].copy())
        # Bytes 8..11 of the digest (hex 17..24), least significant first.
        hex_le = exp.Concat(expressions=[_hex_byte(md5, at) for at in (23, 21, 19, 17)])
        conv = exp.Anonymous(this="CONV", expressions=[hex_le, exp.Literal.number(16), exp.Literal.number(10)])
        return exp.cast(conv, exp.DataType.build("BIGINT"))
    if isinstance(node, exp.Extract) and _is_age_years(node):
        later, earlier = (a.copy() for a in node.expression.expressions)
        return exp.Anonymous(this="TIMESTAMPDIFF", expressions=[exp.var("YEAR"), earlier, later])
    return node


def _output_names(tree: exp.Expression) -> tuple[str, ...]:
    select = tree
    while isinstance(select, exp.Union):
        select = select.this
    names = tuple(e.alias_or_name for e in select.expressions)
    if any(isinstance(e, exp.Star) for e in select.expressions) or len({n.lower() for n in names}) != len(names):
        raise NotPortable("result columns not named one by one")
    return names


def to_remote(sql: str, engine: str, lookup: TableLookup) -> RemoteQuery:
    """`sql` (DuckDB) as the remote engine's SQL, or `NotPortable`.

    `lookup` resolves each table the query reads (TableLookup), so a query may
    join tables of several schemas of the database."""
    dialect = dialect_of(engine)
    if dialect is None:
        raise NotPortable(f"no pushdown for {engine}")
    try:
        statements = sqlglot.parse(sql, read="duckdb")
    except sqlglot.errors.SqlglotError as exc:
        raise NotPortable(f"unparsed: {exc}") from exc
    statements = [s for s in statements if s is not None]
    if len(statements) != 1 or not isinstance(statements[0], (exp.Select, exp.Union)):
        raise NotPortable("not a single SELECT")
    tree = statements[0]
    for cte in tree.find_all(exp.CTE):
        cte.set("materialized", None)
    tree = (
        tree.transform(_unpad(lookup))
        .transform(_unfilter)
        .transform(_ungroup_all)
        .transform(_unnest_pair)
        .transform(_date_part)
        .transform(_within_group)
        .transform(_typed_patient_key)
    )
    _require_named_columns(tree)
    tables = _scope_tables(tree, lookup)
    tree = _typed(tree, tables)
    _check_portable(tree)
    names = _output_names(tree)
    if engine == "doris":
        tree = tree.transform(_doris)
    elif any(isinstance(n, (exp.Anonymous, exp.Median, exp.PercentileCont)) for n in tree.walk()):
        raise NotPortable("no spelling of a DuckDB function")
    # qualify lower-cases every name (DuckDB's are case-insensitive); the remote
    # catalogue's spelling is put back, since Doris and Postgres names are not.
    spelled = {(t.schema.lower(), t.name.lower()): t for t in tables}
    for table in tree.find_all(exp.Table):
        remote = spelled.get((table.text("db").lower(), table.name.lower())) if table.args.get("db") else None
        if remote is not None:
            table.set("db", exp.to_identifier(remote.schema, quoted=True))
            table.set("this", exp.to_identifier(remote.name, quoted=True))
    return RemoteQuery(tree.sql(dialect=dialect), names)
