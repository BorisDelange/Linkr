"""Sankey render: server-owned pandas program + spec validation.

The `_SANKEY_PY` body is ported verbatim from the frontend sankey-server.ts
(`_SANKEY_PY`) — it must stay in parity with the useMemo in SankeyComponent.tsx.
Only the spec (resolved column names + flow options) varies per request.
"""

import json


def validate_spec(spec: dict) -> dict:
    """Coerce + validate the client spec into the shape _SANKEY_PY expects:
    {sourceMode, entity, stage, order, levels, path, pathSeparator,
     collapseRepeats, excludeNA, alignEndStates, endNode,
     minLinkValue, maxLinkValue}. Raises ValueError on a malformed spec so the
    route returns a clean 400."""
    if not isinstance(spec, dict):
        raise ValueError("sankey spec must be an object")

    def opt_str(key: str) -> str | None:
        v = spec.get(key)
        if v is None:
            return None
        if not isinstance(v, str):
            raise ValueError(f"sankey spec.{key} must be a string or null")
        return v

    def num(key: str, default: float) -> float:
        v = spec.get(key, default)
        if isinstance(v, bool) or not isinstance(v, (int, float)):
            raise ValueError(f"sankey spec.{key} must be a number")
        return v

    source_mode = spec.get("sourceMode")
    if not isinstance(source_mode, str):
        raise ValueError("sankey spec.sourceMode must be a string")

    raw_levels = spec.get("levels") or []
    if not isinstance(raw_levels, list):
        raise ValueError("sankey spec.levels must be a list")
    levels = []
    for c in raw_levels:
        if not isinstance(c, str):
            raise ValueError("sankey spec.levels entries must be strings")
        levels.append(c)

    path_separator = spec.get("pathSeparator", ";")
    if not isinstance(path_separator, str):
        raise ValueError("sankey spec.pathSeparator must be a string")
    end_node = spec.get("endNode", "")
    if not isinstance(end_node, str):
        raise ValueError("sankey spec.endNode must be a string")

    return {
        "sourceMode": source_mode,
        "entity": opt_str("entity"),
        "stage": opt_str("stage"),
        "order": opt_str("order"),
        "levels": levels,
        "path": opt_str("path"),
        "pathSeparator": path_separator,
        "collapseRepeats": bool(spec.get("collapseRepeats", True)),
        "excludeNA": bool(spec.get("excludeNA", True)),
        "alignEndStates": bool(spec.get("alignEndStates", False)),
        "endNode": end_node,
        "minLinkValue": num("minLinkValue", 1),
        "maxLinkValue": num("maxLinkValue", 0),
    }


def build_code(spec: dict) -> str:
    # Embed the spec as a JSON string parsed at runtime — a JSON object literal
    # isn't valid Python (true/false/null), so json.loads() is required.
    embedded = json.dumps(json.dumps(spec))
    return f"{_SANKEY_PY}\n_linkr_print_sankey(dataset, _json.loads({embedded}))\n"


_SANKEY_PY = r"""
import json as _json
import math as _math

_TERMINAL_DEPTH = 1000000

def _sk_empty(v):
    if v is None:
        return True
    s = str(v).strip().lower()
    return s in ("", "na", "nan", "null", "none")

def _flows_from_long(df, entity, stage, order, exclude_na):
    import pandas as _pd
    groups = {}
    seq = 0
    for _, row in df.iterrows():
        e = row[entity]
        if e is None or (isinstance(e, float) and _math.isnan(e)):
            continue
        sv = row[stage]
        if exclude_na and _sk_empty(sv):
            continue
        stage_s = str(sv) if sv is not None else ""
        o = seq
        if order and order in df.columns:
            raw = row[order]
            try:
                o = float(raw)
            except Exception:
                ts = _pd.to_datetime(str(raw), errors="coerce")
                o = ts.value if not _pd.isna(ts) else seq
        groups.setdefault(e, []).append((stage_s, o, seq))
        seq += 1
    flows = []
    for lst in groups.values():
        lst.sort(key=lambda x: (x[1], x[2]))
        flows.append([s[0] for s in lst])
    return flows

def _flows_from_levels(df, level_cols, exclude_na):
    flows = []
    for _, row in df.iterrows():
        steps = []
        for c in level_cols:
            v = row[c]
            if exclude_na and _sk_empty(v):
                continue
            steps.append(str(v) if v is not None else "")
        if steps:
            flows.append(steps)
    return flows

def _flows_from_path(df, path_col, sep, exclude_na):
    sep = sep or ";"
    flows = []
    for _, row in df.iterrows():
        raw = row[path_col]
        if _sk_empty(raw):
            continue
        steps = [s.strip() for s in str(raw).split(sep)]
        if exclude_na:
            steps = [s for s in steps if not _sk_empty(s)]
        if steps:
            flows.append(steps)
    return flows

def _build_links(flows, collapse_repeats, align_end_states):
    counts = {}
    for flow in flows:
        steps = flow
        if collapse_repeats:
            steps = [s for i, s in enumerate(flow) if i == 0 or s != flow[i - 1]]
        for i in range(len(steps) - 1):
            is_last = i + 2 == len(steps)
            target_depth = _TERMINAL_DEPTH if (align_end_states and is_last) else i + 1
            key = (i, target_depth, steps[i], steps[i + 1])
            counts[key] = counts.get(key, 0) + 1
    out = []
    for (sd, td, sl, tl), v in counts.items():
        out.append({"source": {"label": sl, "depth": sd}, "target": {"label": tl, "depth": td}, "value": v})
    return out

def _linkr_print_sankey(dataset, spec):
    df = dataset
    mode = spec["sourceMode"]
    exclude_na = spec.get("excludeNA", True)

    if mode == "long":
        entity = spec.get("entity"); stage = spec.get("stage")
        if not entity or not stage or entity not in df.columns or stage not in df.columns:
            print(_json.dumps({"nodes": [], "links": [], "total": 0, "error": "missing"})); return
        flows = _flows_from_long(df, entity, stage, spec.get("order"), exclude_na)
    elif mode == "levels":
        levels = [c for c in (spec.get("levels") or []) if c in df.columns]
        if len(levels) < 2:
            print(_json.dumps({"nodes": [], "links": [], "total": 0, "error": "missing"})); return
        flows = _flows_from_levels(df, levels, exclude_na)
    else:
        path = spec.get("path")
        if not path or path not in df.columns:
            print(_json.dumps({"nodes": [], "links": [], "total": 0, "error": "missing"})); return
        flows = _flows_from_path(df, path, spec.get("pathSeparator", ";"), exclude_na)

    end_node = spec.get("endNode", "")
    if end_node:
        flows = [f + [end_node] if len(f) > 0 else f for f in flows]

    link_counts = _build_links(flows, spec.get("collapseRepeats", True), spec.get("alignEndStates", False))

    min_link = spec.get("minLinkValue", 1)
    max_link = spec.get("maxLinkValue", 0)

    index_of = {}
    node_list = []
    link_list = []
    total = 0

    def node_index(n):
        key = "%d\t%s" % (n["depth"], n["label"])
        i = index_of.get(key)
        if i is None:
            i = len(node_list)
            index_of[key] = i
            node_list.append({"name": key, "label": n["label"]})
        return i

    source_keys = set("%d\t%s" % (l["source"]["depth"], l["source"]["label"]) for l in link_counts)
    for lc in link_counts:
        source = lc["source"]; target = lc["target"]; value = lc["value"]
        if value < min_link:
            continue
        is_entry = source["depth"] == 0
        is_exit = ("%d\t%s" % (target["depth"], target["label"])) not in source_keys
        if max_link > 0 and value > max_link and not is_entry and not is_exit:
            continue
        link_list.append({"source": node_index(source), "target": node_index(target), "value": value})
        total += value

    print(_json.dumps({"nodes": node_list, "links": link_list, "total": total, "error": None}))
"""
