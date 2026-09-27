/*
 * The catalog explorer: which charts, figures and table show a crossing, and
 * the SVG charts themselves, for the standalone page: export-html-script.ts
 * inlines this file ahead of catalog-page.js, the page's glue.
 *
 * Plain ES5 inside the functions: the page runs in any browser with no build.
 *
 * The data is a published catalog (lib/data-catalog/publish.ts): variables
 * with their modalities, and crossings as cells [index per variable…,
 * patients, each of the crossing's `measures`…, status]. The page gets masked cells without their
 * numbers; the app's preview gets them with (`reveal`), to show what the masks hide.
 *
 * Reading rules:
 * - The reader picks a computed crossing (one, two or three variables) and
 *   filters each of its variables. Cells shown always come from one crossing,
 *   never a sum of cells: a patient counted in 2023 and in 2024 is one patient,
 *   not two, and a masked cell cannot be added to anything.
 * - A variable filtered down to one value becomes context ("Sex: Female")
 *   rather than an axis, so a period × sex crossing narrowed to women draws
 *   the curve of women.
 * - Charts show two variables at most: a three-variable crossing shows its
 *   cells one value of a third variable at a time ("pinned"), or all of them
 *   when the crossing of the other two exists.
 */

/** English texts, keys shared with the app's `data_catalog.xp.*` translations. Placeholders: {name}. */
var EXPLORE_TEXT = {
  patients: 'Patients', stays: 'Hospitalizations', unit_stays: 'Unit stays', records: 'Records', concepts: 'Concepts', categories: 'Categories',
  kpi_of: 'of {total}', kpi_unfiltered: 'Whole warehouse: this view does not count them',
  kpi_not_additive: 'Cannot be added up across {things}',
  published_concepts_only: 'published concepts only',
  title_by: '{unit} by {vars}',
  over_time: '{unit} over time', per_unit: '{unit} per {unit2}', age_distribution: 'Age distribution',
  by_var: '{unit} by {var}', top_n: 'Top {n} {things}', n_of_m: '{n} of {m}', share_of: 'Share of {unit}',
  pct_of_patients: '% of all patients', share: 'Share', others: 'Others',
  shares_left_out: 'Shares of the published values; {n} masked value(s) left out.',
  overlap_note: 'A patient can fall in several {things} (one per stay), so these shares add up to more than 100%.',
  over_time_by: '{unit} over time by {var}', largest_of: 'the {n} largest of {m}', composition_over_time: 'Composition over time',
  composition_note: 'Share of each {var} among the published values of each {unit}.',
  by_two: '{unit} by {a} and {b}', within_each: '{a} within each {b}', composition_masked_note: 'Shares among the published values; masked cells are left out.',
  grouped_note: 'Side by side, not stacked: one patient can count in several {things}.',
  age_pyramid: 'Age pyramid', male: 'Male', female: 'Female',
  all_margin_note: '"All" cells are the published totals over every {var}, filters aside.',
  all_things: 'All {things}', row_max: 'row max', max: 'max', scale_label: 'Colour scale:', per_row: 'Each row', whole_table: 'Whole table',
  per_row_tip: 'Each row is shaded against its own largest cell: compares the values within a row, whatever its size.',
  whole_table_tip: 'Every cell is shaded against the largest cell of the table: compares all the cells with one another.',
  hatched_note: '{n} masked value(s) drawn hatched, at most {t} high.',
  mask_primary: 'Fewer than {t} patients — masked', mask_secondary: 'Masked to protect a small cell nearby (secondary suppression)',
  mask_absent: 'Fewer than {t} patients', mask_secondary_short: 'masked', mask_value: '{v} (masked)',
  records_by_category: 'Records by category', concepts_per_category: 'Concepts per category', uncategorised: 'Uncategorised',
  top_concepts: 'Top concepts', not_computed: 'This combination was not computed.', nothing_matches: 'Nothing matches these filters.',
  below_masked: '< {t}: fewer than {t} patients · masked: hidden so that a small cell cannot be worked out by subtraction', search_concepts: 'Search concepts…', no_concept_matches: 'No concept matches these filters.',
  cell: 'cell', cells_noun: 'cells', concept: 'concept', concepts_noun: 'concepts',
  thing_concept: 'concepts', thing_period: 'periods', thing_service: 'services',
  thing_age: 'age groups', thing_sex: 'genders', download_csv: 'Download as CSV', top: 'Top {n}',
  g_year: 'year', g_quarter: 'quarter', g_month: 'month', g_years: '{n} years', g_quarters: '{n} quarters', g_months: '{n} months',
}

var ORDER = ['concept', 'period', 'service', 'age', 'sex'];
var PALETTE = ['#0084d8', '#14b8a6', '#f59e0b', '#e11d48', '#8b5cf6', '#22c55e', '#f97316', '#0ea5e9', '#a855f7', '#64748b', '#84cc16', '#ec4899'];
var OTHERS_COLOR = '#94a3b8';
// Sex keeps the same colours in every chart, so a reader never has to re-learn them.
var SEX_COLOR = { male: PALETTE[0], female: PALETTE[1], other: PALETTE[2] };
/** Each variable's own hue, as in the app's badges (lib/data-catalog/variable-colors.ts). */
var VARIABLE_HEX = { concept: '#8b5cf6', period: '#0284c7', service: '#0d9488', age: '#d97706', sex: '#db2777' };

function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function keyOf(vars) { return ORDER.filter(function(v) { return vars.indexOf(v) !== -1; }).join('-'); }
function slug(s) { return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'table'; }
function uniqueSorted(values) {
  var seen = {}, out = [];
  values.forEach(function(v) { if (v != null && v !== '' && !seen[v]) { seen[v] = true; out.push(String(v)); } });
  return out.sort(function(a, b) { return a.localeCompare(b, 'en', { numeric: true }); });
}
function fuzzy(needle, hay) {
  if (hay.indexOf(needle) !== -1) return true;
  var n = 0;
  for (var k = 0; k < hay.length && n < needle.length; k++) if (hay[k] === needle[n]) n++;
  return n === needle.length;
}
function csvCell(v) {
  var s = v == null ? '' : String(v);
  return /[",\r\n]/.test(s) || s !== s.trim() ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function csvText(lines) { return lines.map(function(l) { return l.map(csvCell).join(','); }).join('\r\n') + '\r\n'; }

/**
 * An explorer over one published catalog.
 * opts: { reveal?: masked cells carry their numbers, text?: EXPLORE_TEXT overrides,
 *         locale?: number formatting, dark?: () => boolean, fileBase?: CSV name prefix,
 *         conceptNote?: trusted HTML for the concept list }
 */
function createExplorer(DATA, opts) {
  opts = opts || {};
  var TEXT = {};
  Object.keys(EXPLORE_TEXT).forEach(function(k) { TEXT[k] = (opts.text && opts.text[k]) || EXPLORE_TEXT[k]; });
  function tr(key, vars) {
    return String(TEXT[key] || key).replace(/\{(\w+)\}/g, function(m, name) { return vars && name in vars ? vars[name] : m; });
  }
  var locale = opts.locale || 'en';
  function fmt(n) { return Number(n).toLocaleString(locale); }
  var T = DATA.threshold;
  var V = DATA.variables;
  var X = {};
  DATA.crossings.forEach(function(c) { X[c.id] = c; });
  var LIST = DATA.concepts || { cols: [], rows: [] };
  var hasList = LIST.rows.length > 0;
  var MEASURE = { patients: tr('patients'), stays: tr('stays'), unit_stays: tr('unit_stays'), records: tr('records') };
  var MASK_TEXT = { 1: '< ' + T, 2: tr('mask_secondary_short'), 3: '< ' + T };
  var MASK_TIP = { 1: tr('mask_primary', { t: T }), 2: tr('mask_secondary'), 3: tr('mask_absent', { t: T }) };

  var LCOL = {};
  LIST.cols.forEach(function(c, i) { LCOL[c.key] = i; });
  var ANON = LIST.cols.length;
  var listCategories = LCOL.category == null ? [] : uniqueSorted(LIST.rows.map(function(r) { return r[LCOL.category]; }));

  function varLabel(v) { return V[v] ? V[v].label : v === 'concept' ? tr('concept').charAt(0).toUpperCase() + tr('concept').slice(1) : v; }
  function plural(v) { return tr('thing_' + v); }

  // ---- The crossings the reader can pick ----
  /** Groups of options by number of variables: [{ size, items: [{ id, vars }] }]. */
  function options() {
    var groups = [];
    var add = function(id, vars) {
      var g = groups.filter(function(x) { return x.size === vars.length; })[0];
      if (!g) { g = { size: vars.length, items: [] }; groups.push(g); }
      if (!g.items.some(function(it) { return it.id === id; })) g.items.push({ id: id, vars: vars });
    };
    if (hasList && !X.concept) add('concept', ['concept']);
    DATA.crossings.forEach(function(c) { add(c.id, c.vars); });
    groups.sort(function(a, b) { return a.size - b.size; });
    groups.forEach(function(g) {
      g.items.sort(function(a, b) {
        for (var i = 0; i < Math.min(a.vars.length, b.vars.length); i++) {
          var d = ORDER.indexOf(a.vars[i]) - ORDER.indexOf(b.vars[i]);
          if (d) return d;
        }
        return 0;
      });
    });
    return groups;
  }
  function varsOf(id) { return X[id] ? X[id].vars : id === 'concept' ? ['concept'] : []; }

  // ---- State ----
  var firstChoice = X.period ? 'period' : X['period-age'] ? 'period-age' : (options()[0] && options()[0].items[0] ? options()[0].items[0].id : null);
  var S = {
    crossing: firstChoice,
    metric: 'patients',
    sel: {},       // nominal variable → { modality index: true }; absent = all
    range: null,   // period → [first, last] index
    cq: '',        // concept search
    ccat: '',      // concept category
    pin: null,     // three-variable crossing: the variable shown one value at a time
    pinVal: null,  // its modality index, or null for all (the crossing of the other two)
    topN: 20,
    scale: 'row',
    periodMode: 'slider',
    tab: 'charts', // 'charts' (key figures and charts) or 'table'
  };
  // Derived on every read: the variables drawn as axes and those narrowed to one value.
  var D = { display: [], slice: {} };

  function singleOf(v) {
    if (v === 'period') return S.range && S.range[0] === S.range[1] ? S.range[0] : null;
    if (v === 'concept' && V.concept && V.concept.level === 'concept') return null;
    var sel = S.sel[v];
    if (!sel) return null;
    var keys = Object.keys(sel);
    return keys.length === 1 ? Number(keys[0]) : null;
  }
  function defaultPin(vars) {
    var best = null;
    vars.forEach(function(v) {
      if (v === 'period' || v === 'concept' || !V[v]) return;
      if (!best || V[v].mods.length < V[best].mods.length) best = v;
    });
    return best || vars[vars.length - 1];
  }
  function others(vars, v) { return vars.filter(function(x) { return x !== v; }); }
  function canUnpin() { var vars = varsOf(S.crossing); return !!X[keyOf(others(vars, S.pin))]; }
  function derive() {
    var vars = varsOf(S.crossing);
    if (vars.length === 3) {
      if (!S.pin || vars.indexOf(S.pin) === -1) { S.pin = defaultPin(vars); S.pinVal = null; }
      if (S.pinVal == null && !canUnpin()) S.pinVal = 0;
    } else { S.pin = null; S.pinVal = null; }
    var display = [], slice = {};
    vars.forEach(function(v) {
      if (v === S.pin) { if (S.pinVal != null) slice[v] = S.pinVal; return; }
      var one = vars.length > 1 ? singleOf(v) : null;
      if (one != null) slice[v] = one; else display.push(v);
    });
    if (!display.length) {
      var back = vars.filter(function(v) { return v !== S.pin && v in slice; }).pop();
      if (back) { display.push(back); delete slice[back]; }
    }
    D.display = display.sort(function(a, b) { return ORDER.indexOf(a) - ORDER.indexOf(b); });
    D.slice = slice;
  }
  function sourceVars() { return D.display.concat(Object.keys(D.slice)); }
  function isListView() { return S.crossing === 'concept' && hasList; }
  function sourceCrossing() { return X[keyOf(sourceVars())] || null; }
  function measuresOf() {
    derive();
    if (isListView()) return LCOL.visitCount != null ? ['patients', 'stays', 'records'] : ['patients', 'records'];
    var c = sourceCrossing();
    return ['patients'].concat(c ? c.measures : []);
  }

  var conceptMatchCache = { key: null, ok: null };
  function conceptOk(i) {
    var cv = V.concept;
    if (!cv) return true;
    var key = S.cq + '\u0001' + S.ccat;
    if (conceptMatchCache.key !== key) {
      var q = S.cq.trim().toLowerCase();
      conceptMatchCache = { key: key, ok: cv.mods.map(function(m, j) {
        if (S.ccat && cv.level === 'concept' && (!cv.categories || cv.categories[j] !== S.ccat)) return false;
        return !q || fuzzy(q, (cv.names[j] + ' ' + m).toLowerCase());
      }) };
    }
    return conceptMatchCache.ok[i];
  }
  function keepMod(v, i) {
    if (v === 'period') return !S.range || (i >= S.range[0] && i <= S.range[1]);
    if (v === 'concept' && V.concept && V.concept.level === 'concept') return conceptOk(i);
    var sel = S.sel[v];
    return !sel || !!sel[i];
  }
  function keptMods(v) {
    var out = [];
    V[v].mods.forEach(function(_, i) { if (keepMod(v, i)) out.push(i); });
    return out;
  }

  function viewCells(c) {
    var pos = {};
    c.vars.forEach(function(v, i) { pos[v] = i; });
    var sliced = Object.keys(D.slice);
    return c.cells.filter(function(cell) {
      for (var s = 0; s < sliced.length; s++) if (cell[pos[sliced[s]]] !== D.slice[sliced[s]]) return false;
      for (var d = 0; d < D.display.length; d++) if (!keepMod(D.display[d], cell[pos[D.display[d]]])) return false;
      return true;
    });
  }
  function lookup(c) {
    if (!c._map) {
      c._map = {};
      var n = c.vars.length;
      c.cells.forEach(function(cell) { c._map[cell.slice(0, n).join('|')] = cell; });
    }
    return c._map;
  }
  /** The published cell of `vars` at the given modalities (plus the slices), or undefined. */
  function marginCell(vars, at) {
    var all = vars.concat(Object.keys(D.slice));
    var c = X[keyOf(all)];
    if (!c) return undefined;
    // Crossings with the concept variable count events, the others visits: a
    // total over one population is no margin of a table over the other.
    if ((all.indexOf('concept') !== -1) !== (sourceVars().indexOf('concept') !== -1)) return undefined;
    var key = c.vars.map(function(v) { return v in at ? at[v] : D.slice[v]; }).join('|');
    return { cell: lookup(c)[key] || null, crossing: c };
  }
  function statusOf(cell) { return cell[cell.length - 1]; }
  function measureAt(cell, c, metric) {
    var n = c.vars.length;
    if (!cell) return { v: null, st: 3 };
    var st = statusOf(cell);
    var k = metric === 'patients' ? 0 : c.measures.indexOf(metric) + 1;
    var raw = k ? cell[n + k] : metric === 'patients' ? cell[n] : null;
    if (st) return { v: null, st: st, raw: raw };
    return { v: raw, st: 0 };
  }
  function shown(m) {
    // A number behind a mask only reaches the engine in the app's revealing preview.
    if ((m.st === 1 || m.st === 2) && m.raw != null) return tr('mask_value', { v: fmt(m.raw) });
    return m.st ? MASK_TEXT[m.st] : fmt(m.v);
  }
  function compact(n) {
    var a = Math.abs(n);
    if (a >= 1e6) return (n / 1e6).toFixed(a >= 1e7 ? 0 : 1).replace(/\.0$/, '') + 'M';
    if (a >= 1e4) return Math.round(n / 1e3) + 'k';
    if (a >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'k';
    return String(Math.round(n));
  }
  function pct(v, total) { return total ? (v / total * 100).toFixed(v / total < 0.1 ? 1 : 0) + '%' : ''; }

  // ---- Charts: SVG at the container's pixel width, so text stays at its size ----
  var hatchSeq = 0;
  function tipAttr(title, lines) {
    var html = '<b>' + escHtml(title) + '</b>' + (lines || []).map(function(l) {
      return '<div class="tl">' + (l.color ? '<i style="background:' + l.color + '"></i>' : '') + '<span>' + escHtml(l.label) + '</span><em>' + escHtml(l.value) + '</em></div>';
    }).join('');
    return ' data-tip="' + escHtml(html) + '"';
  }
  function svgOpen(w, h, label) {
    var id = 'h' + Math.random().toString(36).slice(2, 7) + (++hatchSeq);
    return {
      id: id,
      head: '<svg class="ch" viewBox="0 0 ' + w + ' ' + h + '" width="' + w + '" height="' + h + '" role="img" aria-label="' + escHtml(label) + '">'
        + '<defs><pattern id="' + id + '" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="6" height="6" class="hatch-bg"/><line x1="0" y1="0" x2="0" y2="6" class="hatch-line"/></pattern></defs>',
    };
  }
  function niceScale(max, ticks) {
    if (max <= 0) return { max: 1, step: 1 };
    var raw = Math.max(1, max / ticks);
    var mag = Math.pow(10, Math.floor(Math.log10(raw)));
    var step = 10 * mag;
    var f = [1, 2, 2.5, 5, 10];
    for (var i = 0; i < f.length; i++) if (f[i] * mag >= raw) { step = f[i] * mag; break; }
    return { max: Math.ceil(max / step) * step, step: step };
  }
  function yGrid(p, sc, x0, x1, yOf, percent) {
    for (var v = 0; v <= sc.max + 1e-9; v += sc.step) {
      var y = yOf(v).toFixed(1);
      p.push('<line x1="' + x0 + '" y1="' + y + '" x2="' + x1 + '" y2="' + y + '" class="' + (v ? 'grid' : 'axis') + '"/>');
      p.push('<text x="' + (x0 - 6) + '" y="' + (Number(y) + 3.5) + '" text-anchor="end" class="tick">' + (percent ? Math.round(v) + '%' : compact(v)) + '</text>');
    }
  }
  function truncate(s, n) { s = String(s); return s.length > n ? s.slice(0, n - 1) + '…' : s; }
  function xLabels(p, names, xOf, y, maxW) {
    var longest = 0;
    names.forEach(function(nm) { longest = Math.max(longest, String(nm).length); });
    var every = Math.max(1, Math.ceil((Math.min(longest, 14) * 6.2 + 10) / Math.max(1, maxW)));
    names.forEach(function(nm, i) {
      if (i % every) return;
      p.push('<text x="' + xOf(i).toFixed(1) + '" y="' + y + '" text-anchor="middle" class="tick x">' + escHtml(truncate(nm, 14)) + '</text>');
    });
  }
  function maxOf(values) { var m = 0; values.forEach(function(v) { if (v != null && v > m) m = v; }); return m; }
  function maskLines(it) { return it.st ? [{ label: '', value: MASK_TIP[it.st] }] : []; }

  /** One series over a category axis. items: [{ name, v, st }]. */
  function columnChart(w, items, o) {
    var h = o.height || 250, pad = { t: 12, r: 10, b: 30, l: 46 };
    var pw = w - pad.l - pad.r, ph = h - pad.t - pad.b;
    var sc = niceScale(Math.max(maxOf(items.map(function(i) { return i.v; })), T), 5);
    var yOf = function(v) { return pad.t + ph - (v / sc.max) * ph; };
    var s = svgOpen(w, h, o.title);
    var p = [];
    yGrid(p, sc, pad.l, w - pad.r, yOf);
    var slot = items.length ? pw / items.length : pw;
    var bw = items.length > 60 ? slot : Math.max(2, Math.min(56, slot * 0.7));
    items.forEach(function(it, i) {
      var cx = pad.l + i * slot + slot / 2, x = (cx - bw / 2).toFixed(1);
      var t = tipAttr(it.name, [{ label: o.unit, value: shown(it) }].concat(maskLines(it)));
      if (it.st) {
        var hy = it.st === 2 ? yOf(0) - 3 : yOf(T);
        p.push('<rect x="' + x + '" y="' + hy.toFixed(1) + '" width="' + bw.toFixed(1) + '" height="' + (yOf(0) - hy).toFixed(1) + '" fill="url(#' + s.id + ')"' + t + '/>');
      } else if (it.v > 0) {
        var y = yOf(it.v);
        p.push('<rect class="bar" x="' + x + '" y="' + y.toFixed(1) + '" width="' + bw.toFixed(1) + '" height="' + (yOf(0) - y).toFixed(1) + '" rx="' + (bw > 6 ? 2 : 0) + '" fill="' + (o.color || PALETTE[0]) + '"' + t + '/>');
      }
      // Hover target over the whole column, so thin bars are easy to point at.
      p.push('<rect x="' + (cx - slot / 2).toFixed(1) + '" y="' + pad.t + '" width="' + slot.toFixed(1) + '" height="' + ph + '" class="hit"' + t + '/>');
    });
    xLabels(p, items.map(function(i) { return i.name; }), function(i) { return pad.l + i * slot + slot / 2; }, h - 10, slot);
    return s.head + p.join('') + '</svg>';
  }

  /** One or more series over an ordered axis. series: [{ name, color, vals: [{ v, st }] }]. */
  function lineChart(w, names, series, o) {
    var h = o.height || 280, pad = { t: 14, r: 14, b: 30, l: 46 };
    var pw = w - pad.l - pad.r, ph = h - pad.t - pad.b, n = names.length;
    var all = [];
    series.forEach(function(se) { se.vals.forEach(function(m) { all.push(m.v); }); });
    var sc = niceScale(maxOf(all), 5);
    var xOf = function(i) { return pad.l + (n > 1 ? i * pw / (n - 1) : pw / 2); };
    var yOf = function(v) { return pad.t + ph - (v / sc.max) * ph; };
    var s = svgOpen(w, h, o.title);
    var p = [];
    yGrid(p, sc, pad.l, w - pad.r, yOf);
    series.forEach(function(se) {
      var d = '', area = '', run = [];
      var flush = function() {
        if (run.length > 1 && series.length === 1) {
          area += 'M' + xOf(run[0][0]).toFixed(1) + ' ' + yOf(0).toFixed(1) + run.map(function(r) { return 'L' + xOf(r[0]).toFixed(1) + ' ' + yOf(r[1]).toFixed(1); }).join('') + 'L' + xOf(run[run.length - 1][0]).toFixed(1) + ' ' + yOf(0).toFixed(1) + 'Z';
        }
        run = [];
      };
      se.vals.forEach(function(m, i) {
        if (m.v == null) { flush(); return; }
        d += (run.length ? 'L' : 'M') + xOf(i).toFixed(1) + ' ' + yOf(m.v).toFixed(1);
        run.push([i, m.v]);
      });
      flush();
      if (area) p.push('<path d="' + area + '" fill="' + se.color + '" opacity=".12"/>');
      p.push('<path d="' + d + '" fill="none" stroke="' + se.color + '" stroke-width="' + (series.length === 1 ? 2.2 : 1.8) + '" stroke-linejoin="round" stroke-linecap="round"/>');
      if (n <= 48) se.vals.forEach(function(m, i) {
        if (m.v != null) p.push('<circle cx="' + xOf(i).toFixed(1) + '" cy="' + yOf(m.v).toFixed(1) + '" r="2.6" fill="' + se.color + '" class="dot"/>');
      });
      // A lone point between two gaps draws no segment.
      se.vals.forEach(function(m, i) {
        var prev = se.vals[i - 1], next = se.vals[i + 1];
        if (m.v != null && n > 48 && (!prev || prev.v == null) && (!next || next.v == null)) p.push('<circle cx="' + xOf(i).toFixed(1) + '" cy="' + yOf(m.v).toFixed(1) + '" r="2" fill="' + se.color + '"/>');
      });
    });
    if (series.length === 1) series[0].vals.forEach(function(m, i) {
      if (m.st) p.push('<rect x="' + (xOf(i) - 3).toFixed(1) + '" y="' + (yOf(0) - 6).toFixed(1) + '" width="6" height="6" fill="url(#' + s.id + ')" class="mk"/>');
    });
    var slot = n > 1 ? pw / (n - 1) : pw;
    names.forEach(function(nm, i) {
      var lines = series.map(function(se) { return { label: se.name, value: shown(se.vals[i]), color: series.length > 1 ? se.color : null }; });
      p.push('<rect x="' + (xOf(i) - slot / 2).toFixed(1) + '" y="' + pad.t + '" width="' + slot.toFixed(1) + '" height="' + ph + '" class="hit col"' + tipAttr(nm + (series.length === 1 ? '' : ' · ' + o.unit), series.length === 1 ? [{ label: o.unit, value: lines[0].value }] : lines) + '/>');
    });
    xLabels(p, names, xOf, h - 10, slot);
    return s.head + p.join('') + '</svg>';
  }

  /** Labelled horizontal bars, in the order given. items: [{ name, v, st }]. */
  function hBars(w, items, o) {
    var rowH = 24, h = items.length * rowH + 8;
    var labelW = 60;
    items.forEach(function(i) { labelW = Math.max(labelW, Math.min(String(i.name).length, 40) * 6.3 + 10); });
    labelW = Math.min(labelW, Math.round(w * 0.42));
    var valueW = o.pctOf ? 92 : 60;
    var pw = Math.max(40, w - labelW - valueW);
    var max = Math.max(1, maxOf(items.map(function(i) { return i.v; })), T);
    var s = svgOpen(w, h, o.title);
    var maxChars = Math.floor((labelW - 10) / 6.3);
    var p = items.map(function(it, i) {
      var y = 4 + i * rowH;
      var bw = it.st ? (it.st === 2 ? 3 : T / max * pw) : it.v / max * pw;
      var text = shown(it) + (o.pctOf && !it.st ? '  ' + pct(it.v, o.pctOf) : '');
      var t = tipAttr(it.name, [{ label: o.unit, value: shown(it) }].concat(o.pctOf && !it.st ? [{ label: o.pctLabel || tr('share'), value: pct(it.v, o.pctOf) }] : []).concat(maskLines(it)));
      return '<g' + t + '><rect x="0" y="' + y + '" width="' + w + '" height="' + rowH + '" class="hit row"/>'
        + '<text x="' + (labelW - 8) + '" y="' + (y + 15.5) + '" text-anchor="end" class="lbl">' + escHtml(truncate(it.name, maxChars)) + '</text>'
        + (bw > 0 ? '<rect x="' + labelW + '" y="' + (y + 5) + '" width="' + bw.toFixed(1) + '" height="' + (rowH - 10) + '" rx="2" fill="' + (it.st ? 'url(#' + s.id + ')' : (it.color || o.color || PALETTE[0])) + '"/>' : '')
        + '<text x="' + (labelW + bw + 6).toFixed(1) + '" y="' + (y + 15.5) + '" class="val">' + escHtml(text) + '</text></g>';
    });
    return s.head + p.join('') + '</svg>';
  }

  /** Shares of a whole. items: [{ name, v, color }] with v > 0. */
  function donut(w, items, o) {
    var total = 0;
    items.forEach(function(i) { total += i.v; });
    var side = w >= 440;
    var r = Math.min(side ? 96 : 90, (side ? w * 0.45 : w) / 2 - 8), inner = r * 0.64;
    var legendH = items.length * 22;
    var h = side ? Math.max(2 * r + 20, legendH + 20) : 2 * r + 24 + legendH;
    var cx = side ? r + 12 : w / 2, cy = side ? h / 2 : r + 10;
    var s = svgOpen(w, h, o.title);
    var p = [];
    var angle = -Math.PI / 2;
    var pt = function(a, rad) { return (cx + rad * Math.cos(a)).toFixed(2) + ' ' + (cy + rad * Math.sin(a)).toFixed(2); };
    items.forEach(function(it) {
      if (!total || it.v <= 0) return;
      var t = tipAttr(it.name, [{ label: o.unit, value: fmt(it.v) }, { label: tr('share'), value: pct(it.v, total) }]);
      if (it.v === total) {
        p.push('<circle cx="' + cx + '" cy="' + cy + '" r="' + ((r + inner) / 2) + '" fill="none" stroke="' + it.color + '" stroke-width="' + (r - inner) + '"' + t + '/>');
        return;
      }
      var sweep = it.v / total * Math.PI * 2, end = angle + sweep, large = sweep > Math.PI ? 1 : 0;
      p.push('<path class="slice" d="M ' + pt(angle, r) + ' A ' + r + ' ' + r + ' 0 ' + large + ' 1 ' + pt(end, r) + ' L ' + pt(end, inner) + ' A ' + inner + ' ' + inner + ' 0 ' + large + ' 0 ' + pt(angle, inner) + ' Z" fill="' + it.color + '"' + t + '/>');
      angle = end;
    });
    p.push('<text x="' + cx + '" y="' + (cy + 2) + '" text-anchor="middle" class="donut-v">' + compact(total) + '</text>');
    p.push('<text x="' + cx + '" y="' + (cy + 20) + '" text-anchor="middle" class="tick">' + escHtml(o.unit.toLowerCase()) + '</text>');
    var lx = side ? cx + r + 24 : 12, ly = side ? (h - legendH) / 2 : 2 * r + 24;
    items.forEach(function(it, i) {
      var y = ly + i * 22;
      p.push('<g' + tipAttr(it.name, [{ label: o.unit, value: fmt(it.v) }, { label: tr('share'), value: pct(it.v, total) }]) + '><rect x="' + lx + '" y="' + (y + 3) + '" width="11" height="11" rx="2.5" fill="' + it.color + '"/>'
        + '<text x="' + (lx + 18) + '" y="' + (y + 12.5) + '" class="lbl">' + escHtml(truncate(it.name, side ? Math.floor((w - lx - 80) / 6.4) : 34)) + '</text>'
        + '<text x="' + (w - 8) + '" y="' + (y + 12.5) + '" text-anchor="end" class="val strong">' + pct(it.v, total) + '</text></g>');
    });
    return s.head + p.join('') + '</svg>';
  }

  /**
   * Categories split by series: stacked (parts of a whole), 100 % stacked, or
   * grouped side by side (when the parts overlap and a stack would add them up).
   */
  function barsBySeries(w, cats, series, o) {
    var horizontal = !!o.horizontal, mode = o.mode;
    var n = cats.length, k = series.length;
    var totals = cats.map(function(_, i) { var t = 0; series.forEach(function(se) { t += se.vals[i].v || 0; }); return t; });
    var valueOf = function(m, i) { return mode === 'percent' ? (totals[i] ? (m.v || 0) / totals[i] * 100 : 0) : (m.v || 0); };
    var max = mode === 'percent' ? 100 : mode === 'stack' ? maxOf(totals) : maxOf(series.map(function(se) { return maxOf(se.vals.map(function(m) { return m.v; })); }));
    var sc = mode === 'percent' ? { max: 100, step: 25 } : niceScale(max, 5);
    var p = [];
    var tipFor = function(i) {
      return tipAttr(cats[i], series.map(function(se) {
        var m = se.vals[i];
        return { label: se.name, value: shown(m) + (mode === 'percent' && !m.st && totals[i] ? ' · ' + pct(m.v, totals[i]) : ''), color: se.color };
      }));
    };
    var h = horizontal ? n * (mode === 'group' ? Math.max(18, k * 7 + 8) : 24) + 34 : o.height || 280;
    if (horizontal) {
      var labelW = 60;
      cats.forEach(function(c) { labelW = Math.max(labelW, Math.min(String(c).length, 36) * 6.3 + 10); });
      labelW = Math.min(labelW, Math.round(w * 0.38));
      var rowH = mode === 'group' ? Math.max(18, k * 7 + 8) : 24;
      var pw = w - labelW - 16;
      var xOf = function(v) { return labelW + v / sc.max * pw; };
      for (var v = 0; v <= sc.max + 1e-9; v += sc.step) {
        p.push('<line x1="' + xOf(v).toFixed(1) + '" y1="4" x2="' + xOf(v).toFixed(1) + '" y2="' + (n * rowH + 4) + '" class="' + (v ? 'grid' : 'axis') + '"/>');
        p.push('<text x="' + xOf(v).toFixed(1) + '" y="' + (n * rowH + 20) + '" text-anchor="middle" class="tick">' + (mode === 'percent' ? v + '%' : compact(v)) + '</text>');
      }
      var maxChars = Math.floor((labelW - 10) / 6.3);
      cats.forEach(function(c, i) {
        var y = 4 + i * rowH;
        p.push('<g' + tipFor(i) + '><rect x="0" y="' + y + '" width="' + w + '" height="' + rowH + '" class="hit row"/>');
        p.push('<text x="' + (labelW - 8) + '" y="' + (y + rowH / 2 + 4) + '" text-anchor="end" class="lbl">' + escHtml(truncate(c, maxChars)) + '</text>');
        var acc = 0;
        series.forEach(function(se, j) {
          var m = se.vals[i], val = valueOf(m, i);
          if (mode === 'group') {
            var bh = (rowH - 6) / k;
            if (val > 0) p.push('<rect x="' + labelW + '" y="' + (y + 3 + j * bh).toFixed(1) + '" width="' + (xOf(val) - labelW).toFixed(1) + '" height="' + Math.max(1, bh - 1).toFixed(1) + '" fill="' + se.color + '"/>');
          } else if (val > 0) {
            p.push('<rect x="' + xOf(acc).toFixed(1) + '" y="' + (y + 5) + '" width="' + (xOf(acc + val) - xOf(acc)).toFixed(1) + '" height="' + (rowH - 10) + '" fill="' + se.color + '"/>');
            acc += val;
          }
        });
        p.push('</g>');
      });
    } else {
      var pad = { t: 12, r: 10, b: 30, l: 46 };
      var pw2 = w - pad.l - pad.r, ph = h - pad.t - pad.b;
      var yOf = function(v) { return pad.t + ph - v / sc.max * ph; };
      yGrid(p, sc, pad.l, w - pad.r, yOf, mode === 'percent');
      var slot = n ? pw2 / n : pw2;
      var bw = Math.min(64, slot * (mode === 'group' ? 0.84 : 0.7));
      cats.forEach(function(c, i) {
        var cx = pad.l + i * slot + slot / 2;
        var acc = 0;
        series.forEach(function(se, j) {
          var val = valueOf(se.vals[i], i);
          if (val <= 0) return;
          if (mode === 'group') {
            var gw = bw / k;
            p.push('<rect x="' + (cx - bw / 2 + j * gw).toFixed(1) + '" y="' + yOf(val).toFixed(1) + '" width="' + Math.max(1, gw - 1).toFixed(1) + '" height="' + (yOf(0) - yOf(val)).toFixed(1) + '" fill="' + se.color + '"/>');
          } else {
            p.push('<rect x="' + (cx - bw / 2).toFixed(1) + '" y="' + yOf(acc + val).toFixed(1) + '" width="' + bw.toFixed(1) + '" height="' + (yOf(acc) - yOf(acc + val)).toFixed(1) + '" fill="' + se.color + '"/>');
            acc += val;
          }
        });
        p.push('<rect x="' + (cx - slot / 2).toFixed(1) + '" y="' + pad.t + '" width="' + slot.toFixed(1) + '" height="' + ph + '" class="hit col"' + tipFor(i) + '/>');
      });
      xLabels(p, cats, function(i) { return pad.l + i * slot + slot / 2; }, h - 10, slot);
    }
    return svgOpen(w, h, o.title).head + p.join('') + '</svg>';
  }

  /** Age pyramid: one bar per age group and side, the youngest at the bottom. */
  function pyramid(w, ages, left, right, o) {
    var rowH = Math.max(14, Math.min(26, 300 / Math.max(1, ages.length))), n = ages.length;
    var h = n * rowH + 40, mid = w / 2, gap = 40;
    var max = Math.max(T, maxOf(left.vals.map(function(m) { return m.v; }).concat(right.vals.map(function(m) { return m.v; }))));
    var sc = niceScale(max, 4);
    var half = mid - gap / 2 - 12;
    var s = svgOpen(w, h, o.title);
    var p = [];
    var lenOf = function(m) { return m.st ? (m.st === 2 ? 2 : T / sc.max * half) : (m.v || 0) / sc.max * half; };
    for (var v = 0; v <= sc.max + 1e-9; v += sc.step) {
      var dx = v / sc.max * half;
      [mid - gap / 2 - dx, mid + gap / 2 + dx].forEach(function(x) {
        p.push('<line x1="' + x.toFixed(1) + '" y1="18" x2="' + x.toFixed(1) + '" y2="' + (18 + n * rowH) + '" class="' + (v ? 'grid' : 'axis') + '"/>');
        p.push('<text x="' + x.toFixed(1) + '" y="' + (h - 6) + '" text-anchor="middle" class="tick">' + compact(v) + '</text>');
      });
    }
    p.push('<text x="' + (mid - gap / 2) + '" y="11" text-anchor="end" class="lbl strong">' + escHtml(left.name) + '</text>');
    p.push('<text x="' + (mid + gap / 2) + '" y="11" class="lbl strong">' + escHtml(right.name) + '</text>');
    ages.forEach(function(a, idx) {
      var i = n - 1 - idx, y = 18 + i * rowH;
      var lm = left.vals[idx], rm = right.vals[idx];
      var t = tipAttr(a, [{ label: left.name, value: shown(lm), color: left.color }, { label: right.name, value: shown(rm), color: right.color }]);
      var ll = lenOf(lm), rl = lenOf(rm);
      p.push('<g' + t + '><rect x="0" y="' + y + '" width="' + w + '" height="' + rowH + '" class="hit row"/>');
      p.push('<rect x="' + (mid - gap / 2 - ll).toFixed(1) + '" y="' + (y + 2) + '" width="' + ll.toFixed(1) + '" height="' + (rowH - 4) + '" fill="' + (lm.st ? 'url(#' + s.id + ')' : left.color) + '"/>');
      p.push('<rect x="' + (mid + gap / 2).toFixed(1) + '" y="' + (y + 2) + '" width="' + rl.toFixed(1) + '" height="' + (rowH - 4) + '" fill="' + (rm.st ? 'url(#' + s.id + ')' : right.color) + '"/>');
      p.push('<text x="' + mid + '" y="' + (y + rowH / 2 + 3.5) + '" text-anchor="middle" class="tick">' + escHtml(a) + '</text></g>');
    });
    return s.head + p.join('') + '</svg>';
  }

  function legend(series) {
    return '<div class="ch-legend">' + series.map(function(se) {
      return '<span><i style="background:' + se.color + '"></i>' + escHtml(se.name) + '</span>';
    }).join('') + '</div>';
  }

  // ---- Heatmap (HTML table: scrolls, and each cell is readable) ----
  function heat(t) {
    var dark = opts.dark ? opts.dark() : false;
    var LO = dark ? [27, 40, 58] : [238, 245, 251], HI = dark ? [61, 143, 209] : [31, 94, 151];
    var c = [0, 1, 2].map(function(i) { return Math.round(LO[i] + t * (HI[i] - LO[i])); });
    return 'rgb(' + c.join(',') + ')';
  }
  function heatmap(rows, cols, at, o) {
    var grid = rows.map(function(_, r) { return cols.map(function(_, c) { return at(r, c); }); });
    var globalMax = 0;
    grid.forEach(function(line) { line.forEach(function(m) { if (m.v > globalMax) globalMax = m.v; }); });
    var h = '<div class="hm-scroll"><table class="hm-t"><thead><tr><th class="corner">' + escHtml(o.rowLabel) + ' <span>╲</span> ' + escHtml(o.colLabel) + '</th>';
    cols.forEach(function(c) { h += '<th title="' + escHtml(c.name) + '">' + escHtml(c.name) + '</th>'; });
    if (o.rowAll) h += '<th class="all">' + escHtml(tr('all_things', { things: o.colPlural })) + '</th>';
    h += '</tr></thead><tbody>';
    var cell = function(m, max, title) {
      if (m.st) return '<td class="masked m' + m.st + '"' + tipAttr(title, [{ label: o.unit, value: shown(m) }, { label: '', value: MASK_TIP[m.st] }]) + '>' + (m.raw != null ? '<s>' + compact(m.raw) + '</s>' : MASK_TEXT[m.st]) + '</td>';
      var t = max ? m.v / max : 0;
      return '<td class="num" style="background:' + heat(t) + ';color:' + (t > 0.55 ? '#fff' : 'inherit') + '"' + tipAttr(title, [{ label: o.unit, value: fmt(m.v) }]) + '>' + compact(m.v) + '</td>';
    };
    var allCell = function(m, title) {
      return '<td class="all' + (m.st ? ' masked' : '') + '"' + tipAttr(title, [{ label: o.unit, value: shown(m) }]) + '>' + (m.st ? MASK_TEXT[m.st] : compact(m.v)) + '</td>';
    };
    grid.forEach(function(line, r) {
      var max = S.scale === 'row' ? maxOf(line.map(function(m) { return m.v; })) : globalMax;
      h += '<tr><th class="row" title="' + escHtml(rows[r].name) + '">' + escHtml(rows[r].name) + '</th>';
      line.forEach(function(m, c) { h += cell(m, max, rows[r].name + ' · ' + cols[c].name); });
      if (o.rowAll) h += allCell(o.rowAll(r), rows[r].name + ' · ' + tr('all_things', { things: o.colPlural }));
      h += '</tr>';
    });
    if (o.colAll) {
      h += '<tr class="all-row"><th class="row">' + escHtml(tr('all_things', { things: o.rowPlural })) + '</th>';
      cols.forEach(function(c, j) { h += allCell(o.colAll(j), c.name + ' · ' + tr('all_things', { things: o.rowPlural })); });
      if (o.rowAll) h += '<td class="all"></td>';
      h += '</tr>';
    }
    h += '</tbody></table></div>';
    h += '<div class="hm-scale"><span>0</span><span class="bar" style="background:linear-gradient(90deg,' + heat(0) + ',' + heat(1) + ')"></span><span>' + (S.scale === 'row' ? tr('row_max') : tr('max')) + '</span><span class="mask"></span><span>' + escHtml(tr('mask_secondary_short')) + '</span>'
      + '<span class="spacer"></span><span>' + escHtml(tr('scale_label')) + '</span><div class="seg mini" data-act="scale"><button type="button" data-v="row" title="' + escHtml(tr('per_row_tip')) + '"' + (S.scale === 'row' ? ' class="active"' : '') + '>' + escHtml(tr('per_row')) + '</button><button type="button" data-v="all" title="' + escHtml(tr('whole_table_tip')) + '"' + (S.scale === 'all' ? ' class="active"' : '') + '>' + escHtml(tr('whole_table')) + '</button></div></div>';
    return h;
  }

  // ---- View ----
  var blocks;
  function colorFor(i, count) { return count > PALETTE.length && i >= PALETTE.length - 1 ? OTHERS_COLOR : PALETTE[i % PALETTE.length]; }
  function sliceText() {
    return Object.keys(D.slice).map(function(v) { return { v: v, label: V[v].label, value: V[v].names[D.slice[v]] }; });
  }
  function block(title, size, render, extra) {
    blocks.push({ title: title, size: size, render: render, sub: extra && extra.sub, csv: extra && extra.csv, note: extra && extra.note, head: extra && extra.head });
  }
  function topNControl(total) {
    if (total <= 10) return '';
    return '<div class="seg mini" data-act="topn">' + [10, 20, 50].filter(function(n, i) { return i === 0 || total > [10, 20, 50][i - 1]; }).map(function(n) {
      return '<button type="button" data-v="' + n + '"' + (S.topN === n ? ' class="active"' : '') + '>' + escHtml(tr('top', { n: n })) + '</button>';
    }).join('') + '</div>';
  }
  function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }
  /** 'year', or '2 years' for a stepped period. */
  function periodUnit(vr) {
    var g = vr.granularity || 'year';
    return vr.step > 1 ? tr('g_' + g + 's', { n: vr.step }) : tr('g_' + g);
  }

  /**
   * Everything the host draws: { title, context: [{ v, label, value }], stats:
   * [{ key, label, value, sub, icon }], blocks: [{ title, size, sub, note, head,
   * render(width) → HTML, csv }], table, empty }.
   */
  function view() {
    derive();
    blocks = [];
    hatchSeq = 0;
    var ms = measuresOf();
    if (ms.indexOf(S.metric) === -1) S.metric = 'patients';
    var metric = S.metric, unit = MEASURE[metric];
    var table = null;
    var empty = '';
    if (isListView()) {
      table = listView(metric, unit);
    } else {
      var c = sourceCrossing();
      if (!c) return { title: '', context: [], stats: globals(), blocks: [], table: null, empty: tr('not_computed') };
      table = D.display.length === 1 ? oneWay(c, metric, unit) : twoWay(c, metric, unit);
    }
    // Half-width charts pair up; a lone one takes the whole row.
    var run = [];
    blocks.forEach(function(b, i) {
      if (b.size === 'half') run.push(i);
      if (b.size !== 'half' || i === blocks.length - 1) {
        if (run.length % 2) blocks[run[run.length - 1]].size = 'full';
        run = [];
      }
    });
    if (!blocks.length) empty = tr('nothing_matches');
    var title = tr('title_by', { unit: unit, vars: (isListView() ? ['concept'] : D.display).map(function(v) { return varLabel(v).toLowerCase(); }).join(' × ') });
    return { title: title, context: sliceText(), stats: globals(), blocks: blocks, table: table, empty: empty };
  }
  /** Whether the reader narrowed any displayed variable. */
  function displayFiltered() {
    return D.display.some(function(v) { return keptMods(v).length < V[v].mods.length; });
  }
  /** The concept list's rows the concept filters keep. */
  function listRows() {
    var q = S.cq.trim().toLowerCase();
    return LIST.rows.filter(function(r) {
      if (S.ccat && LCOL.category != null && r[LCOL.category] !== S.ccat) return false;
      return !q || fuzzy(q, (String(r[LCOL.conceptName]) + ' ' + r[LCOL.conceptId]).toLowerCase());
    });
  }
  /**
   * One key figure under the reader's filters: `{ v, of?, atLeast?, sub? }`.
   * Nothing filtered: the warehouse's total. Single values kept only (a slice):
   * that slice's own computed cell. Several values kept: the sum of the view's
   * cells, when the measure adds up across the displayed variables — a stay has
   * one start period, a patient seen twice does not — and at least that sum when
   * some cells are masked. Otherwise the figure cannot be told, and says why.
   */
  function figure(metric, total) {
    var sliced = Object.keys(D.slice).length > 0, filtered = displayFiltered();
    if (!sliced && !filtered) return { v: total };
    var c = sourceCrossing();
    if (!c || (metric !== 'patients' && c.measures.indexOf(metric) === -1)) return { v: total, sub: tr('kpi_unfiltered') };
    if (!filtered) {
      var m = marginCell([], {});
      var r = m && m.cell ? measureAt(m.cell, m.crossing, metric) : null;
      if (r && r.v != null) return { v: r.v, of: total };
    }
    var blocker = D.display.filter(function(v) { return !V[v].partition[metric]; })[0];
    if (blocker) return { v: null, sub: tr('kpi_not_additive', { things: plural(blocker) }) };
    var sum = 0, masked = false;
    viewCells(c).forEach(function(cell) { var x = measureAt(cell, c, metric); if (x.st) masked = true; else sum += x.v || 0; });
    return { v: sum, of: total, atLeast: masked };
  }
  function card(key, label, icon, f) {
    var value = f.v == null ? '—' : (f.atLeast ? '≥ ' : '') + fmt(f.v);
    var sub = f.of != null ? tr('kpi_of', { total: fmt(f.of) }) + (f.of ? ' (' + pct(f.v, f.of) + ')' : '') : f.sub || '';
    return { key: key, label: label, value: value, sub: sub, icon: icon };
  }
  /**
   * The key figures: patients, the stays the catalog counts, records — each
   * as what the filters leave of the warehouse's total. On the concept list,
   * its concepts take the middle card.
   */
  function globals() {
    var t = DATA.totals;
    if (isListView()) {
      var rows = listRows(), narrowed = rows.length < LIST.rows.length, rec = 0, capped = false;
      rows.forEach(function(r) { if (r[ANON]) capped = true; else rec += r[LCOL.recordCount] || 0; });
      return [
        card('patients', tr('patients'), 'user', narrowed ? { v: null, sub: tr('kpi_not_additive', { things: plural('concept') }) } : { v: t.patients }),
        card('concepts', tr('concepts'), 'tags', narrowed ? { v: rows.length, of: LIST.rows.length } : { v: LIST.rows.length }),
        card('records', tr('records'), 'activity', narrowed ? { v: rec, of: t.records, atLeast: capped } : { v: t.records }),
      ];
    }
    var cards = [card('patients', tr('patients'), 'user', figure('patients', t.patients))];
    if (t.stays != null) cards.push(card('stays', tr('stays'), 'stethoscope', figure('stays', t.stays)));
    if (t.unitStays != null) cards.push(card('unit_stays', tr('unit_stays'), 'stethoscope', figure('unit_stays', t.unitStays)));
    cards.push(card('records', tr('records'), 'activity', figure('records', t.records)));
    return cards;
  }

  function itemsOf(c, v, metric) {
    var byMod = {};
    var pos = c.vars.indexOf(v);
    viewCells(c).forEach(function(cell) { byMod[cell[pos]] = cell; });
    var items = keptMods(v).map(function(i) {
      var m = measureAt(byMod[i], c, metric);
      return { i: i, name: V[v].names[i], v: m.v, st: m.st, raw: m.raw, cell: byMod[i] };
    });
    if (v === 'concept' || v === 'service') {
      if (v === 'concept') items = items.filter(function(it) { return it.cell; });
      // "Other services" is a remainder, not a service: it stays last whatever its size.
      var isOther = function(it) { return V[v].mods[it.i] === '__other__'; };
      items.sort(function(a, b) { return (isOther(a) - isOther(b)) || (b.v == null ? -1 : b.v) - (a.v == null ? -1 : a.v); });
    }
    return items;
  }
  /** The whole population the view is drawn from: the grand total, or the slice's own cell. */
  function populationTotal(metric) {
    if (metric !== 'patients') return null;
    if (!Object.keys(D.slice).length) return DATA.totals.patients;
    var m = marginCell([], {});
    if (!m || !m.cell || statusOf(m.cell)) return null;
    return m.cell[m.crossing.vars.length];
  }
  function maskNote(items) {
    var k = items.filter(function(i) { return i.st === 1 || i.st === 2; }).length;
    return k ? tr('hatched_note', { n: k, t: T }) : '';
  }

  function crossingTable(c, metric, displayed) {
    var n = c.vars.length;
    var cols = displayed.map(function(v) {
      return { key: v, label: V[v].label, type: 'text', variable: v, filter: V[v].mods.length > 30 ? 'text' : 'select', width: v === 'concept' ? 320 : 170, className: v === 'concept' ? 'name' : '' };
    }).concat([
      { key: 'patients', label: MEASURE.patients, type: 'number', filter: 'min', className: 'p', measure: true, width: 130 },
    ]).concat(c.measures.map(function(m) {
      return { key: m, label: MEASURE[m], type: 'number', filter: 'min', measure: true, width: 150 };
    }));
    var rows = viewCells(c).map(function(cell) {
      var r = { _st: statusOf(cell) };
      c.vars.forEach(function(v, i) { r[v] = V[v].names[cell[i]]; r['_i_' + v] = cell[i]; });
      r.patients = cell[n];
      c.measures.forEach(function(m, k) { r[m] = cell[n + 1 + k]; });
      return r;
    });
    // Rows follow the variables' display order, not the alphabet.
    rows.sort(function(a, b) {
      for (var k = 0; k < displayed.length; k++) {
        var d = a['_i_' + displayed[k]] - b['_i_' + displayed[k]];
        if (d) return d;
      }
      return 0;
    });
    return {
      kind: 'cells',
      columns: cols,
      rows: rows,
      maskText: MASK_TEXT,
      maskTip: MASK_TIP,
      searchKeys: displayed,
      initialSort: displayed[0] === 'concept' ? { key: metric, desc: true } : null,
      noun: displayed.length === 1 ? [plural(displayed[0]), plural(displayed[0])] : [tr('cell'), tr('cells_noun')],
      note: tr('below_masked', { t: T }),
      csvFileName: (opts.fileBase || 'catalog') + '-' + slug(displayed.join('-')) + (Object.keys(D.slice).length ? '-' + slug(sliceText().map(function(s) { return s.value; }).join('-')) : '') + '.csv',
    };
  }

  function oneWay(c, metric, unit) {
    var v = D.display[0], vr = V[v];
    var items = itemsOf(c, v, metric);
    var total = populationTotal(metric);

    var note = maskNote(items);
    var pctLabel = tr('pct_of_patients');
    if (vr.kind === 'time') {
      block(tr('over_time', { unit: unit }), 'full', function(w) { return lineChart(w, items.map(function(i) { return i.name; }), [{ name: unit, color: VARIABLE_HEX.period, vals: items }], { title: unit, unit: unit }); }, { note: note });
      if (items.length <= 60) block(tr('per_unit', { unit: unit, unit2: periodUnit(vr) }), 'full', function(w) { return columnChart(w, items, { title: unit, unit: unit, color: VARIABLE_HEX.period }); });
    } else if (v === 'age') {
      block(tr('age_distribution'), 'half', function(w) { return columnChart(w, items, { title: tr('age_distribution'), unit: unit, color: VARIABLE_HEX.age }); }, { note: note });
      pieOrShare(items, vr, metric, unit, total, pctLabel);
    } else if (v === 'sex') {
      pieOrShare(items, vr, metric, unit, total, pctLabel);
      block(tr('by_var', { unit: unit, var: vr.label.toLowerCase() }), 'half', function(w) { return columnChart(w, items, { title: unit, unit: unit, color: VARIABLE_HEX.sex }); }, { note: note });
    } else {
      var shownItems = items.slice(0, v === 'concept' ? S.topN : 40);
      block(v === 'concept' ? tr('top_n', { n: shownItems.length, things: plural(v) }) : tr('by_var', { unit: unit, var: vr.label.toLowerCase() }), vr.partition[metric] ? 'half' : 'full', function(w) {
        return hBars(w, shownItems, { title: vr.label, unit: unit, pctOf: total, pctLabel: pctLabel, color: VARIABLE_HEX[v] });
      }, { note: note, sub: items.length > shownItems.length ? tr('n_of_m', { n: shownItems.length, m: items.length }) : '', head: v === 'concept' ? topNControl(items.length) : '' });
      if (vr.partition[metric]) pieOrShare(items, vr, metric, unit, total, pctLabel, true);
    }
    return crossingTable(c, metric, [v]);
  }

  /** A pie when the modalities split the whole; otherwise the share of patients reached by each. */
  function pieOrShare(items, vr, metric, unit, total, pctLabel, pieOnly) {
    var published = items.filter(function(i) { return !i.st && i.v > 0; });
    if (vr.partition[metric] && published.length > 1) {
      var sorted = published.slice().sort(function(a, b) { return b.v - a.v; });
      var head = sorted.slice(0, 9);
      if (vr.kind === 'ordinal') head.sort(function(a, b) { return a.i - b.i; });
      var slices = head.map(function(it, k) { return { name: it.name, v: it.v, color: vr.id === 'sex' ? SEX_COLOR[vr.mods[it.i]] || OTHERS_COLOR : PALETTE[k % PALETTE.length] }; });
      var rest = 0;
      sorted.slice(9).forEach(function(it) { rest += it.v; });
      if (rest) slices.push({ name: tr('others'), v: rest, color: OTHERS_COLOR });
      var masked = items.length - published.length;
      block(tr('share_of', { unit: unit.toLowerCase() }), 'half', function(w) { return donut(w, slices, { title: tr('share'), unit: unit }); },
        { note: masked ? tr('shares_left_out', { n: masked }) : '' });
    } else if (!pieOnly && total) {
      block(cap(pctLabel), 'half', function(w) {
        return hBars(w, items, { title: pctLabel, unit: unit, pctOf: total, pctLabel: pctLabel, color: VARIABLE_HEX[vr.id] });
      }, { note: tr('overlap_note', { things: plural(vr.id) }) });
    }
  }

  function twoWay(c, metric, unit) {
    var a = D.display[0], b = D.display[1];
    // The time axis runs across; otherwise the variable with fewer values becomes the columns (or the series).
    var colVar, rowVar;
    if (a === 'period' || b === 'period') { colVar = 'period'; rowVar = a === 'period' ? b : a; }
    else if (a === 'concept' || b === 'concept') { rowVar = 'concept'; colVar = a === 'concept' ? b : a; }
    else if (V[a].mods.length >= V[b].mods.length) { rowVar = a; colVar = b; }
    else { rowVar = b; colVar = a; }
    var rv = V[rowVar], cv = V[colVar];
    var pos = {};
    c.vars.forEach(function(v, i) { pos[v] = i; });
    var cells = viewCells(c);
    var grid = {};
    cells.forEach(function(cell) { grid[cell[pos[rowVar]] + '|' + cell[pos[colVar]]] = cell; });
    var cols = keptMods(colVar);
    var rowsAll = rowVar === 'concept' ? uniqueRows(cells, pos.concept) : keptMods(rowVar);
    var at = function(ri, ci) { return measureAt(grid[ri + '|' + ci], c, metric); };
    var rowMargin = function(ri) { var at1 = {}; at1[rowVar] = ri; var m = marginCell([rowVar], at1); return m ? measureAt(m.cell, m.crossing, metric) : null; };
    var colMargin = function(ci) { var at1 = {}; at1[colVar] = ci; var m = marginCell([colVar], at1); return m ? measureAt(m.cell, m.crossing, metric) : null; };
    var hasRowMargin = !!marginCell([rowVar], {});
    var hasColMargin = !!marginCell([colVar], {});

    // Rows ranked by their own total when there are many (concepts, services).
    var rankKey = function(ri) { var m = hasRowMargin ? rowMargin(ri) : null; if (m && m.v != null) return m.v; var s = 0; cols.forEach(function(ci) { s = Math.max(s, at(ri, ci).v || 0); }); return s; };
    var ranked = rowsAll;
    var capped = false;
    if (rowVar === 'concept' || (rowVar === 'service' && rowsAll.length > 20)) {
      ranked = rowsAll.slice().sort(function(x, y) { return rankKey(y) - rankKey(x); });
      if (ranked.length > S.topN) { ranked = ranked.slice(0, S.topN); capped = true; }
    }
    var rows = ranked.map(function(i) { return { i: i, name: rv.names[i] }; });
    var colObjs = cols.map(function(i) { return { i: i, name: cv.names[i] }; });


    var rowPartition = rv.partition[metric], colPartition = cv.partition[metric];
    var ser = function(list, getVal) {
      var v = list === colObjs ? colVar : rowVar;
      return list.map(function(o, k) { return { name: o.name, color: v === 'sex' ? SEX_COLOR[V.sex.mods[o.i]] || OTHERS_COLOR : colorFor(k, list.length), vals: getVal(o) }; });
    };

    // Age × sex: a pyramid says it best.
    if ((rowVar === 'age' && colVar === 'sex') || (rowVar === 'sex' && colVar === 'age')) {
      var ageRows = rowVar === 'age' ? rows : colObjs, sexCols = rowVar === 'age' ? colObjs : rows;
      var male = sexCols.filter(function(s) { return V.sex.mods[s.i] === 'male'; })[0], female = sexCols.filter(function(s) { return V.sex.mods[s.i] === 'female'; })[0];
      if (male && female) {
        var valAt = function(ageI, sexI) { return rowVar === 'age' ? at(ageI, sexI) : at(sexI, ageI); };
        block(tr('age_pyramid'), 'half', function(w) {
          return pyramid(w, ageRows.map(function(r) { return r.name; }), { name: V.sex.names[male.i], color: SEX_COLOR.male, vals: ageRows.map(function(r) { return valAt(r.i, male.i); }) }, { name: V.sex.names[female.i], color: SEX_COLOR.female, vals: ageRows.map(function(r) { return valAt(r.i, female.i); }) }, { title: tr('age_pyramid') });
        });
      }
    }

    if (colVar === 'period') {
      var lineRows = rows.slice(0, Math.min(rows.length, 8));
      var series = ser(lineRows, function(r) { return colObjs.map(function(col) { return at(r.i, col.i); }); });
      block(tr('over_time_by', { unit: unit, var: rv.label.toLowerCase() }), 'full', function(w) { return lineChart(w, colObjs.map(function(col) { return col.name; }), series, { title: unit, unit: unit }) + legend(series); },
        { sub: rows.length > lineRows.length ? tr('largest_of', { n: lineRows.length, m: rows.length }) : '', head: rowVar === 'concept' || rowVar === 'service' ? topNControl(rowsAll.length) : '' });
      if (rowPartition && rows.length <= 12) {
        var stackSeries = ser(rows, function(r) { return colObjs.map(function(col) { return at(r.i, col.i); }); });
        block(tr('composition_over_time'), 'full', function(w) { return barsBySeries(w, colObjs.map(function(col) { return col.name; }), stackSeries, { title: tr('composition_over_time'), mode: 'percent' }) + legend(stackSeries); },
          { note: tr('composition_note', { var: rv.label.toLowerCase(), unit: periodUnit(cv) }) });
      }
    } else {
      var seriesCols = colObjs.slice(0, 12);
      var horizontal = rowVar === 'concept' || rowVar === 'service' || rows.length > 16;
      var bySeries = ser(seriesCols, function(col) { return rows.map(function(r) { return at(r.i, col.i); }); });
      var catNames = rows.map(function(r) { return r.name; });
      var byTwo = tr('by_two', { unit: unit, a: rv.label.toLowerCase(), b: cv.label.toLowerCase() });
      if (colPartition) {
        block(byTwo, horizontal ? 'full' : 'half', function(w) { return barsBySeries(w, catNames, bySeries, { title: byTwo, mode: 'stack', horizontal: horizontal }) + legend(bySeries); });
        block(tr('within_each', { a: cv.label, b: rv.label.toLowerCase() }), horizontal ? 'full' : 'half', function(w) { return barsBySeries(w, catNames, bySeries, { title: byTwo, mode: 'percent', horizontal: horizontal }) + legend(bySeries); },
          { note: tr('composition_masked_note') });
      } else if (rows.length * seriesCols.length <= 160) {
        block(byTwo, 'full', function(w) { return barsBySeries(w, catNames, bySeries, { title: byTwo, mode: 'group', horizontal: horizontal }) + legend(bySeries); },
          { note: tr('grouped_note', { things: plural(colVar) }) });
      }
    }

    block(rv.label + ' × ' + cv.label, 'full', function() {
      return heatmap(rows, colObjs, function(r, col) { return at(rows[r].i, colObjs[col].i); }, {
        unit: unit, rowLabel: rv.label, colLabel: cv.label, rowPlural: plural(rowVar), colPlural: plural(colVar),
        rowAll: hasRowMargin ? function(r) { return rowMargin(rows[r].i); } : null,
        colAll: hasColMargin ? function(col) { return colMargin(colObjs[col].i); } : null,
      });
    }, {
      sub: capped ? tr('largest_of', { n: rows.length, m: rowsAll.length }) : '',
      head: capped || rowsAll.length > 10 ? (rowVar === 'concept' || rowVar === 'service' ? topNControl(rowsAll.length) : '') : '',
      note: hasRowMargin || hasColMargin ? tr('all_margin_note', { var: (hasRowMargin ? cv.label : rv.label).toLowerCase() }) : '',
      csv: { name: (opts.fileBase || 'catalog') + '-' + slug(rowVar + '-' + colVar) + '-pivot.csv', text: function() {
        var lines = [[rv.label + ' \\ ' + cv.label].concat(colObjs.map(function(col) { return col.name; }))];
        rows.forEach(function(r) { lines.push([r.name].concat(colObjs.map(function(col) { var m = at(r.i, col.i); return m.st ? MASK_TEXT[m.st] : String(m.v); }))); });
        return csvText(lines);
      } },
    });
    return crossingTable(c, metric, rowVar === 'concept' ? ['concept', colVar] : [rowVar, colVar].sort(function(x, y) { return ORDER.indexOf(x) - ORDER.indexOf(y); }));
  }

  function uniqueRows(cells, p) {
    var seen = {}, out = [];
    cells.forEach(function(cell) { if (!seen[cell[p]]) { seen[cell[p]] = true; out.push(cell[p]); } });
    return out;
  }

  /** The concept list: every concept with its own counts, whatever the variables. */
  function listView(metric, unit) {
    var key = { patients: 'patientCount', stays: 'visitCount', records: 'recordCount' }[metric];
    var rows = listRows();
    var published = rows.filter(function(r) { return !r[ANON]; });
    var masked = rows.length - published.length;

    var ranked = published.slice().sort(function(a, b) { return b[LCOL[key]] - a[LCOL[key]]; });
    var top = ranked.slice(0, S.topN).map(function(r) { return { name: r[LCOL.conceptName], v: r[LCOL[key]], st: 0 }; });
    var total = metric === 'patients' ? DATA.totals.patients : null;
    block(tr('top_n', { n: top.length, things: tr('thing_concept') }), LCOL.category != null ? 'half' : 'full', function(w) {
      return hBars(w, top, { title: tr('top_concepts'), unit: unit, pctOf: total, pctLabel: tr('pct_of_patients'), color: VARIABLE_HEX.concept });
    }, { head: topNControl(published.length) });

    var catCrossing = V.concept && V.concept.level !== 'concept' ? X.concept : null;
    if (catCrossing) {
      var catMetric = metric === 'records' ? 'records' : 'patients';
      var catItems0 = itemsOf(catCrossing, 'concept', catMetric);
      block(tr('by_var', { unit: MEASURE[catMetric], var: V.concept.label.toLowerCase() }), 'full', function(w) {
        return hBars(w, catItems0.slice(0, 30), { title: V.concept.label, unit: MEASURE[catMetric], pctOf: catMetric === 'records' ? null : DATA.totals.patients, pctLabel: tr('pct_of_patients'), color: PALETTE[4] });
      }, { note: maskNote(catItems0) });
    }

    if (LCOL.category != null) {
      var byCat = {}, conceptsPerCat = {};
      published.forEach(function(r) {
        var cat = r[LCOL.category] || tr('uncategorised');
        byCat[cat] = (byCat[cat] || 0) + (r[LCOL.recordCount] || 0);
      });
      rows.forEach(function(r) { var cat = r[LCOL.category] || tr('uncategorised'); conceptsPerCat[cat] = (conceptsPerCat[cat] || 0) + 1; });
      var catItems = Object.keys(byCat).map(function(k) { return { name: k, v: byCat[k] }; }).sort(function(a, b) { return b.v - a.v; });
      var slices = catItems.slice(0, 9).map(function(it, k) { return { name: it.name, v: it.v, color: PALETTE[k] }; });
      var rest = 0;
      catItems.slice(9).forEach(function(it) { rest += it.v; });
      if (rest) slices.push({ name: tr('others'), v: rest, color: OTHERS_COLOR });
      if (slices.length) block(tr('records_by_category'), 'half', function(w) { return donut(w, slices, { title: tr('records_by_category'), unit: tr('records') }); }, { note: masked ? tr('published_concepts_only') : '' });
      var perCat = Object.keys(conceptsPerCat).map(function(k) { return { name: k, v: conceptsPerCat[k], st: 0 }; }).sort(function(a, b) { return b.v - a.v; });
      block(tr('concepts_per_category'), 'full', function(w) { return hBars(w, perCat.slice(0, 30), { title: tr('concepts_per_category'), unit: tr('concepts'), color: PALETTE[1] }); });
    }

    return {
      kind: 'concepts',
      columns: LIST.cols,
      rows: rows.map(function(a) {
        var r = { _anon: a[ANON] === true };
        LIST.cols.forEach(function(c, i) { r[c.key] = a[i]; });
        return r;
      }),
      searchKeys: ['conceptId', 'conceptName'],
      searchPlaceholder: tr('search_concepts'),
      initialSort: { key: key, desc: true },
      noun: [tr('concept'), tr('concepts_noun')],
      emptyText: tr('no_concept_matches'),
      note: opts.conceptNote || '',
      csvFileName: (opts.fileBase || 'catalog') + '-concepts.csv',
    };
  }

  // ---- What the host's controls need ----
  /** Pick a crossing; filters of variables it does not hold are dropped. */
  function setCrossing(id) {
    var vars = varsOf(id);
    S.crossing = id;
    Object.keys(S.sel).forEach(function(v) { if (vars.indexOf(v) === -1) delete S.sel[v]; });
    if (vars.indexOf('period') === -1) S.range = null;
    if (vars.indexOf('concept') === -1) { S.cq = ''; S.ccat = ''; }
    S.pin = null; S.pinVal = null;
    derive();
  }
  function toggleSel(v, i) {
    var n = V[v].mods.length;
    var sel = S.sel[v];
    if (!sel) { sel = {}; for (var k = 0; k < n; k++) sel[k] = true; }
    if (sel[i]) delete sel[i]; else sel[i] = true;
    if (Object.keys(sel).length === n) delete S.sel[v]; else S.sel[v] = sel;
  }
  function reset() { S.sel = {}; S.range = null; S.cq = ''; S.ccat = ''; S.pinVal = null; derive(); }
  /** The concept filter's categories: of the concept variable, or of the concept list. */
  function conceptCategories() {
    var cv = V.concept;
    return cv && cv.level === 'concept' && cv.categories && !isListView() ? uniqueSorted(cv.categories) : listCategories;
  }

  derive();
  return {
    S: S,
    V: V,
    options: options,
    varsOf: varsOf,
    varLabel: varLabel,
    plural: plural,
    measures: measuresOf,
    measureLabel: function(m) { return MEASURE[m]; },
    isListView: isListView,
    canUnpin: function() { derive(); return !!S.pin && canUnpin(); },
    setCrossing: setCrossing,
    toggleSel: toggleSel,
    reset: reset,
    conceptCategories: conceptCategories,
    view: view,
    tr: tr,
  };
}
