/*
 * Behaviour of the standalone catalog page. Inlined as-is by export-html.ts
 * (imported `?raw`), after TABLE_HELPERS and inside an IIFE, so it runs in any
 * browser with no build step and no network.
 *
 * Globals the page declares before it: DATA (published crossings, variables,
 * concept list, totals — see lib/data-catalog/publish.ts), META, ICONS.
 *
 * Explore tab: the reader picks one or two variables to DISPLAY and may narrow
 * the others down to ONE modality each. The cells shown always come from the
 * single crossing holding exactly those variables — never a sum of cells: a
 * patient counted in 2023 and in 2024 is one patient, not two, and a masked
 * cell cannot be added to anything. So a variable can be filtered only when a
 * crossing with it was computed, and "several periods" means displaying them.
 */

var NNBSP = String.fromCharCode(8239);
function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function slug(s) { return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'table'; }
// The in-app preview is a sandboxed iframe: without allow-downloads the browser drops the click silently.
function downloadFile(fileName, text, type) {
  try {
    var url = URL.createObjectURL(new Blob([type === 'text/csv' ? '﻿' + text : text], { type: type + ';charset=utf-8' }));
    var a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function() { URL.revokeObjectURL(url); }, 10000);
  } catch (err) { /* nothing to fall back to without a download permission */ }
}
function downloadCsv(fileName, text) { downloadFile(fileName, text, 'text/csv'); }
function $(id) { return document.getElementById(id); }
function each(list, fn) { Array.prototype.forEach.call(list, fn); }

// ---- Tabs ----
var tabs = document.querySelectorAll('.tab');
each(tabs, function(t) {
  t.addEventListener('click', function() {
    each(tabs, function(x) { x.classList.toggle('active', x === t); x.setAttribute('aria-selected', x === t ? 'true' : 'false'); });
    each(document.querySelectorAll('.tab-content'), function(c) { c.classList.toggle('active', c.id === 'tab-' + t.dataset.tab); });
    // Charts are sized on their container, which has no width while its tab is hidden.
    if (t.dataset.tab === 'explore') drawCharts();
  });
});

// ---- JSON-LD viewer ----
var overlay = $('jsonld-overlay');
function closeOverlay() { overlay.classList.remove('open'); }
$('open-jsonld').addEventListener('click', function() { overlay.classList.add('open'); });
$('close-jsonld').addEventListener('click', closeOverlay);
overlay.addEventListener('click', function(e) { if (e.target === overlay) closeOverlay(); });
document.addEventListener('keydown', function(e) { if (e.key === 'Escape') closeOverlay(); });
$('download-jsonld').addEventListener('click', function() {
  downloadFile(META.fileBase + '-metadata.jsonld', $('jsonld-code').textContent || '', 'application/ld+json');
});
var copyBtn = $('copy-jsonld');
copyBtn.addEventListener('click', function() {
  var code = $('jsonld-code');
  var done = function() {
    var label = copyBtn.querySelector('span');
    label.textContent = 'Copied';
    setTimeout(function() { label.textContent = 'Copy'; }, 1500);
  };
  // The in-app preview is a sandboxed iframe without clipboard access.
  var fallback = function() {
    var range = document.createRange();
    range.selectNodeContents(code);
    var sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    try { if (document.execCommand('copy')) done(); } catch (err) { /* selection stays for a manual copy */ }
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(code.textContent || '').then(done, fallback);
  } else fallback();
});

// ---- Schema: table filter, TOC and diagram navigation ----
function goToTable(id) {
  var card = $(id);
  if (!card) return;
  card.scrollIntoView({ behavior: 'smooth', block: 'start' });
  card.classList.add('flash');
  setTimeout(function() { card.classList.remove('flash'); }, 1200);
  each(document.querySelectorAll('.toc-item'), function(it) { it.classList.toggle('active', it.dataset.target === id); });
}
each(document.querySelectorAll('.toc-item'), function(it) {
  it.addEventListener('click', function(e) { e.preventDefault(); goToTable(it.dataset.target); });
});
each(document.querySelectorAll('.erd .node'), function(n) {
  n.addEventListener('click', function() { goToTable(n.getAttribute('data-target')); });
});
var tocFilter = $('toc-filter');
if (tocFilter) tocFilter.addEventListener('input', function() {
  var q = tocFilter.value.trim().toLowerCase();
  each(document.querySelectorAll('.toc-item'), function(it) {
    var show = !q || it.dataset.name.indexOf(q) !== -1;
    it.style.display = show ? '' : 'none';
    var card = $(it.dataset.target);
    if (card) card.style.display = show ? '' : 'none';
  });
});

// ---- Tooltip: any element with data-tip (trusted HTML, escaped into the attribute) ----
var tip = document.createElement('div');
tip.className = 'tip';
document.body.appendChild(tip);
var tipTarget = null;
document.addEventListener('mouseover', function(e) {
  var t = e.target && e.target.closest ? e.target.closest('[data-tip]') : null;
  if (t === tipTarget) return;
  tipTarget = t;
  if (!t) { tip.classList.remove('on'); return; }
  tip.innerHTML = t.getAttribute('data-tip');
  tip.classList.add('on');
});
document.addEventListener('mousemove', function(e) {
  if (!tipTarget) return;
  var r = tip.getBoundingClientRect();
  var x = e.clientX + 14, y = e.clientY + 14;
  if (x + r.width > window.innerWidth - 8) x = e.clientX - r.width - 14;
  if (y + r.height > window.innerHeight - 8) y = e.clientY - r.height - 14;
  tip.style.transform = 'translate(' + Math.max(8, x) + 'px,' + Math.max(8, y) + 'px)';
});
function tipAttr(title, lines) {
  var html = '<b>' + escHtml(title) + '</b>' + (lines || []).map(function(l) {
    return '<div class="tl">' + (l.color ? '<i style="background:' + l.color + '"></i>' : '') + '<span>' + escHtml(l.label) + '</span><em>' + escHtml(l.value) + '</em></div>';
  }).join('');
  return ' data-tip="' + escHtml(html) + '"';
}

// ---- Data ----
var ORDER = ['concept', 'period', 'service', 'age', 'sex'];
var T = DATA.threshold;
var V = DATA.variables;
var X = {};
DATA.crossings.forEach(function(c) { X[c.id] = c; });
var LIST = DATA.concepts;
var hasList = LIST.rows.length > 0;
var MEASURE = { patients: 'Patients', stays: 'Stays', records: 'Records' };
var MASK_TEXT = { 1: '< ' + T, 2: 'masked', 3: '< ' + T };
var MASK_TIP = {
  1: 'Fewer than ' + T + ' patients — masked',
  2: 'Masked to protect a small cell nearby (secondary suppression)',
  3: 'Fewer than ' + T + ' patients',
};
var PALETTE = ['#0084d8', '#14b8a6', '#f59e0b', '#e11d48', '#8b5cf6', '#22c55e', '#f97316', '#0ea5e9', '#a855f7', '#64748b', '#84cc16', '#ec4899'];
var OTHERS_COLOR = '#94a3b8';
// Sex keeps the same colours in every chart, so a reader never has to re-learn them.
var SEX_COLOR = { male: PALETTE[0], female: PALETTE[1], other: PALETTE[2] };

function keyOf(vars) { return ORDER.filter(function(v) { return vars.indexOf(v) !== -1; }).join('-'); }
function varLabel(v) { return V[v] ? V[v].label : v === 'concept' ? 'Concept' : v; }
function available(vars) {
  var k = keyOf(vars);
  return !!X[k] || (k === 'concept' && hasList);
}
var CHIP_VARS = ORDER.filter(function(v) { return V[v] || (v === 'concept' && hasList); });

// Concept list: column index by key, and each concept's category for the filter.
var LCOL = {};
LIST.cols.forEach(function(c, i) { LCOL[c.key] = i; });
var ANON = LIST.cols.length;
var listCategories = LCOL.category == null ? [] : uniqueSorted(LIST.rows.map(function(r) { return r[LCOL.category]; }));
function uniqueSorted(values) {
  var seen = {}, out = [];
  values.forEach(function(v) { if (v != null && v !== '' && !seen[v]) { seen[v] = true; out.push(String(v)); } });
  return out.sort(function(a, b) { return a.localeCompare(b, 'en', { numeric: true }); });
}

// ---- State ----
var S = {
  display: [CHIP_VARS.indexOf('period') !== -1 ? 'period' : CHIP_VARS.indexOf('age') !== -1 ? 'age' : CHIP_VARS[0]],
  metric: 'patients',
  sel: {},       // displayed nominal variable → { modality index: true }, absent = all
  range: null,   // displayed period → [first, last] index
  slice: {},     // variable not displayed → one modality index
  cq: '',        // concept search
  ccat: '',      // concept category
  topN: 20,
  scale: 'row',
  periodMode: 'slider',
};
function sourceVars() { return S.display.concat(Object.keys(S.slice)); }
function isListView() { return S.display.length === 1 && S.display[0] === 'concept' && !Object.keys(S.slice).length && hasList; }
function sourceCrossing() { return X[keyOf(sourceVars())] || null; }
function measuresOf() {
  if (isListView()) return ['patients', 'stays', 'records'];
  var c = sourceCrossing();
  return c ? ['patients', c.second] : ['patients'];
}
function secondOf(c) { return c ? c.second : 'stays'; }

// Concept match for the search box and category, cached per filter value.
var conceptMatchCache = { key: null, ok: null };
function fuzzy(needle, hay) {
  if (hay.indexOf(needle) !== -1) return true;
  var n = 0;
  for (var k = 0; k < hay.length && n < needle.length; k++) if (hay[k] === needle[n]) n++;
  return n === needle.length;
}
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

/** The source crossing's cells for the current slices and displayed filters. */
function viewCells(c) {
  var pos = {};
  c.vars.forEach(function(v, i) { pos[v] = i; });
  var sliced = Object.keys(S.slice);
  return c.cells.filter(function(cell) {
    for (var s = 0; s < sliced.length; s++) if (cell[pos[sliced[s]]] !== S.slice[sliced[s]]) return false;
    for (var d = 0; d < S.display.length; d++) if (!keepMod(S.display[d], cell[pos[S.display[d]]])) return false;
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
/** The published cell of `vars` at the given modalities (plus the current slices), or undefined. */
function marginCell(vars, at) {
  var all = vars.concat(Object.keys(S.slice));
  var c = X[keyOf(all)];
  if (!c) return undefined;
  // Crossings with the concept variable count events, the others visits: a
  // total over one population is no margin of a table over the other.
  if ((all.indexOf('concept') !== -1) !== (sourceVars().indexOf('concept') !== -1)) return undefined;
  var key = c.vars.map(function(v) { return v in at ? at[v] : S.slice[v]; }).join('|');
  return { cell: lookup(c)[key] || null, crossing: c };
}
function measureAt(cell, c, metric) {
  var n = c.vars.length;
  if (!cell) return { v: null, st: 3 };
  var st = cell[n + 2];
  if (st) return { v: null, st: st };
  return { v: metric === 'patients' ? cell[n] : cell[n + 1], st: 0 };
}
function shown(m) { return m.st ? MASK_TEXT[m.st] : fmt(m.v); }
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
function svgOpen(w, h, label) {
  var id = 'h' + (++hatchSeq);
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
  var charW = 6.2;
  var every = Math.max(1, Math.ceil((Math.min(longest, 14) * charW + 10) / Math.max(1, maxW)));
  names.forEach(function(nm, i) {
    if (i % every) return;
    p.push('<text x="' + xOf(i).toFixed(1) + '" y="' + y + '" text-anchor="middle" class="tick x">' + escHtml(truncate(nm, 14)) + '</text>');
  });
}
function maxOf(values) { var m = 0; values.forEach(function(v) { if (v != null && v > m) m = v; }); return m; }

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
    var tipLines = [{ label: o.unit, value: shown(it) }];
    if (it.st) tipLines.push({ label: '', value: MASK_TIP[it.st] });
    var t = tipAttr(it.name, tipLines);
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

/** Labelled horizontal bars, largest first as given. items: [{ name, v, st }]. */
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
    var t = tipAttr(it.name, [{ label: o.unit, value: shown(it) }].concat(o.pctOf && !it.st ? [{ label: o.pctLabel || 'Share', value: pct(it.v, o.pctOf) }] : []).concat(it.st ? [{ label: '', value: MASK_TIP[it.st] }] : []));
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
    var t = tipAttr(it.name, [{ label: o.unit, value: fmt(it.v) }, { label: 'Share', value: pct(it.v, total) }]);
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
    p.push('<g' + tipAttr(it.name, [{ label: o.unit, value: fmt(it.v) }, { label: 'Share', value: pct(it.v, total) }]) + '><rect x="' + lx + '" y="' + (y + 3) + '" width="11" height="11" rx="2.5" fill="' + it.color + '"/>'
      + '<text x="' + (lx + 18) + '" y="' + (y + 12.5) + '" class="lbl">' + escHtml(truncate(it.name, side ? Math.floor((w - lx - 80) / 6.4) : 34)) + '</text>'
      + '<text x="' + (w - 8) + '" y="' + (y + 12.5) + '" text-anchor="end" class="val strong">' + pct(it.v, total) + '</text></g>');
  });
  return s.head + p.join('') + '</svg>';
}

/**
 * Categories split by series: stacked (parts of a whole), 100 % stacked, or
 * grouped side by side (when the parts overlap and a stack would add them up).
 * cats: names; series: [{ name, color, vals: [{ v, st }] }].
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
var dark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
var LO = dark ? [27, 40, 58] : [238, 245, 251], HI = dark ? [61, 143, 209] : [31, 94, 151];
function heat(t) {
  var c = [0, 1, 2].map(function(i) { return Math.round(LO[i] + t * (HI[i] - LO[i])); });
  return 'rgb(' + c.join(',') + ')';
}
/** rows/cols: [{ name }]; at(r, c) → { v, st }; rowAll(r)/colAll(c)/all → margins or null. */
function heatmap(rows, cols, at, o) {
  var grid = rows.map(function(_, r) { return cols.map(function(_, c) { return at(r, c); }); });
  var globalMax = 0;
  grid.forEach(function(line) { line.forEach(function(m) { if (m.v > globalMax) globalMax = m.v; }); });
  var h = '<div class="hm-scroll"><table class="hm-t"><thead><tr><th class="corner">' + escHtml(o.rowLabel) + ' <span>╲</span> ' + escHtml(o.colLabel) + '</th>';
  cols.forEach(function(c) { h += '<th title="' + escHtml(c.name) + '">' + escHtml(c.name) + '</th>'; });
  if (o.rowAll) h += '<th class="all">All ' + escHtml(o.colPlural) + '</th>';
  h += '</tr></thead><tbody>';
  var cell = function(m, max, title) {
    if (m.st) return '<td class="masked m' + m.st + '"' + tipAttr(title, [{ label: o.unit, value: MASK_TEXT[m.st] }, { label: '', value: MASK_TIP[m.st] }]) + '>' + MASK_TEXT[m.st] + '</td>';
    var t = max ? m.v / max : 0;
    return '<td class="num" style="background:' + heat(t) + ';color:' + (t > 0.55 ? '#fff' : 'inherit') + '"' + tipAttr(title, [{ label: o.unit, value: fmt(m.v) }]) + '>' + compact(m.v) + '</td>';
  };
  grid.forEach(function(line, r) {
    var rowMax = maxOf(line.map(function(m) { return m.v; }));
    var max = S.scale === 'row' ? rowMax : globalMax;
    h += '<tr><th class="row" title="' + escHtml(rows[r].name) + '">' + escHtml(rows[r].name) + '</th>';
    line.forEach(function(m, c) { h += cell(m, max, rows[r].name + ' · ' + cols[c].name); });
    if (o.rowAll) { var ra = o.rowAll(r); h += '<td class="all' + (ra.st ? ' masked' : '') + '"' + tipAttr(rows[r].name + ' · all ' + o.colPlural, [{ label: o.unit, value: shown(ra) }]) + '>' + (ra.st ? MASK_TEXT[ra.st] : compact(ra.v)) + '</td>'; }
    h += '</tr>';
  });
  if (o.colAll) {
    h += '<tr class="all-row"><th class="row">All ' + escHtml(o.rowPlural) + '</th>';
    cols.forEach(function(c, j) { var ca = o.colAll(j); h += '<td class="all' + (ca.st ? ' masked' : '') + '"' + tipAttr(c.name + ' · all ' + o.rowPlural, [{ label: o.unit, value: shown(ca) }]) + '>' + (ca.st ? MASK_TEXT[ca.st] : compact(ca.v)) + '</td>'; });
    if (o.rowAll) h += '<td class="all"></td>';
    h += '</tr>';
  }
  h += '</tbody></table></div>';
  h += '<div class="hm-scale"><span>0</span><span class="bar" style="background:linear-gradient(90deg,' + heat(0) + ',' + heat(1) + ')"></span><span>' + (S.scale === 'row' ? 'row max' : 'max') + '</span><span class="mask"></span><span>masked</span>'
    + '<span class="spacer"></span><div class="seg mini" data-act="scale"><button type="button" data-v="row"' + (S.scale === 'row' ? ' class="active"' : '') + '>Per row</button><button type="button" data-v="all"' + (S.scale === 'all' ? ' class="active"' : '') + '>Whole table</button></div></div>';
  return h;
}

// ---- Explore: sidebar ----
var side = $('xp-side');
var main = $('xp-main');
var blocks = [];

function periodBounds(code) {
  var q = /^(\d{4})-Q([1-4])$/.exec(code);
  if (q) { var m0 = (Number(q[2]) - 1) * 3 + 1; return [q[1] + '-' + pad2(m0) + '-01', q[1] + '-' + pad2(m0 + 2) + '-' + lastDay(q[1], m0 + 2)]; }
  var m = /^(\d{4})-(\d{2})$/.exec(code);
  if (m) return [code + '-01', code + '-' + lastDay(m[1], Number(m[2]))];
  return [code + '-01-01', code + '-12-31'];
}
function pad2(n) { return (n < 10 ? '0' : '') + n; }
function lastDay(y, m) { return pad2(new Date(Date.UTC(Number(y), m, 0)).getUTCDate()); }

function chipHtml(v) {
  var on = S.display.indexOf(v) !== -1;
  var next = on ? null : S.display.concat([v]).concat(Object.keys(S.slice).filter(function(s) { return s !== v; }));
  var ok = on ? S.display.length > 1 : S.display.length < 2 && available(next);
  var why = on ? (S.display.length > 1 ? 'Stop displaying' : 'At least one variable is displayed') : S.display.length >= 2 ? 'Two variables at most — narrow the others down below' : ok ? 'Display' : 'Not crossed with ' + S.display.map(varLabel).join(' × ') + ' in this catalog';
  return '<button type="button" class="chip' + (on ? ' on' : '') + '" data-act="display" data-v="' + v + '"' + (!on && !ok ? ' disabled' : '') + ' title="' + escHtml(why) + '">' + escHtml(varLabel(v)) + '</button>';
}

function nominalFilter(v) {
  var vr = V[v], sel = S.sel[v];
  var many = vr.mods.length > 14 || vr.names.some(function(nm) { return nm.length > 24; });
  var h = '<div class="flt"><div class="flt-head"><span>' + escHtml(vr.label) + '</span><span class="spacer"></span>'
    + (sel ? '<button type="button" class="link" data-act="sel-all" data-v="' + v + '">All</button>' : '')
    + '<button type="button" class="link" data-act="sel-none" data-v="' + v + '">None</button></div>';
  if (many) h += '<input type="search" class="input flt-search" data-act="sel-search" data-v="' + v + '" placeholder="Filter ' + escHtml(vr.label.toLowerCase()) + 's…" autocomplete="off">';
  h += '<div class="' + (many ? 'checks' : 'pills') + '">';
  vr.names.forEach(function(nm, i) {
    var on = !sel || !!sel[i];
    h += many
      ? '<label class="check" data-name="' + escHtml(nm.toLowerCase()) + '"><input type="checkbox" data-act="sel" data-v="' + v + '" data-i="' + i + '"' + (on ? ' checked' : '') + '><span>' + escHtml(nm) + '</span></label>'
      : '<button type="button" class="pill-t' + (on ? ' on' : '') + '" data-act="sel" data-v="' + v + '" data-i="' + i + '">' + escHtml(nm) + '</button>';
  });
  return h + '</div></div>';
}

function periodFilter() {
  var vr = V.period, n = vr.mods.length;
  var r = S.range || [0, n - 1];
  var h = '<div class="flt"><div class="flt-head"><span>Period</span><span class="spacer"></span>'
    + '<div class="seg mini" data-act="pmode"><button type="button" data-v="slider"' + (S.periodMode === 'slider' ? ' class="active"' : '') + '>Slider</button><button type="button" data-v="calendar"' + (S.periodMode === 'calendar' ? ' class="active"' : '') + '>Calendar</button></div></div>';
  if (S.periodMode === 'slider') {
    h += '<div class="range"><div class="range-track"><div class="range-fill" id="range-fill"></div></div>'
      + '<input type="range" min="0" max="' + (n - 1) + '" value="' + r[0] + '" data-act="range" data-end="0" aria-label="First period">'
      + '<input type="range" min="0" max="' + (n - 1) + '" value="' + r[1] + '" data-act="range" data-end="1" aria-label="Last period"></div>'
      + '<div class="range-labels"><span id="range-lo">' + escHtml(vr.names[r[0]]) + '</span><span id="range-hi">' + escHtml(vr.names[r[1]]) + '</span></div>';
  } else {
    var min = periodBounds(vr.mods[0])[0], max = periodBounds(vr.mods[n - 1])[1];
    h += '<div class="cal"><label><span>From</span><input type="date" class="input" data-act="cal" data-end="0" min="' + min + '" max="' + max + '" value="' + periodBounds(vr.mods[r[0]])[0] + '"></label>'
      + '<label><span>To</span><input type="date" class="input" data-act="cal" data-end="1" min="' + min + '" max="' + max + '" value="' + periodBounds(vr.mods[r[1]])[1] + '"></label></div>'
      + '<div class="hint">Whole ' + (vr.granularity || 'period') + 's containing these dates are kept.</div>';
  }
  var presets = [['All', 0]];
  if (n > 12) presets.push(['Last 12', n - 12]);
  if (n > 5 && vr.granularity === 'year') presets.push(['Last 5', n - 5]);
  if (n > 24 && vr.granularity === 'month') presets.push(['Last 24', n - 24]);
  h += '<div class="presets">' + presets.map(function(pr) { return '<button type="button" class="link" data-act="range-preset" data-v="' + pr[1] + '">' + pr[0] + '</button>'; }).join('') + '</div>';
  return h + '</div>';
}

function conceptFilter() {
  var cv = V.concept;
  if (cv && cv.level !== 'concept' && !isListView()) return nominalFilter('concept');
  var cats = cv && cv.level === 'concept' && cv.categories && !isListView() ? uniqueSorted(cv.categories) : listCategories;
  var h = '<div class="flt"><div class="flt-head"><span>' + escHtml(isListView() || !cv ? 'Concept' : cv.label) + '</span></div>'
    + '<input type="search" class="input flt-search" id="concept-q" data-act="cq" placeholder="Search concepts…" value="' + escHtml(S.cq) + '" autocomplete="off">';
  if (cats.length) h += '<select class="select" data-act="ccat"><option value="">All categories</option>' + cats.map(function(c) { return '<option value="' + escHtml(c) + '"' + (S.ccat === c ? ' selected' : '') + '>' + escHtml(c) + '</option>'; }).join('') + '</select>';
  return h + '</div>';
}

function sliceControl(v) {
  var vr = V[v], cur = S.slice[v];
  var h = '<label class="slice"><span>' + escHtml(vr.label) + '</span>';
  if (vr.mods.length > 60) {
    // Too many for a select: search on names, the datalist resolves them.
    h += '<input type="search" class="input" list="dl-' + v + '" data-act="slice-text" data-v="' + v + '" placeholder="All — type to pick one" value="' + (cur != null ? escHtml(vr.names[cur]) : '') + '" autocomplete="off"><datalist id="dl-' + v + '">'
      + vr.names.map(function(nm) { return '<option value="' + escHtml(nm) + '">'; }).join('') + '</datalist>';
  } else {
    h += '<select class="select" data-act="slice" data-v="' + v + '"><option value="">All</option>'
      + vr.names.map(function(nm, i) { return '<option value="' + i + '"' + (cur === i ? ' selected' : '') + '>' + escHtml(nm) + '</option>'; }).join('') + '</select>';
  }
  return h + '</label>';
}

function renderSide() {
  var h = '<div class="xp-sec"><div class="xp-sec-t">Display</div><div class="chips">' + CHIP_VARS.map(chipHtml).join('') + '</div>'
    + '<div class="hint">One variable, or two crossed. Hover a greyed one to see why.</div></div>';
  var ms = measuresOf();
  if (ms.indexOf(S.metric) === -1) S.metric = 'patients';
  h += '<div class="xp-sec"><div class="xp-sec-t">Count</div><div class="seg full" data-act="metric">' + ms.map(function(m) {
    return '<button type="button" data-v="' + m + '"' + (S.metric === m ? ' class="active"' : '') + '>' + MEASURE[m] + '</button>';
  }).join('') + '</div></div>';

  var filters = S.display.map(function(v) {
    if (v === 'period') return periodFilter();
    if (v === 'concept') return conceptFilter();
    return nominalFilter(v);
  }).join('');
  h += '<div class="xp-sec"><div class="xp-sec-t">Filter what is displayed</div>' + filters + '</div>';

  var sliceable = CHIP_VARS.filter(function(v) {
    if (S.display.indexOf(v) !== -1 || !V[v]) return false;
    if (v in S.slice) return true;
    return available(sourceVars().concat([v]));
  });
  if (sliceable.length) {
    h += '<div class="xp-sec"><div class="xp-sec-t">Narrow down to one value</div>' + sliceable.map(sliceControl).join('')
      + '<div class="hint">Only variables computed together with the displayed ones can be narrowed down.</div></div>';
  }
  h += '<button type="button" class="btn full" data-act="reset">' + ICONS.x + 'Reset</button>';
  side.innerHTML = h;
  paintRange();
}

function paintRange() {
  var fill = $('range-fill');
  if (!fill || !V.period) return;
  var n = V.period.mods.length, r = S.range || [0, n - 1];
  var d = Math.max(1, n - 1);
  fill.style.left = (r[0] / d * 100) + '%';
  fill.style.right = (100 - r[1] / d * 100) + '%';
  $('range-lo').textContent = V.period.names[r[0]];
  $('range-hi').textContent = V.period.names[r[1]];
}

/** Drop the slices that no longer combine with what is displayed. */
function fitSlices() {
  var keys = Object.keys(S.slice);
  while (keys.length && !available(sourceVars())) {
    delete S.slice[keys.pop()];
  }
}

var debounceTimer;
function later(fn, ms) { clearTimeout(debounceTimer); debounceTimer = setTimeout(fn, ms); }

side.addEventListener('click', function(e) {
  var b = e.target.closest('[data-act]');
  if (!b || b.disabled) return;
  var act = b.dataset.act, v = b.dataset.v;
  if (act === 'display') {
    var i = S.display.indexOf(v);
    if (i !== -1) { S.display.splice(i, 1); delete S.sel[v]; if (v === 'period') S.range = null; }
    else {
      S.display.push(v);
      // A variable narrowed down to one value keeps that value, as a filter.
      if (v in S.slice) {
        if (v === 'period') S.range = [S.slice[v], S.slice[v]];
        else if (v !== 'concept') { S.sel[v] = {}; S.sel[v][S.slice[v]] = true; }
        delete S.slice[v];
      }
    }
    fitSlices();
  } else if (act === 'sel' && b.tagName === 'BUTTON') {
    toggleSel(v, Number(b.dataset.i));
  } else if (act === 'sel-all') { delete S.sel[v]; }
  else if (act === 'sel-none') { S.sel[v] = {}; }
  else if (act === 'reset') {
    S.sel = {}; S.slice = {}; S.range = null; S.cq = ''; S.ccat = '';
  } else if (act === 'range-preset') {
    var n = V.period.mods.length;
    S.range = Number(v) ? [Number(v), n - 1] : null;
  } else if (e.target.closest('[data-act="metric"] button')) {
    S.metric = e.target.closest('button').dataset.v;
  } else if (e.target.closest('[data-act="pmode"] button')) {
    S.periodMode = e.target.closest('button').dataset.v;
  } else return;
  renderSide();
  renderMain();
});
function toggleSel(v, i) {
  var n = V[v].mods.length;
  var sel = S.sel[v];
  if (!sel) { sel = {}; for (var k = 0; k < n; k++) sel[k] = true; }
  if (sel[i]) delete sel[i]; else sel[i] = true;
  S.sel[v] = Object.keys(sel).length === n ? undefined : sel;
  if (!S.sel[v]) delete S.sel[v];
}
side.addEventListener('change', function(e) {
  var el = e.target, act = el.dataset.act, v = el.dataset.v;
  if (act === 'sel') { toggleSel(v, Number(el.dataset.i)); renderMain(); return; }
  if (act === 'ccat') { S.ccat = el.value; renderMain(); return; }
  if (act === 'slice') {
    if (el.value === '') delete S.slice[v]; else S.slice[v] = Number(el.value);
  } else if (act === 'slice-text') {
    var i = V[v].names.indexOf(el.value);
    if (i === -1) delete S.slice[v]; else S.slice[v] = i;
  } else if (act === 'cal') {
    var mods = V.period.mods, r = S.range ? S.range.slice() : [0, mods.length - 1];
    var end = Number(el.dataset.end), date = el.value;
    if (date) {
      var idx = -1;
      for (var k = 0; k < mods.length; k++) {
        var b = periodBounds(mods[k]);
        if (end === 0 ? b[1] >= date : b[0] <= date) { idx = k; if (end === 0) break; }
      }
      if (idx !== -1) r[end] = idx;
    } else r[end] = end === 0 ? 0 : mods.length - 1;
    if (r[0] > r[1]) r = end === 0 ? [r[0], r[0]] : [r[1], r[1]];
    S.range = r[0] === 0 && r[1] === mods.length - 1 ? null : r;
  } else return;
  renderSide();
  renderMain();
});
side.addEventListener('input', function(e) {
  var el = e.target, act = el.dataset.act;
  if (act === 'cq') { S.cq = el.value; later(renderMain, 200); }
  else if (act === 'sel-search') {
    var q = el.value.trim().toLowerCase();
    each(el.parentNode.querySelectorAll('.check'), function(c) { c.style.display = !q || c.dataset.name.indexOf(q) !== -1 ? '' : 'none'; });
  } else if (act === 'range') {
    var n = V.period.mods.length, r = S.range ? S.range.slice() : [0, n - 1];
    var end = Number(el.dataset.end), val = Number(el.value);
    r[end] = val;
    if (r[0] > r[1]) { r[1 - end] = val; }
    S.range = r[0] === 0 && r[1] === n - 1 ? null : r;
    each(side.querySelectorAll('input[data-act="range"]'), function(x) { x.value = r[Number(x.dataset.end)]; });
    paintRange();
    later(renderMain, 120);
  }
});

// ---- Explore: main ----
main.addEventListener('click', function(e) {
  var b = e.target.closest('[data-act] button, button[data-act]');
  if (!b) return;
  var group = b.closest('[data-act]');
  var act = group.dataset.act;
  if (act === 'scale') { S.scale = b.dataset.v; renderMain(); }
  else if (act === 'topn') { S.topN = Number(b.dataset.v); renderMain(); }
  else if (act === 'csv-block') { var bl = blocks[Number(b.dataset.i)]; if (bl && bl.csv) downloadCsv(bl.csv.name, bl.csv.text()); }
});

function colorFor(i, count) { return count > PALETTE.length && i >= PALETTE.length - 1 ? OTHERS_COLOR : PALETTE[i % PALETTE.length]; }
function plural(v) {
  return { concept: 'concepts', period: 'periods', service: V.service && V.service.label === 'Visit type' ? 'visit types' : 'care units', age: 'age groups', sex: 'sexes' }[v] || v;
}
function sliceText() {
  return Object.keys(S.slice).map(function(v) { return V[v].label + ': ' + V[v].names[S.slice[v]]; });
}
function block(title, size, render, extra) {
  blocks.push({ title: title, size: size, render: render, sub: extra && extra.sub, csv: extra && extra.csv, note: extra && extra.note, head: extra && extra.head });
}
function topNControl(total) {
  if (total <= 10) return '';
  return '<div class="seg mini" data-act="topn">' + [10, 20, 50].filter(function(n, i) { return i === 0 || total > [10, 20, 50][i - 1]; }).map(function(n) {
    return '<button type="button" data-v="' + n + '"' + (S.topN === n ? ' class="active"' : '') + '>Top ' + n + '</button>';
  }).join('') + '</div>';
}

function stat(label, value, sub) {
  return '<div class="st"><div class="st-v num">' + escHtml(value) + '</div><div class="st-l">' + escHtml(label) + '</div>' + (sub ? '<div class="st-s">' + escHtml(sub) + '</div>' : '') + '</div>';
}

function renderMain() {
  blocks = [];
  hatchSeq = 0;
  var metric = S.metric, unit = MEASURE[metric];
  var title = unit + ' by ' + S.display.map(function(v) { return varLabel(v).toLowerCase(); }).join(' × ');
  var ctx = sliceText();
  var stats = [];
  var table = null;

  if (isListView()) {
    table = listView(metric, unit, stats);
  } else {
    var c = sourceCrossing();
    if (!c) {
      main.innerHTML = '<div class="card empty">This combination was not computed.</div>';
      return;
    }
    table = S.display.length === 1 ? oneWay(c, metric, unit, stats) : twoWay(c, metric, unit, stats);
  }

  var run = [];
  blocks.forEach(function(b, i) {
    if (b.size === 'half') run.push(i);
    if (b.size !== 'half' || i === blocks.length - 1) {
      if (run.length % 2) blocks[run[run.length - 1]].size = 'full';
      run = [];
    }
  });
  var h = '<div class="xp-head"><div><h3>' + escHtml(title) + '</h3>'
    + (ctx.length ? '<div class="ctx">' + ctx.map(function(t) { return '<span class="pill">' + escHtml(t) + '</span>'; }).join('') + '</div>' : '')
    + '</div></div>';
  if (stats.length) h += '<div class="stats">' + stats.join('') + '</div>';
  h += '<div class="charts">' + blocks.map(function(b, i) {
    return '<div class="card chart ' + b.size + '"><div class="chart-head"><h4>' + escHtml(b.title) + '</h4>' + (b.sub ? '<span class="sub">' + escHtml(b.sub) + '</span>' : '') + '<span class="spacer"></span>' + (b.head || '')
      + (b.csv ? '<span data-act="csv-block"><button type="button" class="btn sm" data-i="' + i + '" title="Download as CSV">' + ICONS.download + 'CSV</button></span>' : '') + '</div>'
      + '<div class="chart-body" data-block="' + i + '"></div>' + (b.note ? '<p class="caption">' + b.note + '</p>' : '') + '</div>';
  }).join('') + '</div>';
  if (!blocks.length) h += '<div class="card empty">Nothing matches these filters.</div>';
  h += '<div class="card dt" id="xp-table"></div>';
  main.innerHTML = h;
  drawCharts();
  if (table) createDataTable($('xp-table'), table);
  else $('xp-table').remove();
}

function drawCharts() {
  each(main.querySelectorAll('.chart-body[data-block]'), function(el) {
    var b = blocks[Number(el.dataset.block)];
    var w = Math.floor(el.clientWidth);
    if (!b || w <= 0) return;
    el.innerHTML = b.render(w);
  });
}
var resizeTimer;
window.addEventListener('resize', function() { clearTimeout(resizeTimer); resizeTimer = setTimeout(drawCharts, 150); });

// Items of one displayed variable, in its display order.
function itemsOf(c, v, metric) {
  var byMod = {};
  var pos = c.vars.indexOf(v);
  viewCells(c).forEach(function(cell) { byMod[cell[pos]] = cell; });
  var items = keptMods(v).map(function(i) {
    var m = measureAt(byMod[i], c, metric);
    return { i: i, name: V[v].names[i], v: m.v, st: m.st, cell: byMod[i] };
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
  var keys = Object.keys(S.slice);
  if (!keys.length) return DATA.totals.patients;
  var m = marginCell([], {});
  if (!m) return null;
  var cell = m.cell;
  if (!cell || cell[m.crossing.vars.length + 2]) return null;
  return cell[m.crossing.vars.length];
}

function maskNote(items) {
  var k = items.filter(function(i) { return i.st === 1 || i.st === 2; }).length;
  return k ? k + ' masked value' + (k > 1 ? 's' : '') + ' drawn hatched, at most ' + T + ' high.' : '';
}

function crossingRows(c, second) {
  var n = c.vars.length;
  return viewCells(c).map(function(cell) {
    var r = { _st: cell[n + 2] };
    c.vars.forEach(function(v, i) { r[v] = V[v].names[cell[i]]; r['_i_' + v] = cell[i]; });
    r.patients = cell[n];
    r[second] = cell[n + 1];
    return r;
  });
}
function crossingTable(c, metric, displayed) {
  var second = c.second;
  var maskedFmt = function(v, r) { return r._st ? MASK_TEXT[r._st] : v == null ? '' : fmt(v); };
  var maskedTip = function(v, r) { return r._st ? MASK_TIP[r._st] : ''; };
  var cols = displayed.map(function(v) {
    return { key: v, label: V[v].label, type: 'text', filter: V[v].mods.length > 30 ? 'text' : 'select', width: v === 'concept' ? 320 : 170, className: v === 'concept' ? 'name' : '' };
  }).concat([
    { key: 'patients', label: 'Patients', type: 'number', filter: 'min', format: maskedFmt, title: maskedTip, className: 'p' },
    { key: second, label: MEASURE[second], type: 'number', filter: 'min', format: maskedFmt, title: maskedTip },
  ]);
  var rows = crossingRows(c, second);
  // Rows follow the variables' display order, not the alphabet.
  rows.sort(function(a, b) {
    for (var k = 0; k < displayed.length; k++) {
      var d = a['_i_' + displayed[k]] - b['_i_' + displayed[k]];
      if (d) return d;
    }
    return 0;
  });
  return {
    columns: cols,
    rows: rows,
    rowClass: function(r) { return r._st ? 'anon' : ''; },
    searchKeys: displayed,
    initialSort: displayed[0] === 'concept' ? { key: metric, desc: true } : null,
    noun: displayed.length === 1 ? [displayed[0] === 'sex' ? 'sex' : plural(displayed[0]).replace(/s$/, ''), plural(displayed[0])] : ['cell', 'cells'],
    note: ICONS.shield + 'Below ' + T + ' patients: masked',
    csvFileName: META.fileBase + '-' + slug(displayed.join('-')) + (Object.keys(S.slice).length ? '-' + slug(sliceText().join('-')) : '') + '.csv',
  };
}

function oneWay(c, metric, unit, stats) {
  var v = S.display[0], vr = V[v];
  var items = itemsOf(c, v, metric);
  var total = populationTotal(metric);
  var published = items.filter(function(i) { return !i.st; });
  var masked = items.length - published.length;
  var top = published.slice().sort(function(a, b) { return b.v - a.v; })[0];
  stats.push(stat(plural(v).charAt(0).toUpperCase() + plural(v).slice(1), fmt(items.length)));
  if (top) stats.push(stat('Highest', compact(top.v), top.name));
  if (vr.kind === 'time' && published.length) {
    var vals = published.map(function(i) { return i.v; }).sort(function(a, b) { return a - b; });
    stats.push(stat('Median per ' + (vr.granularity || 'period'), compact(vals[Math.floor(vals.length / 2)])));
  }
  if (vr.partition[metric] && published.length) {
    var sum = 0;
    published.forEach(function(i) { sum += i.v; });
    stats.push(stat('Total', compact(sum), masked ? 'published values only' : ''));
  }
  stats.push(stat('Masked', fmt(masked), 'below ' + T + ' patients'));

  var note = maskNote(items);
  var pctLabel = '% of all patients';
  if (vr.kind === 'time') {
    block(unit + ' over time', 'full', function(w) { return lineChart(w, items.map(function(i) { return i.name; }), [{ name: unit, color: PALETTE[0], vals: items }], { title: unit + ' over time', unit: unit }); }, { note: note });
    if (items.length <= 60) block(unit + ' per ' + (vr.granularity || 'period'), 'full', function(w) { return columnChart(w, items, { title: unit, unit: unit }); });
  } else if (v === 'age') {
    block('Age distribution', 'half', function(w) { return columnChart(w, items, { title: 'Age distribution', unit: unit }); }, { note: note });
    pieOrShare(items, vr, metric, unit, total, pctLabel);
  } else if (v === 'sex') {
    pieOrShare(items, vr, metric, unit, total, pctLabel);
    block(unit + ' by sex', 'half', function(w) { return columnChart(w, items, { title: unit, unit: unit, color: PALETTE[1] }); }, { note: note });
  } else {
    var shownItems = items.slice(0, v === 'concept' ? S.topN : 40);
    block(v === 'concept' ? 'Top ' + shownItems.length + ' ' + plural(v) : unit + ' by ' + vr.label.toLowerCase(), vr.partition[metric] ? 'half' : 'full', function(w) {
      return hBars(w, shownItems, { title: vr.label, unit: unit, pctOf: total, pctLabel: pctLabel });
    }, { note: note, sub: items.length > shownItems.length ? shownItems.length + ' of ' + items.length : '', head: v === 'concept' ? topNControl(items.length) : '' });
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
    var slices = head.map(function(it, k) { return { name: it.name, v: it.v, color: PALETTE[k % PALETTE.length] }; });
    var rest = 0;
    sorted.slice(9).forEach(function(it) { rest += it.v; });
    if (rest) slices.push({ name: 'Others', v: rest, color: OTHERS_COLOR });
    var masked = items.length - published.length;
    block('Share of ' + unit.toLowerCase(), 'half', function(w) { return donut(w, slices, { title: 'Share', unit: unit }); },
      { note: masked ? 'Shares of the published values; ' + masked + ' masked value' + (masked > 1 ? 's' : '') + ' left out.' : '' });
  } else if (!pieOnly && total) {
    block(pctLabel.charAt(0).toUpperCase() + pctLabel.slice(1), 'half', function(w) {
      return hBars(w, items, { title: pctLabel, unit: unit, pctOf: total, pctLabel: pctLabel, color: PALETTE[1] });
    }, { note: 'A patient can fall in several ' + plural(vr.id) + ' (one per stay), so these shares add up to more than 100%.' });
  }
}

function twoWay(c, metric, unit, stats) {
  var a = S.display[0], b = S.display[1];
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

  var maskedCount = cells.filter(function(cell) { return cell[c.vars.length + 2]; }).length;
  var biggest = null;
  cells.forEach(function(cell) { var m = measureAt(cell, c, metric); if (m.v != null && (!biggest || m.v > biggest.v)) biggest = { v: m.v, name: rv.names[cell[pos[rowVar]]] + ' · ' + cv.names[cell[pos[colVar]]] }; });
  stats.push(stat('Cells', fmt(cells.length), rows.length + ' × ' + cols.length + (capped ? ' shown' : '')));
  if (biggest) stats.push(stat('Largest cell', compact(biggest.v), biggest.name));
  stats.push(stat('Masked', fmt(maskedCount), maskedCount ? pct(maskedCount, cells.length) + ' of the cells' : 'none'));

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
      block('Age pyramid', 'half', function(w) {
        return pyramid(w, ageRows.map(function(r) { return r.name; }), { name: 'Male', color: SEX_COLOR.male, vals: ageRows.map(function(r) { return valAt(r.i, male.i); }) }, { name: 'Female', color: SEX_COLOR.female, vals: ageRows.map(function(r) { return valAt(r.i, female.i); }) }, { title: 'Age pyramid' });
      });
    }
  }

  if (colVar === 'period') {
    var lineRows = rows.slice(0, Math.min(rows.length, 8));
    var series = ser(lineRows, function(r) { return colObjs.map(function(col) { return at(r.i, col.i); }); });
    block(unit + ' over time by ' + rv.label.toLowerCase(), 'full', function(w) { return lineChart(w, colObjs.map(function(col) { return col.name; }), series, { title: 'Trends', unit: unit }) + legend(series); },
      { sub: rows.length > lineRows.length ? 'the ' + lineRows.length + ' largest of ' + rows.length : '', head: rowVar === 'concept' || rowVar === 'service' ? topNControl(rowsAll.length) : '' });
    if (rowPartition && rows.length <= 12) {
      var stackSeries = ser(rows, function(r) { return colObjs.map(function(col) { return at(r.i, col.i); }); });
      block('Composition over time', 'full', function(w) { return barsBySeries(w, colObjs.map(function(col) { return col.name; }), stackSeries, { title: 'Composition', mode: 'percent' }) + legend(stackSeries); },
        { note: 'Share of each ' + rv.label.toLowerCase() + ' among the published values of each ' + (cv.granularity || 'period') + '.' });
    }
  } else {
    var seriesCols = colObjs.slice(0, 12);
    var cats = rows;
    var horizontal = rowVar === 'concept' || rowVar === 'service' || cats.length > 16;
    var bySeries = ser(seriesCols, function(col) { return cats.map(function(r) { return at(r.i, col.i); }); });
    var catNames = cats.map(function(r) { return r.name; });
    if (colPartition) {
      block(unit + ' by ' + rv.label.toLowerCase() + ' and ' + cv.label.toLowerCase(), horizontal ? 'full' : 'half', function(w) { return barsBySeries(w, catNames, bySeries, { title: 'Stacked', mode: 'stack', horizontal: horizontal }) + legend(bySeries); });
      block(cv.label + ' within each ' + rv.label.toLowerCase(), horizontal ? 'full' : 'half', function(w) { return barsBySeries(w, catNames, bySeries, { title: 'Composition', mode: 'percent', horizontal: horizontal }) + legend(bySeries); },
        { note: 'Shares among the published values; masked cells are left out.' });
    } else if (cats.length * seriesCols.length <= 160) {
      block(unit + ' by ' + rv.label.toLowerCase() + ' and ' + cv.label.toLowerCase(), 'full', function(w) { return barsBySeries(w, catNames, bySeries, { title: 'Grouped', mode: 'group', horizontal: horizontal }) + legend(bySeries); },
        { note: 'Side by side, not stacked: one patient can count in several ' + plural(colVar) + '.' });
    }
  }

  block(rv.label + ' × ' + cv.label, 'full', function() {
    return heatmap(rows, colObjs, function(r, col) { return at(rows[r].i, colObjs[col].i); }, {
      unit: unit, rowLabel: rv.label, colLabel: cv.label, rowPlural: plural(rowVar), colPlural: plural(colVar),
      rowAll: hasRowMargin ? function(r) { return rowMargin(rows[r].i); } : null,
      colAll: hasColMargin ? function(col) { return colMargin(colObjs[col].i); } : null,
    });
  }, {
    sub: capped ? 'the ' + rows.length + ' largest of ' + rowsAll.length : '',
    head: capped || rowsAll.length > 10 ? (rowVar === 'concept' || rowVar === 'service' ? topNControl(rowsAll.length) : '') : '',
    note: hasRowMargin || hasColMargin ? '"All" cells are the published totals over every ' + (hasRowMargin ? cv.label.toLowerCase() : rv.label.toLowerCase()) + ', filters aside.' : '',
    csv: { name: META.fileBase + '-' + slug(rowVar + '-' + colVar) + '-pivot.csv', text: function() {
      var lines = [[rv.label + ' \\ ' + cv.label].concat(colObjs.map(function(col) { return col.name; }))];
      rows.forEach(function(r) { lines.push([r.name].concat(colObjs.map(function(col) { var m = at(r.i, col.i); return m.st ? MASK_TEXT[m.st] : String(m.v); }))); });
      return toCsv(lines);
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
function listView(metric, unit, stats) {
  var key = { patients: 'patientCount', stays: 'visitCount', records: 'recordCount' }[metric];
  var q = S.cq.trim().toLowerCase();
  var rows = LIST.rows.filter(function(r) {
    if (S.ccat && LCOL.category != null && r[LCOL.category] !== S.ccat) return false;
    return !q || fuzzy(q, (String(r[LCOL.conceptName]) + ' ' + r[LCOL.conceptId]).toLowerCase());
  });
  var published = rows.filter(function(r) { return !r[ANON]; });
  var masked = rows.length - published.length;
  stats.push(stat('Concepts', fmt(rows.length), rows.length < LIST.rows.length ? 'of ' + fmt(LIST.rows.length) : ''));
  if (LCOL.category != null) stats.push(stat('Categories', fmt(uniqueSorted(rows.map(function(r) { return r[LCOL.category]; })).length)));
  var recSum = 0;
  published.forEach(function(r) { recSum += r[LCOL.recordCount] || 0; });
  stats.push(stat('Records', compact(recSum), masked ? 'published concepts only' : ''));
  stats.push(stat('Masked', fmt(masked), 'below ' + T + ' patients'));

  var ranked = published.slice().sort(function(a, b) { return b[LCOL[key]] - a[LCOL[key]]; });
  var top = ranked.slice(0, S.topN).map(function(r) { return { name: r[LCOL.conceptName], v: r[LCOL[key]], st: 0 }; });
  var total = metric === 'patients' ? DATA.totals.patients : null;
  block('Top ' + top.length + ' concepts', LCOL.category != null ? 'half' : 'full', function(w) {
    return hBars(w, top, { title: 'Top concepts', unit: unit, pctOf: total, pctLabel: '% of all patients' });
  }, { head: topNControl(published.length) });

  var catCrossing = V.concept && V.concept.level !== 'concept' ? X.concept : null;
  if (catCrossing) {
    var catItems0 = itemsOf(catCrossing, 'concept', metric === 'records' ? 'records' : 'patients');
    block((metric === 'records' ? 'Records' : 'Patients') + ' by ' + V.concept.label.toLowerCase(), 'full', function(w) {
      return hBars(w, catItems0.slice(0, 30), { title: V.concept.label, unit: metric === 'records' ? 'Records' : 'Patients', pctOf: metric === 'records' ? null : DATA.totals.patients, pctLabel: '% of all patients', color: PALETTE[4] });
    }, { note: maskNote(catItems0) });
  }

  if (LCOL.category != null) {
    var byCat = {}, conceptsPerCat = {};
    published.forEach(function(r) {
      var cat = r[LCOL.category] || 'Uncategorised';
      byCat[cat] = (byCat[cat] || 0) + (r[LCOL.recordCount] || 0);
    });
    rows.forEach(function(r) { var cat = r[LCOL.category] || 'Uncategorised'; conceptsPerCat[cat] = (conceptsPerCat[cat] || 0) + 1; });
    var catItems = Object.keys(byCat).map(function(k) { return { name: k, v: byCat[k] }; }).sort(function(a, b) { return b.v - a.v; });
    var slices = catItems.slice(0, 9).map(function(it, k) { return { name: it.name, v: it.v, color: PALETTE[k] }; });
    var rest = 0;
    catItems.slice(9).forEach(function(it) { rest += it.v; });
    if (rest) slices.push({ name: 'Others', v: rest, color: OTHERS_COLOR });
    if (slices.length) block('Records by category', 'half', function(w) { return donut(w, slices, { title: 'Records by category', unit: 'Records' }); }, { note: masked ? 'Published concepts only.' : '' });
    var perCat = Object.keys(conceptsPerCat).map(function(k) { return { name: k, v: conceptsPerCat[k], st: 0 }; }).sort(function(a, b) { return b.v - a.v; });
    block('Concepts per category', 'full', function(w) { return hBars(w, perCat.slice(0, 30), { title: 'Concepts per category', unit: 'Concepts', color: PALETTE[1] }); });
  }

  var anonText = function(v, r) { return v == null ? '' : (r._anon ? '< ' : '') + fmt(v); };
  var anonTitle = function(v, r) { return r._anon ? 'Below the anonymisation threshold' : ''; };
  return {
    columns: LIST.cols.map(function(c) { return c.type === 'number' ? Object.assign({ format: anonText, title: anonTitle }, c) : c; }),
    rows: rows.map(function(a) {
      var r = { _anon: a[ANON] === true };
      LIST.cols.forEach(function(c, i) { r[c.key] = a[i]; });
      return r;
    }),
    rowClass: function(r) { return r._anon ? 'anon' : ''; },
    searchKeys: ['conceptId', 'conceptName'],
    searchPlaceholder: 'Search concepts…',
    initialSort: { key: key, desc: true },
    noun: ['concept', 'concepts'],
    emptyText: 'No concept matches these filters.',
    note: META.conceptNote,
    csvFileName: META.fileBase + '-concepts.csv',
  };
}

// ---- DataTable ----
/*
 * createDataTable(container, opts) renders the page's DataTable into container: toolbar
 * (search, clear filters, CSV), resizable sortable header with inline filters, paged body,
 * footer. Returns { setRows(rows, pinnedRows) }, which keeps filters, sort and widths.
 *   columns: [{ key, label, type: 'text'|'number',
 *     filter?: 'text'|'select'|'min'|'none' (default none), align?: 'left'|'right' (number: right),
 *     width?: px (default 180, number 120), className?: td class,
 *     format?: (value, row) => shown text (number default: 1,234; null: empty),
 *     csv?: (value, row) => CSV cell (default: raw number when shown as such, else shown text),
 *     title?: (value, row) => tooltip, style?: (value, row) => inline td style }]
 *   rows: [{ key: value }]; pinnedRows?: rows kept on top, never sorted, filtered nor paged
 *   (first in the CSV too); rowClass?: row => tr class
 *   searchKeys?: keys the search box matches (default: text columns; [] hides the box)
 *   searchPlaceholder?, initialSort?: { key, desc } | null, pageSize? (50),
 *   noun?: [singular, plural], emptyText?, note?: trusted HTML shown in the toolbar,
 *   csvFileName?: the CSV holds the filtered rows in their sort order, all pages.
 */
function createDataTable(container, o) {
  var cols = o.columns, all = o.rows, pinned = o.pinnedRows || [];
  var searchKeys = o.searchKeys || cols.filter(function(c) { return c.type !== 'number'; }).map(function(c) { return c.key; });
  var noun = o.noun || ['row', 'rows'];
  var pageSize = o.pageSize || 50, page = 0;
  var sorting = o.initialSort || null;
  var filtered = all;
  var hasFilters = cols.some(function(c) { return c.filter && c.filter !== 'none'; });
  function isRight(c) { return c.align ? c.align === 'right' : c.type === 'number'; }
  function defaultWidth(c) { return c.width || (c.type === 'number' ? 120 : 180); }
  var widths = cols.map(defaultWidth);

  function filterCell(c, i) {
    var attrs = 'class="f" data-idx="' + i + '" aria-label="Filter ' + escHtml(c.label) + '"';
    if (c.filter === 'min') return '<input ' + attrs + ' type="number" min="0" placeholder="≥ min">';
    if (c.filter === 'text') return '<input ' + attrs + ' type="text" placeholder="Filter…">';
    if (c.filter !== 'select') return '';
    var values = uniqueSorted(all.map(function(r) { return r[c.key]; }));
    return '<select ' + attrs + '><option value="">All</option>' + values.map(function(v) { return '<option value="' + escHtml(v) + '">' + escHtml(v) + '</option>'; }).join('') + '</select>';
  }

  var h = '<div class="dt-toolbar">';
  if (searchKeys.length) h += '<label class="search">' + ICONS.search + '<input type="search" class="input dt-search" placeholder="' + escHtml(o.searchPlaceholder || 'Search…') + '" autocomplete="off"></label>';
  h += '<button class="btn dt-clear" type="button" hidden>' + ICONS.x + 'Clear filters</button><span class="spacer"></span>';
  if (o.note) h += '<span class="dt-note">' + o.note + '</span>';
  h += '<button class="btn dt-csv" type="button" title="Download the filtered rows as CSV">' + ICONS.download + 'CSV</button></div>';
  // The last, width-less column takes the slack, so resizing one column never stretches the others.
  h += '<div class="dt-scroll"><table><colgroup>' + widths.map(function(w) { return '<col style="width:' + w + 'px">'; }).join('') + '<col></colgroup><thead><tr class="head">';
  cols.forEach(function(c, i) {
    h += '<th' + (isRight(c) ? ' class="r"' : '') + ' aria-sort="none"><button class="sort" type="button" data-idx="' + i + '"><span class="lbl">' + escHtml(c.label) + '</span><span class="sort-ico"></span></button>'
      + '<span class="rz" data-idx="' + i + '" title="Drag to resize, double-click to reset"></span></th>';
  });
  h += '<th class="fill"></th></tr>';
  if (hasFilters) {
    h += '<tr class="filters">';
    cols.forEach(function(c, i) { h += '<th' + (isRight(c) ? ' class="r"' : '') + '>' + filterCell(c, i) + '</th>'; });
    h += '<th class="fill"></th></tr>';
  }
  h += '</thead><tbody></tbody></table></div><div class="dt-foot"><span class="num dt-count"></span><span class="spacer"></span><span>Rows per page</span><select class="select dt-size">'
    + [25, 50, 100, 250, 500].map(function(n) { return '<option value="' + n + '"' + (n === pageSize ? ' selected' : '') + '>' + n + '</option>'; }).join('') + '</select>'
    + '<button class="btn icon-only dt-prev" type="button" aria-label="Previous page">' + ICONS.left + '</button><span class="page-info num dt-page"></span>'
    + '<button class="btn icon-only dt-next" type="button" aria-label="Next page">' + ICONS.right + '</button></div>';
  container.innerHTML = h;

  function q(sel) { return container.querySelector(sel); }
  var tbody = q('tbody'), search = q('.dt-search'), clearBtn = q('.dt-clear');
  var filterEls = container.querySelectorAll('.f'), sortBtns = container.querySelectorAll('.sort');
  var colEls = container.querySelectorAll('col');

  function compare(a, b, num) {
    if (num) {
      var x = a == null || a === '' ? -Infinity : Number(a), y = b == null || b === '' ? -Infinity : Number(b);
      return x === y ? 0 : x < y ? -1 : 1;
    }
    a = String(a == null ? '' : a).toLowerCase(); b = String(b == null ? '' : b).toLowerCase();
    return a < b ? -1 : a > b ? 1 : 0;
  }

  function apply() {
    var needle = search ? search.value.trim().toLowerCase() : '';
    var active = [];
    each(filterEls, function(el) {
      var v = el.value.trim();
      if (v === '') return;
      var c = cols[Number(el.dataset.idx)];
      active.push({ key: c.key, kind: c.filter, v: c.filter === 'min' ? Number(v) : v.toLowerCase() });
    });
    clearBtn.hidden = !needle && !active.length;
    filtered = all.filter(function(r) {
      if (needle && !fuzzy(needle, searchKeys.map(function(k) { return r[k] == null ? '' : String(r[k]); }).join(' ').toLowerCase())) return false;
      for (var i = 0; i < active.length; i++) {
        var f = active[i], cell = r[f.key];
        if (f.kind === 'min') { if (cell == null || !(Number(cell) >= f.v)) return false; }
        else if (f.kind === 'select') { if (String(cell).toLowerCase() !== f.v) return false; }
        else if (String(cell == null ? '' : cell).toLowerCase().indexOf(f.v) === -1) return false;
      }
      return true;
    });
    var sc = sorting && cols.filter(function(c) { return c.key === sorting.key; })[0];
    if (sc) {
      var dir = sorting.desc ? -1 : 1, num = sc.type === 'number';
      filtered = filtered.slice().sort(function(a, b) { return compare(a[sc.key], b[sc.key], num) * dir; });
    }
    page = 0;
    render();
  }

  function paintSort() {
    each(sortBtns, function(b) {
      var on = !!sorting && sorting.key === cols[Number(b.dataset.idx)].key;
      b.classList.toggle('on', on);
      b.querySelector('.sort-ico').innerHTML = on ? (sorting.desc ? ICONS.down : ICONS.up) : ICONS.both;
      b.closest('th').setAttribute('aria-sort', on ? (sorting.desc ? 'descending' : 'ascending') : 'none');
    });
  }

  function rowHtml(r, extraClass) {
    var rc = [extraClass, o.rowClass ? o.rowClass(r) : ''].filter(Boolean).join(' ');
    var s = rc ? '<tr class="' + rc + '">' : '<tr>';
    cols.forEach(function(c) {
      var v = r[c.key];
      var cls = [isRight(c) ? 'r' : '', c.className || ''].filter(Boolean).join(' ');
      var tp = c.title ? c.title(v, r) : '', st = c.style ? c.style(v, r) : '';
      s += '<td' + (cls ? ' class="' + cls + '"' : '') + (tp ? ' title="' + escHtml(tp) + '"' : '') + (st ? ' style="' + escHtml(st) + '"' : '') + '>' + escHtml(cellText(c, r)) + '</td>';
    });
    return s + '<td class="fill"></td></tr>';
  }

  function render() {
    var pages = Math.max(1, Math.ceil(filtered.length / pageSize));
    if (page >= pages) page = pages - 1;
    var html = pinned.map(function(r) { return rowHtml(r, 'pinned'); }).join('');
    var slice = filtered.slice(page * pageSize, page * pageSize + pageSize);
    html += slice.map(function(r) { return rowHtml(r, ''); }).join('');
    if (!slice.length) html += '<tr class="no-rows"><td colspan="' + (cols.length + 1) + '">' + escHtml(o.emptyText || 'No row matches these filters.') + '</td></tr>';
    tbody.innerHTML = html;
    var total = all.length, word = function(n) { return n === 1 ? noun[0] : noun[1]; };
    q('.dt-count').textContent = filtered.length === total ? fmt(total) + ' ' + word(total) : fmt(filtered.length) + ' of ' + fmt(total) + ' ' + word(total);
    q('.dt-page').textContent = (page + 1) + ' / ' + pages;
    q('.dt-prev').disabled = page === 0;
    q('.dt-next').disabled = page >= pages - 1;
  }

  function setWidth(i, w) {
    widths[i] = Math.max(50, Math.round(w));
    colEls[i].style.width = widths[i] + 'px';
  }
  each(container.querySelectorAll('.rz'), function(grip) {
    var i = Number(grip.dataset.idx);
    grip.addEventListener('pointerdown', function(e) {
      if (e.button !== 0) return;
      e.preventDefault();
      var startX = e.clientX, startW = colEls[i].getBoundingClientRect().width || widths[i];
      try { grip.setPointerCapture(e.pointerId); } catch (err) { /* synthetic event: no live pointer */ }
      grip.classList.add('on');
      document.body.classList.add('col-resizing');
      var move = function(ev) { setWidth(i, startW + ev.clientX - startX); };
      var end = function() {
        grip.classList.remove('on');
        document.body.classList.remove('col-resizing');
        grip.removeEventListener('pointermove', move);
        grip.removeEventListener('pointerup', end);
        grip.removeEventListener('pointercancel', end);
      };
      grip.addEventListener('pointermove', move);
      grip.addEventListener('pointerup', end);
      grip.addEventListener('pointercancel', end);
    });
    grip.addEventListener('dblclick', function() { setWidth(i, defaultWidth(cols[i])); });
  });

  var timer;
  function debounced() { clearTimeout(timer); timer = setTimeout(apply, 150); }
  if (search) search.addEventListener('input', debounced);
  each(filterEls, function(el) { el.addEventListener(el.tagName === 'SELECT' ? 'change' : 'input', debounced); });
  clearBtn.addEventListener('click', function() {
    if (search) search.value = '';
    each(filterEls, function(el) { el.value = ''; });
    apply();
  });
  each(sortBtns, function(b) {
    b.addEventListener('click', function() {
      var key = cols[Number(b.dataset.idx)].key;
      // Same cycle as the app's tables: a fresh column sorts descending, then ascending, then clears.
      if (!sorting || sorting.key !== key) sorting = { key: key, desc: true };
      else sorting = sorting.desc ? { key: key, desc: false } : null;
      paintSort();
      apply();
    });
  });
  q('.dt-csv').addEventListener('click', function() {
    downloadCsv(o.csvFileName || 'table.csv', tableCsv(cols, pinned.concat(filtered)));
  });
  q('.dt-prev').addEventListener('click', function() { if (page > 0) { page--; render(); } });
  q('.dt-next').addEventListener('click', function() { page++; render(); });
  q('.dt-size').addEventListener('change', function() { pageSize = Number(this.value) || 50; page = 0; render(); });

  paintSort();
  apply();
  return {
    setRows: function(rows, pinnedRows) {
      all = rows;
      if (pinnedRows) pinned = pinnedRows;
      apply();
    },
  };
}

// ---- Start ----
if (side && main && CHIP_VARS.length) {
  renderSide();
  renderMain();
} else if (main) {
  main.innerHTML = '<div class="card empty">Nothing was computed for this catalog.</div>';
}
