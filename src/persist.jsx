// ── Persistent storage ───────────────────────────────────────────────────────
// All localStorage interaction lives here. One generic helper, then named
// save/load pairs that match the original API so call sites don't change.

// ── Generic try/catch wrapper ────────────────────────────────────────────────
function safeGet(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function safeSet(key, value) {
  try { localStorage.setItem(key, value); } catch (e) { console.warn(`localStorage save failed (${key}):`, e); }
}
function safeRemove(key) {
  try { localStorage.removeItem(key); } catch {}
}

// ── Keys (exported so App can clear them all at once) ────────────────────────
export const LS_KEY              = 'interscale_xlsx_b64';
export const LS_COMPLETED_KEY    = 'interscale_completed';
export const LS_STATUS_KEY       = 'interscale_status_overrides';
export const LS_DEPS_KEY         = 'interscale_dep_overrides';
export const LS_WORKFLOWS_KEY    = 'interscale_workflows';
export const LS_EDITS_KEY        = 'interscale_edits';

export const ALL_LS_KEYS = [
  LS_KEY, LS_COMPLETED_KEY, LS_STATUS_KEY, LS_DEPS_KEY, LS_WORKFLOWS_KEY, LS_EDITS_KEY,
];

/** Clear every key this app uses. */
export function clearAllStorage() {
  for (const k of ALL_LS_KEYS) safeRemove(k);
}

// ── XLSX buffer (base64-encoded ArrayBuffer) ─────────────────────────────────
export function saveToStorage(arrayBuffer) {
  try {
    const bytes = new Uint8Array(arrayBuffer);
    let binary = '';
    for (const b of bytes) binary += String.fromCharCode(b);
    safeSet(LS_KEY, btoa(binary));
  } catch (e) { console.warn('xlsx save failed:', e); }
}

export function loadFromStorage() {
  try {
    const b64 = safeGet(LS_KEY);
    if (!b64) return null;
    const binary = atob(b64);
    const buf = new ArrayBuffer(binary.length);
    const view = new Uint8Array(buf);
    for (let i = 0; i < binary.length; i++) view[i] = binary.charCodeAt(i);
    return buf;
  } catch { return null; }
}

// ── Sets (completed task ids) ────────────────────────────────────────────────
export function saveCompleted(ids) { safeSet(LS_COMPLETED_KEY, JSON.stringify([...ids])); }
export function loadCompleted() {
  const s = safeGet(LS_COMPLETED_KEY);
  try { return s ? new Set(JSON.parse(s)) : new Set(); } catch { return new Set(); }
}

// ── Maps (status overrides, dep overrides, workflows) ────────────────────────
function saveMap(key, map) { safeSet(key, JSON.stringify([...map.entries()])); }
function loadMap(key) {
  const s = safeGet(key);
  try { return s ? new Map(JSON.parse(s)) : new Map(); } catch { return new Map(); }
}

export const saveStatusOverrides = m => saveMap(LS_STATUS_KEY, m);
export const loadStatusOverrides = () => loadMap(LS_STATUS_KEY);

export const saveDepOverrides = m => saveMap(LS_DEPS_KEY, m);
export const loadDepOverrides = () => loadMap(LS_DEPS_KEY);

export const saveWorkflows = m => saveMap(LS_WORKFLOWS_KEY, m);
export const loadWorkflows = () => loadMap(LS_WORKFLOWS_KEY);

// ── Edits blob (plain JSON object) ───────────────────────────────────────────
export function saveSchedEdits(edits) { safeSet(LS_EDITS_KEY, JSON.stringify(edits)); }
export function loadSchedEdits() {
  const s = safeGet(LS_EDITS_KEY);
  try { return s ? JSON.parse(s) : null; } catch { return null; }
}
