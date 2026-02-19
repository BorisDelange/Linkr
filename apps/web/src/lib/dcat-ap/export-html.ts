/**
 * Standalone HTML export for concept catalogs.
 *
 * Generates a self-contained HTML page with:
 * - Embedded JSON-LD (machine-readable metadata)
 * - Interactive data table (vanilla JS search + sort)
 * - Summary statistics
 * - DCAT-AP metadata display
 * - Anonymization: rows below threshold are excluded
 */

import type { DataCatalog, CatalogResultCache, CatalogResultRow, SchemaMapping } from '@/types'
import { buildJsonLd } from './jsonld'

export interface ExportHtmlOptions {
  catalog: DataCatalog
  cache: CatalogResultCache
  schemaMapping?: SchemaMapping | null
  /** Rows below this patient count are excluded. Defaults to catalog.anonymization.threshold. */
  threshold?: number
  /** Include JSON-LD in the HTML. Default true. */
  includeJsonLd?: boolean
}

export function generateCatalogHtml(opts: ExportHtmlOptions): string {
  const { catalog, cache, schemaMapping } = opts
  const threshold = opts.threshold ?? catalog.anonymization.threshold
  const includeJsonLd = opts.includeJsonLd !== false

  // Filter rows by anonymization threshold
  const rows = cache.rows.filter((r) => r.patientCount >= threshold)

  // Collect dimension keys from the first row
  const dimensionKeys = rows.length > 0 ? Object.keys(rows[0].dimensions) : []

  // Summary stats
  const totalConcepts = new Set(rows.map((r) => r.conceptId)).size
  const totalPatients = cache.totalPatients
  const totalRows = rows.length
  const suppressedRows = cache.rows.length - rows.length

  // JSON-LD
  const metadata = catalog.dcatApMetadata ?? {}
  const jsonLd = includeJsonLd
    ? JSON.stringify(buildJsonLd({ metadata, schemaMapping, cache }), null, 2)
    : null

  const catalogTitle = (metadata['catalog.title'] as string) || catalog.name
  const catalogDesc = (metadata['catalog.description'] as string) || catalog.description || ''
  const publisher = (metadata['agent.name'] as string) || (metadata['catalog.publisher'] as string) || ''

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escHtml(catalogTitle)} — Concept Catalog</title>
${jsonLd ? `<script type="application/ld+json">\n${escHtml(jsonLd)}\n</script>` : ''}
<style>
${CSS}
</style>
</head>
<body>
<div class="container">
  <header>
    <h1>${escHtml(catalogTitle)}</h1>
    ${catalogDesc ? `<p class="description">${escHtml(catalogDesc)}</p>` : ''}
    ${publisher ? `<p class="publisher">${escHtml(publisher)}</p>` : ''}
    <p class="generated">Generated on ${new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })} by LinkR</p>
  </header>

  <div class="stats-grid">
    <div class="stat-card">
      <div class="stat-value">${totalConcepts.toLocaleString()}</div>
      <div class="stat-label">Concepts</div>
    </div>
    <div class="stat-card">
      <div class="stat-value">${totalPatients.toLocaleString()}</div>
      <div class="stat-label">Unique patients</div>
    </div>
    <div class="stat-card">
      <div class="stat-value">${totalRows.toLocaleString()}</div>
      <div class="stat-label">Data rows</div>
    </div>
    <div class="stat-card">
      <div class="stat-value">${suppressedRows.toLocaleString()}</div>
      <div class="stat-label">Suppressed rows (threshold &lt; ${threshold})</div>
    </div>
  </div>

  <div class="table-controls">
    <input type="text" id="search" placeholder="Search concepts..." class="search-input" />
    <span id="row-count" class="row-count">${totalRows} rows</span>
  </div>

  <div class="table-wrapper">
    <table id="catalog-table">
      <thead>
        <tr>
          <th data-col="conceptId" class="sortable">Concept ID</th>
          <th data-col="conceptName" class="sortable">Concept Name</th>
${catalog.categoryColumn ? `          <th data-col="category" class="sortable">Category</th>\n` : ''}${catalog.subcategoryColumn ? `          <th data-col="subcategory" class="sortable">Subcategory</th>\n` : ''}${dimensionKeys.map((k) => `          <th data-col="dim_${k}" class="sortable">${escHtml(titleCase(k))}</th>`).join('\n')}
          <th data-col="patientCount" class="sortable num">Patients</th>
          <th data-col="recordCount" class="sortable num">Records</th>
        </tr>
      </thead>
      <tbody>
${buildTableRows(rows, dimensionKeys, catalog.categoryColumn, catalog.subcategoryColumn)}
      </tbody>
    </table>
  </div>

  <footer>
    <p>Anonymization threshold: ${threshold} patients minimum per row. ${suppressedRows} row${suppressedRows !== 1 ? 's' : ''} suppressed.</p>
    <p>Health-DCAT-AP Release 6 · EHDS Regulation (EU) 2025/327</p>
  </footer>
</div>

<script>
${JS}
</script>
</body>
</html>`
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildTableRows(
  rows: CatalogResultRow[],
  dimensionKeys: string[],
  categoryColumn?: string,
  subcategoryColumn?: string,
): string {
  return rows.map((r) => {
    const cells = [
      `        <td>${escHtml(String(r.conceptId))}</td>`,
      `        <td>${escHtml(r.conceptName)}</td>`,
    ]
    if (categoryColumn) {
      cells.push(`        <td>${escHtml(r.category ?? '')}</td>`)
    }
    if (subcategoryColumn) {
      cells.push(`        <td>${escHtml(r.subcategory ?? '')}</td>`)
    }
    for (const k of dimensionKeys) {
      cells.push(`        <td>${escHtml(String(r.dimensions[k] ?? ''))}</td>`)
    }
    cells.push(`        <td class="num">${r.patientCount.toLocaleString()}</td>`)
    cells.push(`        <td class="num">${r.recordCount.toLocaleString()}</td>`)
    return `      <tr>\n${cells.join('\n')}\n      </tr>`
  }).join('\n')
}

function escHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function titleCase(s: string): string {
  return s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

// ---------------------------------------------------------------------------
// Embedded CSS
// ---------------------------------------------------------------------------

const CSS = `
:root {
  --bg: #ffffff;
  --fg: #1a1a2e;
  --muted: #6b7280;
  --border: #e5e7eb;
  --card-bg: #f9fafb;
  --accent: #0d9488;
  --accent-light: #ccfbf1;
}

@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0f172a;
    --fg: #e2e8f0;
    --muted: #94a3b8;
    --border: #334155;
    --card-bg: #1e293b;
    --accent: #2dd4bf;
    --accent-light: #134e4a;
  }
}

* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: var(--bg); color: var(--fg); line-height: 1.5; }
.container { max-width: 1200px; margin: 0 auto; padding: 2rem 1.5rem; }

header { margin-bottom: 2rem; }
header h1 { font-size: 1.5rem; font-weight: 700; }
header .description { margin-top: 0.25rem; color: var(--muted); font-size: 0.875rem; }
header .publisher { margin-top: 0.25rem; color: var(--accent); font-size: 0.8125rem; font-weight: 500; }
header .generated { margin-top: 0.5rem; color: var(--muted); font-size: 0.75rem; }

.stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 0.75rem; margin-bottom: 1.5rem; }
.stat-card { background: var(--card-bg); border: 1px solid var(--border); border-radius: 0.5rem; padding: 1rem; text-align: center; }
.stat-value { font-size: 1.5rem; font-weight: 700; color: var(--accent); }
.stat-label { font-size: 0.75rem; color: var(--muted); margin-top: 0.25rem; }

.table-controls { display: flex; align-items: center; gap: 1rem; margin-bottom: 0.75rem; }
.search-input { flex: 1; max-width: 320px; padding: 0.5rem 0.75rem; border: 1px solid var(--border); border-radius: 0.375rem; font-size: 0.875rem; background: var(--bg); color: var(--fg); outline: none; }
.search-input:focus { border-color: var(--accent); }
.row-count { font-size: 0.75rem; color: var(--muted); }

.table-wrapper { overflow-x: auto; border: 1px solid var(--border); border-radius: 0.5rem; }
table { width: 100%; border-collapse: collapse; font-size: 0.8125rem; }
thead { background: var(--card-bg); position: sticky; top: 0; }
th { padding: 0.5rem 0.75rem; text-align: left; font-weight: 600; font-size: 0.75rem; color: var(--muted); border-bottom: 1px solid var(--border); white-space: nowrap; user-select: none; }
th.sortable { cursor: pointer; }
th.sortable:hover { color: var(--fg); }
th.num, td.num { text-align: right; }
td { padding: 0.375rem 0.75rem; border-bottom: 1px solid var(--border); }
tr:hover { background: var(--accent-light); }

footer { margin-top: 2rem; padding-top: 1rem; border-top: 1px solid var(--border); }
footer p { font-size: 0.75rem; color: var(--muted); margin-bottom: 0.25rem; }

@media print {
  .table-controls { display: none; }
  .table-wrapper { border: none; overflow: visible; }
  footer { page-break-inside: avoid; }
}
`

// ---------------------------------------------------------------------------
// Embedded JavaScript (search + sort)
// ---------------------------------------------------------------------------

const JS = `
(function() {
  var table = document.getElementById('catalog-table');
  var tbody = table.querySelector('tbody');
  var rows = Array.from(tbody.querySelectorAll('tr'));
  var search = document.getElementById('search');
  var rowCount = document.getElementById('row-count');
  var sortCol = null, sortAsc = true;

  // Search
  search.addEventListener('input', function() {
    var q = this.value.toLowerCase();
    var visible = 0;
    rows.forEach(function(r) {
      var match = r.textContent.toLowerCase().indexOf(q) !== -1;
      r.style.display = match ? '' : 'none';
      if (match) visible++;
    });
    rowCount.textContent = visible + ' rows';
  });

  // Sort
  var headers = table.querySelectorAll('th.sortable');
  headers.forEach(function(th, i) {
    th.addEventListener('click', function() {
      var colIdx = i;
      var isNum = th.classList.contains('num');
      if (sortCol === colIdx) { sortAsc = !sortAsc; } else { sortCol = colIdx; sortAsc = true; }
      headers.forEach(function(h) { h.textContent = h.textContent.replace(/ [\\u25B2\\u25BC]/, ''); });
      th.textContent += sortAsc ? ' \\u25B2' : ' \\u25BC';
      rows.sort(function(a, b) {
        var va = a.cells[colIdx].textContent.trim();
        var vb = b.cells[colIdx].textContent.trim();
        if (isNum) {
          va = parseFloat(va.replace(/,/g, '')) || 0;
          vb = parseFloat(vb.replace(/,/g, '')) || 0;
        } else {
          va = va.toLowerCase();
          vb = vb.toLowerCase();
        }
        if (va < vb) return sortAsc ? -1 : 1;
        if (va > vb) return sortAsc ? 1 : -1;
        return 0;
      });
      rows.forEach(function(r) { tbody.appendChild(r); });
    });
  });
})();
`
