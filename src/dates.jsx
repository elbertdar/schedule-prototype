// ── Date helpers ─────────────────────────────────────────────────────────────
// Pure, dependency-free helpers used across the engine and components.
// No React, no JSX — keep it that way.

/**
 * Add `n` working days (Mon–Fri) to a date.
 * @param {Date} d - Source date
 * @param {number} n - Working days to add (negative shifts backward)
 * @returns {Date} New date instance
 */
export function addW(d, n) {
  if (!n) return new Date(d);
  const r = new Date(d);
  let c = 0;
  const s = n > 0 ? 1 : -1;
  while (c < Math.abs(n)) {
    r.setDate(r.getDate() + s);
    if (r.getDay() % 6) c++;
  }
  return r;
}

/**
 * Calendar-day difference between two dates (rounded).
 * @param {Date} a
 * @param {Date} b
 * @returns {number} (b - a) in days
 */
export function calDiff(a, b) {
  return Math.round((b - a) / 864e5);
}

/**
 * Count working days strictly between `e` (end) and `s` (start), exclusive.
 * Returns 0 if s <= e.
 * @param {Date} e
 * @param {Date} s
 * @returns {number}
 */
export function wdayGap(e, s) {
  if (s <= e) return 0;
  let g = 0;
  const c = new Date(e);
  while (c < s) {
    c.setDate(c.getDate() + 1);
    if (c.getDay() % 6) g++;
  }
  return g;
}

/**
 * Parse a date in DD/MM/YYYY, "D MMM YYYY", or ISO format, or an Excel serial.
 * @param {string|number|Date} str
 * @returns {Date|null}
 */
export function parseDate(str) {
  if (!str) return null;
  // Excel serial numbers
  if (typeof str === 'number') {
    const d = new Date(Math.round((str - 25569) * 864e5));
    return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  }
  const s = String(str).trim();
  if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(s)) {
    const [d, m, y] = s.split('/').map(Number);
    return new Date(y, m - 1, d);
  }
  const months = { jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11 };
  const m2 = s.match(/^(\d{1,2})\s+([a-z]{3})\s+(\d{4})$/i);
  if (m2) return new Date(Number(m2[3]), months[m2[2].toLowerCase()], Number(m2[1]));
  const d2 = new Date(s);
  return isNaN(d2) ? null : d2;
}

/** Format as "01 Jan" (en-AU). Returns "—" for null/undefined. */
export const fmtDate = d => d ? d.toLocaleDateString('en-AU', { day:'2-digit', month:'short' }) : '—';

/** Format as DD/MM/YYYY — used when writing dates back to rawTasks for engine compatibility. */
export const fmtDDMMYYYY = d => `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}/${d.getFullYear()}`;
