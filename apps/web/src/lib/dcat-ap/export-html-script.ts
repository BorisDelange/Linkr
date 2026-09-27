/**
 * Behaviour of the standalone catalog page: the table helpers below, then
 * `catalog-page.js` (plain browser JavaScript, inlined as text), in one IIFE.
 */
import PAGE_SCRIPT from './catalog-page.js?raw'

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

export const CATALOG_SCRIPT = `(function() {
${TABLE_HELPERS}
${PAGE_SCRIPT}
})();`
