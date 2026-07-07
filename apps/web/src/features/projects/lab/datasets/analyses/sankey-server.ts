import type { DatasetColumn } from '@/types'

/**
 * Build the pandas code that aggregates the Sankey flows→links server-side and
 * prints the same {nodes, links, total, error} the client computes from rows.
 * Pure counting (no stats libs): reconstruct flows (long/levels/path), count
 * depth-keyed transitions, index nodes, apply min/max link filters. The d3-sankey
 * layout + rendering stay client-side. Parity with the useMemo in SankeyComponent.
 */
export function buildSankeyCode(columns: DatasetColumn[], config: Record<string, unknown>): string {
  const byId = new Map(columns.map((c) => [c.id, c]))
  const name = (id: unknown): string | null => (typeof id === 'string' ? byId.get(id)?.name ?? null : null)

  const sourceMode = (config.sourceMode as string) ?? 'long'
  const spec = {
    sourceMode,
    entity: name(config.entityColumn),
    stage: name(config.stageColumn),
    order: name(config.orderColumn),
    levels: ((config.levelColumns as string[]) ?? []).map((id) => byId.get(id)?.name).filter((n): n is string => !!n),
    path: name(config.pathColumn),
    pathSeparator: (config.pathSeparator as string) ?? ';',
    collapseRepeats: (config.collapseRepeats as boolean) ?? true,
    excludeNA: (config.excludeNA as boolean) ?? true,
    alignEndStates: (config.alignEndStates as boolean) ?? false,
    endNode: ((config.addEndNode as string) ?? '').trim(),
    minLinkValue: Math.max(1, (config.minLinkValue as number) ?? 1),
    maxLinkValue: Math.max(0, (config.maxLinkValue as number) ?? 0),
  }
  const specStr = JSON.stringify(JSON.stringify(spec))
  return `${_SANKEY_PY}\n_linkr_print_sankey(dataset, _json.loads(${specStr}))\n`
}

const _SANKEY_PY = String.raw`
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
`
