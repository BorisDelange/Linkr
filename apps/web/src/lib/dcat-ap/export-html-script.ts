/**
 * Behaviour of the standalone catalog page, as a classic inline script (no
 * modules, no template literals: it lives inside one). It reads the
 * globals the page declares before it: CONCEPTS, CONCEPT_COLS, PERIODS, META,
 * ICONS.
 *
 * The Overview charts are rendered at export time with the cohort report's builders
 * (`lib/cohort-report/charts.ts`); the ports below redraw them only when one
 * period is picked, so they must keep the same geometry and colours.
 */

/**
 * Cell text and CSV serialisation shared by every table of the page. Kept apart
 * so the tests can evaluate it: the CSV must carry masked counts ("< 10")
 * exactly as displayed, never the number behind them.
 */
export const TABLE_HELPERS = `
  function fmt(n) { return Number(n).toLocaleString('en'); }
  function cellText(col, row) {
    var v = row[col.key];
    if (col.format) return col.format(v, row);
    if (v == null) return '';
    return col.type === 'number' ? fmt(v) : String(v);
  }
  // A number goes out raw, unless its cell shows something else (a masked count).
  function csvValue(col, row) {
    var v = row[col.key];
    if (col.csv) return col.csv(v, row);
    var text = cellText(col, row);
    return col.type === 'number' && typeof v === 'number' && text === fmt(v) ? String(v) : text;
  }
  // RFC 4180.
  function csvField(v) {
    var s = v == null ? '' : String(v);
    return /[",\\r\\n]/.test(s) || s !== s.trim() ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function toCsv(lines) {
    return lines.map(function(l) { return l.map(csvField).join(','); }).join('\\r\\n') + '\\r\\n';
  }
  function tableCsv(columns, rows) {
    return toCsv([columns.map(function(c) { return c.label; })].concat(rows.map(function(r) {
      return columns.map(function(c) { return csvValue(c, r); });
    })));
  }
`

export const CATALOG_SCRIPT = `
(function() {
  var NNBSP = String.fromCharCode(8239);
  function escHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
${TABLE_HELPERS}
  function slug(s) { return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'table'; }
  // The in-app preview is a sandboxed iframe: without allow-downloads the browser drops the click silently.
  function downloadCsv(fileName, text) {
    try {
      var url = URL.createObjectURL(new Blob(['\\uFEFF' + text], { type: 'text/csv;charset=utf-8' }));
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
  function $(id) { return document.getElementById(id); }
  function each(list, fn) { Array.prototype.forEach.call(list, fn); }

  // ---- Tabs ----
  var tabs = document.querySelectorAll('.tab');
  each(tabs, function(t) {
    t.addEventListener('click', function() {
      each(tabs, function(x) { x.classList.toggle('active', x === t); x.setAttribute('aria-selected', x === t ? 'true' : 'false'); });
      each(document.querySelectorAll('.tab-content'), function(c) { c.classList.toggle('active', c.id === 'tab-' + t.dataset.tab); });
    });
  });

  // ---- JSON-LD viewer ----
  var overlay = $('jsonld-overlay');
  function closeOverlay() { overlay.classList.remove('open'); }
  $('open-jsonld').addEventListener('click', function() { overlay.classList.add('open'); });
  $('close-jsonld').addEventListener('click', closeOverlay);
  overlay.addEventListener('click', function(e) { if (e.target === overlay) closeOverlay(); });
  document.addEventListener('keydown', function(e) { if (e.key === 'Escape') closeOverlay(); });
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

  // ---- Chart builders (ports of lib/cohort-report/charts.ts) ----
  var AXIS = '#cdd7e3', TEXT = '#33445c', MUTED = '#667892';
  var FONT = 'font-family="system-ui,-apple-system,Segoe UI,Helvetica,Arial,sans-serif"';
  var DONUT_COLORS = ['#1f5e97', '#3b8fb5', '#7fb3d5', '#a9c6de', '#9aa8b8', '#c9d3de'];
  function svg(w, h, body, title) {
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + w + ' ' + h + '" width="' + w + '" height="' + h + '" role="img" aria-label="' + escHtml(title) + '" ' + FONT + '>' + body + '</svg>';
  }
  function niceScale(max, ticks) {
    if (max <= 0) return { max: 1, step: 1 };
    var raw = Math.max(1, max / ticks);
    var mag = Math.pow(10, Math.floor(Math.log10(raw)));
    var step = 10 * mag;
    var f = [1, 2, 5, 10];
    for (var i = 0; i < f.length; i++) if (f[i] * mag >= raw) { step = f[i] * mag; break; }
    return { max: Math.ceil(max / step) * step, step: step };
  }
  function maxOf(items) { var m = 0; items.forEach(function(i) { if (i.value != null && i.value > m) m = i.value; }); return m; }

  function columnChart(items, title, unit) {
    var width = 520, height = 270, pad = { top: 16, right: 10, bottom: 40, left: 52 };
    var plotW = width - pad.left - pad.right, plotH = height - pad.top - pad.bottom;
    var sc = niceScale(maxOf(items), 6);
    var yOf = function(v) { return pad.top + plotH - (v / sc.max) * plotH; };
    var p = [];
    for (var v = 0; v <= sc.max; v += sc.step) {
      var y = yOf(v).toFixed(1);
      p.push('<line x1="' + pad.left + '" y1="' + y + '" x2="' + (width - pad.right) + '" y2="' + y + '" stroke="#eef2f7" />');
      p.push('<text x="' + (pad.left - 7) + '" y="' + (Number(y) + 5.5).toFixed(1) + '" text-anchor="end" font-size="16" fill="' + MUTED + '">' + fmt(v).replace(/,/g, NNBSP) + '</text>');
    }
    var slot = items.length ? plotW / items.length : plotW;
    var barW = slot * 0.58;
    var every = Math.max(1, Math.ceil(items.length / 8));
    items.forEach(function(it, i) {
      var cx = pad.left + i * slot + slot / 2;
      if (it.value != null && it.value > 0) {
        var y = yOf(it.value);
        p.push('<rect x="' + (cx - barW / 2).toFixed(1) + '" y="' + y.toFixed(1) + '" width="' + barW.toFixed(1) + '" height="' + (pad.top + plotH - y).toFixed(1) + '" fill="#1f5e97"><title>' + escHtml(it.label + ' : ' + it.text + ' ' + unit) + '</title></rect>');
      }
      if (i % every === 0) p.push('<text x="' + cx.toFixed(1) + '" y="' + (height - 12) + '" text-anchor="middle" font-size="16" fill="#47576f">' + escHtml(it.label) + '</text>');
    });
    p.push('<line x1="' + pad.left + '" y1="' + (pad.top + plotH) + '" x2="' + (width - pad.right) + '" y2="' + (pad.top + plotH) + '" stroke="' + AXIS + '" />');
    return svg(width, height, p.join(''), title);
  }

  function share(v, total) { return (v / total * 100).toFixed(1) + '%'; }
  function donut(items, title, centerValue, centerLabel) {
    var width = 520, height = 270, cx = 138, cy = 135, r = 100, inner = 68;
    var total = 0;
    items.forEach(function(i) { total += i.value || 0; });
    var p = [];
    var angle = -Math.PI / 2;
    var pt = function(a, rad) { return (cx + rad * Math.cos(a)).toFixed(2) + ' ' + (cy + rad * Math.sin(a)).toFixed(2); };
    items.forEach(function(it, i) {
      var v = it.value || 0;
      if (!total || v <= 0) return;
      var color = DONUT_COLORS[i % DONUT_COLORS.length];
      var tip = '<title>' + escHtml(it.label + ' : ' + it.text + ' (' + share(v, total) + ')') + '</title>';
      if (v === total) {
        p.push('<circle cx="' + cx + '" cy="' + cy + '" r="' + ((r + inner) / 2) + '" fill="none" stroke="' + color + '" stroke-width="' + (r - inner) + '">' + tip + '</circle>');
        return;
      }
      var sweep = (v / total) * Math.PI * 2, end = angle + sweep, large = sweep > Math.PI ? 1 : 0;
      p.push('<path d="M ' + pt(angle, r) + ' A ' + r + ' ' + r + ' 0 ' + large + ' 1 ' + pt(end, r) + ' L ' + pt(end, inner) + ' A ' + inner + ' ' + inner + ' 0 ' + large + ' 0 ' + pt(angle, inner) + ' Z" fill="' + color + '">' + tip + '</path>');
      angle = end;
    });
    if (centerValue) {
      p.push('<text x="' + cx + '" y="' + (cy + 4) + '" text-anchor="middle" font-size="34" font-weight="600" fill="#1a4c7c">' + escHtml(centerValue) + '</text>');
      p.push('<text x="' + cx + '" y="' + (cy + 25) + '" text-anchor="middle" font-size="15" fill="#77869a">' + escHtml(centerLabel) + '</text>');
    }
    var top = cy - (items.length * 30) / 2 + 2;
    items.forEach(function(it, i) {
      var y = top + i * 30;
      var s = it.value != null && total ? share(it.value, total) : it.text;
      p.push('<rect x="252" y="' + y + '" width="16" height="16" rx="2" fill="' + DONUT_COLORS[i % DONUT_COLORS.length] + '" />');
      p.push('<text x="278" y="' + (y + 13) + '" font-size="17" fill="' + TEXT + '">' + escHtml(it.label + ' — ' + s) + '</text>');
    });
    return svg(width, height, p.join(''), title);
  }

  function horizontalBars(items, title, width) {
    var rowH = 22, valueW = 56;
    var labelW = 80;
    items.forEach(function(i) { labelW = Math.max(labelW, i.label.length * 6.2); });
    labelW = Math.min(220, labelW);
    var height = Math.max(rowH, items.length * rowH) + 8;
    var plotW = width - labelW - valueW - 16;
    var max = Math.max(1, maxOf(items));
    var p = items.map(function(it, i) {
      var y = 4 + i * rowH;
      var label = it.label.length > 36 ? it.label.slice(0, 35) + '…' : it.label;
      var w = it.value ? (it.value / max) * plotW : 0;
      return '<text x="' + (labelW - 6) + '" y="' + (y + 14) + '" font-size="10" text-anchor="end" fill="' + TEXT + '">' + escHtml(label) + '</text>'
        + (w > 0 ? '<rect x="' + labelW + '" y="' + (y + 4) + '" width="' + w.toFixed(1) + '" height="' + (rowH - 8) + '" rx="1.5" fill="#0084d8" />' : '')
        + '<text x="' + (labelW + w + 6).toFixed(1) + '" y="' + (y + 14) + '" font-size="10" fill="' + TEXT + '">' + escHtml(it.text) + '</text>';
    });
    return svg(width, height, p.join(''), title);
  }

  // ---- Overview: period filter ----
  var masked = '<' + META.threshold;
  function count(v) { return { value: v, text: v == null ? masked : fmt(v) }; }
  function leadingNumber(s) { var m = /\\d+/.exec(s); return m ? Number(m[0]) : Infinity; }

  var chartCards = document.querySelectorAll('.chart[data-dim]');
  var initialCharts = [];
  each(chartCards, function(c) { initialCharts.push(c.querySelector('.chart-body').innerHTML); });
  var kpiEls = document.querySelectorAll('.kpi[data-kpi]');

  function renderPeriod(row) {
    each(kpiEls, function(k) {
      var key = k.dataset.kpi, v = k.querySelector('.v'), s = k.querySelector('.s');
      if (key === 'patients') v.textContent = row ? count(row.n_patients).text : fmt(META.totalPatients);
      else if (key === 'visits') v.textContent = row ? count(row.n_sejours).text : fmt(META.totalVisits);
      else if (s) s.style.display = row ? '' : 'none';
    });
    each(chartCards, function(card, i) {
      var type = card.dataset.dim, body = card.querySelector('.chart-body'), title = card.dataset.title;
      card.style.display = '';
      if (!row) { body.innerHTML = initialCharts[i]; return; }
      if (type === 'admission_date') { card.style.display = 'none'; return; }
      var items = [];
      if (type === 'sex') {
        [['M', row.sex_m], ['F', row.sex_f], ['Other', row.sex_other]].forEach(function(e) {
          if (e[1] !== null && e[1] !== undefined) { var c = count(e[1]); items.push({ label: e[0], value: c.value, text: c.text }); }
        });
        items.sort(function(a, b) { return (b.value || 0) - (a.value || 0); });
        body.innerHTML = items.length ? donut(items, title, count(row.n_patients).text, 'patients') : '<div class="empty">No data for this period</div>';
      } else if (type === 'age_group') {
        for (var k in row.age_buckets) { var a = count(row.age_buckets[k]); items.push({ label: k, value: a.value, text: a.text }); }
        items.sort(function(x, y) { return leadingNumber(x.label) - leadingNumber(y.label) || (x.label < y.label ? -1 : 1); });
        body.innerHTML = items.length ? columnChart(items, title, 'patients') : '<div class="empty">No data for this period</div>';
      } else if (type === 'care_site') {
        for (var s in row.services) { var sv = row.services[s]; if (sv) { var c2 = count(sv.n_patients); items.push({ label: s, value: c2.value, text: c2.text }); } }
        items.sort(function(x, y) { return (y.value || 0) - (x.value || 0); });
        body.innerHTML = items.length ? horizontalBars(items.slice(0, 30), title, 1100) : '<div class="empty">No data for this period</div>';
      }
    });
  }

  // ---- Overview: heatmaps (one hue, per-row scale) ----
  var dark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  var LO = dark ? [27, 40, 58] : [238, 245, 251], HI = dark ? [61, 143, 209] : [31, 94, 151];
  function heat(t) {
    var c = [0, 1, 2].map(function(i) { return Math.round(LO[i] + t * (HI[i] - LO[i])); });
    return 'rgb(' + c.join(',') + ')';
  }
  var hmScale = 'linear-gradient(90deg,' + heat(0) + ',' + heat(1) + ')';

  var heatmapSpecs = [];
  function heatmapCsv(spec) {
    var lines = [[spec.rowHeader].concat(spec.rows.map(function(r) { return r.period_label; }))];
    spec.labels.forEach(function(lab) {
      lines.push([lab].concat(spec.rows.map(function(r) { var v = spec.pick(r, lab); return v == null ? masked : String(v); })));
    });
    return toCsv(lines);
  }
  function heatmap(title, rowHeader, labels, rows, pick) {
    heatmapSpecs.push({ title: title, rowHeader: rowHeader, labels: labels, rows: rows, pick: pick });
    var h = '<div class="card hm"><div class="hm-head"><h3 class="eyebrow">' + escHtml(title) + '</h3><button class="btn hm-csv" type="button" data-hm="' + (heatmapSpecs.length - 1) + '" title="Download this table as CSV">' + ICONS.download + 'CSV</button></div><div class="hm-scroll"><table><thead><tr><th></th>';
    rows.forEach(function(r) { h += '<th>' + escHtml(r.period_label) + '</th>'; });
    h += '</tr></thead><tbody>';
    labels.forEach(function(lab) {
      var max = 0;
      rows.forEach(function(r) { var v = pick(r, lab); if (v != null && v > max) max = v; });
      h += '<tr><th class="row" title="' + escHtml(lab) + '">' + escHtml(lab) + '</th>';
      rows.forEach(function(r) {
        var v = pick(r, lab);
        if (v == null) { h += '<td class="masked" title="' + escHtml(r.period_label + ' · ' + masked) + '">' + escHtml(masked) + '</td>'; return; }
        var t = max ? v / max : 0;
        h += '<td class="num" style="background:' + heat(t) + ';color:' + (t > 0.55 ? '#fff' : 'inherit') + '" title="' + escHtml(lab + ' · ' + r.period_label + ': ' + fmt(v)) + '">' + fmt(v) + '</td>';
      });
      h += '</tr>';
    });
    return h + '</tbody></table></div><div class="hm-scale"><span>0</span><span class="bar" style="background:' + hmScale + '"></span><span>row max</span><span class="mask"></span><span>below ' + META.threshold + ' patients</span></div></div>';
  }

  var GRANS = ['month', 'quarter', 'year'];
  var availGrans = GRANS.filter(function(g) { return PERIODS.some(function(r) { return r.period_granularity === g; }); });
  function periodRows(gran) {
    var g = gran === 'all' ? availGrans[0] : gran;
    return PERIODS.filter(function(r) { return r.period_granularity === g; });
  }
  function renderHeatmaps(gran, periodValue) {
    var section = $('heatmaps');
    if (!section) return;
    var rows = periodRows(gran);
    if (periodValue) rows = rows.filter(function(r) { return r.period_label === periodValue; });
    var allRow = PERIODS.find(function(r) { return r.period_granularity === 'all'; });
    if (!allRow || rows.length < 2) { section.innerHTML = ''; return; }
    var html = '';
    heatmapSpecs = [];
    var svc = Object.keys(allRow.services || {});
    if (svc.length) html += heatmap('Patients by service over time', 'Service', svc, rows, function(r, l) { return r.services[l] ? r.services[l].n_patients : null; });
    var cats = Object.keys(allRow.concept_categories || {});
    if (cats.length) html += heatmap('Patients by concept category over time', 'Concept category', cats, rows, function(r, l) { return r.concept_categories[l] ? r.concept_categories[l].n_patients : null; });
    section.innerHTML = html;
  }
  var heatmapSection = $('heatmaps');
  if (heatmapSection) heatmapSection.addEventListener('click', function(e) {
    var btn = e.target.closest('.hm-csv');
    var spec = btn && heatmapSpecs[Number(btn.dataset.hm)];
    if (spec) downloadCsv(META.fileBase + '-' + slug(spec.title) + '.csv', heatmapCsv(spec));
  });

  if (PERIODS.length) {
    var gran = 'all', periodSel = $('period-filter');
    each(document.querySelectorAll('#granularity button'), function(b) {
      if (b.dataset.gran !== 'all' && availGrans.indexOf(b.dataset.gran) === -1) b.disabled = true;
    });
    var fillPeriods = function() {
      periodSel.innerHTML = '<option value="">All periods</option>' + periodRows(gran).map(function(r) {
        return '<option value="' + escHtml(r.period_label) + '">' + escHtml(r.period_label) + '</option>';
      }).join('');
    };
    var update = function() {
      var v = periodSel.value;
      renderPeriod(v ? PERIODS.find(function(r) { return r.period_label === v; }) || null : null);
      renderHeatmaps(gran, v);
    };
    $('granularity').addEventListener('click', function(e) {
      var btn = e.target.closest('button');
      if (!btn || btn.disabled) return;
      gran = btn.dataset.gran;
      each(document.querySelectorAll('#granularity button'), function(b) { b.classList.toggle('active', b === btn); });
      fillPeriods();
      update();
    });
    periodSel.addEventListener('change', update);
    fillPeriods();
    renderHeatmaps(gran, '');
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
      var seen = {}, values = [];
      all.forEach(function(r) { var v = r[c.key]; if (v != null && v !== '' && !seen[v]) { seen[v] = true; values.push(String(v)); } });
      values.sort(function(a, b) { return a.localeCompare(b, 'en', { numeric: true }); });
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

    function fuzzy(needle, hay) {
      if (hay.indexOf(needle) !== -1) return true;
      var n = 0;
      for (var k = 0; k < hay.length && n < needle.length; k++) if (hay[k] === needle[n]) n++;
      return n === needle.length;
    }
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
        var tip = c.title ? c.title(v, r) : '', st = c.style ? c.style(v, r) : '';
        s += '<td' + (cls ? ' class="' + cls + '"' : '') + (tip ? ' title="' + escHtml(tip) + '"' : '') + (st ? ' style="' + escHtml(st) + '"' : '') + '>' + escHtml(cellText(c, r)) + '</td>';
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

  // ---- Concepts table ----
  var conceptBox = $('concept-dt');
  if (conceptBox) {
    var anonIdx = CONCEPT_COLS.length;
    var anonText = function(v, r) { return v == null ? '' : (r._anon ? '< ' : '') + fmt(v); };
    var anonTitle = function(v, r) { return r._anon ? 'Below the anonymisation threshold' : ''; };
    createDataTable(conceptBox, {
      columns: CONCEPT_COLS.map(function(c) { return c.type === 'number' ? Object.assign({ format: anonText, title: anonTitle }, c) : c; }),
      rows: CONCEPTS.map(function(a) {
        var r = { _anon: a[anonIdx] === true };
        CONCEPT_COLS.forEach(function(c, i) { r[c.key] = a[i]; });
        return r;
      }),
      rowClass: function(r) { return r._anon ? 'anon' : ''; },
      searchKeys: ['conceptId', 'conceptName'],
      searchPlaceholder: 'Search concepts…',
      initialSort: { key: 'patientCount', desc: true },
      noun: ['concept', 'concepts'],
      emptyText: 'No concept matches these filters.',
      note: META.conceptNote,
      csvFileName: META.fileBase + '-concepts.csv',
    });
  }
})();
`
