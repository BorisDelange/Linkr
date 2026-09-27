/*
 * Behaviour of the standalone catalog page. Inlined as-is by export-html.ts
 * (imported `?raw`), after TABLE_HELPERS and the explorer engine
 * (catalog-explore.js, `export` stripped), inside an IIFE, so it runs in any
 * browser with no build step and no network.
 *
 * Globals the page declares before it: DATA (published crossings, variables,
 * concept list, totals — see lib/data-catalog/publish.ts), META, ICONS.
 *
 * This file is the page's glue: tabs, the JSON-LD viewer, the schema, and the
 * Explore tab's controls around the engine, which decides what to draw.
 */

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

// ---- Explore ----
var XP = createExplorer(DATA, {
  fileBase: META.fileBase,
  conceptNote: META.conceptNote,
  dark: function() { return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches); },
});
var S = XP.S, V = XP.V;
var side = $('xp-side');
var main = $('xp-main');
var current = null; // the last view, for chart redraws and CSV buttons

var GROUP_LABEL = { 1: 'One variable', 2: 'Two variables', 3: 'Three variables' };
var ICON_OF = { user: 'user', stethoscope: 'stethoscope', activity: 'activity', tags: 'tags', layers: 'layers', trendingUp: 'trendingUp', barChart: 'barChart', sigma: 'sigma', shield: 'shield', grid: 'table' };

function dot(v) { return '<i class="vdot" style="background:' + VARIABLE_HEX[v] + '"></i>'; }
function vbadge(v) { return '<span class="vbadge" style="--vc:' + VARIABLE_HEX[v] + '">' + escHtml(XP.varLabel(v)) + '</span>'; }

function periodBounds(code) {
  var q = /^(\d{4})-Q([1-4])$/.exec(code);
  if (q) { var m0 = (Number(q[2]) - 1) * 3 + 1; return [q[1] + '-' + pad2(m0) + '-01', q[1] + '-' + pad2(m0 + 2) + '-' + lastDay(q[1], m0 + 2)]; }
  var m = /^(\d{4})-(\d{2})$/.exec(code);
  if (m) return [code + '-01', code + '-' + lastDay(m[1], Number(m[2]))];
  return [code + '-01-01', code + '-12-31'];
}
function pad2(n) { return (n < 10 ? '0' : '') + n; }
function lastDay(y, m) { return pad2(new Date(Date.UTC(Number(y), m, 0)).getUTCDate()); }

function crossingPicker() {
  var h = '<select class="select full" data-act="crossing" aria-label="Variables to show">';
  XP.options().forEach(function(g) {
    h += '<optgroup label="' + GROUP_LABEL[g.size] + '">' + g.items.map(function(it) {
      return '<option value="' + it.id + '"' + (S.crossing === it.id ? ' selected' : '') + '>' + escHtml(it.vars.map(XP.varLabel).join(' × ')) + '</option>';
    }).join('') + '</optgroup>';
  });
  return h + '</select><div class="vbadges">' + XP.varsOf(S.crossing).map(vbadge).join('<span class="x">×</span>') + '</div>';
}

function nominalFilter(v) {
  var vr = V[v], sel = S.sel[v];
  var many = vr.mods.length > 14 || vr.names.some(function(nm) { return nm.length > 24; });
  var h = '<div class="flt"><div class="flt-head">' + dot(v) + '<span>' + escHtml(vr.label) + '</span><span class="spacer"></span>'
    + (sel ? '<button type="button" class="link" data-act="sel-all" data-v="' + v + '">All</button>' : '')
    + '<button type="button" class="link" data-act="sel-none" data-v="' + v + '">None</button></div>';
  if (many) h += '<input type="search" class="input flt-search" data-act="sel-search" data-v="' + v + '" placeholder="Filter…" autocomplete="off">';
  h += '<div class="' + (many ? 'checks' : 'pills') + '">';
  vr.names.forEach(function(nm, i) {
    var on = !sel || !!sel[i];
    h += many
      ? '<label class="check" data-name="' + escHtml(nm.toLowerCase()) + '"><input type="checkbox" data-act="sel" data-v="' + v + '" data-i="' + i + '"' + (on ? ' checked' : '') + '><span>' + escHtml(nm) + '</span></label>'
      : '<button type="button" class="pill-t' + (on ? ' on' : '') + '" style="--vc:' + VARIABLE_HEX[v] + '" data-act="sel" data-v="' + v + '" data-i="' + i + '">' + escHtml(nm) + '</button>';
  });
  return h + '</div><div class="hint">Keep one value to read the others for it alone.</div></div>';
}

function periodFilter() {
  var vr = V.period, n = vr.mods.length;
  var r = S.range || [0, n - 1];
  var h = '<div class="flt"><div class="flt-head">' + dot('period') + '<span>' + escHtml(vr.label) + '</span><span class="spacer"></span>'
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
  if (cv && cv.level !== 'concept' && !XP.isListView()) return nominalFilter('concept');
  var cats = XP.conceptCategories();
  var h = '<div class="flt"><div class="flt-head">' + dot('concept') + '<span>' + escHtml(XP.varLabel('concept')) + '</span></div>'
    + '<input type="search" class="input flt-search" id="concept-q" data-act="cq" placeholder="Search concepts…" value="' + escHtml(S.cq) + '" autocomplete="off">';
  if (cats.length) h += '<select class="select" data-act="ccat"><option value="">All categories</option>' + cats.map(function(c) { return '<option value="' + escHtml(c) + '"' + (S.ccat === c ? ' selected' : '') + '>' + escHtml(c) + '</option>'; }).join('') + '</select>';
  return h + '</div>';
}

/** A three-variable crossing shows one value of one of its variables at a time. */
function pinControl(vars) {
  var vr = V[S.pin];
  var h = '<div class="flt pin"><div class="flt-head">' + dot(S.pin) + '<span>One value at a time</span></div>'
    + '<select class="select" data-act="pin">' + vars.map(function(v) { return '<option value="' + v + '"' + (S.pin === v ? ' selected' : '') + '>' + escHtml(XP.varLabel(v)) + '</option>'; }).join('') + '</select>'
    + '<select class="select" data-act="pin-val">' + (XP.canUnpin() ? '<option value="">All</option>' : '')
    + vr.names.map(function(nm, i) { return '<option value="' + i + '"' + (S.pinVal === i ? ' selected' : '') + '>' + escHtml(nm) + '</option>'; }).join('') + '</select>'
    + '<div class="hint">Charts draw two variables; this one is read value by value' + (XP.canUnpin() ? ', or all together.' : '.') + '</div></div>';
  return h;
}

function renderSide() {
  var vars = XP.varsOf(S.crossing);
  var h = '<div class="xp-sec"><div class="xp-sec-t">Variables</div>' + crossingPicker() + '</div>';
  var ms = XP.measures();
  if (ms.indexOf(S.metric) === -1) S.metric = 'patients';
  h += '<div class="xp-sec"><div class="xp-sec-t">Count</div><div class="seg full" data-act="metric">' + ms.map(function(m) {
    return '<button type="button" data-v="' + m + '"' + (S.metric === m ? ' class="active"' : '') + '>' + escHtml(XP.measureLabel(m)) + '</button>';
  }).join('') + '</div></div>';

  var filters = (S.pin ? pinControl(vars) : '') + vars.filter(function(v) { return v !== S.pin; }).map(function(v) {
    if (v === 'period') return periodFilter();
    if (v === 'concept') return conceptFilter();
    return nominalFilter(v);
  }).join('');
  h += '<div class="xp-sec"><div class="xp-sec-t">Filters</div>' + filters + '</div>';
  h += '<div class="xp-sec"><div class="xp-sec-t">Show</div><div class="shows">'
    + [['stats', 'Key figures'], ['charts', 'Charts'], ['table', 'Table']].map(function(o) {
      return '<label class="check"><input type="checkbox" data-act="show" data-v="' + o[0] + '"' + (S.show[o[0]] ? ' checked' : '') + '><span>' + o[1] + '</span></label>';
    }).join('') + '</div></div>';
  h += '<button type="button" class="btn full" data-act="reset">' + ICONS.x + 'Reset filters</button>';
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

var debounceTimer;
function later(fn, ms) { clearTimeout(debounceTimer); debounceTimer = setTimeout(fn, ms); }
function refresh() { renderSide(); renderMain(); }

side.addEventListener('click', function(e) {
  var b = e.target.closest('[data-act]');
  if (!b || b.disabled) return;
  var act = b.dataset.act, v = b.dataset.v;
  if (act === 'sel' && b.tagName === 'BUTTON') XP.toggleSel(v, Number(b.dataset.i));
  else if (act === 'sel-all') delete S.sel[v];
  else if (act === 'sel-none') S.sel[v] = {};
  else if (act === 'reset') XP.reset();
  else if (act === 'range-preset') S.range = Number(v) ? [Number(v), V.period.mods.length - 1] : null;
  else if (e.target.closest('[data-act="metric"] button')) S.metric = e.target.closest('button').dataset.v;
  else if (e.target.closest('[data-act="pmode"] button')) S.periodMode = e.target.closest('button').dataset.v;
  else return;
  refresh();
});
side.addEventListener('change', function(e) {
  var el = e.target, act = el.dataset.act, v = el.dataset.v;
  if (act === 'crossing') XP.setCrossing(el.value);
  else if (act === 'sel') XP.toggleSel(v, Number(el.dataset.i));
  else if (act === 'ccat') S.ccat = el.value;
  else if (act === 'pin') { S.pin = el.value; S.pinVal = null; }
  else if (act === 'pin-val') S.pinVal = el.value === '' ? null : Number(el.value);
  else if (act === 'show') { S.show[v] = el.checked; renderMain(); return; }
  else if (act === 'cal') {
    var mods = V.period.mods, r = S.range ? S.range.slice() : [0, mods.length - 1];
    var end = Number(el.dataset.end), date = el.value;
    if (date) {
      var idx = -1;
      for (var k = 0; k < mods.length; k++) {
        var bd = periodBounds(mods[k]);
        if (end === 0 ? bd[1] >= date : bd[0] <= date) { idx = k; if (end === 0) break; }
      }
      if (idx !== -1) r[end] = idx;
    } else r[end] = end === 0 ? 0 : mods.length - 1;
    if (r[0] > r[1]) r = end === 0 ? [r[0], r[0]] : [r[1], r[1]];
    S.range = r[0] === 0 && r[1] === mods.length - 1 ? null : r;
  } else return;
  refresh();
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
    if (r[0] > r[1]) r[1 - end] = val;
    S.range = r[0] === 0 && r[1] === n - 1 ? null : r;
    each(side.querySelectorAll('input[data-act="range"]'), function(x) { x.value = r[Number(x.dataset.end)]; });
    paintRange();
    // A single period turns into context: the whole view changes shape.
    later(function() { if (S.range && S.range[0] === S.range[1]) refresh(); else renderMain(); }, 120);
  }
});

main.addEventListener('click', function(e) {
  var b = e.target.closest('[data-act] button, button[data-act]');
  if (!b) return;
  var act = b.closest('[data-act]').dataset.act;
  if (act === 'scale') { S.scale = b.dataset.v; renderMain(); }
  else if (act === 'topn') { S.topN = Number(b.dataset.v); renderMain(); }
  else if (act === 'csv-block') { var bl = current && current.blocks[Number(b.dataset.i)]; if (bl && bl.csv) downloadCsv(bl.csv.name, bl.csv.text()); }
});

function kpiHtml(s) {
  return '<div class="kpi"><div class="kpi-ico">' + (ICONS[ICON_OF[s.icon]] || ICONS.activity) + '</div><div class="kpi-t"><div class="v num">' + escHtml(s.value) + '</div><div class="l">' + escHtml(s.label) + '</div>'
    + (s.sub ? '<div class="s" title="' + escHtml(s.sub) + '">' + escHtml(s.sub) + '</div>' : '') + '</div></div>';
}

/** The engine's table spec, as the page's DataTable wants it. */
function tableOptions(t) {
  if (t.kind === 'concepts') {
    var anonText = function(v, r) { return v == null ? '' : (r._anon ? '< ' : '') + fmt(v); };
    var anonTitle = function(v, r) { return r._anon ? 'Below the anonymisation threshold' : ''; };
    return Object.assign({}, t, {
      columns: t.columns.map(function(c) { return c.type === 'number' ? Object.assign({ format: anonText, title: anonTitle }, c) : c; }),
      rowClass: function(r) { return r._anon ? 'anon' : ''; },
      note: t.note,
    });
  }
  var maskedFmt = function(v, r) { return r._st ? t.maskText[r._st] : v == null ? '' : fmt(v); };
  var maskedTip = function(v, r) { return r._st ? t.maskTip[r._st] : ''; };
  return Object.assign({}, t, {
    columns: t.columns.map(function(c) { return c.measure ? Object.assign({ format: maskedFmt, title: maskedTip }, c) : c; }),
    rowClass: function(r) { return r._st ? 'anon' : ''; },
    note: ICONS.shield + escHtml(t.note),
  });
}

function renderMain() {
  var view = XP.view();
  current = view;
  var h = '';
  if (S.show.stats && view.stats.length) h += '<div class="kpis">' + view.stats.map(kpiHtml).join('') + '</div>';
  h += '<div class="xp-head"><h3>' + escHtml(view.title) + '</h3>'
    + (view.context.length ? '<div class="ctx">' + view.context.map(function(c) { return '<span class="pill" style="--vc:' + VARIABLE_HEX[c.v] + '">' + escHtml(c.label + ': ' + c.value) + '</span>'; }).join('') + '</div>' : '')
    + '</div>';
  if (view.empty && !view.blocks.length) h += '<div class="card empty">' + escHtml(view.empty) + '</div>';
  if (S.show.charts && view.blocks.length) {
    h += '<div class="charts">' + view.blocks.map(function(b, i) {
      return '<div class="card chart ' + b.size + '"><div class="chart-head"><h4>' + escHtml(b.title) + '</h4>' + (b.sub ? '<span class="sub">' + escHtml(b.sub) + '</span>' : '') + '<span class="spacer"></span>' + (b.head || '')
        + (b.csv ? '<span data-act="csv-block"><button type="button" class="btn sm" data-i="' + i + '" title="Download as CSV">' + ICONS.download + 'CSV</button></span>' : '') + '</div>'
        + '<div class="chart-body" data-block="' + i + '"></div>' + (b.note ? '<p class="caption">' + escHtml(b.note) + '</p>' : '') + '</div>';
    }).join('') + '</div>';
  }
  if (S.show.table && view.table) h += '<div class="card dt" id="xp-table"></div>';
  main.innerHTML = h;
  drawCharts();
  if (S.show.table && view.table) createDataTable($('xp-table'), tableOptions(view.table));
}

function drawCharts() {
  if (!current) return;
  each(main.querySelectorAll('.chart-body[data-block]'), function(el) {
    var b = current.blocks[Number(el.dataset.block)];
    var w = Math.floor(el.clientWidth);
    if (!b || w <= 0) return;
    el.innerHTML = b.render(w);
  });
}
var resizeTimer;
window.addEventListener('resize', function() { clearTimeout(resizeTimer); resizeTimer = setTimeout(drawCharts, 150); });

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
if (side && main && S.crossing) refresh();
else if (main) main.innerHTML = '<div class="card empty">Nothing was computed for this catalog.</div>';
