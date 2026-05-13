import { useState, useMemo, useRef, useEffect, useCallback, createContext, useContext, Component } from "react";

class ErrorBoundary extends Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(e) { return { error: e }; }
  render() {
    if (this.state.error) {
      return (
        <div style={{ fontFamily:'monospace', padding:'32px', background:'#0A0A0F', color:'#F87171', minHeight:'100vh' }}>
          <div style={{ fontSize:'18px', fontWeight:'700', marginBottom:'12px' }}>Runtime Error</div>
          <div style={{ fontSize:'13px', marginBottom:'8px', color:'#FCA5A5' }}>{String(this.state.error)}</div>
          <pre style={{ fontSize:'11px', color:'#6B7280', whiteSpace:'pre-wrap' }}>{this.state.error?.stack}</pre>
          <button onClick={() => { localStorage.clear(); window.location.reload(); }}
            style={{ marginTop:'20px', padding:'8px 18px', borderRadius:'8px', border:'none', background:'#EF4444', color:'white', cursor:'pointer', fontSize:'13px' }}>
            Clear storage &amp; reload
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

// ── Schedule engine helpers ────────────────────────────────────────────────────
function addW(d, n) {
  if (!n) return new Date(d);
  const r = new Date(d); let c = 0, s = n > 0 ? 1 : -1;
  while (c < Math.abs(n)) { r.setDate(r.getDate() + s); if (r.getDay() % 6) c++; }
  return r;
}
function calDiff(a, b) { return Math.round((b - a) / 864e5); }
function wdayGap(e, s) {
  if (s <= e) return 0;
  let g = 0; const c = new Date(e);
  while (c < s) { c.setDate(c.getDate() + 1); if (c.getDay() % 6) g++; }
  return g;
}
function parseDate(str) {
  if (!str) return null;
  // Handle Excel serial dates (numbers)
  if (typeof str === 'number') {
    const d = new Date(Math.round((str - 25569) * 864e5));
    return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  }
  const s = String(str).trim();
  // DD/MM/YYYY
  if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(s)) {
    const [d, m, y] = s.split('/').map(Number);
    return new Date(y, m - 1, d);
  }
  // D Jan YYYY or DD Jan YYYY
  const months = { jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11 };
  const m2 = s.match(/^(\d{1,2})\s+([a-z]{3})\s+(\d{4})$/i);
  if (m2) return new Date(Number(m2[3]), months[m2[2].toLowerCase()], Number(m2[1]));
  // ISO
  const d2 = new Date(s);
  return isNaN(d2) ? null : d2;
}
const fmtDate = d => d ? d.toLocaleDateString('en-AU', { day:'2-digit', month:'short' }) : '—';
const fd = fmtDate;
const fmtDDMMYYYY = d => `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}/${d.getFullYear()}`;

// ── Color palettes — auto-assigned by insertion order ────────────────────────
const PROJ_COLORS  = ['#6366F1','#10B981','#F59E0B','#0EA5E9','#EC4899','#8B5CF6','#EF4444','#06B6D4'];
const PERSON_COLORS = ['#6366F1','#10B981','#F59E0B','#0EA5E9','#EC4899','#7C3AED','#EF4444','#06B6D4','#84CC16','#F97316'];

// ── Static timeline constants ─────────────────────────────────────────────────
const ALL_MONS = [
  { n:'Jan', d:0  }, { n:'Feb', d:31  }, { n:'Mar', d:59  }, { n:'Apr', d:90  },
  { n:'May', d:120 }, { n:'Jun', d:151 }, { n:'Jul', d:181 }, { n:'Aug', d:212 },
  { n:'Sep', d:243 }, { n:'Oct', d:273 }, { n:'Nov', d:304 }, { n:'Dec', d:334 },
  { n:'', d:365 },
];

// ── Schedule context ──────────────────────────────────────────────────────────
// All components read rawTasks, projs, people, tdepMap, BASE, todayDay from here.
const ScheduleCtx = createContext(null);
const useSched = () => useContext(ScheduleCtx);

// ── xlsx parser ───────────────────────────────────────────────────────────────
// Reads an ArrayBuffer from the xlsx file.
// Expected sheet: "Schedule" (or first sheet) with columns:
//   Project | Task ID | Task Name | Assigned | Role | Rate | Start | End | Dependencies | Status
// Returns { rawTasks, projs, people, tdepMap, base, todayDay, periods }
async function parseXlsx(buffer) {
  // Dynamically import SheetJS (available in the artifact runtime)
  const XLSX = await import('https://cdn.sheetjs.com/xlsx-0.20.1/package/xlsx.mjs');
  const wb = XLSX.read(buffer, { type:'array', cellDates:true });

  // ── Schedule sheet ──────────────────────────────────────────────────────────
  const sheetName = wb.SheetNames.find(n => /schedule/i.test(n)) || wb.SheetNames[0];
  const ws = wb.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(ws, { defval:'' });

  if (!rows.length) throw new Error('Schedule sheet is empty.');

  // Normalise column names (case-insensitive, trim)
  const norm = obj => {
    const out = {};
    for (const [k, v] of Object.entries(obj)) out[k.trim().toLowerCase().replace(/\s+/g,'_')] = v;
    return out;
  };
  const data = rows.map(norm);

  // Map column aliases
  const col = (row, ...keys) => {
    for (const k of keys) { if (row[k] !== undefined && row[k] !== '') return row[k]; }
    return '';
  };

  // ── Parse rows ──────────────────────────────────────────────────────────────
  const rawTasks = [];
  const projOrder = [], personOrder = [];
  const projMap = {}, personMap = {};

  for (const row of data) {
    const projId  = String(col(row, 'project', 'proj')).trim();
    const seqId   = String(col(row, 'task_id', 'taskid', 'id')).trim();
    const name    = String(col(row, 'task_name', 'taskname', 'name')).trim();
    const person  = String(col(row, 'assigned', 'person', 'resource')).trim();
    const role    = String(col(row, 'role')).trim();
    const rate    = String(col(row, 'rate')).trim();
    const startRaw = col(row, 'start', 'start_date');
    const endRaw   = col(row, 'end', 'end_date', 'finish');
    const depsRaw  = String(col(row, 'dependencies', 'depends_on', 'deps')).trim();

    if (!projId || !seqId || !name) continue; // skip blank/header rows

    const id = `${projId}-${seqId}`;
    const startD = startRaw instanceof Date ? startRaw : parseDate(startRaw);
    const endD   = endRaw   instanceof Date ? endRaw   : parseDate(endRaw);
    if (!startD || !endD) continue;

    // Format dates back to DD/MM/YYYY for engine compatibility
    const fmt = d => `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}/${d.getFullYear()}`;
    const dur = Math.max(1, Math.round(Math.abs(endD - startD) / (864e5 * 7 / 5))); // approx working days

    // Parse dependencies: "1A, 1B" → ["P1-1A", "P1-1B"] (same project assumed if no prefix)
    const deps = depsRaw ? depsRaw.split(/[,;]+/).map(d => {
      const clean = d.trim();
      if (!clean) return null;
      if (clean.includes('-')) return clean; // already full ID
      return `${projId}-${clean}`;
    }).filter(Boolean) : [];

    // Register project
    if (!projMap[projId]) {
      projMap[projId] = { id:projId, name:`${projId} — New Build`, color:PROJ_COLORS[projOrder.length % PROJ_COLORS.length], base:startD };
      projOrder.push(projId);
    } else if (startD < projMap[projId].base) {
      projMap[projId].base = startD;
    }

    // Register person
    if (person && !personMap[person]) {
      const init = person.split(' ').map(w=>w[0]).join('').slice(0,2).toUpperCase();
      personMap[person] = {
        name: person, role, init,
        color: PERSON_COLORS[personOrder.length % PERSON_COLORS.length],
        rate: rate || '$42/hr',
      };
      personOrder.push(person);
    }
    // Update rate if provided and better than default
    if (person && rate && personMap[person]) personMap[person].rate = rate;

    rawTasks.push({ id, proj:projId, name, person, dur, start:fmt(startD), end:fmt(endD), deps });
  }

  // ── Optional People sheet ───────────────────────────────────────────────────
  const peopleSheet = wb.SheetNames.find(n => /people|resource|team/i.test(n));
  if (peopleSheet) {
    const pws = wb.Sheets[peopleSheet];
    const prows = XLSX.utils.sheet_to_json(pws, { defval:'' }).map(norm);
    for (const row of prows) {
      const name  = String(col(row, 'name')).trim();
      const role  = String(col(row, 'role')).trim();
      const rate  = String(col(row, 'rate')).trim();
      const color = String(col(row, 'color')).trim();
      if (!name) continue;
      if (!personMap[name]) {
        const init = name.split(' ').map(w=>w[0]).join('').slice(0,2).toUpperCase();
        personMap[name] = { name, role, init, color: color || PERSON_COLORS[personOrder.length % PERSON_COLORS.length], rate: rate || '$42/hr' };
        personOrder.push(name);
      } else {
        if (role)  personMap[name].role  = role;
        if (rate)  personMap[name].rate  = rate;
        if (color) personMap[name].color = color;
      }
    }
  }

  if (!rawTasks.length) throw new Error('No valid tasks found. Check column names match the template.');

  const projs   = projOrder.map(id => projMap[id]);
  const people  = personOrder.map(n => personMap[n]);
  const tdepMap = Object.fromEntries(rawTasks.map(t => [t.id, t.deps]));

  // BASE = earliest task start across all tasks
  const allStarts = rawTasks.map(t => parseDate(t.start)).filter(Boolean);
  const base = new Date(Math.min(...allStarts.map(d => d.getTime())));
  // Snap to Jan 1 of that year for clean month alignment
  const baseYear = new Date(base.getFullYear(), 0, 1);

  // todayDay = calendar days from base to actual today
  const today = new Date();
  today.setHours(0,0,0,0);
  const todayDay = calDiff(baseYear, today);

  // Build periods: one per month covered by tasks, plus quarters
  const maxEnd = new Date(Math.max(...rawTasks.map(t => parseDate(t.end)).filter(Boolean).map(d => d.getTime())));
  const periods = [];
  const startYear = baseYear.getFullYear();
  for (let mo = 0; mo < 24; mo++) {
    const mStart = new Date(startYear, mo, 1);
    const mEnd   = new Date(startYear, mo + 1, 0);
    if (mStart > maxEnd) break;
    const sd = calDiff(baseYear, mStart);
    const ed = calDiff(baseYear, mEnd);
    const label = mStart.toLocaleDateString('en-AU', { month:'short', year:'2-digit' });
    const key   = `m${startYear}${String(mo+1).padStart(2,'0')}`;
    periods.push({ key, label, startDay:sd, endDay:ed });
  }

  return { rawTasks, projs, people, tdepMap, base:baseYear, todayDay, periods };
}

// ── localStorage persistence ──────────────────────────────────────────────────
const LS_KEY = 'interscale_xlsx_b64';

function saveToStorage(arrayBuffer) {
  try {
    const bytes = new Uint8Array(arrayBuffer);
    let binary = '';
    for (const b of bytes) binary += String.fromCharCode(b);
    localStorage.setItem(LS_KEY, btoa(binary));
  } catch (e) { console.warn('localStorage save failed:', e); }
}

function loadFromStorage() {
  try {
    const b64 = localStorage.getItem(LS_KEY);
    if (!b64) return null;
    const binary = atob(b64);
    const buf = new ArrayBuffer(binary.length);
    const view = new Uint8Array(buf);
    for (let i = 0; i < binary.length; i++) view[i] = binary.charCodeAt(i);
    return buf;
  } catch (e) { return null; }
}



// ── Completed task persistence ────────────────────────────────────────────────
const LS_COMPLETED_KEY = 'interscale_completed';
function saveCompleted(ids) {
  try { localStorage.setItem(LS_COMPLETED_KEY, JSON.stringify([...ids])); } catch(e) {}
}
function loadCompleted() {
  try { const s = localStorage.getItem(LS_COMPLETED_KEY); return s ? new Set(JSON.parse(s)) : new Set(); } catch(e) { return new Set(); }
}

// ── Status override persistence ───────────────────────────────────────────────
const LS_STATUS_KEY = 'interscale_status_overrides';
function saveStatusOverrides(map) {
  try { localStorage.setItem(LS_STATUS_KEY, JSON.stringify([...map.entries()])); } catch(e) {}
}
function loadStatusOverrides() {
  try { const s = localStorage.getItem(LS_STATUS_KEY); return s ? new Map(JSON.parse(s)) : new Map(); } catch(e) { return new Map(); }
}

// ── computeStatus ─────────────────────────────────────────────────────────────
// Single source of truth for task status — used by all views.
const ALL_STATUSES = ['On Track', 'In Progress', 'Completed', 'Overdue', 'Conflict', 'Fragile'];
function computeStatus(t, statusOverrides, todayMs) {
  if (statusOverrides && statusOverrides.has(t.id)) return statusOverrides.get(t.id);
  if (t.isCompleted)          return 'Completed';
  if (t.isOverdue)            return 'Overdue';
  if (t.isC)                  return 'Conflict';
  if (t.isF)                  return 'Fragile';
  if (t.s.getTime() <= todayMs) return 'In Progress';
  return 'On Track';
}

const STATUS_STYLES = {
  'Completed':   { bg:'#0D2B1E', tx:'#34D399', bd:'#065F46' },
  'Overdue':     { bg:'#3B1219', tx:'#FB923C', bd:'#C2410C' },
  'Conflict':    { bg:'#3B1219', tx:'#F87171', bd:'#7F1D1D' },
  'Fragile':     { bg:'#2D2200', tx:'#FBBF24', bd:'#92400E' },
  'In Progress': { bg:'#0D2235', tx:'#38BDF8', bd:'#0369A1' },
  'On Track':    { bg:'#0F1F14', tx:'#4ADE80', bd:'#166534' },
};
// ── Dep overrides persistence ──────────────────────────────────────────────────
const LS_DEPS_KEY = 'interscale_dep_overrides';
function saveDepOverrides(map) {
  try { localStorage.setItem(LS_DEPS_KEY, JSON.stringify([...map.entries()])); } catch(e) {}
}
function loadDepOverrides() {
  try { const s = localStorage.getItem(LS_DEPS_KEY); return s ? new Map(JSON.parse(s)) : new Map(); } catch(e) { return new Map(); }
}

// ── normDep: normalise a dep entry to {id, type} ─────────────────────────────
function normDep(d) {
  if (typeof d === 'string') return { id: d, type: 'FS' };
  return { id: d.id, type: d.type || 'FS' };
}

// ── hasCycle: DFS — returns true if adding (fromId→toId) would create a cycle ─
function hasCycle(fromId, toId, typedDepMap) {
  const visited = new Set();
  const stack = [toId];
  while (stack.length) {
    const cur = stack.pop();
    if (cur === fromId) return true;
    if (visited.has(cur)) continue;
    visited.add(cur);
    const deps = typedDepMap[cur] || [];
    for (const d of deps) stack.push(normDep(d).id);
  }
  return false;
}

// ── Workflow persistence ───────────────────────────────────────────────────────
// Stores reusable task templates: Map<id, {id, name, tasks:[{seq,name,role,deps,depType}]}>
const LS_WORKFLOWS_KEY = 'interscale_workflows';
function saveWorkflows(map) {
  try { localStorage.setItem(LS_WORKFLOWS_KEY, JSON.stringify([...map.entries()])); } catch(e) {}
}
function loadWorkflows() {
  try { const s = localStorage.getItem(LS_WORKFLOWS_KEY); return s ? new Map(JSON.parse(s)) : new Map(); } catch(e) { return new Map(); }
}


// rawTasks, tdepMap, base come from context — not hardcoded globals.
function buildSched(rawTasks, tdepMap, base, extraDelays = {}, cascadeMode = 'full', completedIds = new Set(), todayMs = Date.now()) {
  if (!rawTasks || !rawTasks.length || !base) return [];
  // ── Compute actual start/end dates ─────────────────────────────────────────
  // cascadeMode controls how delays propagate:
  //   'full' — delays cascade through all dependents immediately
  //   'min'  — delays eat into available float first; only overflow cascades
  //   'none' — only the directly-delayed task moves; everything else frozen

  // We need orig dates available for float calculation
  const origStart = {}; // taskId → original Date (no delays)
  const origEnd   = {};
  for (const t of rawTasks) {
    origStart[t.id] = parseDate(t.start);
    origEnd[t.id]   = parseDate(t.end);
  }

  const computedStart = {};
  const computedEnd   = {};

  // For 'none' mode: identify the directly-delayed task IDs
  const directlyDelayed = new Set(Object.keys(extraDelays));

  function getStart(id) {
    if (computedStart[id] !== undefined) return computedStart[id];
    const t = rawTasks.find(x => x.id === id);
    if (!t) return (computedStart[id] = base);

    const oS = origStart[id];
    const ownDelay = extraDelays[id] || 0;

    // Base start: apply own delay if present
    let actualStart = ownDelay > 0 ? addW(oS, ownDelay) : new Date(oS);

    if (cascadeMode === 'none') {
      // Frozen mode: only directly delayed tasks move. All others stay on original date.
      if (!directlyDelayed.has(id)) {
        computedStart[id] = new Date(oS);
        return computedStart[id];
      }
      // The directly delayed task still needs to respect its own delay
      computedStart[id] = actualStart;
      return actualStart;
    }

    // Find latest constraint from deps, respecting type
    let latestDepEnd = null;
    for (const depRaw of (t.deps || [])) {
      const { id: depId, type: depType } = normDep(depRaw);
      const depType2 = depType || (tdepMap[t.id]?.find?.(d => normDep(d).id === depId) && normDep(tdepMap[t.id].find(d => normDep(d).id === depId)).type) || 'FS';
      let constraint;
      if (depType2 === 'SS') {
        // Start-to-Start: this task can start when dep starts
        constraint = getStart(depId);
      } else {
        // Finish-to-Start (default): this task starts after dep finishes
        constraint = getEnd(depId);
      }
      if (!latestDepEnd || constraint > latestDepEnd) latestDepEnd = constraint;
    }

    if (latestDepEnd) {
      if (cascadeMode === 'full') {
        // Must wait until dep finishes
        if (latestDepEnd > actualStart) {
          actualStart = addW(latestDepEnd, 1);
        }
      } else if (cascadeMode === 'min') {
        // Eat into float first. Float = gap between latestDepEnd and our original start.
        // If dep's new end > our original start, we must move.
        // If dep's new end <= our original start, the gap absorbs the push — we stay put.
        if (latestDepEnd > actualStart) {
          // Gap available = working days between latestDepEnd and our actualStart (if any)
          const gap = latestDepEnd > actualStart
            ? wdayGap(latestDepEnd, actualStart)  // dep ends after our start → no gap
            : wdayGap(latestDepEnd, actualStart);  // dep ends before our start → gap exists
          // If dep ends after we're scheduled to start, we must wait
          actualStart = addW(latestDepEnd, 1);
        }
        // else: dep ends before or on our start — we absorb, no movement
      }
    }

    computedStart[id] = actualStart;
    return actualStart;
  }

  function getEnd(id) {
    if (computedEnd[id] !== undefined) return computedEnd[id];
    const t = rawTasks.find(x => x.id === id);
    if (!t) return (computedEnd[id] = base);
    const dur = calDiff(origStart[id], origEnd[id]); // calendar duration
    const s = getStart(id);
    computedEnd[id] = new Date(s.getTime() + dur * 864e5);
    return computedEnd[id];
  }

  for (const t of rawTasks) { getStart(t.id); getEnd(t.id); }

  // ── Build task objects ─────────────────────────────────────────────────────
  const all = rawTasks.map(t => {
    const s = computedStart[t.id];
    const e = computedEnd[t.id];
    const oS = origStart[t.id];
    const ownDelay = extraDelays[t.id] || 0;
    const totalPush = s > oS ? wdayGap(oS, s) : 0;

    // Float consumed (min mode): original gap to this task's start that got eaten
    // We track this so the modal can show "float consumed" info
    let floatConsumed = 0;
    if (cascadeMode === 'min' && t.deps.length > 0 && totalPush === 0 && ownDelay === 0) {
      // Task didn't move — check if any dep's new end ate into our original float
      for (const depId of t.deps) {
        const depNewEnd = computedEnd[depId];
        const depOrigEnd = origEnd[depId];
        if (depNewEnd > depOrigEnd) {
          // How much of our original gap was consumed?
          const origGap = calDiff(depOrigEnd, oS);
          const newGap  = calDiff(depNewEnd, oS);
          floatConsumed = Math.max(floatConsumed, origGap - Math.max(0, newGap));
        }
      }
    }

    return {
      id: t.id, projId: t.proj, name: t.name, person: t.person,
      dur: t.dur, delay: ownDelay, totalPush, floatConsumed,
      s, e,
      sd: calDiff(base, s),
      cd: Math.max(1, calDiff(s, e) + 1),
      isC: false, isF: false, isDV: false, cw: [], dvDeps: [],
      isCompleted: completedIds.has(t.id),
      isOverdue: !completedIds.has(t.id) && e.getTime() < todayMs,
    };
  });

  // ── Conflict detection ─────────────────────────────────────────────────────
  for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) {
    const a = all[i], b = all[j];
    if (a.person !== b.person) continue;
    if (a.s <= b.e && b.s <= a.e) { a.isC = b.isC = true; a.cw.push(b.id); b.cw.push(a.id); }
  }

  // ── Fragile detection ──────────────────────────────────────────────────────
  const byP = {};
  for (const t of all)(byP[t.person] = byP[t.person] || []).push(t);
  for (const ts of Object.values(byP)) {
    ts.sort((a, b) => a.s - b.s);
    for (let i = 0; i < ts.length - 1; i++) {
      const gap = wdayGap(ts[i].e, ts[i + 1].s);
      if (gap <= 1) { ts[i].isF = ts[i + 1].isF = true; }
      // Min mode: if float was consumed and gap is now ≤ 1, also mark fragile
      if (cascadeMode === 'min' && ts[i + 1].floatConsumed > 0 && gap <= 2) {
        ts[i].isF = ts[i + 1].isF = true;
      }
    }
  }

  // ── Dependency violation detection (none mode only) ────────────────────────
  // A dep violation occurs when a task starts before one of its dependencies finishes.
  // This only happens in 'none' mode where downstream tasks are frozen.
  if (cascadeMode === 'none') {
    const taskMap = Object.fromEntries(all.map(t => [t.id, t]));
    for (const t of all) {
      for (const depId of (tdepMap[t.id] || [])) {
        const dep = taskMap[depId];
        if (dep && dep.e > t.s) {
          t.isDV = true;
          t.dvDeps.push(depId);
        }
      }
    }
  }

  return all;
}

// ── Bezier midpoint helper ───────────────────────────────────────────────────
// Given cubic bezier control points, returns the x/y at t=0.5 and the
// tangent angle there (degrees) — used to place the mid-arrow marker.
function bezierMid(x0, y0, cx1, cy1, cx2, cy2, x1, y1) {
  const t = 0.5, mt = 0.5;
  const mx = mt*mt*mt*x0 + 3*mt*mt*t*cx1 + 3*mt*t*t*cx2 + t*t*t*x1;
  const my = mt*mt*mt*y0 + 3*mt*mt*t*cy1 + 3*mt*t*t*cy2 + t*t*t*y1;
  const dx = 3*(mt*mt*(cx1-x0) + 2*mt*t*(cx2-cx1) + t*t*(x1-cx2));
  const dy = 3*(mt*mt*(cy1-y0) + 2*mt*t*(cy2-cy1) + t*t*(y1-cy2));
  return { mx, my, angle: Math.atan2(dy, dx) * 180 / Math.PI };
}

// ── Gantt constants ───────────────────────────────────────────────────────────
const DPX = 9, RH = 76, BH = 42, HH = 56, LW = 190;
// TD and MONS are now computed dynamically inside ProjectGanttTab
// so the timeline expands when delays push tasks beyond the base window.
// fd is declared at the top of the file

// ── computeResolution ────────────────────────────────────────────────────────
// Finds the minimum additional delays needed to eliminate all conflicts.
// Iteratively detects each conflict pair and pushes the later project's root
// task forward enough to clear the overlap, cascading until clean.
function computeResolution(rawTasks, tdepMap, base, projs, currentDelays, currentTasks) {
  const conflicts = currentTasks.filter(t => t.isC);
  if (!conflicts.length) return null;

  const resDelays = Object.assign({}, currentDelays);
  let changed = true, iterations = 0;

  while (changed && iterations < 30) {
    changed = false; iterations++;
    const preview = buildSched(rawTasks, tdepMap, base, resDelays);
    const conflicting = preview.filter(t => t.isC);
    if (!conflicting.length) break;

    const seen = new Set();
    for (const t of conflicting) {
      for (const cwId of t.cw) {
        const pairKey = [t.id, cwId].sort().join('|');
        if (seen.has(pairKey)) continue;
        seen.add(pairKey);
        const other = preview.find(x => x.id === cwId);
        if (!other) continue;

        const tIdx = projs.findIndex(p => p.id === t.projId);
        const oIdx = projs.findIndex(p => p.id === other.projId);
        let toBePushed = t.s > other.s ? t : other.s > t.s ? other : (tIdx > oIdx ? t : other);

        // Compute overlap in working days + 2 buffer
        const overlapStart = t.s > other.s ? t.s : other.s;
        const overlapEnd   = t.e < other.e ? t.e : other.e;
        const overlapWdays = wdayGap(overlapStart, overlapEnd) + 2;

        const roots = rawTasks.filter(rt => rt.proj === toBePushed.projId && rt.deps.length === 0);
        const targetId = roots.length ? roots[0].id : toBePushed.id;
        resDelays[targetId] = (resDelays[targetId] || 0) + Math.max(1, overlapWdays);
        changed = true;
      }
    }
  }

  const addedDelays = {};
  for (const [k, v] of Object.entries(resDelays)) {
    const orig = currentDelays[k] || 0;
    if (v > orig) addedDelays[k] = v - orig;
  }

  const affectedProjects = [...new Set(
    Object.keys(addedDelays).map(id => rawTasks.find(x => x.id === id)?.proj).filter(Boolean)
  )];

  const resolvedTasks = buildSched(rawTasks, tdepMap, base, resDelays);
  const maxEndDay = Math.max(...resolvedTasks.map(t => t.sd + t.cd));
  const newEnd = new Date(base.getTime() + maxEndDay * 864e5);

  return { resDelays, addedDelays, affectedProjects, newEnd };
}

// ── EditModal ─────────────────────────────────────────────────────────────────
// Opens when user clicks a task bar or the "✎ Delay Px" toolbar buttons.
// Shows delay slider, live impact preview, cross-project warning, and confirm step.
function EditModal({ target, tasks, simDelays, onApply, onShift, onClose, onDelete, statusOverrides, onSetStatus, todayMs, onSaveDeps }) {
  const { rawTasks, projs, people, tdepMap, base, todayDay, periods } = useSched() || {};

  // ── All hooks must be called unconditionally before any early return ──────
  const [selectedTaskId, setSelectedTaskId] = useState('__all__');
  const [modalTab, setModalTab] = useState('shift'); // 'shift' | 'details'
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [shiftDays,    setShiftDays]    = useState(0);
  const [cascadeMode,  setCascadeMode]  = useState('full');
  const [needsConfirm, setNeedsConfirm] = useState(false);
  const [depSearch,    setDepSearch]    = useState('');
  const [newDepType,   setNewDepType]   = useState('FS');
  const [depError,     setDepError]     = useState('');

  const reset = () => setNeedsConfirm(false);

  const isProject = target.type === 'project';

  // Build the delays object for preview — used by buildSched to show live impact
  // For negative shifts we pass 0 (no positive delay) so the preview shows original
  // minus the backward offset; we recompute via shiftedRawTasks instead.
  const shiftedRawTasks = useMemo(() => {
    if (!rawTasks || shiftDays === 0) return rawTasks || [];
    const idsToShift = isProject
      ? (selectedTaskId === '__all__'
          ? rawTasks.filter(t => t.proj === target.id).map(t => t.id)
          : [selectedTaskId])
      : [target.id];
    return rawTasks.map(t => {
      if (!idsToShift.includes(t.id)) return t;
      const sDate = parseDate(t.start);
      const eDate = parseDate(t.end);
      if (!sDate || !eDate) return t;
      return { ...t, start: fmtDDMMYYYY(addW(sDate, shiftDays)), end: fmtDDMMYYYY(addW(eDate, shiftDays)) };
    });
  }, [shiftDays, rawTasks, isProject, target.id, selectedTaskId]);

  const previewDelays = {}; // No extra delays — dates are baked into shiftedRawTasks

  // Preview schedule with shifted raw tasks
  const preview = useMemo(() => {
    if (!shiftedRawTasks || !tdepMap || !base) return [];
    return buildSched(shiftedRawTasks, tdepMap, base, {}, cascadeMode);
  }, [shiftedRawTasks, tdepMap, base, cascadeMode]);

  // The directly shifted task IDs — must be before early return (Rules of Hooks)
  const directIds = useMemo(() => {
    if (!rawTasks) return [];
    if (isProject && selectedTaskId === '__all__')
      return rawTasks.filter(t => t.proj === target.id).map(t => t.id);
    return [isProject ? selectedTaskId : target.id];
  }, [isProject, selectedTaskId, target.id, rawTasks]);

  // Guard: if context data isn't ready yet, don't render
  if (!rawTasks || !projs || !base) return null;

  // ── Colour constants (not in scope from ScheduleApp — must be local) ──────
  const BORDER = '#2A2A3A';
  const TEXT   = '#E8E8F0';
  const MUTED  = '#6B7280';

  const proj         = isProject ? projs.find(p => p.id === target.id) : null;
  const projectTasks = isProject ? rawTasks.filter(t => t.proj === target.id) : [];
  const rawTask      = !isProject ? rawTasks.find(t => t.id === target.id) : null;
  const liveTask     = !isProject ? tasks.find(t => t.id === target.id) : null;

  // ── Derived impact data ───────────────────────────────────────────────────

  // Transitive downstream check
  function isDownstream(taskId, roots, visited = new Set()) {
    if (visited.has(taskId)) return false;
    visited.add(taskId);
    for (const d of (tdepMap[taskId] || [])) {
      if (roots.includes(d) || isDownstream(d, roots, visited)) return true;
    }
    return false;
  }

  const cascaded = preview.filter(t => {
    if (directIds.includes(t.id)) return false;
    const o = tasks.find(x => x.id === t.id);
    return o && t.sd !== o.sd;
  });

  const floatConsumed = cascadeMode === 'min'
    ? preview.filter(t => {
        if (directIds.includes(t.id)) return false;
        const o = tasks.find(x => x.id === t.id);
        return o && t.sd === o.sd && t.floatConsumed > 0;
      })
    : [];

  const absorbed = cascadeMode === 'full'
    ? preview.filter(t => {
        if (directIds.includes(t.id)) return false;
        const o = tasks.find(x => x.id === t.id);
        if (!o || t.sd !== o.sd) return false;
        return isDownstream(t.id, directIds);
      })
    : [];

  const depViolations = cascadeMode === 'none'
    ? preview.filter(t => t.isDV)
    : [];

  const newConflicts = preview.filter(t => t.isC && !tasks.find(x => x.id === t.id && x.isC));
  const newFragile   = cascadeMode === 'min'
    ? preview.filter(t => t.isF && !tasks.find(x => x.id === t.id && x.isF))
    : [];

  const otherAffected = [...new Set(cascaded.map(t => t.projId))]
    .filter(pid => pid !== (isProject ? target.id : rawTask?.proj));

  // Recovery cost for no-cascade: max days any dep-violated task finishes late
  const recoveryCost = cascadeMode === 'none' && depViolations.length > 0
    ? Math.max(...depViolations.map(t => {
        const o = tasks.find(x => x.id === t.id);
        return o ? Math.max(0, Math.round((t.e.getTime() - o.e.getTime()) / 864e5)) : 0;
      }))
    : 0;
  // Actually for none mode, recovery cost = how late the delayed task finishes vs original
  const directTask = preview.find(t => directIds.includes(t.id));
  const directOrig = tasks.find(t => directIds.includes(t.id));
  const recoveryDays = cascadeMode === 'none' && directTask && directOrig
    ? Math.max(0, Math.round((directTask.e.getTime() - directOrig.e.getTime()) / 864e5))
    : 0;

  const projColor = isProject ? (proj?.color || '#888') : (projs.find(p => p.id === rawTask?.proj)?.color || '#888');
  const title     = isProject ? `Adjust Timeline: ${proj?.id}` : `Adjust Timeline: ${rawTask?.name || ''}`;
  const subtitle  = isProject ? proj?.name : `${liveTask?.projId} · ${rawTask?.id} · ${rawTask?.person}`;

  const willConflict = newConflicts.length > 0 || depViolations.length > 0;

  const handleApply = () => {
    if (shiftDays === 0) { onClose(); return; }
    if (willConflict && !needsConfirm) { setNeedsConfirm(true); return; }
    onShift(directIds, shiftDays, cascadeMode);
    onClose();
  };

  const pTask = preview.find(t => directIds.includes(t.id));
  const origTask = tasks.find(t => directIds.includes(t.id));

  // Mode labels and descriptions
  const MODES = [
    { key:'full', label:'Full',  desc:'All dependents shift together' },
    { key:'min',  label:'Min',   desc:'Float absorbs shift first; only overflow cascades' },
    { key:'none', label:'None',  desc:'Only selected tasks move; violations flagged' },
  ];

  return (
    <div style={{ position:'fixed', inset:0, zIndex:1000, background:'rgba(15,23,42,0.6)', backdropFilter:'blur(4px)', display:'flex', alignItems:'center', justifyContent:'center' }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{ background:'white', borderRadius:'16px', width:'500px', maxWidth:'95vw', boxShadow:'0 24px 64px rgba(0,0,0,0.3)', overflow:'hidden', maxHeight:'92vh', display:'flex', flexDirection:'column' }}>

        {/* Header */}
        <div style={{ padding:'18px 22px 14px', borderBottom:`3px solid ${projColor}`, background:'#FAFAFA', flexShrink:0 }}>
          <div style={{ display:'flex', alignItems:'flex-start', justifyContent:'space-between' }}>
            <div>
              <div style={{ fontSize:'14px', fontWeight:'700', color:'#0F172A', marginBottom:'3px' }}>{title}</div>
              <div style={{ fontSize:'11px', color:'#64748B' }}>{subtitle}</div>
            </div>
            <button onClick={onClose} style={{ background:'none', border:'none', cursor:'pointer', color:'#94A3B8', fontSize:'22px', lineHeight:'1', padding:'0', marginTop:'-3px' }}>×</button>
          </div>
          {!isProject && liveTask && (
            <div style={{ display:'flex', gap:'16px', marginTop:'10px', fontSize:'11px', color:'#64748B' }}>
              <span>Start: <strong style={{color:'#0F172A'}}>{fd(liveTask.s)}</strong></span>
              <span>End: <strong style={{color:'#0F172A'}}>{fd(liveTask.e)}</strong></span>
              <span>Duration: <strong style={{color:'#0F172A'}}>{liveTask.dur}d</strong></span>
            </div>
          )}
        </div>

        {/* Tab switcher */}
        <div style={{ display:'flex', borderBottom:`1px solid ${BORDER}`, background:'#17171F', flexShrink:0 }}>
          {[{id:'shift',l:'Shift Timeline'},{id:'details',l:'Details'}].map(t => (
            <button key={t.id} onClick={() => { setModalTab(t.id); setConfirmDelete(false); }}
              style={{ padding:'10px 16px', border:'none', background:'none', cursor:'pointer', fontSize:'12px', fontWeight:modalTab===t.id?'600':'400', color:modalTab===t.id?projColor:MUTED, borderBottom:modalTab===t.id?`2px solid ${projColor}`:'2px solid transparent', marginBottom:'-1px' }}>
              {t.l}
            </button>
          ))}
        </div>

        {/* Scrollable body */}
        <div style={{ padding:'18px 22px', overflowY:'auto', flex:1 }}>

        {modalTab === 'details' && (() => {
          const detailTask = !isProject ? liveTask : null;
          const detailRaw  = !isProject ? rawTask  : null;
          const depNames   = !isProject ? (tdepMap[target.id]||[]).map(id => { const d = rawTasks.find(x=>x.id===id); return d?`${id} — ${d.name}`:id; }) : [];
          const ORANGE_RED = '#EF4444';

          return (
            <div>
              {isProject ? (
                // Project details
                <div>
                  <div style={{ display:'flex', alignItems:'center', gap:'10px', marginBottom:'18px', padding:'12px 14px', background:'#17171F', borderRadius:'10px', border:`1px solid ${BORDER}` }}>
                    <div style={{ width:'12px', height:'12px', borderRadius:'50%', background:proj.color, flexShrink:0 }} />
                    <div>
                      <div style={{ fontSize:'14px', fontWeight:'700', color:TEXT }}>{proj.id}</div>
                      <div style={{ fontSize:'11px', color:MUTED, marginTop:'2px' }}>{proj.name}</div>
                    </div>
                    <div style={{ marginLeft:'auto', textAlign:'right' }}>
                      <div style={{ fontSize:'20px', fontWeight:'800', color:TEXT }}>{projectTasks.length}</div>
                      <div style={{ fontSize:'10px', color:MUTED }}>tasks</div>
                    </div>
                  </div>
                  <div style={{ display:'grid', gap:'4px', marginBottom:'20px' }}>
                    {projectTasks.map(t => {
                      const lt = tasks.find(x => x.id === t.id);
                      return (
                        <div key={t.id} style={{ display:'flex', alignItems:'center', gap:'10px', padding:'8px 12px', borderRadius:'7px', background:'#17171F', border:`1px solid ${BORDER}` }}>
                          <span style={{ fontSize:'11px', fontWeight:'600', color:proj.color, width:'40px', flexShrink:0 }}>{t.id.split('-')[1]}</span>
                          <span style={{ fontSize:'12px', color:TEXT, flex:1, minWidth:0, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{t.name}</span>
                          <span style={{ fontSize:'11px', color:MUTED, whiteSpace:'nowrap' }}>{t.person}</span>
                          {lt?.isC && <span style={{ width:'16px', height:'16px', borderRadius:'50%', background:'#EF4444', display:'flex', alignItems:'center', justifyContent:'center', fontSize:'9px', color:'white', fontWeight:'800', flexShrink:0 }}>!</span>}
                        </div>
                      );
                    })}
                  </div>
                  {/* Delete project */}
                  <div style={{ borderTop:`1px solid ${BORDER}`, paddingTop:'16px' }}>
                    {!confirmDelete ? (
                      <button onClick={() => setConfirmDelete(true)}
                        style={{ width:'100%', padding:'9px', borderRadius:'8px', border:'1px solid #7F1D1D', background:'transparent', color:'#F87171', fontSize:'13px', cursor:'pointer', fontWeight:'600', display:'flex', alignItems:'center', justifyContent:'center', gap:'6px' }}>
                        🗑 Delete Project
                      </button>
                    ) : (
                      <div style={{ padding:'12px 14px', borderRadius:'8px', background:'#3B1219', border:'1px solid #7F1D1D' }}>
                        <div style={{ fontSize:'12px', color:'#FCA5A5', marginBottom:'10px', lineHeight:'1.5' }}>
                          <strong>Delete {proj.id}?</strong> This removes all {projectTasks.length} tasks and any people with no remaining assignments.
                        </div>
                        <div style={{ display:'flex', gap:'8px' }}>
                          <button onClick={() => setConfirmDelete(false)} style={{ flex:1, padding:'7px', borderRadius:'7px', border:`1px solid ${BORDER}`, background:'transparent', color:MUTED, fontSize:'12px', cursor:'pointer' }}>Cancel</button>
                          <button onClick={() => { onDelete({ type:'deleteProject', projId:proj.id }); onClose(); }}
                            style={{ flex:2, padding:'7px', borderRadius:'7px', border:'none', background:'#EF4444', color:'white', fontSize:'12px', fontWeight:'700', cursor:'pointer' }}>
                            Yes, delete project
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              ) : (
                // Task details
                <div>
                  <div style={{ display:'grid', gridTemplateColumns:'90px 1fr', gap:'8px 12px', marginBottom:'18px', fontSize:'12px' }}>
                    {[
                      ['Task ID',    target.id],
                      ['Project',    liveTask?.projId || ''],
                      ['Name',       rawTask?.name || ''],
                      ['Assigned',   rawTask?.person || ''],
                      ['Role',       people.find(p=>p.name===rawTask?.person)?.role || ''],
                      ['Rate',       people.find(p=>p.name===rawTask?.person)?.rate || ''],
                      ['Start',      liveTask ? fd(liveTask.s) : ''],
                      ['End',        liveTask ? fd(liveTask.e) : ''],
                      ['Duration',   rawTask ? `${rawTask.dur} working day${rawTask.dur!==1?'s':''}` : ''],
                    ].map(([k,v]) => (
                      <><div key={k+'-k'} style={{ color:MUTED, fontWeight:'500' }}>{k}</div><div key={k+'-v'} style={{ color:TEXT }}>{v||'—'}</div></>
                    ))}
                  </div>

                  {/* ── Dependency management ── */}
                  {liveTask && (() => {
                    // Current typed deps for this task
                    const currentDeps = (tdepMap[target.id] || []).map(normDep);

                    // All tasks that could be a dep (exclude self, and tasks that would create a cycle)
                    const candidateTasks = rawTasks
                      .filter(t => t.id !== target.id)
                      .filter(t => {
                        const search = depSearch.toLowerCase();
                        return !search || t.id.toLowerCase().includes(search) || t.name.toLowerCase().includes(search) || t.proj.toLowerCase().includes(search);
                      })
                      .filter(t => !currentDeps.find(d => d.id === t.id));

                    const addDep = (depId) => {
                      if (hasCycle(target.id, depId, tdepMap)) {
                        setDepError(`Cannot add: would create a circular dependency.`);
                        return;
                      }
                      setDepError('');
                      const next = [...currentDeps, { id: depId, type: newDepType }];
                      onSaveDeps && onSaveDeps(target.id, next);
                      setDepSearch('');
                    };

                    const removeDep = (depId) => {
                      setDepError('');
                      const next = currentDeps.filter(d => d.id !== depId);
                      onSaveDeps && onSaveDeps(target.id, next);
                    };

                    const changeDepType = (depId, type) => {
                      const next = currentDeps.map(d => d.id === depId ? { ...d, type } : d);
                      onSaveDeps && onSaveDeps(target.id, next);
                    };

                    const projColor2 = projColor;

                    return (
                      <div style={{ marginBottom:'18px', padding:'12px 14px', borderRadius:'10px', background:'#17171F', border:`1px solid ${BORDER}` }}>
                        <div style={{ fontSize:'11px', fontWeight:'700', color:MUTED, textTransform:'uppercase', letterSpacing:'0.06em', marginBottom:'10px' }}>
                          Dependencies
                          <span style={{ marginLeft:'6px', color:MUTED, fontWeight:'400', textTransform:'none', letterSpacing:0 }}>— {currentDeps.length} link{currentDeps.length!==1?'s':''}</span>
                        </div>

                        {/* Current deps list */}
                        {currentDeps.length === 0 && (
                          <div style={{ fontSize:'11px', color:MUTED, marginBottom:'10px', fontStyle:'italic' }}>No dependencies set</div>
                        )}
                        {currentDeps.map(d => {
                          const depTask = rawTasks.find(t => t.id === d.id);
                          const depProj = projs.find(p => p.id === depTask?.proj);
                          return (
                            <div key={d.id} style={{ display:'flex', alignItems:'center', gap:'8px', marginBottom:'6px', padding:'7px 10px', borderRadius:'7px', background:'#0F0F18', border:`1px solid ${BORDER}` }}>
                              {/* Type toggle pill */}
                              <div style={{ display:'flex', borderRadius:'6px', overflow:'hidden', border:`1px solid ${BORDER}`, flexShrink:0 }}>
                                {['FS','SS'].map(t => (
                                  <button key={t} onClick={() => changeDepType(d.id, t)}
                                    style={{ padding:'2px 8px', border:'none', cursor:'pointer', fontSize:'10px', fontWeight:'700',
                                      background: d.type === t ? projColor2 : 'transparent',
                                      color: d.type === t ? 'white' : MUTED }}>
                                    {t}
                                  </button>
                                ))}
                              </div>
                              {/* Arrow */}
                              <span style={{ fontSize:'10px', color:MUTED, flexShrink:0 }}>→</span>
                              {/* Dep task info */}
                              <div style={{ flex:1, minWidth:0 }}>
                                <div style={{ fontSize:'11px', fontWeight:'600', color:depProj?.color || TEXT, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
                                  {d.id}
                                </div>
                                <div style={{ fontSize:'10px', color:MUTED, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
                                  {depTask?.name || '?'} · {depTask?.person || '?'}
                                </div>
                              </div>
                              {/* Cross-project badge */}
                              {depTask?.proj !== liveTask.projId && (
                                <span style={{ fontSize:'9px', color:'#38BDF8', background:'#38BDF818', padding:'2px 6px', borderRadius:'6px', border:'1px solid #38BDF840', flexShrink:0 }}>cross-proj</span>
                              )}
                              {/* Remove */}
                              <button onClick={() => removeDep(d.id)}
                                style={{ width:'20px', height:'20px', borderRadius:'5px', border:`1px solid ${BORDER}`, background:'transparent', cursor:'pointer', color:MUTED, fontSize:'11px', display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}
                                onMouseEnter={e=>e.currentTarget.style.color='#EF4444'}
                                onMouseLeave={e=>e.currentTarget.style.color=MUTED}>✕</button>
                            </div>
                          );
                        })}

                        {/* Add new dep */}
                        <div style={{ marginTop:'10px', borderTop:`1px solid ${BORDER}`, paddingTop:'10px' }}>
                          <div style={{ fontSize:'10px', fontWeight:'700', color:MUTED, marginBottom:'6px', textTransform:'uppercase', letterSpacing:'0.05em' }}>Add dependency</div>
                          <div style={{ display:'flex', gap:'6px', marginBottom:'6px' }}>
                            {/* Type selector */}
                            <div style={{ display:'flex', borderRadius:'7px', overflow:'hidden', border:`1px solid ${BORDER}`, flexShrink:0 }}>
                              {['FS','SS'].map(t => (
                                <button key={t} onClick={() => setNewDepType(t)}
                                  style={{ padding:'5px 10px', border:'none', cursor:'pointer', fontSize:'11px', fontWeight:'700',
                                    background: newDepType === t ? projColor2 : 'transparent',
                                    color: newDepType === t ? 'white' : MUTED }}>
                                  {t}
                                </button>
                              ))}
                            </div>
                            {/* Search input */}
                            <input value={depSearch} onChange={e => { setDepSearch(e.target.value); setDepError(''); }}
                              placeholder="Search task ID or name..."
                              style={{ flex:1, padding:'5px 9px', borderRadius:'7px', border:`1px solid ${BORDER}`, background:'#0F0F18', color:TEXT, fontSize:'11px', outline:'none' }} />
                          </div>

                          {/* Candidate list */}
                          {depSearch.trim() && (
                            <div style={{ maxHeight:'150px', overflowY:'auto', borderRadius:'7px', border:`1px solid ${BORDER}`, background:'#0F0F18' }}>
                              {candidateTasks.length === 0 && (
                                <div style={{ padding:'10px', fontSize:'11px', color:MUTED, textAlign:'center' }}>No matching tasks</div>
                              )}
                              {candidateTasks.slice(0, 20).map(t => {
                                const tp = projs.find(p => p.id === t.proj);
                                const isCross = t.proj !== liveTask.projId;
                                const wouldCycle = hasCycle(target.id, t.id, tdepMap);
                                return (
                                  <div key={t.id}
                                    onClick={() => !wouldCycle && addDep(t.id)}
                                    style={{ display:'flex', alignItems:'center', gap:'8px', padding:'8px 10px', cursor: wouldCycle ? 'not-allowed' : 'pointer', borderBottom:`1px solid ${BORDER}20`, opacity: wouldCycle ? 0.4 : 1 }}
                                    onMouseEnter={e => { if (!wouldCycle) e.currentTarget.style.background='#1C1C27'; }}
                                    onMouseLeave={e => e.currentTarget.style.background='transparent'}>
                                    <div style={{ width:'7px', height:'7px', borderRadius:'50%', background:tp?.color||MUTED, flexShrink:0 }} />
                                    <div style={{ flex:1, minWidth:0 }}>
                                      <div style={{ fontSize:'11px', fontWeight:'600', color:tp?.color||TEXT }}>{t.id}</div>
                                      <div style={{ fontSize:'10px', color:MUTED, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{t.name} · {t.person}</div>
                                    </div>
                                    {isCross && <span style={{ fontSize:'9px', color:'#38BDF8', flexShrink:0 }}>cross-proj</span>}
                                    {wouldCycle && <span style={{ fontSize:'9px', color:'#EF4444', flexShrink:0 }}>cycle!</span>}
                                  </div>
                                );
                              })}
                            </div>
                          )}

                          {depError && <div style={{ marginTop:'6px', fontSize:'11px', color:'#F87171' }}>{depError}</div>}
                        </div>
                      </div>
                    );
                  })()}

                  {/* ── Status override ── */}
                  {liveTask && (() => {
                    const defaultStatus = computeStatus(liveTask, new Map(), todayMs || Date.now());
                    const currentOverride = statusOverrides?.get(target.id) || null;
                    const displayStatus = currentOverride || defaultStatus;
                    const ss = STATUS_STYLES[displayStatus] || STATUS_STYLES['On Track'];
                    return (
                      <div style={{ marginBottom:'18px', padding:'12px 14px', borderRadius:'10px', background:'#17171F', border:`1px solid ${BORDER}` }}>
                        <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:'10px' }}>
                          <div style={{ fontSize:'11px', fontWeight:'700', color:MUTED, textTransform:'uppercase', letterSpacing:'0.06em' }}>Status</div>
                          <div style={{ display:'flex', alignItems:'center', gap:'6px' }}>
                            <span style={{ background:ss.bg, color:ss.tx, border:`1px solid ${ss.bd}`, padding:'2px 9px', borderRadius:'10px', fontSize:'11px', fontWeight:'600' }}>
                              {displayStatus}
                            </span>
                            {currentOverride && (
                              <span style={{ fontSize:'10px', color:'#F97316', fontWeight:'600', background:'#F9731618', padding:'2px 7px', borderRadius:'8px', border:'1px solid #F9731640' }}>overridden</span>
                            )}
                          </div>
                        </div>
                        <div style={{ display:'flex', flexWrap:'wrap', gap:'5px' }}>
                          {/* Default option */}
                          <button
                            onClick={() => onSetStatus && onSetStatus(target.id, null)}
                            style={{ padding:'4px 10px', borderRadius:'8px', fontSize:'11px', fontWeight:'600', cursor:'pointer', border:`1.5px solid ${!currentOverride ? '#F97316' : BORDER}`, background: !currentOverride ? '#F9731618' : 'transparent', color: !currentOverride ? '#F97316' : MUTED }}>
                            Default
                          </button>
                          {ALL_STATUSES.map(s => {
                            const sStyle = STATUS_STYLES[s];
                            const isActive = currentOverride === s;
                            return (
                              <button key={s}
                                onClick={() => onSetStatus && onSetStatus(target.id, s)}
                                style={{ padding:'4px 10px', borderRadius:'8px', fontSize:'11px', fontWeight:'600', cursor:'pointer',
                                  border:`1.5px solid ${isActive ? sStyle.tx : BORDER}`,
                                  background: isActive ? sStyle.bg : 'transparent',
                                  color: isActive ? sStyle.tx : MUTED }}>
                                {s}
                              </button>
                            );
                          })}
                        </div>
                        {currentOverride && (
                          <div style={{ marginTop:'8px', fontSize:'10px', color:MUTED, lineHeight:'1.5' }}>
                            Auto-detected: <span style={{ color: STATUS_STYLES[defaultStatus]?.tx || MUTED, fontWeight:'600' }}>{defaultStatus}</span>
                            {' · '}
                            <button onClick={() => onSetStatus && onSetStatus(target.id, null)}
                              style={{ background:'none', border:'none', cursor:'pointer', color:'#F97316', fontSize:'10px', fontWeight:'600', padding:0 }}>
                              Reset to default
                            </button>
                          </div>
                        )}
                      </div>
                    );
                  })()}

                  {liveTask?.isC && (
                    <div style={{ padding:'8px 12px', borderRadius:'7px', background:'#3B1219', border:'1px solid #7F1D1D', color:'#FCA5A5', fontSize:'11px', marginBottom:'14px' }}>
                      ⚠ Resource conflict — clashes with {liveTask.cw.map(id=>{ const c=tasks.find(x=>x.id===id); return c?`${c.id} (${c.person})`:id; }).join(', ')}
                    </div>
                  )}
                  {liveTask?.isDV && (
                    <div style={{ padding:'8px 12px', borderRadius:'7px', background:'#2D1A00', border:'1px dashed #92400E', color:'#FBBF24', fontSize:'11px', marginBottom:'14px' }}>
                      ⊗ Dependency violation — starts before prerequisite finishes
                    </div>
                  )}
                  {/* Delete task */}
                  <div style={{ borderTop:`1px solid ${BORDER}`, paddingTop:'16px' }}>
                    {!confirmDelete ? (
                      <button onClick={() => setConfirmDelete(true)}
                        style={{ width:'100%', padding:'9px', borderRadius:'8px', border:'1px solid #7F1D1D', background:'transparent', color:'#F87171', fontSize:'13px', cursor:'pointer', fontWeight:'600', display:'flex', alignItems:'center', justifyContent:'center', gap:'6px' }}>
                        🗑 Delete Task
                      </button>
                    ) : (
                      <div style={{ padding:'12px 14px', borderRadius:'8px', background:'#3B1219', border:'1px solid #7F1D1D' }}>
                        <div style={{ fontSize:'12px', color:'#FCA5A5', marginBottom:'10px', lineHeight:'1.5' }}>
                          <strong>Delete "{rawTask?.name}"?</strong> Any tasks that depend on it may be affected.
                        </div>
                        <div style={{ display:'flex', gap:'8px' }}>
                          <button onClick={() => setConfirmDelete(false)} style={{ flex:1, padding:'7px', borderRadius:'7px', border:`1px solid ${BORDER}`, background:'transparent', color:MUTED, fontSize:'12px', cursor:'pointer' }}>Cancel</button>
                          <button onClick={() => { onDelete({ type:'deleteTask', taskId:target.id }); onClose(); }}
                            style={{ flex:2, padding:'7px', borderRadius:'7px', border:'none', background:'#EF4444', color:'white', fontSize:'12px', fontWeight:'700', cursor:'pointer' }}>
                            Yes, delete task
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          );
        })()}

        {modalTab === 'shift' && (<div>
          {isProject && (
            <div style={{ marginBottom:'14px' }}>
              <div style={{ fontSize:'11px', fontWeight:'700', color:'#475569', textTransform:'uppercase', letterSpacing:'0.06em', marginBottom:'6px' }}>Which tasks to shift</div>
              <select value={selectedTaskId} onChange={e => { setSelectedTaskId(e.target.value); reset(); }}
                style={{ width:'100%', padding:'8px 10px', borderRadius:'8px', border:'1px solid #E2E8F0', fontSize:'12px', color:'#0F172A', background:'white', cursor:'pointer', outline:'none' }}>
                <option value="__all__">Entire project (all tasks)</option>
                {projectTasks.map(t => (
                  <option key={t.id} value={t.id}>{t.id} — {t.name} ({t.person})</option>
                ))}
              </select>
            </div>
          )}

          {/* Cascade mode selector */}
          <div style={{ marginBottom:'16px' }}>
            <div style={{ fontSize:'11px', fontWeight:'700', color:'#475569', textTransform:'uppercase', letterSpacing:'0.06em', marginBottom:'8px' }}>Cascade Mode</div>
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:'6px' }}>
              {MODES.map(m => (
                <div key={m.key} onClick={() => { setCascadeMode(m.key); reset(); }}
                  style={{ padding:'8px 10px', borderRadius:'8px', border:`1.5px solid ${cascadeMode === m.key ? projColor : '#E2E8F0'}`, background: cascadeMode === m.key ? projColor+'0F' : 'white', cursor:'pointer', textAlign:'center' }}>
                  <div style={{ fontSize:'12px', fontWeight:'700', color: cascadeMode === m.key ? projColor : '#374151' }}>{m.label}</div>
                  <div style={{ fontSize:'9px', color:'#94A3B8', marginTop:'3px', lineHeight:'1.3' }}>{m.desc}</div>
                </div>
              ))}
            </div>
          </div>

          {/* Shift slider — bidirectional */}
          <div style={{ marginBottom:'14px' }}>
            <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:'8px' }}>
              <div style={{ fontSize:'11px', fontWeight:'700', color:'#475569', textTransform:'uppercase', letterSpacing:'0.06em' }}>Shift by</div>
              <div style={{ fontSize:'11px', color:'#64748B' }}>← backward · forward →</div>
            </div>
            <div style={{ display:'flex', alignItems:'center', gap:'10px' }}>
              <button onClick={() => { setShiftDays(d => Math.max(-60, d-1)); reset(); }}
                style={{ width:'32px', height:'32px', borderRadius:'8px', border:'1px solid #E2E8F0', background:'#F8FAFC', cursor:'pointer', fontSize:'18px', color:'#475569', display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>−</button>
              <input type="range" min="-60" max="60" value={shiftDays}
                onChange={e => { setShiftDays(Number(e.target.value)); reset(); }}
                style={{ flex:1, accentColor:projColor }} />
              <button onClick={() => { setShiftDays(d => Math.min(60, d+1)); reset(); }}
                style={{ width:'32px', height:'32px', borderRadius:'8px', border:'1px solid #E2E8F0', background:'#F8FAFC', cursor:'pointer', fontSize:'18px', color:'#475569', display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>+</button>
              <div style={{ width:'68px', textAlign:'center', padding:'6px 8px', borderRadius:'8px', background:projColor+'14', border:`1.5px solid ${projColor}50`, fontSize:'15px', fontWeight:'800', color: shiftDays < 0 ? '#10B981' : shiftDays > 0 ? projColor : '#94A3B8', fontVariantNumeric:'tabular-nums', flexShrink:0 }}>
                {shiftDays > 0 ? `+${shiftDays}d` : shiftDays < 0 ? `${shiftDays}d` : '0d'}
              </div>
            </div>
          </div>

          {/* New dates preview */}
          {pTask && shiftDays !== 0 && (
            <div style={{ marginBottom:'14px', fontSize:'11px', color:'#64748B', display:'flex', gap:'14px', padding:'7px 10px', background:'#F8FAFC', borderRadius:'8px', border:'1px solid #F1F5F9' }}>
              {origTask && <span>Was: <strong style={{color:'#94A3B8', textDecoration:'line-through'}}>{fd(origTask.s)} → {fd(origTask.e)}</strong></span>}
              <span>Now: <strong style={{color:'#0F172A'}}>{fd(pTask.s)} → {fd(pTask.e)}</strong></span>
            </div>
          )}

          {/* Warn if backward shift would make tasks overdue */}
          {shiftDays < 0 && pTask && pTask.e.getTime() < Date.now() && (
            <div style={{ marginBottom:'14px', padding:'8px 10px', borderRadius:'8px', background:'#FFF7ED', border:'1px solid #FED7AA', fontSize:'11px', color:'#92400E', lineHeight:'1.5' }}>
              ⚠ New end date is in the past — affected tasks will be flagged as <strong>overdue</strong> unless marked complete.
            </div>
          )}

          {/* ── Impact panel ── */}
          <div style={{ background:'#F8FAFC', borderRadius:'10px', padding:'12px 14px', marginBottom:'14px', border:'1px solid #E2E8F0' }}>
            <div style={{ fontSize:'10px', fontWeight:'700', color:'#94A3B8', textTransform:'uppercase', letterSpacing:'0.07em', marginBottom:'10px' }}>
              Impact · <span style={{ color: cascadeMode === 'full' ? '#6366F1' : cascadeMode === 'min' ? '#10B981' : '#F59E0B' }}>{MODES.find(m => m.key === cascadeMode)?.label} Cascade</span>
            </div>

            {/* ── FULL MODE tiles ── */}
            {cascadeMode === 'full' && (
              <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:'8px', marginBottom: cascaded.length > 0 || otherAffected.length > 0 ? '10px' : '0' }}>
                <Tile v={cascaded.length} label="cascade" color="#F59E0B" bg="#FEF3C7" border="#FDE68A" />
                <Tile v={absorbed.length}  label="absorbed" color="#10B981" bg="#DCFCE7" border="#86EFAC" />
                <Tile v={newConflicts.length} label="conflicts" color={newConflicts.length > 0 ? '#EF4444' : '#94A3B8'} bg={newConflicts.length > 0 ? '#FEF2F2' : '#F8FAFC'} border={newConflicts.length > 0 ? '#FECACA' : '#F1F5F9'} />
              </div>
            )}

            {/* ── MIN MODE tiles ── */}
            {cascadeMode === 'min' && (
              <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:'8px', marginBottom:'10px' }}>
                <Tile v={cascaded.length}      label="cascade"       color="#F59E0B" bg="#FEF3C7" border="#FDE68A" />
                <Tile v={floatConsumed.length} label="float eaten"   color="#10B981" bg="#DCFCE7" border="#86EFAC" />
                <Tile v={newFragile.length}    label="now fragile"   color={newFragile.length > 0 ? '#F59E0B' : '#94A3B8'} bg={newFragile.length > 0 ? '#FEF9C3' : '#F8FAFC'} border={newFragile.length > 0 ? '#FDE68A' : '#F1F5F9'} />
              </div>
            )}

            {/* ── NONE MODE tiles ── */}
            {cascadeMode === 'none' && (
              <>
                <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'8px', marginBottom:'10px' }}>
                  <Tile v={depViolations.length} label="dep. violations" color={depViolations.length > 0 ? '#F59E0B' : '#94A3B8'} bg={depViolations.length > 0 ? '#FFF7ED' : '#F8FAFC'} border={depViolations.length > 0 ? '#FED7AA' : '#F1F5F9'} />
                  <Tile v={newConflicts.length}  label="conflicts"       color={newConflicts.length > 0 ? '#EF4444' : '#94A3B8'} bg={newConflicts.length > 0 ? '#FEF2F2' : '#F8FAFC'} border={newConflicts.length > 0 ? '#FECACA' : '#F1F5F9'} />
                </div>
                {recoveryDays > 0 && (
                  <div style={{ padding:'8px 10px', borderRadius:'8px', background:'#F0F9FF', border:'1px solid #BAE6FD', fontSize:'11px', color:'#0C4A6E', lineHeight:'1.5', marginBottom:'8px' }}>
                    <strong>Recovery cost:</strong> ~{recoveryDays} working day{recoveryDays !== 1 ? 's' : ''} would need to be found downstream to maintain the original end date. Use this number in client conversations.
                  </div>
                )}
              </>
            )}

            {/* Float consumed list (min mode) */}
            {cascadeMode === 'min' && floatConsumed.length > 0 && (
              <TaskList
                items={floatConsumed.slice(0, 4)}
                tasks={tasks}
                icon="⚡"
                label="Float consumed — buffer shrinking"
                labelColor="#10B981"
                bg="#F0FDF4"
                getValue={t => `${t.floatConsumed}d eaten`}
                valueColor="#14532D"
              />
            )}

            {/* Cascaded list (full + min) */}
            {cascaded.length > 0 && (cascadeMode === 'full' || cascadeMode === 'min') && (
              <TaskList
                items={cascaded.slice(0, 5)}
                tasks={tasks}
                icon="⬇"
                label="Tasks that cascade"
                labelColor="#F59E0B"
                bg="#FFFBEB"
                getValue={(t) => { const o = tasks.find(x => x.id === t.id); if (!o) return ''; const diff = Math.round((t.s - o.s) / 864e5); return diff >= 0 ? `+${diff}d` : `${diff}d`; }}
                valueColor="#92400E"
                overflow={cascaded.length - 5}
              />
            )}

            {/* Dep violations list (none mode) */}
            {cascadeMode === 'none' && depViolations.length > 0 && (
              <TaskList
                items={depViolations.slice(0, 5)}
                tasks={tasks}
                icon="⊗"
                label="Dependency violations — starts before prerequisite finishes"
                labelColor="#F59E0B"
                bg="#FFF7ED"
                getValue={(t) => {
                  const depName = t.dvDeps.map(id => rawTasks.find(r => r.id === id)?.name || id).join(', ');
                  return `after: ${depName}`;
                }}
                valueColor="#92400E"
                overflow={depViolations.length - 5}
              />
            )}

            {/* Other projects warning */}
            {otherAffected.length > 0 && (
              <div style={{ display:'flex', alignItems:'flex-start', gap:'8px', padding:'8px 10px', borderRadius:'8px', background:'#FFF7ED', border:'1px solid #FED7AA', marginTop:'8px' }}>
                <span style={{ fontSize:'13px', flexShrink:0 }}>⚠️</span>
                <div style={{ fontSize:'11px', color:'#92400E', lineHeight:'1.5' }}>
                  <strong>Other projects affected:</strong>{' '}
                  {otherAffected.map(pid => {
                    const p = projs.find(x => x.id === pid);
                    return <span key={pid} style={{ display:'inline-flex', alignItems:'center', gap:'3px', marginRight:'6px' }}>
                      <span style={{ width:'8px', height:'8px', borderRadius:'50%', background:p?.color, display:'inline-block' }} />{pid}
                    </span>;
                  })}
                </div>
              </div>
            )}
          </div>

          {needsConfirm && willConflict && (
            <div style={{ padding:'10px 12px', borderRadius:'8px', background:'#3B1219', border:'1px solid #7F1D1D', marginBottom:'4px', fontSize:'12px', color:'#FCA5A5', lineHeight:'1.5' }}>
              <strong>⚠ Confirm:</strong>{' '}
              {cascadeMode === 'none' && depViolations.length > 0
                ? `This creates ${depViolations.length} dependency violation${depViolations.length !== 1 ? 's' : ''} — tasks will start before their prerequisites finish.`
                : `This creates ${newConflicts.length} new resource conflict${newConflicts.length !== 1 ? 's' : ''}.`
              } Use the Conflicts tab or auto-resolver to address them.
            </div>
          )}
        </div>)} {/* end shift tab content */}

        {modalTab === 'details' && (
          <div style={{ padding:'14px 22px', borderTop:`1px solid #2A2A3A`, flexShrink:0 }}>
            <button onClick={onClose} style={{ padding:'8px 18px', borderRadius:'8px', border:'1px solid #2A2A3A', background:'transparent', cursor:'pointer', fontSize:'13px', color:'#6B7280', fontWeight:'500' }}>Close</button>
          </div>
        )}
        </div> {/* end scrollable body */}

        {/* Footer — only shown on shift tab */}
        {modalTab === 'shift' && (
        <div style={{ padding:'14px 22px 18px', display:'flex', gap:'10px', justifyContent:'flex-end', borderTop:`1px solid #2A2A3A`, flexShrink:0 }}>
          <button onClick={onClose} style={{ padding:'8px 18px', borderRadius:'8px', border:'1px solid #2A2A3A', background:'transparent', cursor:'pointer', fontSize:'13px', color:'#6B7280', fontWeight:'500' }}>Cancel</button>
          <button onClick={handleApply} disabled={shiftDays === 0}
            style={{ padding:'8px 22px', borderRadius:'8px', border:'none', cursor: shiftDays === 0 ? 'default' : 'pointer', fontSize:'13px', fontWeight:'700',
              background: shiftDays === 0 ? '#374151' : willConflict && !needsConfirm ? '#EF4444' : projColor, color:'white', opacity: shiftDays === 0 ? 0.5 : 1 }}>
            {shiftDays === 0 ? 'No change' : willConflict && !needsConfirm ? '⚠ Apply Anyway' : needsConfirm ? '⚠ Confirm & Apply' : shiftDays < 0 ? `← Apply Shift (${shiftDays}d)` : `→ Apply Shift (+${shiftDays}d)`}
          </button>
        </div>
        )}
      </div>
    </div>
  );
}

// Small helpers used inside EditModal — defined here so they're available
function Tile({ v, label, color, bg, border }) {
  return (
    <div style={{ padding:'8px 10px', borderRadius:'8px', background:bg, border:`1px solid ${border}`, textAlign:'center' }}>
      <div style={{ fontSize:'18px', fontWeight:'800', color, fontVariantNumeric:'tabular-nums' }}>{v}</div>
      <div style={{ fontSize:'10px', color, marginTop:'2px', fontWeight:'600', opacity:0.85 }}>{label}</div>
    </div>
  );
}
function TaskList({ items, tasks, icon, label, labelColor, bg, getValue, valueColor, overflow = 0 }) {
  const { projs } = useSched() || {};
  if (!items.length) return null;
  return (
    <div style={{ marginBottom:'8px' }}>
      <div style={{ fontSize:'10px', fontWeight:'700', color:labelColor, marginBottom:'5px', display:'flex', alignItems:'center', gap:'4px' }}>
        <span>{icon}</span> {label}
      </div>
      {items.map(t => {
        const pc = projs?.find(p => p.id === t.projId)?.color || '#888';
        return (
          <div key={t.id} style={{ display:'flex', alignItems:'center', gap:'8px', padding:'4px 6px', borderRadius:'5px', marginBottom:'3px', background:bg }}>
            <div style={{ width:'3px', height:'20px', borderRadius:'2px', background:pc, flexShrink:0 }} />
            <span style={{ fontSize:'11px', color:'#0F172A', flex:1, minWidth:0, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{t.name}</span>
            <span style={{ fontSize:'10px', color:valueColor, fontWeight:'700', flexShrink:0 }}>{getValue(t)}</span>
          </div>
        );
      })}
      {overflow > 0 && <div style={{ fontSize:'10px', color:'#94A3B8', marginTop:'3px', paddingLeft:'6px' }}>+{overflow} more</div>}
    </div>
  );
}

// ── ConflictResolutionPopover ─────────────────────────────────────────────────
// Shown when user clicks the Hard Conflicts KPI card.
// Computes and previews the minimum schedule adjustment to clear all conflicts.
function ConflictResolutionPopover({ tasks, simDelays, onApply, onClose }) {
  const { rawTasks, projs, people, tdepMap, base, todayDay, periods } = useSched();

  const resolution = useMemo(() => computeResolution(rawTasks, tdepMap, base, projs, simDelays, tasks), [rawTasks, tdepMap, base, projs, simDelays, tasks]);

  if (!resolution) return (
    <div style={{ position:'absolute', top:'calc(100% + 8px)', right:0, zIndex:200, background:'white', borderRadius:'14px', width:'320px', boxShadow:'0 16px 48px rgba(0,0,0,0.2)', border:'1px solid #E2E8F0', padding:'20px 16px', textAlign:'center' }}>
      <div style={{ fontSize:'24px', marginBottom:'8px' }}>✓</div>
      <div style={{ fontSize:'13px', color:'#64748B' }}>No conflicts — schedule is clean.</div>
      <button onClick={onClose} style={{ marginTop:'12px', padding:'6px 16px', borderRadius:'8px', border:'1px solid #E2E8F0', background:'white', cursor:'pointer', fontSize:'12px', color:'#64748B' }}>Close</button>
    </div>
  );

  const { addedDelays, affectedProjects, newEnd } = resolution;
  const totalDays = Object.values(addedDelays).reduce((s, v) => s + v, 0);

  return (
    <div style={{ position:'absolute', top:'calc(100% + 8px)', right:0, zIndex:200, background:'white', borderRadius:'14px', width:'340px', boxShadow:'0 16px 48px rgba(0,0,0,0.22)', border:'1px solid #E2E8F0', overflow:'hidden' }}>
      {/* Header */}
      <div style={{ padding:'14px 16px 12px', background:'linear-gradient(135deg,#1E293B,#0F172A)', color:'white' }}>
        <div style={{ fontSize:'13px', fontWeight:'700', marginBottom:'2px' }}>✦ Auto-Resolve Conflicts</div>
        <div style={{ fontSize:'11px', color:'#94A3B8' }}>Suggested adjustment to eliminate all {tasks.filter(t=>t.isC).length} conflicts</div>
      </div>

      <div style={{ padding:'14px 16px' }}>
        {/* Summary tiles */}
        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:'8px', marginBottom:'14px' }}>
          {[
            { l:'Days added', v:`+${totalDays}d`, c:'#F59E0B' },
            { l:'Projects hit', v:affectedProjects.length, c:'#6366F1' },
            { l:'New end', v:fd(newEnd), c:'#10B981' },
          ].map(s => (
            <div key={s.l} style={{ padding:'8px', borderRadius:'8px', background:'#F8FAFC', border:'1px solid #F1F5F9', textAlign:'center' }}>
              <div style={{ fontSize:'13px', fontWeight:'800', color:s.c, fontVariantNumeric:'tabular-nums' }}>{s.v}</div>
              <div style={{ fontSize:'9px', color:'#94A3B8', marginTop:'2px', lineHeight:'1.3' }}>{s.l}</div>
            </div>
          ))}
        </div>

        {/* What changes */}
        <div style={{ fontSize:'10px', fontWeight:'700', color:'#94A3B8', textTransform:'uppercase', letterSpacing:'0.07em', marginBottom:'8px' }}>What will change</div>
        {Object.entries(addedDelays).map(([taskId, days]) => {
          const rawT = rawTasks.find(t => t.id === taskId);
          const p = projs.find(x => x.id === rawT?.proj);
          return (
            <div key={taskId} style={{ display:'flex', alignItems:'center', gap:'8px', padding:'6px 8px', borderRadius:'6px', background:'#FFFBEB', border:'1px solid #FEF3C7', marginBottom:'5px' }}>
              <div style={{ width:'3px', height:'28px', borderRadius:'2px', background:p?.color||'#888', flexShrink:0 }} />
              <div style={{ flex:1, minWidth:0 }}>
                <div style={{ fontSize:'11px', fontWeight:'600', color:'#0F172A' }}>{rawT?.name || taskId}</div>
                <div style={{ fontSize:'10px', color:'#64748B' }}>{rawT?.proj} · root task pushed to clear overlap</div>
              </div>
              <span style={{ fontSize:'11px', fontWeight:'700', color:'#92400E', flexShrink:0 }}>+{days}d</span>
            </div>
          );
        })}

        {affectedProjects.length > 0 && (
          <div style={{ marginTop:'10px', padding:'8px 10px', borderRadius:'8px', background:'#FFF7ED', border:'1px solid #FED7AA', fontSize:'11px', color:'#92400E', lineHeight:'1.5' }}>
            ⚠ {affectedProjects.join(', ')} end dates will shift. Notify relevant stakeholders.
          </div>
        )}

        <div style={{ display:'flex', gap:'8px', marginTop:'14px' }}>
          <button onClick={onClose} style={{ flex:1, padding:'9px', borderRadius:'8px', border:'1px solid #E2E8F0', background:'white', cursor:'pointer', fontSize:'12px', color:'#64748B', fontWeight:'500' }}>Cancel</button>
          <button onClick={() => { onApply(resolution.resDelays); onClose(); }}
            style={{ flex:2, padding:'9px', borderRadius:'8px', border:'none', background:'linear-gradient(135deg,#6366F1,#8B5CF6)', color:'white', cursor:'pointer', fontSize:'12px', fontWeight:'700' }}>
            Apply Resolution →
          </button>
        </div>
      </div>
    </div>
  );
}


// ── Conflicts tab ─────────────────────────────────────────────────────────────
// ── ConflictMiniGantt ─────────────────────────────────────────────────────────
// A compact conflict-focused Gantt. Shows every person who has at least one
// conflict or dep-violation. Each person gets one row. Conflict bars are red,
// dep-violation bars are amber dashed, clean bars are dimmed purple for context.
// "Full Timeline" button scrolls to today.
function ConflictMiniGantt({ tasks, conflicts, depViolations }) {
  const { rawTasks, projs, people, tdepMap, base, todayDay, periods } = useSched();

  const scrollRef = useRef(null);
  const [hov, setHov] = useState(null);
  const [mouse, setMouse] = useState({ x:0, y:0 });
  const outerRef = useRef(null);

  const CARD   = '#1C1C27';
  const BORDER = '#2A2A3A';
  const ORANGE = '#F97316';
  const TEXT   = '#E8E8F0';
  const MUTED  = '#6B7280';

  // Gather all people involved in any conflict or dep-violation
  const involvedPeople = useMemo(() => {
    const names = new Set([
      ...conflicts.map(t => t.person),
      ...depViolations.map(t => t.person),
    ]);
    return people.filter(p => names.has(p.name));
  }, [conflicts, depViolations]);

  // For each involved person, get ALL their tasks (for context) plus flag which are hot
  const rows = useMemo(() => involvedPeople.map(per => {
    const allTasks = tasks.filter(t => t.person === per.name).sort((a,b) => a.s - b.s);
    return { per, allTasks };
  }), [involvedPeople, tasks]);

  // Timeline bounds: earliest start to latest end across all rows, with padding
  const { minDay, maxDay } = useMemo(() => {
    const allT = rows.flatMap(r => r.allTasks).filter(t => t.cd > 0);
    if (!allT.length) return { minDay:0, maxDay:120 };
    return {
      minDay: Math.max(0, Math.min(...allT.map(t => t.sd)) - 7),
      maxDay: Math.max(...allT.map(t => t.sd + t.cd)) + 7,
    };
  }, [rows]);

  const DPX  = 11;          // pixels per calendar day
  const RH   = 56;          // row height
  const BH   = 30;          // bar height
  const HH   = 64;          // header height (month + week rows)
  const LW   = 160;         // left label width
  const totalW = (maxDay - minDay) * DPX;
  const totalH = HH + rows.length * RH;

  const tx = d => (d - minDay) * DPX;  // day → x coordinate

  // Build month/week columns for the visible range
  const visibleMons = ALL_MONS.filter((m, i) =>
    i < ALL_MONS.length - 1 &&
    ALL_MONS[i+1].d > minDay &&
    m.d < maxDay
  );

  const todayX = tx(todayDay);

  // Scroll to today on mount
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollLeft = Math.max(0, todayX - 120);
    }
  }, [todayX]);

  const hotIds = useMemo(() => new Set([
    ...conflicts.map(t => t.id),
    ...depViolations.map(t => t.id),
  ]), [conflicts, depViolations]);

  const ht = hov ? tasks.find(t => t.id === hov) : null;

  return (
    <div style={{ background:'#13131A' }}>
      {/* Mini toolbar */}
      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', padding:'10px 16px', borderBottom:`1px solid ${BORDER}`, background:CARD }}>
        <div style={{ display:'flex', alignItems:'center', gap:'16px' }}>
          <span style={{ fontSize:'12px', fontWeight:'600', color:TEXT }}>{conflicts.length} conflict{conflicts.length!==1?'s':''}</span>
          {depViolations.length > 0 && <span style={{ fontSize:'12px', fontWeight:'600', color:'#FBBF24' }}>{depViolations.length} dep. violation{depViolations.length!==1?'s':''}</span>}
          <span style={{ fontSize:'11px', color:MUTED }}>{involvedPeople.length} people affected</span>
        </div>
        {/* Legend */}
        <div style={{ display:'flex', alignItems:'center', gap:'14px', marginRight:'8px' }}>
          {[
            { color:'#EF4444', label:'Conflict' },
            { color:'#F59E0B', label:'Dep. Violation', dashed:true },
            { color:'#6366F1', label:'Clean task', dim:true },
          ].map(l => (
            <div key={l.label} style={{ display:'flex', alignItems:'center', gap:'5px' }}>
              <div style={{ width:'20px', height:'8px', borderRadius:'3px', background:l.dim?l.color+'50':l.color, border:l.dashed?`1px dashed ${l.color}`:'none' }} />
              <span style={{ fontSize:'10px', color:MUTED }}>{l.label}</span>
            </div>
          ))}
        </div>
        <button
          onClick={() => { if (scrollRef.current) scrollRef.current.scrollLeft = Math.max(0, todayX - 120); }}
          style={{ padding:'5px 12px', borderRadius:'6px', border:`1px solid ${BORDER}`, background:'transparent', color:TEXT, fontSize:'12px', cursor:'pointer' }}>
          Full Timeline
        </button>
      </div>

      <div ref={outerRef} style={{ position:'relative', display:'flex' }}
        onMouseMove={e => { const r=outerRef.current?.getBoundingClientRect(); if(r) setMouse({x:e.clientX-r.left,y:e.clientY-r.top}); }}
        onMouseLeave={() => setHov(null)}>

        {/* Left label panel */}
        <div style={{ width:LW, flexShrink:0, zIndex:5, boxShadow:'4px 0 10px rgba(0,0,0,0.4)' }}>
          <svg width={LW} height={totalH} style={{ display:'block', fontFamily:'-apple-system,system-ui,sans-serif', overflow:'visible' }}>
            {/* Header bg */}
            <rect x={0} y={0} width={LW} height={HH} fill="#0A0A0F" />
            <line x1={0} y1={HH} x2={LW} y2={HH} stroke={BORDER} strokeWidth="1" />
            {/* Person rows */}
            {rows.map(({ per, allTasks: pt }, i) => {
              const y   = HH + i * RH;
              const midY = y + RH / 2;
              const hasC = pt.some(t => t.isC);
              const hasDV = pt.some(t => t.isDV && !t.isC);
              return (
                <g key={per.name}>
                  <rect x={0} y={y} width={LW} height={RH} fill={i%2===0?'#13131A':'#0F0F18'} />
                  <circle cx={22} cy={midY} r={13} fill={per.color+'25'} />
                  <circle cx={22} cy={midY} r={13} fill="none" stroke={per.color} strokeWidth="1.5" />
                  <text x={22} y={midY+1} textAnchor="middle" dominantBaseline="middle" fill={per.color} fontSize="8" fontWeight="700">{per.init}</text>
                  <text x={42} y={midY-6} fill={TEXT} fontSize="12" fontWeight="600">{per.name}</text>
                  <text x={42} y={midY+8} fill={MUTED} fontSize="9.5">{per.role.split(' ')[0]}</text>
                  {hasC  && <circle cx={LW-10} cy={y+12} r={6} fill="#EF4444" />}
                  {hasC  && <text x={LW-10} y={y+12} textAnchor="middle" dominantBaseline="middle" fill="white" fontSize="8" fontWeight="700">!</text>}
                  {hasDV && !hasC && <circle cx={LW-10} cy={y+12} r={6} fill="#F59E0B" />}
                  {hasDV && !hasC && <text x={LW-10} y={y+12} textAnchor="middle" dominantBaseline="middle" fill="white" fontSize="8" fontWeight="700">⊗</text>}
                  <line x1={0} y1={y+RH} x2={LW} y2={y+RH} stroke={BORDER} strokeWidth="0.8" />
                </g>
              );
            })}
            <line x1={LW-1} y1={0} x2={LW-1} y2={totalH} stroke={BORDER} strokeWidth="1" />
          </svg>
        </div>

        {/* Scrollable timeline */}
        <div ref={scrollRef} style={{ overflowX:'auto', flex:1 }}>
          <svg width={totalW} height={totalH} style={{ display:'block', fontFamily:'-apple-system,system-ui,sans-serif' }}>

            {/* Month header row */}
            {visibleMons.map((m, i) => {
              const x1 = tx(m.d);
              const nextMon = ALL_MONS[ALL_MONS.indexOf(m)+1];
              const x2 = nextMon ? Math.min(tx(nextMon.d), totalW) : totalW;
              return (
                <g key={m.n+i}>
                  <rect x={x1} y={0} width={x2-x1} height={HH*0.52} fill={i%2?'#17171F':'#1C1C27'} />
                  <text x={(x1+x2)/2} y={HH*0.52/2+4} textAnchor="middle" fill="#9CA3AF" fontSize="11" fontWeight="500">{m.n} 2026</text>
                  <line x1={x1} y1={0} x2={x1} y2={totalH} stroke={BORDER} strokeWidth="0.5" />
                </g>
              );
            })}

            {/* Week sub-header row */}
            {visibleMons.map((m, i) => {
              const nextMon = ALL_MONS[ALL_MONS.indexOf(m)+1];
              const monEnd  = nextMon ? nextMon.d : maxDay;
              const span    = monEnd - m.d;
              const wSpan   = span / 4;
              return Array.from({length:4}, (_, w) => {
                const wx1 = tx(m.d + w * wSpan);
                const wx2 = tx(m.d + (w+1) * wSpan);
                return (
                  <g key={`${i}-w${w}`}>
                    <rect x={wx1} y={HH*0.52} width={wx2-wx1} height={HH*0.48} fill={w%2?'#13131A':'#17171F'} />
                    <text x={(wx1+wx2)/2} y={HH*0.52+HH*0.48/2+4} textAnchor="middle" fill="#374151" fontSize="9.5" fontWeight="500">W{w+1}</text>
                    <line x1={wx1} y1={HH*0.52} x2={wx1} y2={totalH} stroke={BORDER} strokeWidth="0.3" opacity="0.6" />
                  </g>
                );
              });
            })}

            <line x1={0} y1={HH} x2={totalW} y2={HH} stroke={BORDER} strokeWidth="1" />

            {/* Vertical gridlines (weekly) */}
            {Array.from({length: Math.ceil((maxDay - minDay) / 7)}, (_, i) => minDay + i*7).map(d => (
              <line key={d} x1={tx(d)} y1={HH} x2={tx(d)} y2={totalH} stroke={BORDER} strokeWidth="0.4" opacity="0.5" />
            ))}

            {/* Today line */}
            {todayDay >= minDay && todayDay <= maxDay && (
              <g>
                <line x1={todayX} y1={0} x2={todayX} y2={totalH} stroke={ORANGE} strokeWidth="1.5" strokeDasharray="4 3" opacity="0.8" />
                <rect x={todayX-22} y={HH*0.52-10} width={44} height={18} rx="4" fill={ORANGE} />
                <text x={todayX} y={HH*0.52-1} textAnchor="middle" dominantBaseline="middle" fill="white" fontSize="9" fontWeight="700">Today</text>
              </g>
            )}

            {/* Rows + bars */}
            {rows.map(({ per, allTasks: pt }, i) => {
              const y   = HH + i * RH;
              const by0 = y + (RH - BH) / 2;
              const midY = y + RH / 2;
              return (
                <g key={per.name}>
                  <rect x={0} y={y} width={totalW} height={RH} fill={i%2===0?'#13131A':'#0F0F18'} />
                  <line x1={0} y1={y+RH} x2={totalW} y2={y+RH} stroke={BORDER} strokeWidth="0.8" />
                  {pt.filter(t => t.cd > 0 && t.sd + t.cd > minDay && t.sd < maxDay).map(t => {
                    const x = tx(t.sd);
                    const w = Math.max(t.cd * DPX, 4);
                    const isHot = hotIds.has(t.id);
                    const isDV  = t.isDV && !t.isC;
                    const isC   = t.isC;
                    const ih    = hov === t.id;

                    const barColor = isC ? '#EF4444' : isDV ? '#F59E0B' : per.color;
                    const barFill  = isC ? '#EF444430' : isDV ? '#F59E0B25' : per.color+'18';
                    const opacity  = isHot ? 1 : (hov && !ih) ? 0.3 : isHot ? 1 : 0.65;

                    return (
                      <g key={t.id} opacity={opacity} style={{ cursor:'default' }}
                        onMouseEnter={() => setHov(t.id)}
                        onMouseLeave={() => setHov(null)}>
                        {/* Shadow */}
                        <rect x={x+2} y={by0+2} width={w} height={BH} rx="4" fill="rgba(0,0,0,0.3)" />
                        {/* Bar */}
                        <rect x={x} y={by0} width={w} height={BH} rx="4"
                          fill={barFill}
                          stroke={barColor}
                          strokeWidth={ih ? 2 : isHot ? 1.8 : 1.2}
                          strokeDasharray={isDV ? '5 3' : 'none'} />
                        {/* Left accent stripe */}
                        <rect x={x+1.5} y={by0+1.5} width={4} height={BH-3} rx="2" fill={barColor} opacity={isHot?1:0.8} />
                        {/* Label */}
                        {w > 48 && (
                          <text x={x+10} y={midY+1} dominantBaseline="middle" fill={barColor}
                            fontSize="9.5" fontWeight={isHot?'700':'600'}
                            style={{ pointerEvents:'none', userSelect:'none' }}>
                            {(()=>{ const mc=Math.floor((w-14)/5.5); return t.name.length>mc?t.name.slice(0,mc)+'…':t.name; })()}
                          </text>
                        )}
                        {/* Badge */}
                        {isC && (
                          <g style={{ pointerEvents:'none' }}>
                            <circle cx={x+w-7} cy={by0+7} r={5.5} fill="#EF4444" />
                            <text x={x+w-7} y={by0+7} textAnchor="middle" dominantBaseline="middle" fill="white" fontSize="7" fontWeight="800">!</text>
                          </g>
                        )}
                        {isDV && (
                          <g style={{ pointerEvents:'none' }}>
                            <circle cx={x+w-7} cy={by0+7} r={5.5} fill="#F59E0B" />
                            <text x={x+w-7} y={by0+7} textAnchor="middle" dominantBaseline="middle" fill="white" fontSize="7" fontWeight="800">⊗</text>
                          </g>
                        )}
                      </g>
                    );
                  })}
                </g>
              );
            })}
          </svg>
        </div>

        {/* Tooltip */}
        {ht && (() => {
          const pc  = projs.find(p => p.id === ht.projId)?.color || '#888';
          const ttx = Math.min(mouse.x + 14, (outerRef.current?.clientWidth||700) - 220);
          const tty = Math.max(mouse.y - 100, HH + 4);
          const cNames = ht.cw.map(id => { const c=tasks.find(x=>x.id===id); return c?`${c.id} (${c.person})`:id; });
          const dvNames = (ht.dvDeps||[]).map(id => { const d=tasks.find(x=>x.id===id); return d?`${id} – ${d.name}`:id; });
          return (
            <div style={{ position:'absolute', left:ttx, top:tty, pointerEvents:'none', background:'#0A0A0F', color:TEXT, padding:'11px 14px', borderRadius:'10px', fontSize:'12px', lineHeight:'1.6', boxShadow:'0 10px 30px rgba(0,0,0,0.5)', width:'210px', zIndex:50, borderTop:`3px solid ${pc}` }}>
              <div style={{ fontWeight:'700', marginBottom:'3px' }}>{ht.name}</div>
              <div style={{ color:MUTED, fontSize:'10px', marginBottom:'7px' }}>{ht.projId} · {ht.id} · {ht.person}</div>
              <div style={{ display:'grid', gridTemplateColumns:'52px 1fr', gap:'2px 8px', fontSize:'11px' }}>
                <span style={{ color:MUTED }}>Start</span><span>{fd(ht.s)}</span>
                <span style={{ color:MUTED }}>End</span><span>{fd(ht.e)}</span>
                <span style={{ color:MUTED }}>Duration</span><span>{ht.dur} wdays</span>
              </div>
              {ht.isC && cNames.length > 0 && (
                <div style={{ marginTop:'8px', padding:'5px 8px', background:'rgba(239,68,68,0.15)', borderRadius:'5px', fontSize:'10px', color:'#FCA5A5', fontWeight:'700', border:'1px solid rgba(239,68,68,0.3)' }}>
                  ⚠ Clashes with: {cNames.join(', ')}
                </div>
              )}
              {ht.isDV && dvNames.length > 0 && (
                <div style={{ marginTop:'8px', padding:'5px 8px', background:'rgba(245,158,11,0.15)', borderRadius:'5px', fontSize:'10px', color:'#FDE68A', fontWeight:'700', border:'1px solid rgba(245,158,11,0.3)', borderStyle:'dashed' }}>
                  ⊗ Needs: {dvNames.join(', ')}
                </div>
              )}
            </div>
          );
        })()}
      </div>

      {/* Empty state */}
      {rows.length === 0 && (
        <div style={{ padding:'48px', textAlign:'center', color:MUTED, fontSize:'13px' }}>
          <div style={{ fontSize:'28px', marginBottom:'10px' }}>✓</div>
          No conflicts to display.
        </div>
      )}
    </div>
  );
}

function ConflictsTab({ tasks }) {
  const { rawTasks, projs, people, tdepMap, base, todayDay, periods } = useSched();

  const [subTab, setSubTab]     = useState('conflicts');
  const [search, setSearch]     = useState('');
  const [expanded, setExpanded] = useState(null); // person name whose row is expanded
  const [reassigned, setReassigned] = useState({});
  const [activeTask, setActiveTask] = useState(null);

  const conflicts   = useMemo(() => tasks.filter(t => t.isC).sort((a, b) => a.s - b.s), [tasks]);
  const depViolations = useMemo(() => tasks.filter(t => t.isDV && !t.isC).sort((a, b) => a.s - b.s), [tasks]);

  // Group conflicts by person
  const byPerson = useMemo(() => {
    const map = {};
    for (const t of conflicts) {
      if (!map[t.person]) map[t.person] = [];
      map[t.person].push(t);
    }
    return map;
  }, [conflicts]);

  // Filter by search
  const personEntries = Object.entries(byPerson).filter(([name]) =>
    name.toLowerCase().includes(search.toLowerCase())
  );

  const getCandidates = task => {
    const per = people.find(p => p.name === task.person);
    return per ? people.filter(p => p.role === per.role && p.name !== task.person) : [];
  };
  const getAvail = (personName, s, e) => {
    const overlap = tasks.filter(t => t.person === personName && t.cd > 0 && t.s <= e && t.e >= s);
    return { count: overlap.length };
  };
  const handleReassign = (taskId, toPerson, fromPerson) => {
    setReassigned(prev => ({ ...prev, [taskId]: { to:toPerson, from:fromPerson } }));
    setActiveTask(null);
  };
  const undoReassign = taskId => setReassigned(prev => { const n={...prev}; delete n[taskId]; return n; });

  const CARD = '#1C1C27';
  const BORDER = '#2A2A3A';
  const ORANGE = '#F97316';
  const TEXT = '#E8E8F0';
  const MUTED = '#6B7280';
  const RED = '#EF4444';

  return (
    <div style={{ background:'#13131A', minHeight:'500px' }}>

      {/* Sub-tab bar */}
      <div style={{ display:'flex', alignItems:'center', padding:'0 20px', borderBottom:`1px solid ${BORDER}`, background:CARD }}>
        <div style={{ display:'flex', alignItems:'center', gap:'0', flex:1 }}>
          {[{id:'conflicts',l:'Conflicts'},{id:'gantt',l:'Gantt View'}].map(t => (
            <button key={t.id} onClick={() => setSubTab(t.id)}
              style={{ padding:'13px 16px', border:'none', background:'none', cursor:'pointer', fontSize:'13px', fontWeight: subTab===t.id ? '600' : '400', color: subTab===t.id ? ORANGE : MUTED, borderBottom: subTab===t.id ? `2px solid ${ORANGE}` : '2px solid transparent', marginBottom:'-1px' }}>
              {t.l}
            </button>
          ))}
        </div>
        <div style={{ display:'flex', alignItems:'center', gap:'12px' }}>
          <button style={{ padding:'5px 12px', borderRadius:'6px', border:`1px solid ${BORDER}`, background:'transparent', color:TEXT, fontSize:'12px', cursor:'pointer' }}>Full Timeline</button>
          <div style={{ position:'relative' }}>
            <select style={{ appearance:'none', WebkitAppearance:'none', padding:'5px 24px 5px 10px', borderRadius:'6px', border:`1px solid ${BORDER}`, background:'transparent', color:TEXT, fontSize:'12px', cursor:'pointer', outline:'none' }}>
              <option>All Projects</option>
              {projs.map(p => <option key={p.id}>{p.id}</option>)}
            </select>
            <span style={{ position:'absolute', right:'7px', top:'50%', transform:'translateY(-50%)', pointerEvents:'none', color:MUTED, fontSize:'9px' }}>▾</span>
          </div>
        </div>
      </div>

      {subTab === 'conflicts' && (
        <div style={{ padding:'16px 20px' }}>

          {/* ALL summary row */}
          <div style={{ display:'flex', alignItems:'center', gap:'16px', padding:'12px 16px', borderRadius:'8px', background:CARD, border:`1px solid ${BORDER}`, marginBottom:'14px' }}>
            <span style={{ fontSize:'13px', fontWeight:'700', color:TEXT }}>ALL</span>
            <span style={{ fontSize:'12px', color:MUTED }}>ALL</span>
            <span style={{ fontSize:'13px', fontWeight:'700', color:RED }}>{conflicts.length} Conflicts</span>
            <span style={{ color:RED, fontSize:'12px' }}>▲</span>
          </div>

          {/* Filter + Search row */}
          <div style={{ display:'flex', gap:'10px', marginBottom:'14px' }}>
            <button style={{ display:'flex', alignItems:'center', gap:'6px', padding:'7px 14px', borderRadius:'8px', border:`1px solid ${BORDER}`, background:CARD, color:TEXT, fontSize:'12px', cursor:'pointer', fontWeight:'500' }}>
              <svg width="12" height="12" fill="none" viewBox="0 0 16 16"><path d="M2 4h12M4 8h8M6 12h4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
              Filter
            </button>
            <div style={{ display:'flex', alignItems:'center', gap:'8px', flex:1, background:CARD, border:`1px solid ${BORDER}`, borderRadius:'8px', padding:'7px 12px' }}>
              <svg width="13" height="13" fill="none" viewBox="0 0 16 16"><circle cx="6.5" cy="6.5" r="5" stroke={MUTED} strokeWidth="1.5"/><path d="M10.5 10.5 14 14" stroke={MUTED} strokeWidth="1.5" strokeLinecap="round"/></svg>
              <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search..."
                style={{ border:'none', background:'transparent', color:TEXT, fontSize:'12px', outline:'none', flex:1 }} />
            </div>
          </div>

          {/* Person rows */}
          {personEntries.length === 0 && conflicts.length === 0 && (
            <div style={{ textAlign:'center', padding:'48px', color:MUTED, fontSize:'13px' }}>
              <div style={{ fontSize:'28px', marginBottom:'10px' }}>✓</div>
              No conflicts — schedule is clean.
            </div>
          )}

          <div style={{ display:'grid', gap:'6px' }}>
            {personEntries.map(([person, ts]) => {
              const per = people.find(p => p.name === person);
              const isOpen = expanded === person;
              const pendingTs = ts.filter(t => !reassigned[t.id]);
              const resolvedTs = ts.filter(t => reassigned[t.id]);

              return (
                <div key={person}>
                  {/* Person row — matches Figma: name, role, conflict count, triangle */}
                  <div onClick={() => setExpanded(isOpen ? null : person)}
                    style={{ display:'flex', alignItems:'center', gap:'12px', padding:'14px 16px', borderRadius: isOpen ? '8px 8px 0 0' : '8px', background:CARD, border:`1px solid ${BORDER}`, cursor:'pointer', borderBottom: isOpen ? 'none' : undefined }}>
                    <div style={{ width:'32px', height:'32px', borderRadius:'50%', background:per.color+'30', border:`1.5px solid ${per.color}`, display:'flex', alignItems:'center', justifyContent:'center', fontSize:'10px', fontWeight:'700', color:per.color, flexShrink:0 }}>{per.init}</div>
                    <span style={{ fontSize:'14px', fontWeight:'600', color:TEXT, minWidth:'80px' }}>{person}</span>
                    <span style={{ fontSize:'12px', color:MUTED }}>{per.role}</span>
                    <div style={{ marginLeft:'auto', display:'flex', alignItems:'center', gap:'8px' }}>
                      <span style={{ fontSize:'13px', fontWeight:'700', color:RED }}>{pendingTs.length} Conflict{pendingTs.length !== 1 ? 's' : ''}</span>
                      <span style={{ color:RED, fontSize:'12px', transform: isOpen ? 'rotate(180deg)' : 'none', transition:'transform 0.2s' }}>▲</span>
                    </div>
                  </div>

                  {/* Expanded detail */}
                  {isOpen && (
                    <div style={{ background:'#17171F', border:`1px solid ${BORDER}`, borderTop:'none', borderRadius:'0 0 8px 8px', padding:'12px 16px' }}>
                      {pendingTs.map(t => {
                        const pc = projs.find(p => p.id === t.projId)?.color || '#888';
                        const cNames = t.cw.map(id => { const c = tasks.find(x => x.id === id); return c ? `${c.projId} – ${c.name}` : id; });
                        const isTaskOpen = activeTask === t.id;
                        const candidates = getCandidates(t).map(p => ({ ...p, avail: getAvail(p.name, t.s, t.e) })).sort((a,b) => a.avail.count - b.avail.count);
                        return (
                          <div key={t.id} style={{ marginBottom:'8px' }}>
                            <div style={{ display:'flex', alignItems:'center', gap:'10px', padding:'10px 12px', borderRadius: isTaskOpen ? '6px 6px 0 0' : '6px', background:'#1C1C27', border:`1px solid #3B1219`, borderBottom: isTaskOpen ? 'none' : undefined }}>
                              <div style={{ width:'3px', height:'36px', borderRadius:'2px', background:pc, flexShrink:0 }} />
                              <div style={{ flex:1, minWidth:0 }}>
                                <div style={{ fontSize:'12px', fontWeight:'600', color:TEXT }}>{t.name}</div>
                                <div style={{ fontSize:'11px', color:MUTED, marginTop:'2px' }}>{t.projId} · {t.id} · {fd(t.s)} → {fd(t.e)}</div>
                                {cNames.length > 0 && <div style={{ fontSize:'10px', color:'#F87171', marginTop:'3px' }}>Clashes: {cNames.join(', ')}</div>}
                              </div>
                              <button onClick={e => { e.stopPropagation(); setActiveTask(isTaskOpen ? null : t.id); }}
                                style={{ padding:'4px 12px', borderRadius:'6px', border:`1px solid #7F1D1D`, background: isTaskOpen ? '#3B1219' : 'transparent', cursor:'pointer', fontSize:'11px', color:'#F87171', fontWeight:'600', flexShrink:0 }}>
                                {isTaskOpen ? 'Cancel' : 'Reassign ▾'}
                              </button>
                            </div>
                            {isTaskOpen && (
                              <div style={{ background:'#13131A', border:`1px solid #3B1219`, borderTop:'none', borderRadius:'0 0 6px 6px', padding:'10px 12px' }}>
                                <div style={{ fontSize:'10px', fontWeight:'700', color:MUTED, textTransform:'uppercase', letterSpacing:'0.08em', marginBottom:'8px' }}>Reassign to same-role colleague</div>
                                {candidates.map(c => (
                                  <div key={c.name} onClick={() => handleReassign(t.id, c.name, t.person)}
                                    style={{ display:'flex', alignItems:'center', gap:'10px', padding:'7px 10px', borderRadius:'6px', cursor:'pointer', marginBottom:'4px', background:'#1C1C27', border:`1px solid ${BORDER}` }}
                                    onMouseEnter={e => e.currentTarget.style.background='#2A2A3A'}
                                    onMouseLeave={e => e.currentTarget.style.background='#1C1C27'}>
                                    <div style={{ width:'26px', height:'26px', borderRadius:'50%', background:c.color+'30', border:`1.5px solid ${c.color}`, display:'flex', alignItems:'center', justifyContent:'center', fontSize:'9px', fontWeight:'700', color:c.color, flexShrink:0 }}>{c.init}</div>
                                    <div style={{ flex:1 }}>
                                      <div style={{ fontSize:'12px', fontWeight:'600', color:TEXT }}>{c.name}</div>
                                      <div style={{ fontSize:'10px', color:MUTED }}>{c.avail.count > 0 ? `${c.avail.count} tasks in window` : 'Available'}</div>
                                    </div>
                                    <span style={{ fontSize:'11px', color: c.avail.count > 0 ? '#F59E0B' : '#10B981', fontWeight:'600' }}>{c.avail.count > 0 ? 'Busy' : 'Free'}</span>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        );
                      })}

                      {resolvedTs.length > 0 && (
                        <div style={{ marginTop:'8px' }}>
                          <div style={{ fontSize:'10px', color:'#10B981', fontWeight:'700', textTransform:'uppercase', letterSpacing:'0.07em', marginBottom:'6px' }}>✓ Reassigned</div>
                          {resolvedTs.map(t => {
                            const ra = reassigned[t.id];
                            const toPer = people.find(p => p.name === ra.to);
                            return (
                              <div key={t.id} style={{ display:'flex', alignItems:'center', gap:'10px', padding:'8px 12px', borderRadius:'6px', background:'#0D2B1E', border:'1px solid #065F46', marginBottom:'4px' }}>
                                <div style={{ flex:1 }}>
                                  <div style={{ fontSize:'12px', fontWeight:'600', color:TEXT }}>{t.name}</div>
                                  <div style={{ fontSize:'11px', color:MUTED, display:'flex', alignItems:'center', gap:'6px', marginTop:'2px' }}>
                                    <span style={{ textDecoration:'line-through' }}>{ra.from}</span>
                                    <span>→</span>
                                    <span style={{ color:'#10B981', fontWeight:'600' }}>{ra.to}</span>
                                  </div>
                                </div>
                                <button onClick={() => undoReassign(t.id)} style={{ padding:'3px 9px', borderRadius:'6px', border:`1px solid ${BORDER}`, background:'transparent', cursor:'pointer', fontSize:'11px', color:MUTED }}>Undo</button>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}

            {/* Dep violations section */}
            {depViolations.length > 0 && (
              <div style={{ marginTop:'8px' }}>
                <div style={{ fontSize:'11px', fontWeight:'700', color:'#F59E0B', textTransform:'uppercase', letterSpacing:'0.06em', marginBottom:'8px', display:'flex', alignItems:'center', gap:'6px' }}>
                  <span style={{ width:'18px', height:'18px', borderRadius:'50%', background:'#F59E0B', color:'#0A0A0F', display:'inline-flex', alignItems:'center', justifyContent:'center', fontSize:'10px', fontWeight:'800' }}>⊗</span>
                  Dependency Violations ({depViolations.length})
                </div>
                {depViolations.map(t => {
                  const pc = projs.find(p => p.id === t.projId)?.color || '#888';
                  return (
                    <div key={t.id} style={{ display:'flex', alignItems:'flex-start', gap:'10px', padding:'10px 14px', borderRadius:'8px', background:CARD, border:`1px dashed #F59E0B`, marginBottom:'5px' }}>
                      <div style={{ width:'3px', height:'36px', borderRadius:'2px', background:pc, flexShrink:0, marginTop:'2px' }} />
                      <div style={{ flex:1 }}>
                        <div style={{ fontSize:'12px', fontWeight:'600', color:TEXT }}>{t.name}</div>
                        <div style={{ fontSize:'11px', color:MUTED, marginTop:'2px' }}>{t.projId} · starts {fd(t.s)}</div>
                        {t.dvDeps.map((id, i) => {
                          const dep = tasks.find(x => x.id === id);
                          return <div key={i} style={{ fontSize:'10px', color:'#F59E0B', marginTop:'3px' }}>⊗ Needs: {id} — {dep?.name} (ends {dep ? fd(dep.e) : '?'})</div>;
                        })}
                      </div>
                      <span style={{ fontSize:'10px', fontWeight:'700', color:'#92400E', background:'#FEF3C7', padding:'2px 8px', borderRadius:'10px', flexShrink:0, border:'1px solid #FDE68A' }}>Sequencing</span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}

      {subTab === 'gantt' && (
        <ConflictMiniGantt tasks={tasks} conflicts={conflicts} depViolations={depViolations} />
      )}
    </div>
  );
}
function PeopleTab({ tasks, sel, onSel, statusOverrides, todayMs }) {
  const { rawTasks, projs, people, tdepMap, base, todayDay, periods } = useSched();

  const [subTab, setSubTab] = useState('projects');
  const [search, setSearch] = useState('');

  const CARD   = '#1C1C27';
  const BORDER = '#2A2A3A';
  const ORANGE = '#F97316';
  const TEXT   = '#E8E8F0';
  const MUTED  = '#6B7280';
  const RED    = '#EF4444';

  const pt  = useMemo(() => sel ? tasks.filter(t => t.person === sel).sort((a, b) => a.s - b.s) : [], [tasks, sel]);
  const per = people.find(p => p.name === sel);

  const filteredPeople = people.filter(p => p.name.toLowerCase().includes(search.toLowerCase()));
  const personProjects  = sel ? [...new Set(pt.map(t => t.projId))] : [];
  const personConflicts = pt.filter(t => t.isC);

  return (
    <div style={{ display:'flex', minHeight:'520px', background:'#13131A' }}>
      {/* ── Left sidebar ── */}
      <div style={{ width:'192px', flexShrink:0, borderRight:`1px solid ${BORDER}`, background:'#0A0A0F', display:'flex', flexDirection:'column' }}>
        <div style={{ padding:'12px' }}>
          <button style={{ display:'flex', alignItems:'center', gap:'6px', width:'100%', padding:'7px 10px', borderRadius:'7px', border:`1px solid ${BORDER}`, background:CARD, color:TEXT, fontSize:'12px', cursor:'pointer', fontWeight:'500', marginBottom:'8px' }}>
            <svg width="12" height="12" fill="none" viewBox="0 0 16 16"><path d="M2 4h12M4 8h8M6 12h4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
            Filter
          </button>
          <div style={{ display:'flex', alignItems:'center', gap:'6px', padding:'6px 10px', borderRadius:'7px', border:`1px solid ${BORDER}`, background:CARD }}>
            <svg width="12" height="12" fill="none" viewBox="0 0 16 16"><circle cx="6.5" cy="6.5" r="5" stroke={MUTED} strokeWidth="1.5"/><path d="M10.5 10.5 14 14" stroke={MUTED} strokeWidth="1.5" strokeLinecap="round"/></svg>
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search..."
              style={{ border:'none', background:'transparent', color:TEXT, fontSize:'11px', outline:'none', width:'100%' }} />
          </div>
        </div>
        <div style={{ overflowY:'auto', flex:1 }}>
          {filteredPeople.map(p => {
            const pConflicts = tasks.filter(t => t.person === p.name && t.isC).length;
            const isSelected = sel === p.name;
            return (
              <div key={p.name} onClick={() => { onSel(p.name); setSubTab('projects'); }}
                style={{ padding:'12px', cursor:'pointer', borderBottom:`1px solid ${BORDER}`, background:isSelected?'#1E2535':'transparent', borderLeft:isSelected?`3px solid ${ORANGE}`:'3px solid transparent' }}>
                <div style={{ fontSize:'14px', fontWeight:'600', color:isSelected?TEXT:'#C0C0D0' }}>{p.name}</div>
                <div style={{ fontSize:'11px', color:MUTED, marginTop:'2px' }}>{p.role}</div>
                <div style={{ fontSize:'12px', color:isSelected?ORANGE:MUTED, marginTop:'4px', fontWeight:'600' }}>{p.rate}</div>
                {pConflicts > 0 && <div style={{ fontSize:'11px', color:RED, fontWeight:'700', marginTop:'3px' }}>{pConflicts} conflicts</div>}
              </div>
            );
          })}
        </div>
      </div>
      {/* ── Right panel ── */}
      <div style={{ flex:1, minWidth:0, display:'flex', flexDirection:'column' }}>
        {!sel ? (
          <div style={{ display:'flex', alignItems:'center', justifyContent:'center', height:'100%', color:MUTED, fontSize:'13px' }}>← Select a team member</div>
        ) : (
          <>
            {/* Person header */}
            <div style={{ padding:'18px 20px', background:CARD, borderBottom:`1px solid ${BORDER}`, display:'flex', alignItems:'center' }}>
              <div style={{ flex:1 }}>
                <div style={{ fontSize:'20px', fontWeight:'700', color:TEXT }}>{sel}</div>
                <div style={{ fontSize:'12px', color:MUTED, marginTop:'2px' }}>{per?.role} ({per?.rate})</div>
              </div>
              <div style={{ display:'flex', alignItems:'center', gap:'32px', marginRight:'20px' }}>
                <div style={{ textAlign:'center' }}>
                  <div style={{ fontSize:'22px', fontWeight:'800', color:TEXT, fontVariantNumeric:'tabular-nums' }}>{personProjects.length}</div>
                  <div style={{ fontSize:'11px', color:MUTED, marginTop:'2px' }}>Projects</div>
                </div>
                <div style={{ textAlign:'center' }}>
                  <div style={{ fontSize:'22px', fontWeight:'800', color:TEXT, fontVariantNumeric:'tabular-nums' }}>{pt.length}</div>
                  <div style={{ fontSize:'11px', color:MUTED, marginTop:'2px' }}>Tasks</div>
                </div>
                <div style={{ textAlign:'center' }}>
                  <div style={{ fontSize:'22px', fontWeight:'800', color:personConflicts.length>0?RED:TEXT, fontVariantNumeric:'tabular-nums' }}>
                    {personConflicts.length}{personConflicts.length>0&&<span style={{ fontSize:'14px' }}> ›</span>}
                  </div>
                  <div style={{ fontSize:'11px', color:personConflicts.length>0?RED:MUTED, marginTop:'2px' }}>Conflicts</div>
                </div>
              </div>
              <div style={{ display:'flex', gap:'10px' }}>
                <button style={{ display:'flex', alignItems:'center', gap:'5px', padding:'7px 14px', borderRadius:'8px', border:`1px solid ${BORDER}`, background:'transparent', color:TEXT, fontSize:'12px', cursor:'pointer' }}>
                  <svg width="12" height="12" fill="none" viewBox="0 0 16 16"><path d="M8 2v9M4 8l4 4 4-4" stroke={TEXT} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/><path d="M2 13h12" stroke={TEXT} strokeWidth="1.5" strokeLinecap="round"/></svg>
                  Import
                </button>
                <button style={{ padding:'7px 14px', borderRadius:'8px', border:'none', background:ORANGE, color:'white', fontSize:'12px', cursor:'pointer', fontWeight:'700' }}>+ New Task</button>
              </div>
            </div>
            {/* Sub-tabs */}
            <div style={{ display:'flex', alignItems:'center', padding:'0 20px', borderBottom:`1px solid ${BORDER}`, background:CARD }}>
              <div style={{ display:'flex', alignItems:'center', gap:'0', flex:1 }}>
                {[{id:'projects',l:'Projects'},{id:'gantt',l:'Gantt View'}].map(t => (
                  <button key={t.id} onClick={() => setSubTab(t.id)}
                    style={{ padding:'12px 16px', border:'none', background:'none', cursor:'pointer', fontSize:'13px', fontWeight:subTab===t.id?'600':'400', color:subTab===t.id?ORANGE:MUTED, borderBottom:subTab===t.id?`2px solid ${ORANGE}`:'2px solid transparent', marginBottom:'-1px' }}>
                    {t.l}
                  </button>
                ))}
              </div>
              <div style={{ display:'flex', gap:'10px' }}>
                <button style={{ padding:'5px 12px', borderRadius:'6px', border:`1px solid ${BORDER}`, background:'transparent', color:TEXT, fontSize:'12px', cursor:'pointer' }}>Full Timeline</button>
                <div style={{ position:'relative' }}>
                  <select style={{ appearance:'none', WebkitAppearance:'none', padding:'5px 22px 5px 10px', borderRadius:'6px', border:`1px solid ${BORDER}`, background:'transparent', color:TEXT, fontSize:'12px', cursor:'pointer', outline:'none' }}>
                    <option>All Projects</option>
                    {projs.map(p => <option key={p.id}>{p.id}</option>)}
                  </select>
                  <span style={{ position:'absolute', right:'6px', top:'50%', transform:'translateY(-50%)', pointerEvents:'none', color:MUTED, fontSize:'9px' }}>▾</span>
                </div>
              </div>
            </div>
            {subTab === 'projects' && (
              <div style={{ overflowX:'auto', flex:1 }}>
                <table style={{ borderCollapse:'collapse', width:'100%', fontSize:'12px' }}>
                  <thead>
                    <tr style={{ background:'#0A0A0F', borderBottom:`1px solid ${BORDER}` }}>
                      {['Project','Task ID','Task Name','Start','End','Dependencies','Status'].map(col => (
                        <th key={col} style={{ padding:'10px 14px', textAlign:'left', fontSize:'12px', fontWeight:'500', color:MUTED, borderRight:`1px solid ${BORDER}`, whiteSpace:'nowrap' }}>{col}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    <tr style={{ borderBottom:`1px solid ${BORDER}`, background:'#0F0F18' }}>
                      {['All','','All','','','',''].map((v,i)=>(
                        <td key={i} style={{ padding:'7px 14px', color:MUTED, fontSize:'12px', borderRight:`1px solid ${BORDER}` }}>{v}</td>
                      ))}
                    </tr>
                    {pt.map((t, ri) => {
                      const proj = projs.find(p => p.id === t.projId);
                      const depIds = tdepMap[t.id] || [];
                      const depNames = depIds.join(', ') || '—';
                      const nowMs2 = todayMs || (() => { const d = new Date(); d.setHours(0,0,0,0); return d.getTime(); })();
                      const status = computeStatus(t, statusOverrides, nowMs2);
                      const ss = STATUS_STYLES[status] || STATUS_STYLES['On Track'];
                      const baseBg = ri%2===0 ? '#13131A' : '#0F0F18';
                      return (
                        <tr key={t.id} style={{ background:baseBg, borderBottom:`1px solid ${BORDER}` }}
                          onMouseEnter={e=>e.currentTarget.style.background='#1E2535'}
                          onMouseLeave={e=>e.currentTarget.style.background=baseBg}>
                          <td style={{ padding:'9px 14px', borderRight:`1px solid ${BORDER}` }}><span style={{ fontWeight:'700', color:proj?.color }}>{t.projId}</span></td>
                          <td style={{ padding:'9px 14px', borderRight:`1px solid ${BORDER}` }}><span style={{ fontWeight:'600', color:proj?.color }}>{t.id}</span></td>
                          <td style={{ padding:'9px 14px', borderRight:`1px solid ${BORDER}`, color:TEXT, maxWidth:'240px', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{t.name}</td>
                          <td style={{ padding:'9px 14px', borderRight:`1px solid ${BORDER}`, color:TEXT, whiteSpace:'nowrap', fontVariantNumeric:'tabular-nums' }}>{fd(t.s)}</td>
                          <td style={{ padding:'9px 14px', borderRight:`1px solid ${BORDER}`, color:TEXT, whiteSpace:'nowrap', fontVariantNumeric:'tabular-nums' }}>{fd(t.e)}</td>
                          <td style={{ padding:'9px 14px', borderRight:`1px solid ${BORDER}`, color:MUTED }}>{depNames}</td>
                          <td style={{ padding:'9px 14px' }}><span style={{ background:ss.bg, color:ss.tx, border:`1px solid ${ss.bd}`, padding:'3px 10px', borderRadius:'20px', fontSize:'11px', fontWeight:'600', whiteSpace:'nowrap' }}>{status}</span></td>
                        </tr>
                      );
                    })}
                    {pt.length===0 && <tr><td colSpan={7} style={{ padding:'40px', textAlign:'center', color:MUTED }}>No tasks assigned.</td></tr>}
                  </tbody>
                </table>
              </div>
            )}
            {subTab === 'gantt' && (
              <div style={{ padding:'20px', color:MUTED, textAlign:'center', fontSize:'13px', flex:1, display:'flex', alignItems:'center', justifyContent:'center' }}>
                Gantt view filtered to {sel}'s tasks — coming soon.
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ── Project Gantt tab ─────────────────────────────────────────────────────────
const PRH = 52;   // project header row height
const RRH = 44;   // role sub-header row height
const SRH = 68;   // person leaf-row height
const SBH = 38;   // person bar height

// Three roles matching schedule_simple.xlsx
const ROLES = [
  { key:'coordinator', label:'Project Coordinator', color:'#6366F1', people:['Morgan','Lee','Dana'] },
  { key:'architect',   label:'Architect',           color:'#10B981', people:['Sam','James','Jordan'] },
  { key:'draftee',     label:'Draftee',             color:'#F59E0B', people:['Alex','Chris'] },
];
const roleOf = name => ROLES.find(r => r.people.includes(name)) || ROLES[0];

function ProjectGanttTab({ tasks, simDelays, setSimDelays, onEdit, setAddTasksProj, onToggleComplete, statusOverrides, todayMs }) {
  const { rawTasks, projs, people, tdepMap, base, todayDay, periods } = useSched();

  // ── Filter state — owned here, not in parent ──────────────────────────────
  const [filterProj,   setFilterProj]   = useState(null); // null = All
  const [filterPerson, setFilterPerson] = useState(null); // null = All
  const [zoomPeriod,   setZoomPeriod]   = useState(null);
  const [filterMenuOpen,   setFilterMenuOpen]   = useState(false);
  const [personMenuOpen,   setPersonMenuOpen]   = useState(false);
  const filterMenuRef  = useRef(null);
  const personMenuRef  = useRef(null);

  const fp = filterProj || 'All';

  const [showCompleted, setShowCompleted] = useState(true);
  const [expanded, setExpanded] = useState(() => {
    const s = new Set(projs.map(p => p.id));
    projs.forEach(p => ROLES.forEach(r => s.add(`${p.id}-${r.key}`)));
    return s;
  });
  const [hov, setHov]     = useState(null);
  const [mouse, setMouse] = useState({ x:0, y:0 });
  const [showDeps, setShowDeps] = useState(false);
  const [projMenuOpen, setProjMenuOpen] = useState(false);
  const [addTasksMenuOpen, setAddTasksMenuOpen] = useState(false);
  const projMenuRef     = useRef(null);
  const addTasksMenuRef = useRef(null);

  // Close dropdowns on outside click
  useEffect(() => {
    const handler = e => {
      if (projMenuRef.current && !projMenuRef.current.contains(e.target))
        setProjMenuOpen(false);
      if (addTasksMenuRef.current && !addTasksMenuRef.current.contains(e.target))
        setAddTasksMenuOpen(false);
      if (filterMenuRef.current && !filterMenuRef.current.contains(e.target))
        setFilterMenuOpen(false);
      if (personMenuRef.current && !personMenuRef.current.contains(e.target))
        setPersonMenuOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);
  const outerRef  = useRef(null);
  const scrollRef = useRef(null);

  // Dynamic timeline — expands if delayed tasks push past the base 120-day window
  const maxTaskDay = useMemo(() => Math.max(120, ...tasks.map(t => t.sd + t.cd + 10)), [tasks]);
  const MONS = useMemo(() => {
    const needed = [];
    for (let i = 0; i < ALL_MONS.length - 1; i++) {
      needed.push(ALL_MONS[i]);
      if (ALL_MONS[i + 1].d > maxTaskDay) { needed.push(ALL_MONS[i + 1]); break; }
    }
    if (needed[needed.length - 1].n !== '') needed.push({ n:'', d: maxTaskDay + 30 });
    return needed;
  }, [maxTaskDay]);
  const TD = maxTaskDay;

  // ── Dynamic DPX — single project gets generous spacing, all-projects is compact ──
  const dpx = useMemo(() => {
    const viewW = (outerRef.current?.clientWidth || 1100) - LW - 40;
    if (zoomPeriod) {
      const period = periods.find(p => p.key === zoomPeriod);
      if (period) {
        const span = period.endDay - period.startDay + 1;
        return Math.min(38, Math.max(14, Math.floor(viewW * 0.92 / span)));
      }
    }
    if (filterProj) {
      const pt = tasks.filter(t => t.projId === filterProj && t.cd > 0);
      if (pt.length) {
        const span = Math.max(...pt.map(t => t.sd + t.cd)) - Math.min(...pt.map(t => t.sd));
        return Math.min(48, Math.max(20, Math.floor(viewW * 0.9 / span)));
      }
    }
    if (filterPerson) {
      const pt = tasks.filter(t => t.person === filterPerson && t.cd > 0);
      if (pt.length) {
        const span = Math.max(...pt.map(t => t.sd + t.cd)) - Math.min(...pt.map(t => t.sd));
        return Math.min(48, Math.max(20, Math.floor(viewW * 0.9 / span)));
      }
    }
    return DPX;
  }, [filterProj, filterPerson, zoomPeriod, tasks]);

  const txR = d => d * dpx;

  // ── Scroll to project start when filter changes ───────────────────────────
  useEffect(() => {
    if (!filterProj && !filterPerson) {
      setShowDeps(false);
      return;
    }
    setShowDeps(true);
    // Expand the filtered project(s)
    setExpanded(prev => {
      const next = new Set(prev);
      const targetProjs = filterProj ? [filterProj] : projs.map(p => p.id);
      targetProjs.forEach(pid => {
        next.add(pid);
        ROLES.forEach(r => next.add(`${pid}-${r.key}`));
      });
      return next;
    });
    requestAnimationFrame(() => {
      if (!scrollRef.current) return;
      const relevantTasks = filterPerson
        ? tasks.filter(t => t.person === filterPerson && t.cd > 0)
        : filterProj
          ? tasks.filter(t => t.projId === filterProj && t.cd > 0)
          : [];
      const scrollDay = relevantTasks.length ? Math.min(...relevantTasks.map(t => t.sd)) : 0;
      scrollRef.current.scrollLeft = Math.max(0, scrollDay * dpx - 36);
    });
  }, [filterProj, filterPerson, dpx]);

  const toggle = id => setExpanded(prev => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });

  // One entry per project with role → person breakdown
  const projData = useMemo(() => {
    return projs
      .filter(p => !filterProj || p.id === filterProj)
      .map(proj => {
        const pt = tasks
          .filter(t => t.projId === proj.id)
          .filter(t => {
            if (showCompleted) return true;
            const effStatus = computeStatus(t, statusOverrides, todayMs || Date.now());
            return effStatus !== 'Completed';
          })
          .filter(t => !filterPerson || t.person === filterPerson);
        const withDur = pt.filter(t => t.cd > 0);
        const minSd = withDur.length ? Math.min(...withDur.map(t => t.sd)) : 0;
        const maxEd = withDur.length ? Math.max(...withDur.map(t => t.sd + t.cd)) : 0;
        // Group people by role, only roles that appear in this project
        const roleGroups = ROLES
          .map(role => {
            const members = people.filter(per =>
              role.people.includes(per.name) && pt.some(t => t.person === per.name)
            );
            if (!members.length) return null;
            return {
              role,
              personRows: members.map(per => ({
                per, tasks: pt.filter(t => t.person === per.name).sort((a, b) => a.s - b.s),
              })),
            };
          })
          .filter(Boolean);
        return { proj, pt, minSd, maxEd, roleGroups };
      })
      .filter(pd => pd.pt.length > 0 || !filterPerson); // hide projects with no matching tasks when filtering by person
  }, [tasks, filterProj, filterPerson, showCompleted, statusOverrides, todayMs]);

  // Flat row list: proj → role → person, with y positions
  const { rowList, totalH } = useMemo(() => {
    const list = [];
    let y = HH;
    for (const pd of projData) {
      list.push({ kind: 'proj', pd, y });
      y += PRH;
      if (expanded.has(pd.proj.id)) {
        for (const rg of pd.roleGroups) {
          const roleKey = `${pd.proj.id}-${rg.role.key}`;
          list.push({ kind: 'role', pd, rg, y });
          y += RRH;
          if (expanded.has(roleKey)) {
            for (const pr of rg.personRows) {
              list.push({ kind: 'person', pd, rg, pr, y });
              y += SRH;
            }
          }
        }
      }
    }
    return { rowList: list, totalH: y };
  }, [projData, expanded]);

  const W = LW + TD * DPX;
  const ht = hov ? tasks.find(t => t.id === hov) : null;

  // Pixel positions for every visible task:
  //   • person rows  → yc at person row centre
  //   • collapsed role rows → yc at role row centre (tasks show as mini bars)
  const posMap = useMemo(() => {
    const m = {};
    for (const row of rowList) {
      if (row.kind === 'person') {
        const yc = row.y + SRH / 2;
        for (const t of row.pr.tasks) {
          m[t.id] = { xs: txR(t.sd), xe: txR(t.sd + t.cd), yc, collapsed: false };
        }
      } else if (row.kind === 'role') {
        const roleKey = `${row.pd.proj.id}-${row.rg.role.key}`;
        if (!expanded.has(roleKey)) {
          // Role is collapsed — all its tasks appear as mini bars in this row
          const yc = row.y + RRH / 2;
          for (const pr of row.rg.personRows) {
            for (const t of pr.tasks) {
              m[t.id] = { xs: txR(t.sd), xe: txR(t.sd + t.cd), yc, collapsed: true };
            }
          }
        }
      }
    }
    return m;
  }, [rowList, expanded, dpx]);

  // Dep lines — between any two tasks that both have a position in posMap
  const depLines = useMemo(() => {
    const lines = [];
    for (const pd of projData) {
      for (const t of pd.pt) {
        const toPos = posMap[t.id];
        if (!toPos) continue;
        const rawDeps = tdepMap[t.id] || [];
        for (const depRaw of rawDeps) {
          const { id: depId, type: depType } = normDep(depRaw);
          const fromPos = posMap[depId];
          if (fromPos) {
            lines.push({
              from: fromPos, to: toPos,
              taskId: t.id, depId,
              projId: t.projId,
              type: depType || 'FS',
              sameRow: Math.abs(fromPos.yc - toPos.yc) < 4,
            });
          }
        }
      }
    }
    return lines;
  }, [projData, posMap, tdepMap]);

  // Tasks connected to the hovered one
  const hovRelated = useMemo(() => {
    if (!hov) return new Set();
    const s = new Set([hov]);
    for (const l of depLines) {
      if (l.taskId === hov) s.add(l.depId);
      if (l.depId  === hov) s.add(l.taskId);
    }
    return s;
  }, [hov, depLines]);

  return (
    <div>
      {/* ── Toolbar — matches Figma exactly ── */}
      <div style={{ display:'flex', alignItems:'center', gap:'0', padding:'0 16px', height:'48px', borderBottom:`1px solid #2A2A3A`, background:'#1C1C27' }}>
        {/* Details › */}
        <button style={{ display:'flex', alignItems:'center', gap:'5px', padding:'0 14px', height:'48px', border:'none', background:'none', cursor:'pointer', fontSize:'13px', fontWeight:'500', color:'#E8E8F0', borderRight:'1px solid #2A2A3A' }}>
          Details <span style={{ fontSize:'11px', color:'#6B7280' }}>›</span>
        </button>

        {/* Dependencies toggle */}
        <div style={{ display:'flex', alignItems:'center', gap:'8px', padding:'0 14px', height:'48px', borderRight:'1px solid #2A2A3A', cursor:'pointer' }} onClick={() => setShowDeps(v => !v)}>
          <span style={{ fontSize:'13px', fontWeight:'500', color:'#E8E8F0' }}>Dependencies</span>
          <div style={{ width:'36px', height:'20px', borderRadius:'10px', background: showDeps ? '#F97316' : '#374151', position:'relative', transition:'background 0.2s', flexShrink:0 }}>
            <div style={{ position:'absolute', top:'3px', left: showDeps ? '18px' : '3px', width:'14px', height:'14px', borderRadius:'50%', background:'white', transition:'left 0.2s' }} />
          </div>
        </div>

        {/* Show Completed toggle */}
        <div style={{ display:'flex', alignItems:'center', gap:'8px', padding:'0 14px', height:'48px', borderRight:'1px solid #2A2A3A', cursor:'pointer' }} onClick={() => setShowCompleted(v => !v)}>
          <span style={{ fontSize:'13px', fontWeight:'500', color:'#E8E8F0' }}>Completed</span>
          <div style={{ width:'36px', height:'20px', borderRadius:'10px', background: showCompleted ? '#10B981' : '#374151', position:'relative', transition:'background 0.2s', flexShrink:0 }}>
            <div style={{ position:'absolute', top:'3px', left: showCompleted ? '18px' : '3px', width:'14px', height:'14px', borderRadius:'50%', background:'white', transition:'left 0.2s' }} />
          </div>
        </div>

        {/* Adjust Timeline */}
        <div ref={projMenuRef} style={{ position:'relative' }}>
          <button onClick={() => setProjMenuOpen(v => !v)}
            style={{ display:'flex', alignItems:'center', gap:'6px', padding:'0 14px', height:'48px', border:'none', background:'none', cursor:'pointer', fontSize:'13px', fontWeight:'500', color: projMenuOpen ? '#F97316' : '#E8E8F0', borderRight:'1px solid #2A2A3A' }}>
            Adjust Timeline
          </button>
          {projMenuOpen && (
            <div style={{ position:'absolute', top:'calc(100% + 4px)', left:0, zIndex:50, background:'#1C1C27', borderRadius:'10px', boxShadow:'0 8px 24px rgba(0,0,0,0.5)', border:'1px solid #2A2A3A', minWidth:'210px', overflow:'hidden' }}>
              {projs.map((p, i) => (
                <div key={p.id}
                  onClick={() => { setProjMenuOpen(false); onEdit({ type:'project', id:p.id }); }}
                  style={{ display:'flex', alignItems:'center', gap:'10px', padding:'11px 14px', cursor:'pointer', borderBottom: i < projs.length - 1 ? '1px solid #2A2A3A' : 'none' }}
                  onMouseEnter={e => e.currentTarget.style.background='#2A2A3A'}
                  onMouseLeave={e => e.currentTarget.style.background='transparent'}>
                  <div style={{ width:'9px', height:'9px', borderRadius:'50%', background:p.color, flexShrink:0 }} />
                  <span style={{ fontSize:'13px', color:'#E8E8F0', fontWeight:'500' }}>{p.id} — New Build</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Add Tasks dropdown */}
        <div ref={addTasksMenuRef} style={{ position:'relative' }}>
          <button onClick={() => setAddTasksMenuOpen(v => !v)}
            style={{ display:'flex', alignItems:'center', gap:'6px', padding:'0 14px', height:'48px', border:'none', background:'none', cursor:'pointer', fontSize:'13px', fontWeight:'500', color: addTasksMenuOpen ? '#F97316' : '#E8E8F0', borderRight:'1px solid #2A2A3A' }}>
            + Add Tasks
          </button>
          {addTasksMenuOpen && (
            <div style={{ position:'absolute', top:'calc(100% + 4px)', left:0, zIndex:50, background:'#1C1C27', borderRadius:'10px', boxShadow:'0 8px 24px rgba(0,0,0,0.5)', border:'1px solid #2A2A3A', minWidth:'210px', overflow:'hidden' }}>
              {projs.map((p, i) => (
                <div key={p.id}
                  onClick={() => { setAddTasksMenuOpen(false); setAddTasksProj(p); }}
                  style={{ display:'flex', alignItems:'center', gap:'10px', padding:'11px 14px', cursor:'pointer', borderBottom: i < projs.length-1 ? '1px solid #2A2A3A' : 'none' }}
                  onMouseEnter={e => e.currentTarget.style.background='#2A2A3A'}
                  onMouseLeave={e => e.currentTarget.style.background='transparent'}>
                  <div style={{ width:'9px', height:'9px', borderRadius:'50%', background:p.color, flexShrink:0 }} />
                  <span style={{ fontSize:'13px', color:'#E8E8F0', fontWeight:'500' }}>{p.id} — {p.name.replace(' — New Build','')}</span>
                </div>
              ))}
            </div>
          )}
        </div>
        {Object.keys(simDelays).length > 0 && (
          <button onClick={() => setSimDelays({})}
            style={{ display:'flex', alignItems:'center', gap:'5px', padding:'0 12px', height:'48px', border:'none', background:'none', cursor:'pointer', fontSize:'12px', color:'#F97316', fontWeight:'600', borderRight:'1px solid #2A2A3A' }}>
            ✕ Clear preview delays
          </button>
        )}

        {/* Right side */}
        <div style={{ marginLeft:'auto', display:'flex', alignItems:'center', gap:'0' }}>
          {/* Month label */}
          <span style={{ padding:'0 14px', fontSize:'13px', color:'#6B7280', borderLeft:'1px solid #2A2A3A', height:'48px', display:'flex', alignItems:'center' }}>Month</span>

          {/* Resource filter */}
          <div ref={personMenuRef} style={{ position:'relative', borderLeft:'1px solid #2A2A3A' }}>
            <button onClick={() => setPersonMenuOpen(v => !v)}
              style={{ display:'flex', alignItems:'center', gap:'8px', padding:'0 14px', height:'48px', border:'none', background: filterPerson ? '#10B98112' : 'none', cursor:'pointer', fontSize:'13px', fontWeight:'500', color: filterPerson ? '#10B981' : '#E8E8F0', minWidth:'140px' }}>
              {filterPerson
                ? <><div style={{ width:'9px', height:'9px', borderRadius:'50%', background: people.find(p=>p.name===filterPerson)?.color || '#10B981', flexShrink:0 }} />{filterPerson}</>
                : 'All Resources'
              }
              <span style={{ marginLeft:'auto', color:'#6B7280', fontSize:'10px' }}>▾</span>
            </button>
            {personMenuOpen && (
              <div style={{ position:'absolute', top:'calc(100% + 4px)', right:0, zIndex:100, background:'#1C1C27', borderRadius:'10px', boxShadow:'0 8px 24px rgba(0,0,0,0.6)', border:'1px solid #2A2A3A', minWidth:'200px', maxHeight:'320px', overflowY:'auto' }}>
                <div onClick={() => { setFilterPerson(null); setPersonMenuOpen(false); }}
                  style={{ display:'flex', alignItems:'center', gap:'10px', padding:'11px 14px', cursor:'pointer', borderBottom:'1px solid #2A2A3A',
                    background: !filterPerson ? '#2A2A3A' : 'transparent',
                    color: !filterPerson ? '#F97316' : '#E8E8F0',
                    fontSize:'13px', fontWeight: !filterPerson ? '600' : '400' }}
                  onMouseEnter={e => { if (filterPerson) e.currentTarget.style.background='#2A2A3A'; }}
                  onMouseLeave={e => { if (filterPerson) e.currentTarget.style.background='transparent'; }}>
                  <div style={{ width:'9px', height:'9px', borderRadius:'50%', background:'#6B7280', flexShrink:0 }} />
                  All Resources
                </div>
                {people.map((per, i) => {
                  const perTasks = tasks.filter(t => t.person === per.name);
                  const hasConflict = perTasks.some(t => t.isC);
                  const projCount = new Set(perTasks.map(t => t.projId)).size;
                  return (
                    <div key={per.name} onClick={() => { setFilterPerson(per.name); setPersonMenuOpen(false); }}
                      style={{ display:'flex', alignItems:'center', gap:'10px', padding:'10px 14px', cursor:'pointer',
                        borderBottom: i < people.length - 1 ? '1px solid #2A2A3A22' : 'none',
                        background: filterPerson === per.name ? '#2A2A3A' : 'transparent',
                        color: filterPerson === per.name ? (per.color || '#10B981') : '#E8E8F0',
                        fontSize:'13px', fontWeight: filterPerson === per.name ? '600' : '400' }}
                      onMouseEnter={e => { if (filterPerson !== per.name) e.currentTarget.style.background='#2A2A3A'; }}
                      onMouseLeave={e => { if (filterPerson !== per.name) e.currentTarget.style.background='transparent'; }}>
                      <div style={{ width:'9px', height:'9px', borderRadius:'50%', background: per.color || '#6B7280', flexShrink:0 }} />
                      <div style={{ flex:1, minWidth:0 }}>
                        <div style={{ fontWeight:'500', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{per.name}</div>
                        <div style={{ fontSize:'10px', color:'#6B7280', marginTop:'1px' }}>{per.role || '—'} · {projCount} project{projCount!==1?'s':''}</div>
                      </div>
                      {hasConflict && <div style={{ width:'7px', height:'7px', borderRadius:'50%', background:'#EF4444', flexShrink:0 }} />}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Project filter — custom dropdown */}
          <div ref={filterMenuRef} style={{ position:'relative', borderLeft:'1px solid #2A2A3A' }}>
            <button onClick={() => setFilterMenuOpen(v => !v)}
              style={{ display:'flex', alignItems:'center', gap:'8px', padding:'0 14px', height:'48px', border:'none', background: filterProj ? '#F9731612' : 'none', cursor:'pointer', fontSize:'13px', fontWeight:'500', color: filterProj ? '#F97316' : '#E8E8F0', minWidth:'140px' }}>
              {filterProj
                ? <><div style={{ width:'9px', height:'9px', borderRadius:'50%', background: projs.find(p=>p.id===filterProj)?.color, flexShrink:0 }} />{filterProj}</>
                : 'All Projects'
              }
              <span style={{ marginLeft:'auto', color:'#6B7280', fontSize:'10px' }}>▾</span>
            </button>
            {filterMenuOpen && (
              <div style={{ position:'absolute', top:'calc(100% + 4px)', right:0, zIndex:100, background:'#1C1C27', borderRadius:'10px', boxShadow:'0 8px 24px rgba(0,0,0,0.6)', border:'1px solid #2A2A3A', minWidth:'180px', overflow:'hidden' }}>
                <div onClick={() => { setFilterProj(null); setFilterMenuOpen(false); }}
                  style={{ display:'flex', alignItems:'center', gap:'10px', padding:'11px 14px', cursor:'pointer', borderBottom:'1px solid #2A2A3A',
                    background: !filterProj ? '#2A2A3A' : 'transparent', color: !filterProj ? '#F97316' : '#E8E8F0', fontSize:'13px', fontWeight: !filterProj ? '600' : '400' }}
                  onMouseEnter={e => { if (filterProj) e.currentTarget.style.background='#2A2A3A'; }}
                  onMouseLeave={e => { if (filterProj) e.currentTarget.style.background='transparent'; }}>
                  <div style={{ width:'9px', height:'9px', borderRadius:'50%', background:'#6B7280', flexShrink:0 }} />
                  All Projects
                </div>
                {projs.map((p, i) => (
                  <div key={p.id} onClick={() => { setFilterProj(p.id); setFilterMenuOpen(false); }}
                    style={{ display:'flex', alignItems:'center', gap:'10px', padding:'11px 14px', cursor:'pointer',
                      borderBottom: i < projs.length - 1 ? '1px solid #2A2A3A' : 'none',
                      background: filterProj === p.id ? '#2A2A3A' : 'transparent',
                      color: filterProj === p.id ? p.color : '#E8E8F0',
                      fontSize:'13px', fontWeight: filterProj === p.id ? '600' : '400' }}
                    onMouseEnter={e => { if (filterProj !== p.id) e.currentTarget.style.background='#2A2A3A'; }}
                    onMouseLeave={e => { if (filterProj !== p.id) e.currentTarget.style.background='transparent'; }}>
                    <div style={{ width:'9px', height:'9px', borderRadius:'50%', background:p.color, flexShrink:0 }} />
                    {p.id} — {p.name.replace(' — New Build','').replace(' — ','') || 'New Build'}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      <div ref={outerRef} style={{ position:'relative', display:'flex', background:'#13131A' }}
        onMouseMove={e => { const r = outerRef.current?.getBoundingClientRect(); if (r) setMouse({ x: e.clientX - r.left, y: e.clientY - r.top }); }}
        onMouseLeave={() => setHov(null)}>

        {/* ── STICKY LEFT PANEL — does not scroll ── */}
        <div style={{ width:LW, flexShrink:0, position:'relative', zIndex:5, boxShadow:'4px 0 12px rgba(0,0,0,0.4)' }}>
          <svg width={LW} height={totalH} style={{ display:'block', fontFamily:'-apple-system,system-ui,sans-serif' }}>
            {/* Header bg */}
            <rect x={0} y={0} width={LW} height={HH} fill="#0A0A0F" />
            <line x1={0} y1={HH} x2={LW} y2={HH} stroke="#2A2A3A" strokeWidth="1.5" />

            {rowList.map(row => {
              if (row.kind === 'proj') {
                const { pd, y } = row;
                const { proj, pt } = pd;
                const isExp = expanded.has(proj.id);
                const midY = y + PRH / 2;
                const hasC = pt.some(t => t.isC);
                return (
                  <g key={proj.id+'-lbl'} style={{ cursor:'pointer' }} onClick={() => toggle(proj.id)}>
                    <rect x={0} y={y} width={LW} height={PRH} fill={proj.color+'18'} />
                    <rect x={10} y={midY-11} width={22} height={22} rx="6" fill={proj.color+'30'} />
                    <text x={21} y={midY+1} textAnchor="middle" dominantBaseline="middle" fill={proj.color} fontSize="14" fontWeight="800" style={{userSelect:'none'}}>{isExp?'−':'+'}</text>
                    <text x={40} y={midY-6} fill={proj.color} fontSize="14" fontWeight="800">{proj.id}</text>
                    <text x={40} y={midY+9} fill="#6B7280" fontSize="10">New Build · {pt.length} tasks</text>
                    <rect x={LW-46} y={midY-11} width={36} height={22} rx="11" fill={proj.color+'25'} />
                    <text x={LW-28} y={midY+1} textAnchor="middle" dominantBaseline="middle" fill={proj.color} fontSize="11" fontWeight="700">{pt.length}</text>
                    {hasC && <g>
                      <circle cx={LW-8} cy={y+14} r={7} fill="#EF4444" />
                      <text x={LW-8} y={y+14} textAnchor="middle" dominantBaseline="middle" fill="white" fontSize="9" fontWeight="700">!</text>
                    </g>}
                    <line x1={0} y1={y+PRH} x2={LW} y2={y+PRH} stroke={isExp?proj.color+'50':'#2A2A3A'} strokeWidth={isExp?1.5:1} />
                  </g>
                );
              }
              // ── Role sub-header row ──────────────────────────────────────
              if (row.kind === 'role') {
                const { pd: rpd, rg, y: ry } = row;
                const roleKey = `${rpd.proj.id}-${rg.role.key}`;
                const isRExp = expanded.has(roleKey);
                const rMidY = ry + RRH / 2;
                const allTasks = rg.personRows.flatMap(r2 => r2.tasks);
                const rHasC = allTasks.some(t => t.isC);
                return (
                  <g key={roleKey+'-lbl'} style={{ cursor:'pointer' }} onClick={() => toggle(roleKey)}>
                    <rect x={0} y={ry} width={LW} height={RRH} fill="#1A1A24" />
                    <line x1={18} y1={ry} x2={18} y2={ry+RRH} stroke={rpd.proj.color+'50'} strokeWidth="1.5" />
                    <rect x={26} y={rMidY-9} width={18} height={18} rx="5" fill={rg.role.color+'30'} />
                    <text x={35} y={rMidY+1} textAnchor="middle" dominantBaseline="middle" fill={rg.role.color} fontSize="12" fontWeight="800" style={{userSelect:'none'}}>{isRExp?'−':'+'}</text>
                    <text x={51} y={rMidY-5} fill={rg.role.color} fontSize="11.5" fontWeight="700">{rg.role.label}</text>
                    <text x={51} y={rMidY+8} fill="#6B7280" fontSize="9.5">{rg.personRows.length} member{rg.personRows.length>1?'s':''} · {allTasks.length} tasks</text>
                    {rHasC && <g>
                      <circle cx={LW-8} cy={ry+12} r={7} fill="#EF4444" />
                      <text x={LW-8} y={ry+12} textAnchor="middle" dominantBaseline="middle" fill="white" fontSize="9" fontWeight="700">!</text>
                    </g>}
                    <line x1={0} y1={ry+RRH} x2={LW} y2={ry+RRH} stroke={isRExp?rg.role.color+'40':'#2A2A3A'} strokeWidth={isRExp?1.2:0.8} />
                  </g>
                );
              }

              // ── Person leaf row ──────────────────────────────────────────────
              if (row.kind === 'person') {
                const { pd: ppd, rg: prg, pr, y: py } = row;
                const pTasks = pr.tasks;
                const pMidY = py + SRH / 2;
                const pHasC = pTasks.some(t => t.isC);
                const pHasF = pTasks.some(t => t.isF && !t.isC);
                return (
                  <g key={`${ppd.proj.id}-${pr.per.name}-lbl`}>
                    <rect x={0} y={py} width={LW} height={SRH} fill="#13131A" />
                    <line x1={18} y1={py} x2={18} y2={py+SRH} stroke={ppd.proj.color+'50'} strokeWidth="1.5" />
                    <line x1={32} y1={py} x2={32} y2={py+SRH} stroke={prg.role.color+'50'} strokeWidth="1.5" />
                    <line x1={32} y1={pMidY} x2={44} y2={pMidY} stroke={prg.role.color+'50'} strokeWidth="1.5" />
                    <circle cx={56} cy={pMidY} r={13} fill={prg.role.color+'20'} />
                    <circle cx={56} cy={pMidY} r={13} fill="none" stroke={prg.role.color} strokeWidth="1.5" />
                    <text x={56} y={pMidY+1} textAnchor="middle" dominantBaseline="middle" fill={prg.role.color} fontSize="8.5" fontWeight="700">{pr.per.init}</text>
                    <text x={75} y={pMidY-7} fill="#E8E8F0" fontSize="12" fontWeight="600">{pr.per.name}</text>
                    <text x={75} y={pMidY+8} fill="#6B7280" fontSize="9.5">{pTasks.length} tasks</text>
                    <rect x={LW-40} y={pMidY-10} width={28} height={20} rx="10" fill="#2A2A3A" />
                    <text x={LW-26} y={pMidY+1} textAnchor="middle" dominantBaseline="middle" fill="#6B7280" fontSize="10" fontWeight="600">{pTasks.length}</text>
                    {pHasC && <g>
                      <circle cx={LW-8} cy={py+13} r={7} fill="#EF4444" />
                      <text x={LW-8} y={py+13} textAnchor="middle" dominantBaseline="middle" fill="white" fontSize="9" fontWeight="700">!</text>
                    </g>}
                    {pHasF && !pHasC && <g>
                      <circle cx={LW-8} cy={py+13} r={7} fill="#F59E0B" />
                      <text x={LW-8} y={py+13} textAnchor="middle" dominantBaseline="middle" fill="white" fontSize="10" fontWeight="800">~</text>
                    </g>}
                    <line x1={0} y1={py+SRH} x2={py} y2={py+SRH} stroke="#2A2A3A" strokeWidth="1" />
                    <line x1={0} y1={py+SRH} x2={LW} y2={py+SRH} stroke="#2A2A3A" strokeWidth="1" />
                  </g>
                );
              }
              return null;
            })}

            <line x1={LW-1} y1={0} x2={LW-1} y2={totalH} stroke="#2A2A3A" strokeWidth="1" />
          </svg>
        </div>

        {/* ── SCROLLABLE TIMELINE — right side only ── */}
        <div ref={scrollRef} style={{ overflowX:'auto', flex:1 }}>
          <svg width={TD*dpx} height={totalH} style={{ display:'block', fontFamily:'-apple-system,system-ui,sans-serif' }}>

            {/* Month header row — top */}
            {MONS.slice(0,-1).map((m, i) => {
              const x1 = txR(m.d), x2 = txR(MONS[i+1].d);
              return (
                <g key={m.n+'-'+i}>
                  <rect x={x1} y={0} width={x2-x1} height={HH*0.55} fill={i%2 ? '#17171F' : '#1C1C27'} />
                  <text x={(x1+x2)/2} y={HH*0.55/2+4} textAnchor="middle" fill="#9CA3AF" fontSize="12" fontWeight="500">{m.n} 2026</text>
                  <line x1={x1} y1={0} x2={x1} y2={totalH} stroke="#2A2A3A" strokeWidth={i===0?1:0.5} />
                </g>
              );
            })}

            {/* Week sub-header row — below month row */}
            {(() => {
              const rows = [];
              const weekRowY = HH * 0.55;
              const weekRowH = HH * 0.45;
              for (let i = 0; i < MONS.length - 1; i++) {
                const monStart = MONS[i].d;
                const monEnd   = MONS[i+1].d;
                const monSpan  = monEnd - monStart;
                const wSpan    = monSpan / 4;
                for (let w = 0; w < 4; w++) {
                  const wx  = txR(monStart + w * wSpan);
                  const wx2 = txR(monStart + (w+1) * wSpan);
                  rows.push(
                    <g key={`${i}-w${w}`}>
                      <rect x={wx} y={weekRowY} width={wx2-wx} height={weekRowH} fill={w%2 ? '#13131A' : '#17171F'} />
                      <text x={(wx+wx2)/2} y={weekRowY + weekRowH/2 + 4} textAnchor="middle" fill="#4B5563" fontSize="10" fontWeight="500">W{w+1}</text>
                      <line x1={wx} y1={weekRowY} x2={wx} y2={totalH} stroke="#2A2A3A" strokeWidth="0.4" opacity="0.7" />
                    </g>
                  );
                }
              }
              return rows;
            })()}

            {/* Header bottom border */}
            <line x1={0} y1={HH} x2={TD*dpx} y2={HH} stroke="#2A2A3A" strokeWidth="1" />

            {/* Weekly gridlines through chart body */}
            {Array.from({length:Math.floor(TD/7)},(_,i)=>(i+1)*7).map(d=>(
              <line key={d} x1={txR(d)} y1={HH} x2={txR(d)} y2={totalH} stroke="#2A2A3A" strokeWidth="0.4" opacity="0.5" />
            ))}

            {/* Period highlight band */}
            {zoomPeriod && (() => {
              const period = periods.find(p => p.key === zoomPeriod);
              if (!period) return null;
              const px1 = txR(period.startDay), px2 = txR(period.endDay + 1);
              return (
                <g>
                  <rect x={px1} y={0} width={px2-px1} height={totalH} fill="#F97316" opacity="0.04" />
                  <line x1={px1} y1={0} x2={px1} y2={totalH} stroke="#F97316" strokeWidth="1.5" opacity="0.4" strokeDasharray="4 3"/>
                  <line x1={px2} y1={0} x2={px2} y2={totalH} stroke="#F97316" strokeWidth="1.5" opacity="0.4" strokeDasharray="4 3"/>
                  <rect x={px1} y={2} width={px2-px1} height={20} rx="4" fill="#F97316" opacity="0.15" />
                  <text x={(px1+px2)/2} y={13} textAnchor="middle" fill="#F97316" fontSize="10" fontWeight="700" opacity="0.8">
                    {period.label}
                  </text>
                </g>
              );
            })()}

            {/* Today line */}
            <line x1={txR(todayDay)} y1={0} x2={txR(todayDay)} y2={totalH} stroke="#F97316" strokeWidth="1.5" strokeDasharray="4 3" opacity="0.8" />
            <rect x={txR(todayDay)-22} y={HH/2-10} width={44} height={19} rx="4" fill="#F97316" />
            <text x={txR(todayDay)} y={HH/2+0.5} textAnchor="middle" dominantBaseline="middle" fill="white" fontSize="9" fontWeight="700">Today</text>

            {/* Row backgrounds + bars */}
            {rowList.map(row => {
              if (row.kind === 'proj') {
                const { pd, y } = row;
                const { proj, pt, minSd, maxEd } = pd;
                const bx = txR(minSd), bw = (maxEd - minSd) * dpx;
                const midY = y + PRH / 2;
                const isExp = expanded.has(proj.id);
                return (
                  <g key={proj.id+'-r'}>
                    <rect x={0} y={y} width={TD*dpx} height={PRH} fill={proj.color+'15'} />
                    <rect x={bx+2} y={midY-11} width={bw} height={22} rx="11" fill={proj.color+'25'} />
                    <rect x={bx} y={midY-11} width={bw} height={22} rx="11" fill="none" stroke={proj.color} strokeWidth="2" />
                    {bw>80 && <text x={bx+bw/2} y={midY+1} textAnchor="middle" dominantBaseline="middle" fill={proj.color} fontSize="11" fontWeight="700" style={{pointerEvents:'none',userSelect:'none'}}>
                      {proj.id} · {pt.filter(t=>t.cd>0).length} tasks with duration
                    </text>}
                    <line x1={0} y1={y+PRH} x2={TD*dpx} y2={y+PRH} stroke={isExp?proj.color+'50':'#2A2A3A'} strokeWidth={isExp?1.5:1} />
                  </g>
                );
              }
              // ── Role row — collapsed shows mini task bars, expanded is just bg ──
              if (row.kind === 'role') {
                const { rg, y: ry2 } = row;
                const roleKey = `${row.pd.proj.id}-${rg.role.key}`;
                const isRExp = expanded.has(roleKey);
                const allTasks = rg.personRows.flatMap(r2 => r2.tasks);
                const rMid = ry2 + RRH / 2;
                // Mini bar height — fits inside RRH with padding
                const mbH = 20, mbY = rMid - mbH / 2;
                return (
                  <g key={roleKey+'-r'}>
                    <rect x={0} y={ry2} width={TD*dpx} height={RRH} fill={rg.role.color+'08'} />
                    {/* When collapsed: render every task as a small bar in this single row */}
                    {!isRExp && allTasks.filter(t => t.cd > 0).map(t => {
                      const tx2 = txR(t.sd), tw = Math.max(t.cd * dpx, 4);
                      const isHovT = hov === t.id;
                      return (
                        <g key={t.id} style={{ cursor:'pointer' }}
                          onMouseEnter={() => setHov(t.id)}
                          onMouseLeave={() => setHov(null)}
                          onClick={() => onEdit({ type:'task', id:t.id })}>
                          <rect x={tx2+1} y={mbY+1} width={tw} height={mbH} rx="3" fill="rgba(0,0,0,0.05)" />
                          <rect x={tx2} y={mbY} width={tw} height={mbH} rx="3"
                            fill={rg.role.color+'30'}
                            stroke={isHovT ? rg.role.color : rg.role.color+'70'}
                            strokeWidth={isHovT ? 1.5 : 1} />
                          {/* Left stripe per person for identity */}
                          <rect x={tx2+1} y={mbY+1} width={3} height={mbH-2} rx="2"
                            fill={rg.role.color} />
                          {t.isC && <circle cx={tx2+tw-5} cy={mbY+5} r={4} fill="#EF4444" />}

                          {/* Label only if wide enough */}
                          {tw > 60 && <text x={tx2+8} y={rMid+1} dominantBaseline="middle"
                            fill={rg.role.color} fontSize="8.5" fontWeight="600"
                            style={{ pointerEvents:'none', userSelect:'none' }}>
                            {t.name.length > Math.floor((tw-12)/5) ? t.name.slice(0, Math.floor((tw-12)/5))+'…' : t.name}
                          </text>}
                        </g>
                      );
                    })}
                    {/* When collapsed: milestones as diamonds */}
                    {!isRExp && allTasks.filter(t => t.cd === 0).map(t => (
                      <polygon key={t.id}
                        points={`${txR(t.sd)},${rMid-5} ${txR(t.sd)+5},${rMid} ${txR(t.sd)},${rMid+5} ${txR(t.sd)-5},${rMid}`}
                        fill={rg.role.color} opacity="0.7" />
                    ))}
                    <line x1={0} y1={ry2+RRH} x2={TD*dpx} y2={ry2+RRH}
                      stroke={isRExp ? rg.role.color+'40' : '#2A2A3A'}
                      strokeWidth={isRExp ? 1 : 1} />
                  </g>
                );
              }
              const { rg: prg, pd, pr, y } = row;
              const { proj } = pd;
              const { per, tasks: pTasks } = pr;
              const roleColor = per.color; // color by person (all same role)
              const by0 = y + (SRH-SBH)/2;
              const midY = y + SRH/2;
              return (
                <g key={`${proj.id}-${per.name}-bars`}>
                  <rect x={0} y={y} width={TD*dpx} height={SRH} fill="#13131A" />
                  <line x1={0} y1={y+SRH} x2={TD*dpx} y2={y+SRH} stroke="#2A2A3A" strokeWidth="1" />
                  {pTasks.map(t => {
                    const x = txR(t.sd), w = Math.max(t.cd*DPX, t.cd?4:0);
                    const ih = hov===t.id;
                    const dimmed = showDeps && hov && !hovRelated.has(t.id);
                    if (!t.cd) return (
                      <polygon key={t.id}
                        points={`${x},${midY-5} ${x+5},${midY} ${x},${midY+5} ${x-5},${midY}`}
                        fill={roleColor} opacity={dimmed?0.2:0.85}
                        style={{cursor:'pointer'}}
                        onMouseEnter={()=>setHov(t.id)} onMouseLeave={()=>setHov(null)}
                        onClick={()=>onEdit({ type:'task', id:t.id })} />
                    );

                    // ── Bar colour logic ───────────────────────────────────
                    const nowMs2 = todayMs || Date.now();
                    const effectiveStatus = computeStatus(t, statusOverrides, nowMs2);
                    const effectiveCompleted = effectiveStatus === 'Completed';

                    const barStroke = effectiveCompleted ? '#10B981'
                      : t.isOverdue  ? '#F59E0B'
                      : t.isDV       ? '#F59E0B'
                      : roleColor;
                    const barFill = effectiveCompleted ? '#10B98118'
                      : t.isOverdue  ? '#F59E0B18'
                      : t.isDV       ? '#FFF7ED'
                      : roleColor+'28';
                    const barDash = (t.isDV && !effectiveCompleted) ? '5 3' : 'none';
                    const labelColor = effectiveCompleted ? '#10B981' : t.isOverdue ? '#F59E0B' : roleColor;
                    const labelDecoration = effectiveCompleted ? 'line-through' : 'none';

                    // Badge position — clamped so it stays inside even tiny bars
                    // For bars < 16px wide, show a small dot on the left edge instead
                    const badgeCx = Math.min(x + 8, x + w - 5);
                    const badgeCy = by0 + 8;
                    const tinyBar = w < 16;

                    return (
                      <g key={t.id} style={{cursor:'pointer'}} opacity={effectiveCompleted ? 0.55 : dimmed ? 0.28 : 1}
                        onMouseEnter={()=>setHov(t.id)} onMouseLeave={()=>setHov(null)}
                        onClick={()=>onEdit({ type:'task', id:t.id })}>

                        <rect x={x+2} y={by0+2} width={w} height={SBH} rx="4" fill="rgba(0,0,0,0.06)" />
                        <rect x={x} y={by0} width={w} height={SBH} rx="4"
                          fill={barFill}
                          stroke={barStroke}
                          strokeWidth={ih ? 2 : 1.5}
                          strokeDasharray={barDash} />
                        <rect x={x+1.5} y={by0+1.5} width={5} height={SBH-3} rx="3" fill={barStroke} />
                        {t.delay>0 && !effectiveCompleted && w>10 && <rect x={x+w-7} y={by0} width={7} height={SBH} fill="#FCA5A5" opacity="0.75" rx="4" />}
                        {w>52 && <text x={x+12} y={by0+SBH/2} dominantBaseline="middle"
                          fill={labelColor} fontSize="10" fontWeight="600"
                          textDecoration={labelDecoration}
                          style={{pointerEvents:'none',userSelect:'none'}}>
                          {(()=>{const mc=Math.floor((w-18)/5.8);return t.name.length>mc?t.name.slice(0,mc)+'…':t.name;})()}
                        </text>}

                        {/* Badge — completed ✓ takes priority, then conflict, fragile, overdue, DV */}
                        {/* Tiny bars (<16px): coloured dot on left stripe instead of circle+text */}
                        {tinyBar ? (
                          /* Dot indicator on the left stripe for very narrow bars */
                          effectiveCompleted ? <circle cx={x+3} cy={by0+4} r={3} fill="#10B981" style={{pointerEvents:'none'}} /> :
                          !effectiveCompleted && t.isC ? <circle cx={x+3} cy={by0+4} r={3} fill="#EF4444" style={{pointerEvents:'none'}} /> :
                          !effectiveCompleted && t.isOverdue ? <circle cx={x+3} cy={by0+4} r={3} fill="#F59E0B" style={{pointerEvents:'none'}} /> :
                          null
                        ) : (
                          <>
                            {effectiveCompleted && <g style={{pointerEvents:'none'}}>
                              <circle cx={badgeCx} cy={badgeCy} r={7} fill="#10B981" />
                              <text x={badgeCx} y={badgeCy} textAnchor="middle" dominantBaseline="middle" fill="white" fontSize="9" fontWeight="800">✓</text>
                            </g>}
                            {!effectiveCompleted && t.isC && <g style={{pointerEvents:'none'}}>
                              <circle cx={badgeCx} cy={badgeCy} r={7} fill="#EF4444" />
                              <text x={badgeCx} y={badgeCy} textAnchor="middle" dominantBaseline="middle" fill="white" fontSize="8.5" fontWeight="800">!</text>
                            </g>}
                            {!effectiveCompleted && t.isOverdue && !t.isC && <g style={{pointerEvents:'none'}}>
                              <circle cx={badgeCx} cy={badgeCy} r={7} fill="#F59E0B" />
                              <text x={badgeCx} y={badgeCy} textAnchor="middle" dominantBaseline="middle" fill="white" fontSize="9" fontWeight="800">⚠</text>
                            </g>}
                            {!effectiveCompleted && t.isF && !t.isC && !t.isOverdue && <g style={{pointerEvents:'none'}}>
                              <circle cx={badgeCx} cy={badgeCy} r={7} fill="#F59E0B" />
                              <text x={badgeCx} y={badgeCy} textAnchor="middle" dominantBaseline="middle" fill="white" fontSize="11" fontWeight="800" dy="0.5">~</text>
                            </g>}
                            {!effectiveCompleted && t.isDV && !t.isC && !t.isF && !t.isOverdue && <g style={{pointerEvents:'none'}}>
                              <circle cx={badgeCx} cy={badgeCy} r={7} fill="#F59E0B" />
                              <text x={badgeCx} y={badgeCy} textAnchor="middle" dominantBaseline="middle" fill="white" fontSize="9" fontWeight="800">⊗</text>
                            </g>}
                          </>
                        )}

                        {/* Hover icons — pencil (edit) + checkmark (toggle complete) */}
                        {ih && w > 52 && <g>
                          <rect x={x+w-40} y={by0+SBH-15} width={16} height={13} rx="3" fill={barStroke} opacity="0.9" style={{pointerEvents:'none'}}/>
                          <text x={x+w-32} y={by0+SBH-9} textAnchor="middle" dominantBaseline="middle" fill="white" fontSize="9" fontWeight="700" style={{pointerEvents:'none'}}>✎</text>
                          <rect x={x+w-20} y={by0+SBH-15} width={16} height={13} rx="3"
                            fill={effectiveCompleted ? '#10B981' : '#374151'} opacity="0.95"
                            style={{cursor:'pointer'}}
                            onClick={e => { e.stopPropagation(); onToggleComplete(t.id); }} />
                          <text x={x+w-12} y={by0+SBH-9} textAnchor="middle" dominantBaseline="middle" fill="white" fontSize="9" fontWeight="800"
                            style={{pointerEvents:'none'}}>✓</text>
                        </g>}
                        {/* Narrow bar — only checkmark */}
                        {ih && w > 20 && w <= 52 && <g>
                          <rect x={x+w-20} y={by0+SBH-15} width={16} height={13} rx="3"
                            fill={effectiveCompleted ? '#10B981' : '#374151'} opacity="0.95"
                            style={{cursor:'pointer'}}
                            onClick={e => { e.stopPropagation(); onToggleComplete(t.id); }} />
                          <text x={x+w-12} y={by0+SBH-9} textAnchor="middle" dominantBaseline="middle" fill="white" fontSize="9" fontWeight="800"
                            style={{pointerEvents:'none'}}>✓</text>
                        </g>}
                      </g>
                    );
                  })}
                </g>
              );
            })}

            {/* Dep lines — elbow routing, last so they paint on top */}
            {showDeps && (
              <g style={{ pointerEvents:'none' }}>
                {depLines.map((line, i) => {
                  const { from, to, projId, taskId, depId, type: depType } = line;
                  const pc = projs.find(p => p.id === projId)?.color || '#888';
                  const isHov = hov && (hovRelated.has(taskId) || hovRelated.has(depId));
                  const opacity = hov ? (isHov ? 1 : 0.07) : 0.4;
                  const sw = isHov ? 2.5 : 1.5;
                  const r = 4;
                  const isFS = depType !== 'SS';

                  // FS: exits right edge of dep, enters left edge of target
                  // SS: exits left edge of dep, enters left edge of target
                  const x1 = isFS ? from.xe : from.xs;
                  const y1 = from.yc;
                  const x4 = to.xs;
                  const y4 = to.yc;

                  const gap      = x4 - x1;
                  const rowDiff  = y4 - y1;
                  const sameRow  = Math.abs(rowDiff) < 4;
                  const goDown   = rowDiff > 0;

                  let pathD;

                  if (!isFS) {
                    // ── SS routing: left exit → left entry ────────────────────
                    // Exit left from source, loop above/below, enter left of target
                    const loopX = Math.min(x1, x4) - 16;
                    if (sameRow) {
                      // Same row: loop above
                      const archY = y1 - SBH * 0.9;
                      pathD = [
                        `M ${x1} ${y1}`,
                        `L ${x1 - r} ${y1}`,
                        `Q ${loopX} ${y1} ${loopX} ${y1 - r}`,
                        `L ${loopX} ${archY + r}`,
                        `Q ${loopX} ${archY} ${loopX + r} ${archY}`,
                        `L ${x4 - r} ${archY}`,
                        `Q ${x4} ${archY} ${x4} ${archY + r}`,
                        `L ${x4} ${y4}`,
                      ].join(' ');
                    } else {
                      // Different rows: go left to loopX, then down/up, then right to target
                      const xMid = loopX;
                      pathD = [
                        `M ${x1} ${y1}`,
                        `L ${xMid + r} ${y1}`,
                        `Q ${xMid} ${y1} ${xMid} ${y1 + (goDown ? r : -r)}`,
                        `L ${xMid} ${y4 + (goDown ? -r : r)}`,
                        `Q ${xMid} ${y4} ${xMid + r} ${y4}`,
                        `L ${x4} ${y4}`,
                      ].join(' ');
                    }
                  } else if (sameRow && gap > 0) {
                    // ── FS, same row, forward: arch above ─────────────────────
                    const archY = y1 - SBH * 0.9;
                    pathD = [
                      `M ${x1} ${y1}`,
                      `L ${x1} ${archY + r}`,
                      `Q ${x1} ${archY} ${x1 + r} ${archY}`,
                      `L ${x4 - r} ${archY}`,
                      `Q ${x4} ${archY} ${x4} ${archY + r}`,
                      `L ${x4} ${y4}`,
                    ].join(' ');
                  } else if (sameRow && gap <= 0) {
                    // ── FS, same row, backward: loop below ────────────────────
                    const loopY  = y1 + SBH * 0.9;
                    const loopX  = Math.min(x1, x4) - 16;
                    pathD = [
                      `M ${x1} ${y1}`,
                      `L ${x1 + 10} ${y1}`,
                      `Q ${x1 + 10 + r} ${y1} ${x1 + 10 + r} ${y1 + r}`,
                      `L ${x1 + 10 + r} ${loopY - r}`,
                      `Q ${x1 + 10 + r} ${loopY} ${x1 + 10} ${loopY}`,
                      `L ${loopX + r} ${loopY}`,
                      `Q ${loopX} ${loopY} ${loopX} ${loopY - r}`,
                      `L ${loopX} ${y4 + r}`,
                      `Q ${loopX} ${y4} ${loopX + r} ${y4}`,
                      `L ${x4} ${y4}`,
                    ].join(' ');
                  } else if (gap >= r * 2) {
                    // ── FS, forward, different rows: standard elbow ───────────
                    const xMid = x1 + Math.max(gap / 2, r + 2);
                    pathD = [
                      `M ${x1} ${y1}`,
                      `L ${xMid - r} ${y1}`,
                      `Q ${xMid} ${y1} ${xMid} ${y1 + (goDown ? r : -r)}`,
                      `L ${xMid} ${y4 + (goDown ? -r : r)}`,
                      `Q ${xMid} ${y4} ${xMid + r} ${y4}`,
                      `L ${x4} ${y4}`,
                    ].join(' ');
                  } else {
                    // ── FS, backward / overlap ────────────────────────────────
                    const stub   = 10;
                    const loopX  = Math.min(x1, x4) - 16;
                    const midY   = y1 + rowDiff / 2;
                    pathD = [
                      `M ${x1} ${y1}`,
                      `L ${x1 + stub} ${y1}`,
                      `Q ${x1 + stub + r} ${y1} ${x1 + stub + r} ${y1 + (goDown ? r : -r)}`,
                      `L ${x1 + stub + r} ${midY + (goDown ? -r : r)}`,
                      `Q ${x1 + stub + r} ${midY} ${x1 + stub} ${midY}`,
                      `L ${loopX + r} ${midY}`,
                      `Q ${loopX} ${midY} ${loopX} ${midY + (goDown ? r : -r)}`,
                      `L ${loopX} ${y4 + (goDown ? -r : r)}`,
                      `Q ${loopX} ${y4} ${loopX + r} ${y4}`,
                      `L ${x4} ${y4}`,
                    ].join(' ');
                  }

                  // Arrowhead always points right into target left edge
                  const ax = x4, ay = y4;
                  const arrowPts = `${ax},${ay} ${ax-7},${ay-3.5} ${ax-7},${ay+3.5}`;

                  // Type label at midpoint of path (rough midpoint)
                  const labelX = (x1 + x4) / 2;
                  const labelY = sameRow ? (y1 - SBH * 0.9) : (y1 + rowDiff / 2);

                  return (
                    <g key={i} opacity={opacity}>
                      <path d={pathD} fill="none" stroke={pc} strokeWidth={sw}
                        strokeLinecap="round" strokeLinejoin="round"
                        strokeDasharray={depType === 'SS' ? '5 3' : 'none'} />
                      <polygon points={arrowPts} fill={pc} />
                      {/* Type label — only show when hovered or always if zoomed in */}
                      {(isHov || dpx >= 20) && (
                        <g>
                          <rect x={labelX - 9} y={labelY - 7} width={18} height={13} rx="3"
                            fill={pc} opacity="0.9" />
                          <text x={labelX} y={labelY + 0.5} textAnchor="middle" dominantBaseline="middle"
                            fill="white" fontSize="8" fontWeight="800" style={{ pointerEvents:'none' }}>
                            {depType || 'FS'}
                          </text>
                        </g>
                      )}
                    </g>
                  );
                })}
              </g>
            )}
          </svg>
        </div>

        {/* Tooltip */}
        {ht && (() => {
          const pc = projs.find(p => p.id === ht.projId)?.color || '#888';
          const htPer = people.find(p => p.name === ht.person);
          const cNames = ht.cw.map(id => { const c = tasks.find(x => x.id === id); return c ? `${c.id} (${c.person})` : id; });
          const depIds = tdepMap[ht.id] || [];
          const depNames = depIds.map(did => { const dt = tasks.find(x => x.id === did); return dt ? `${did} – ${dt.name}` : did; });
          const ttx = Math.min(mouse.x + 14, (outerRef.current?.clientWidth || 800) - 240);
          const tty = Math.max(mouse.y - 130, 52);
          const nowMs = (() => { const d = new Date(); d.setHours(0,0,0,0); return d.getTime(); })();
          const ttStatus =
            ht.isCompleted          ? 'Completed'  :
            ht.isOverdue            ? 'Overdue'    :
            ht.isC                  ? 'Conflict'   :
            ht.isF                  ? 'Fragile'    :
            ht.s.getTime() <= nowMs ? 'In Progress':
                                      'On Track';
          const ttStatusColor = {
            'Completed':'#34D399','Overdue':'#FB923C','Conflict':'#F87171',
            'Fragile':'#FBBF24','In Progress':'#38BDF8','On Track':'#4ADE80'
          }[ttStatus];
          return (
            <div style={{ position:'absolute', left:ttx, top:tty, pointerEvents:'none', background:'#0F172A', color:'white', padding:'12px 14px', borderRadius:'10px', fontSize:'12px', lineHeight:'1.65', boxShadow:'0 10px 30px rgba(0,0,0,0.3)', width:'228px', zIndex:50, borderTop:`3px solid ${pc}` }}>
              <div style={{ display:'flex', alignItems:'flex-start', justifyContent:'space-between', marginBottom:'5px' }}>
                <div style={{ fontWeight:'700', fontSize:'12px', lineHeight:'1.35', flex:1, marginRight:'8px' }}>{ht.name}</div>
                <span style={{ fontSize:'10px', fontWeight:'700', color:ttStatusColor, whiteSpace:'nowrap', background:ttStatusColor+'18', padding:'2px 7px', borderRadius:'10px', border:`1px solid ${ttStatusColor}40` }}>{ttStatus}</span>
              </div>
              <div style={{ color:'#64748B', fontSize:'10px', marginBottom:'8px' }}>{ht.projId} · {ht.id} · {ht.person}</div>
              <div style={{ display:'grid', gridTemplateColumns:'60px 1fr', gap:'3px 8px', fontSize:'11px' }}>
                <span style={{ color:'#475569' }}>Role</span>
                <span style={{ color:htPer?.color||'#888', fontWeight:'600', fontSize:'10px' }}>{htPer?.role || '—'}</span>
                <span style={{ color:'#475569' }}>Start</span><span>{fd(ht.s)}</span>
                <span style={{ color:'#475569' }}>End</span><span>{fd(ht.e)}</span>
                <span style={{ color:'#475569' }}>Duration</span>
                <span>{ht.dur} working day{ht.dur !== 1 ? 's' : ''}{ht.delay ? ` (+${ht.delay}d delay)` : ''}</span>
              </div>
              {depNames.length > 0 && (
                <div style={{ marginTop:'8px', padding:'5px 8px', background:'rgba(255,255,255,0.06)', borderRadius:'4px', border:'1px solid rgba(255,255,255,0.1)' }}>
                  <div style={{ fontSize:'9px', letterSpacing:'0.08em', textTransform:'uppercase', color:'#475569', marginBottom:'3px', fontWeight:'700' }}>Depends on</div>
                  {depNames.map((n, i) => (
                    <div key={i} style={{ fontSize:'10px', color:'#94A3B8', display:'flex', alignItems:'center', gap:'5px' }}>
                      <span style={{ color:pc }}>→</span> {n}
                    </div>
                  ))}
                </div>
              )}
              {ht.isCompleted && <div style={{ marginTop:'8px', padding:'4px 8px', background:'rgba(52,211,153,0.15)', borderRadius:'4px', color:'#34D399', fontSize:'10px', fontWeight:'700', border:'1px solid rgba(52,211,153,0.3)' }}>
                ✓ COMPLETED · Click ✓ on bar to undo
              </div>}
              {ht.isOverdue && !ht.isCompleted && <div style={{ marginTop:'8px', padding:'4px 8px', background:'rgba(251,146,60,0.15)', borderRadius:'4px', color:'#FB923C', fontSize:'10px', fontWeight:'700', border:'1px solid rgba(251,146,60,0.3)' }}>
                ⚠ OVERDUE — end date has passed
              </div>}
              {ht.isC && !ht.isOverdue && <div style={{ marginTop:'8px', padding:'4px 8px', background:'rgba(239,68,68,0.18)', borderRadius:'4px', color:'#FCA5A5', fontSize:'10px', fontWeight:'700', border:'1px solid rgba(239,68,68,0.3)' }}>
                ⚠ CONFLICT — clashes with {cNames[0] || '?'} · Click to edit
              </div>}
              {ht.isF && !ht.isC && !ht.isOverdue && <div style={{ marginTop:'8px', padding:'4px 8px', background:'rgba(245,158,11,0.15)', borderRadius:'4px', color:'#FDE68A', fontSize:'10px', fontWeight:'700', border:'1px solid rgba(245,158,11,0.3)' }}>
                ⚡ FRAGILE — ≤1 working day gap to adjacent task
              </div>}
              {ht.isDV && <div style={{ marginTop:'8px', padding:'4px 8px', background:'rgba(245,158,11,0.18)', borderRadius:'4px', color:'#FDE68A', fontSize:'10px', fontWeight:'700', border:'1px solid rgba(245,158,11,0.35)', borderStyle:'dashed' }}>
                ⊗ DEP. VIOLATION — starts before prerequisite finishes
              </div>}
              <div style={{ marginTop:'6px', fontSize:'10px', color:'#475569', fontStyle:'italic' }}>Click to open editor</div>
            </div>
          );
        })()}
      </div>
    </div>
  );
}


// ── Project View tab — Excel-style filterable table ──────────────────────────
function ProjectViewTab({ tasks, onDelete, onEdit, onToggleComplete, statusOverrides, onSetStatus, todayMs }) {
  const { rawTasks, projs, people, tdepMap, base, todayDay, periods } = useSched();

  const [sortCol,      setSortCol]      = useState('projId');
  const [sortDir,      setSortDir]      = useState('asc');
  const [showCompleted,setShowCompleted]= useState(true);
  const [filters,      setFilters]      = useState({});
  const [openFilter,   setOpenFilter]   = useState(null);
  const [filterSearch, setFilterSearch] = useState('');
  const filterRef = useRef(null);

  const CARD   = '#1C1C27';
  const BORDER = '#2A2A3A';
  const ORANGE = '#F97316';
  const TEXT   = '#E8E8F0';
  const MUTED  = '#6B7280';
  const BG     = '#13131A';

  const nowMs = todayMs || (() => { const d = new Date(); d.setHours(0,0,0,0); return d.getTime(); })();

  const COLS = [
    { key:'projId',  label:'Project',   filterable:true  },
    { key:'id',      label:'Task ID',   filterable:false },
    { key:'name',    label:'Task Name', filterable:true  },
    { key:'person',  label:'Assigned',  filterable:true  },
    { key:'role',    label:'Role',      filterable:true  },
    { key:'rate',    label:'Rate',      filterable:true  },
    { key:'start',   label:'Start',     filterable:true  },
    { key:'end',     label:'End',       filterable:true  },
    { key:'status',  label:'Status',    filterable:true  },
    { key:'actions', label:'',          filterable:false },
  ];

  // ── Build rows with status ──────────────────────────────────────────────────
  const rows = useMemo(() => {
    return tasks
      .filter(t => showCompleted || !t.isCompleted)
      .map(t => {
        const per = people.find(p => p.name === t.person);
        const status = computeStatus(t, statusOverrides, nowMs);
        return { ...t, role:per?.role||'', rate:per?.rate||'—', start:fd(t.s), end:fd(t.e), status };
      });
  }, [tasks, showCompleted, statusOverrides, nowMs]);

  // ── Unique values per filterable column (from full rows, before filtering) ──
  const colValues = useMemo(() => {
    const cv = {};
    for (const col of COLS.filter(c => c.filterable)) {
      const vals = [...new Set(rows.map(r => String(r[col.key] ?? '')))].sort();
      cv[col.key] = vals;
    }
    return cv;
  }, [rows]);

  // ── Apply column filters ────────────────────────────────────────────────────
  const filtered = useMemo(() => {
    return rows.filter(r => {
      for (const [key, allowed] of Object.entries(filters)) {
        if (!allowed || allowed.size === 0) continue;
        if (!allowed.has(String(r[key] ?? ''))) return false;
      }
      return true;
    });
  }, [rows, filters]);

  // ── Sort ────────────────────────────────────────────────────────────────────
  const sorted = useMemo(() => [...filtered].sort((a, b) => {
    let va = a[sortCol], vb = b[sortCol];
    if (sortCol==='start') { va=a.s; vb=b.s; }
    if (sortCol==='end')   { va=a.e; vb=b.e; }
    if (va < vb) return sortDir==='asc' ? -1 : 1;
    if (va > vb) return sortDir==='asc' ?  1 : -1;
    return 0;
  }), [filtered, sortCol, sortDir]);

  const handleSort = col => {
    if (sortCol === col) setSortDir(d => d==='asc'?'desc':'asc');
    else { setSortCol(col); setSortDir('asc'); }
  };

  // ── Filter helpers ──────────────────────────────────────────────────────────
  const toggleFilterVal = (colKey, val) => {
    setFilters(prev => {
      const existing = prev[colKey] ? new Set(prev[colKey]) : new Set(colValues[colKey]);
      existing.has(val) ? existing.delete(val) : existing.add(val);
      // If all values selected, remove the filter entirely (same as no filter)
      if (existing.size === colValues[colKey]?.length) {
        const next = { ...prev }; delete next[colKey]; return next;
      }
      return { ...prev, [colKey]: existing };
    });
  };

  const selectAll = colKey => {
    setFilters(prev => { const next = { ...prev }; delete next[colKey]; return next; });
  };

  const clearAll = colKey => {
    setFilters(prev => ({ ...prev, [colKey]: new Set() }));
  };

  const isFiltered = colKey => filters[colKey] && filters[colKey].size < (colValues[colKey]?.length ?? 0);
  const activeFilterCount = Object.keys(filters).filter(k => isFiltered(k)).length;

  // ── Close dropdown on outside click ────────────────────────────────────────
  useEffect(() => {
    const handler = e => {
      if (filterRef.current && !filterRef.current.contains(e.target))
        setOpenFilter(null);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const SS = STATUS_STYLES;

  return (
    <div style={{ fontFamily:'-apple-system,system-ui,sans-serif', position:'relative' }} ref={filterRef}>
      {/* Toolbar */}
      <div style={{ display:'flex', alignItems:'center', padding:'0', borderBottom:`1px solid ${BORDER}`, background:CARD }}>
        {/* Completed toggle */}
        <div style={{ display:'flex', alignItems:'center', gap:'8px', padding:'0 14px', height:'48px', borderRight:`1px solid ${BORDER}`, cursor:'pointer' }}
          onClick={() => setShowCompleted(v => !v)}>
          <span style={{ fontSize:'13px', fontWeight:'500', color:TEXT }}>Completed</span>
          <div style={{ width:'36px', height:'20px', borderRadius:'10px', background: showCompleted ? '#10B981' : '#374151', position:'relative', transition:'background 0.2s', flexShrink:0 }}>
            <div style={{ position:'absolute', top:'3px', left: showCompleted ? '18px' : '3px', width:'14px', height:'14px', borderRadius:'50%', background:'white', transition:'left 0.2s' }} />
          </div>
        </div>

        {/* Clear all filters */}
        {activeFilterCount > 0 && (
          <button onClick={() => setFilters({})}
            style={{ display:'flex', alignItems:'center', gap:'6px', padding:'0 14px', height:'48px', border:'none', background:'none', cursor:'pointer', fontSize:'12px', color:ORANGE, fontWeight:'600', borderRight:`1px solid ${BORDER}` }}>
            ✕ Clear {activeFilterCount} filter{activeFilterCount>1?'s':''}
          </button>
        )}

        {/* Row count */}
        <span style={{ padding:'0 14px', fontSize:'12px', color:MUTED }}>
          {sorted.length} of {rows.length} row{rows.length!==1?'s':''}
        </span>
      </div>

      {/* Table */}
      <div style={{ overflowX:'auto', overflowY:'auto', maxHeight:'calc(100vh - 310px)' }}>
        <table style={{ borderCollapse:'collapse', width:'100%', fontSize:'13px' }}>
          <thead style={{ position:'sticky', top:0, zIndex:10 }}>
            <tr style={{ background:'#0A0A0F', borderBottom:`2px solid ${BORDER}` }}>
              {COLS.map(col => {
                const active = isFiltered(col.key);
                const isOpen = openFilter === col.key;
                const vals   = colValues[col.key] || [];
                const chosen = filters[col.key] || new Set(vals);
                const fSearch = openFilter === col.key ? filterSearch : '';
                const visibleVals = vals.filter(v => v.toLowerCase().includes(fSearch.toLowerCase()));

                return (
                  <th key={col.key}
                    style={{ padding:'0', textAlign:'left', fontWeight:'500', borderRight:`1px solid ${BORDER}`, userSelect:'none', position:'relative', whiteSpace:'nowrap' }}>
                    <div style={{ display:'flex', alignItems:'center', minHeight:'44px' }}>
                      {/* Sort area */}
                      <div onClick={() => col.key !== 'actions' && handleSort(col.key)}
                        style={{ flex:1, padding:'0 12px', height:'44px', display:'flex', alignItems:'center', gap:'5px',
                          cursor: col.key === 'actions' ? 'default' : 'pointer',
                          color: sortCol===col.key ? ORANGE : MUTED, fontSize:'12px' }}>
                        {col.label}
                        {sortCol===col.key && <span style={{ fontSize:'10px' }}>{sortDir==='asc'?'▲':'▼'}</span>}
                        {active && <div style={{ width:'6px', height:'6px', borderRadius:'50%', background:ORANGE, flexShrink:0 }} />}
                      </div>

                      {/* Filter button */}
                      {col.filterable && (
                        <button
                          onClick={e => { e.stopPropagation(); setOpenFilter(isOpen ? null : col.key); setFilterSearch(''); }}
                          style={{ width:'28px', height:'44px', border:'none', background: active ? ORANGE+'18' : 'transparent',
                            cursor:'pointer', color: active ? ORANGE : MUTED, fontSize:'11px', flexShrink:0,
                            borderLeft:`1px solid ${BORDER}`, display:'flex', alignItems:'center', justifyContent:'center' }}>
                          ▾
                        </button>
                      )}
                    </div>

                    {/* Dropdown */}
                    {col.filterable && isOpen && (
                      <div style={{ position:'absolute', top:'100%', left:0, zIndex:100, background:'#1C1C27',
                        border:`1px solid ${BORDER}`, borderRadius:'8px', boxShadow:'0 8px 24px rgba(0,0,0,0.6)',
                        minWidth:'200px', maxWidth:'280px', overflow:'hidden' }}
                        onClick={e => e.stopPropagation()}>

                        {/* Search */}
                        <div style={{ padding:'8px', borderBottom:`1px solid ${BORDER}` }}>
                          <input value={filterSearch} onChange={e => setFilterSearch(e.target.value)}
                            placeholder="Search..."
                            style={{ width:'100%', padding:'5px 8px', borderRadius:'6px', border:`1px solid ${BORDER}`,
                              background:'#0A0A0F', color:TEXT, fontSize:'12px', outline:'none', boxSizing:'border-box' }} />
                        </div>

                        {/* Select all / Clear */}
                        <div style={{ display:'flex', gap:'0', borderBottom:`1px solid ${BORDER}` }}>
                          <button onClick={() => selectAll(col.key)}
                            style={{ flex:1, padding:'6px 10px', border:'none', background:'transparent', color:'#38BDF8',
                              fontSize:'11px', cursor:'pointer', fontWeight:'600', borderRight:`1px solid ${BORDER}` }}>
                            Select All
                          </button>
                          <button onClick={() => clearAll(col.key)}
                            style={{ flex:1, padding:'6px 10px', border:'none', background:'transparent', color:MUTED,
                              fontSize:'11px', cursor:'pointer', fontWeight:'500' }}>
                            Clear
                          </button>
                        </div>

                        {/* Value list */}
                        <div style={{ maxHeight:'220px', overflowY:'auto' }}>
                          {visibleVals.length === 0 && (
                            <div style={{ padding:'12px', fontSize:'11px', color:MUTED, textAlign:'center' }}>No matches</div>
                          )}
                          {visibleVals.map(val => {
                            const checked = chosen.has(val);
                            const ss = col.key === 'status' ? SS[val] : null;
                            return (
                              <div key={val} onClick={() => toggleFilterVal(col.key, val)}
                                style={{ display:'flex', alignItems:'center', gap:'10px', padding:'8px 12px',
                                  cursor:'pointer', borderBottom:`1px solid ${BORDER}20` }}
                                onMouseEnter={e => e.currentTarget.style.background='#2A2A3A'}
                                onMouseLeave={e => e.currentTarget.style.background='transparent'}>
                                {/* Checkbox */}
                                <div style={{ width:'14px', height:'14px', borderRadius:'3px', flexShrink:0,
                                  border:`1.5px solid ${checked ? ORANGE : BORDER}`,
                                  background: checked ? ORANGE : 'transparent',
                                  display:'flex', alignItems:'center', justifyContent:'center' }}>
                                  {checked && <span style={{ color:'white', fontSize:'9px', fontWeight:'800', lineHeight:1 }}>✓</span>}
                                </div>
                                {/* Value — status gets colour pill, project gets dot */}
                                {ss ? (
                                  <span style={{ background:ss.bg, color:ss.tx, border:`1px solid ${ss.bd}`,
                                    padding:'2px 8px', borderRadius:'10px', fontSize:'11px', fontWeight:'600' }}>
                                    {val}
                                  </span>
                                ) : col.key === 'projId' ? (
                                  <div style={{ display:'flex', alignItems:'center', gap:'6px' }}>
                                    <div style={{ width:'8px', height:'8px', borderRadius:'50%', background: projs.find(p=>p.id===val)?.color || MUTED, flexShrink:0 }} />
                                    <span style={{ fontSize:'12px', color:TEXT }}>{val}</span>
                                  </div>
                                ) : (
                                  <span style={{ fontSize:'12px', color:TEXT }}>{val || '—'}</span>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {sorted.length === 0 && (
              <tr><td colSpan={COLS.length} style={{ padding:'48px', textAlign:'center', color:MUTED, fontSize:'13px' }}>
                No rows match the current filters. <button onClick={() => setFilters({})} style={{ color:ORANGE, background:'none', border:'none', cursor:'pointer', fontSize:'13px', fontWeight:'600' }}>Clear filters</button>
              </td></tr>
            )}
            {sorted.map((r, ri) => {
              const proj  = projs.find(p => p.id === r.projId);
              const ss    = SS[r.status] || SS['On Track'];
              const baseBg = ri%2===0 ? '#13131A' : '#0F0F18';
              return (
                <tr key={r.id} style={{ background:baseBg, borderBottom:`1px solid ${BORDER}` }}
                  onMouseEnter={e=>e.currentTarget.style.background='#1E2535'}
                  onMouseLeave={e=>e.currentTarget.style.background=baseBg}>
                  <td style={{ padding:'10px 16px', borderRight:`1px solid ${BORDER}` }}>
                    <div style={{ display:'flex', alignItems:'center', gap:'6px' }}>
                      <div style={{ width:'8px', height:'8px', borderRadius:'50%', background:proj?.color, flexShrink:0 }} />
                      <span style={{ fontWeight:'700', color:proj?.color, fontSize:'13px' }}>{r.projId}</span>
                    </div>
                  </td>
                  <td style={{ padding:'10px 16px', borderRight:`1px solid ${BORDER}` }}>
                    <span style={{ fontWeight:'600', color:proj?.color, fontSize:'13px' }}>{r.id.split('-')[1]}</span>
                  </td>
                  <td style={{ padding:'10px 16px', borderRight:`1px solid ${BORDER}`, color:TEXT, maxWidth:'280px', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{r.name}</td>
                  <td style={{ padding:'10px 16px', borderRight:`1px solid ${BORDER}`, color:TEXT }}>{r.person}</td>
                  <td style={{ padding:'10px 16px', borderRight:`1px solid ${BORDER}`, color:MUTED, whiteSpace:'nowrap' }}>{r.role}</td>
                  <td style={{ padding:'10px 16px', borderRight:`1px solid ${BORDER}`, color:MUTED, fontVariantNumeric:'tabular-nums' }}>{r.rate}</td>
                  <td style={{ padding:'10px 16px', borderRight:`1px solid ${BORDER}`, color:TEXT, whiteSpace:'nowrap', fontVariantNumeric:'tabular-nums' }}>{r.start}</td>
                  <td style={{ padding:'10px 16px', borderRight:`1px solid ${BORDER}`, color:TEXT, whiteSpace:'nowrap', fontVariantNumeric:'tabular-nums' }}>{r.end}</td>
                  <td style={{ padding:'10px 16px', borderRight:`1px solid ${BORDER}` }}>
                    <span style={{ background:ss.bg, color:ss.tx, border:`1px solid ${ss.bd}`, padding:'3px 11px', borderRadius:'20px', fontSize:'11px', fontWeight:'600', whiteSpace:'nowrap' }}>
                      {r.status}
                    </span>
                  </td>
                  <td style={{ padding:'6px 10px', width:'96px' }}>
                    <div style={{ display:'flex', gap:'4px', opacity:0, transition:'opacity 0.1s' }}
                      ref={el => { if (el) { const row = el.closest('tr'); row.onmouseenter = () => el.style.opacity='1'; row.onmouseleave = () => el.style.opacity='0'; } }}>
                      <button title={r.isCompleted ? 'Mark incomplete' : 'Mark complete'}
                        onClick={() => onToggleComplete && onToggleComplete(r.id)}
                        style={{ width:'26px', height:'26px', borderRadius:'6px', border:`1px solid ${r.isCompleted ? '#065F46' : BORDER}`, background: r.isCompleted ? '#0D2B1E' : 'transparent', cursor:'pointer', color: r.isCompleted ? '#34D399' : '#9CA3AF', fontSize:'13px', display:'flex', alignItems:'center', justifyContent:'center' }}
                        onMouseEnter={e=>e.currentTarget.style.color='#34D399'}
                        onMouseLeave={e=>e.currentTarget.style.color= r.isCompleted ? '#34D399' : '#9CA3AF'}>✓</button>
                      <button title="Edit timeline" onClick={() => onEdit && onEdit({ type:'task', id:r.id })}
                        style={{ width:'26px', height:'26px', borderRadius:'6px', border:`1px solid ${BORDER}`, background:'transparent', cursor:'pointer', color:'#9CA3AF', fontSize:'13px', display:'flex', alignItems:'center', justifyContent:'center' }}
                        onMouseEnter={e=>e.currentTarget.style.color=ORANGE}
                        onMouseLeave={e=>e.currentTarget.style.color='#9CA3AF'}>✎</button>
                      <button title="Delete task" onClick={() => onDelete && onDelete({ type:'deleteTask', taskId:r.id })}
                        style={{ width:'26px', height:'26px', borderRadius:'6px', border:`1px solid ${BORDER}`, background:'transparent', cursor:'pointer', color:'#9CA3AF', fontSize:'13px', display:'flex', alignItems:'center', justifyContent:'center' }}
                        onMouseEnter={e=>e.currentTarget.style.color='#EF4444'}
                        onMouseLeave={e=>e.currentTarget.style.color='#9CA3AF'}>🗑</button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}


// ── saveSchedEdits / loadSchedEdits ──────────────────────────────────────────
// Persists manual additions (new projects/tasks) as a JSON patch on top of the
// imported xlsx. Stored separately so Clear Data wipes both.
const LS_EDITS_KEY = 'interscale_edits';
function saveSchedEdits(edits) {
  try { localStorage.setItem(LS_EDITS_KEY, JSON.stringify(edits)); } catch(e) {}
}
function loadSchedEdits() {
  try { const s = localStorage.getItem(LS_EDITS_KEY); return s ? JSON.parse(s) : null; } catch(e) { return null; }
}

// ── applyEditsToData ──────────────────────────────────────────────────────────
// Merges saved edits into a parsed schedData object.
// edits shape: { rawTasks, projs, people, deletedIds: Set<string>, deletedProjs: Set<string> }
function applyEditsToData(base, edits) {
  if (!edits) return base;

  const deletedIds   = new Set(edits.deletedIds   || []);
  const deletedProjs = new Set(edits.deletedProjs  || []);

  // Merge added tasks, then filter out deleted ones
  let rawTasks = [
    ...base.rawTasks,
    ...(edits.rawTasks || []),
  ].filter(t => !deletedIds.has(t.id) && !deletedProjs.has(t.proj));

  // Merge projects, filter deleted
  let projs = [
    ...base.projs,
    ...(edits.projs || []).filter(p => !base.projs.find(x => x.id === p.id)),
  ].filter(p => !deletedProjs.has(p.id));

  // Merge people
  let people = [
    ...base.people,
    ...(edits.people || []).filter(p => !base.people.find(x => x.name === p.name)),
  ];

  // Prune people who have no remaining tasks
  const activePeople = new Set(rawTasks.map(t => t.person));
  people = people.filter(p => activePeople.has(p.name));

  const tdepMap = Object.fromEntries(rawTasks.map(t => [t.id, t.deps]));

  // Apply dep overrides — overlay typed deps on top of xlsx deps
  const depOverrides = loadDepOverrides();
  for (const [taskId, typedDeps] of depOverrides.entries()) {
    if (rawTasks.find(t => t.id === taskId)) {
      tdepMap[taskId] = typedDeps; // fully replaces deps for this task
    }
  }

  return { ...base, rawTasks, projs, people, tdepMap };
}

// ── mutateSchedData ───────────────────────────────────────────────────────────
// Produces a new edits object with the requested mutation applied, then
// saves it and returns the updated schedData.
function mutateSchedData(baseData, currentEdits, mutation) {
  const edits = {
    rawTasks:    [...(currentEdits?.rawTasks    || [])],
    projs:       [...(currentEdits?.projs       || [])],
    people:      [...(currentEdits?.people      || [])],
    deletedIds:  [...(currentEdits?.deletedIds  || [])],
    deletedProjs:[...(currentEdits?.deletedProjs|| [])],
  };

  if (mutation.type === 'deleteTask') {
    if (!edits.deletedIds.includes(mutation.taskId))
      edits.deletedIds.push(mutation.taskId);
    // Also remove from added tasks list if it was manually added
    edits.rawTasks = edits.rawTasks.filter(t => t.id !== mutation.taskId);
  }

  if (mutation.type === 'deleteProject') {
    if (!edits.deletedProjs.includes(mutation.projId))
      edits.deletedProjs.push(mutation.projId);
    // Remove any manually added tasks for this project too
    edits.rawTasks = edits.rawTasks.filter(t => t.proj !== mutation.projId);
    edits.projs    = edits.projs.filter(p => p.id !== mutation.projId);
  }

  if (mutation.type === 'addTasks') {
    edits.rawTasks.push(...mutation.tasks);
    // Add any new people
    for (const p of (mutation.people || [])) {
      if (!edits.people.find(x => x.name === p.name)) edits.people.push(p);
    }
  }

  if (mutation.type === 'shiftTimeline') {
    // Shift start/end dates of specified task IDs by N working days.
    // taskIds: array of rawTask IDs to shift directly.
    // We store overrides in edits.rawTasks — replacing any existing override for that task.
    const { taskIds, days } = mutation;
    const allRaw = [
      ...baseData.rawTasks,
      ...(edits.rawTasks || []),
    ];
    // Build a map of the most up-to-date raw task for each id
    const rawMap = {};
    for (const t of allRaw) rawMap[t.id] = t;

    for (const id of taskIds) {
      const t = rawMap[id];
      if (!t) continue;
      const sDate = parseDate(t.start);
      const eDate = parseDate(t.end);
      if (!sDate || !eDate) continue;
      const newStart = addW(sDate, days);
      const newEnd   = addW(eDate, days);
      const shifted = { ...t, start: fmtDDMMYYYY(newStart), end: fmtDDMMYYYY(newEnd) };
      // Replace or add in edits.rawTasks
      const idx = edits.rawTasks.findIndex(x => x.id === id);
      if (idx >= 0) edits.rawTasks[idx] = shifted;
      else edits.rawTasks.push(shifted);
      // Also remove from deletedIds if somehow present
      edits.deletedIds = edits.deletedIds.filter(x => x !== id);
    }
  }

  saveSchedEdits(edits);
  return applyEditsToData(baseData, edits);
}

// ── WorkflowsTab ──────────────────────────────────────────────────────────────
// Stores and manages reusable task templates (workflows) — project-agnostic.
// Each workflow has: name + tasks with seq, name, role, deps (letters), depType.
function WorkflowsTab() {
  const BORDER = '#2A2A3A'; const TEXT = '#E8E8F0'; const MUTED = '#6B7280';
  const ORANGE = '#F97316'; const CARD = '#1C1C27'; const BG = '#13131A';
  const INPUT = { width:'100%', padding:'6px 9px', borderRadius:'7px', border:`1px solid ${BORDER}`, background:'#0F0F18', color:TEXT, fontSize:'12px', outline:'none', boxSizing:'border-box', fontFamily:'inherit' };

  const [workflows, setWorkflows] = useState(() => loadWorkflows());
  const [expanded,  setExpanded]  = useState(null);    // workflow id being viewed
  const [editing,   setEditing]   = useState(null);    // {id,name,tasks} being edited, null=new
  const [showForm,  setShowForm]  = useState(false);
  const [formName,  setFormName]  = useState('');
  const [formTasks, setFormTasks] = useState([{ seq:'A', name:'', role:'', deps:[], depType:'FS' }]);
  const [formError, setFormError] = useState('');

  const persist = map => { saveWorkflows(map); setWorkflows(new Map(map)); };

  const openNew = () => {
    setEditing(null);
    setFormName('');
    setFormTasks([{ seq:'A', name:'', role:'', deps:[], depType:'FS' }]);
    setFormError('');
    setShowForm(true);
  };

  const openEdit = wf => {
    setEditing(wf);
    setFormName(wf.name);
    setFormTasks(wf.tasks.map(t => ({ ...t, deps: t.deps || [], depType: t.depType || 'FS' })));
    setFormError('');
    setShowForm(true);
  };

  const deleteWf = id => {
    const next = new Map(workflows);
    next.delete(id);
    persist(next);
    if (expanded === id) setExpanded(null);
  };

  const saveForm = () => {
    if (!formName.trim()) { setFormError('Workflow name is required.'); return; }
    const validTasks = formTasks.filter(t => t.name.trim());
    if (!validTasks.length) { setFormError('Add at least one task with a name.'); return; }
    const id = editing ? editing.id : `wf_${Date.now()}`;
    const wf = { id, name: formName.trim(), tasks: validTasks };
    const next = new Map(workflows);
    next.set(id, wf);
    persist(next);
    setShowForm(false);
  };

  const updateFT = (i, f, v) => setFormTasks(prev => prev.map((t, idx) => idx === i ? { ...t, [f]: v } : t));
  const addFTRow = () => {
    const seq = String.fromCharCode(65 + formTasks.length);
    setFormTasks(prev => [...prev, { seq, name:'', role:'', deps:[], depType:'FS' }]);
  };
  const removeFTRow = i => setFormTasks(prev => {
    const next = prev.filter((_, idx) => idx !== i).map((t, idx) => ({ ...t, seq: String.fromCharCode(65 + idx) }));
    return next.length ? next : [{ seq:'A', name:'', role:'', deps:[], depType:'FS' }];
  });
  const toggleDep = (i, seq) => setFormTasks(prev => prev.map((t, idx) => {
    if (idx !== i) return t;
    const deps = t.deps.includes(seq) ? t.deps.filter(d => d !== seq) : [...t.deps, seq];
    return { ...t, deps };
  }));

  const wfList = [...workflows.values()];

  return (
    <div style={{ fontFamily:'-apple-system,system-ui,sans-serif' }}>
      {/* Toolbar */}
      <div style={{ display:'flex', alignItems:'center', padding:'0 16px', height:'48px', borderBottom:`1px solid ${BORDER}`, background:CARD, gap:'12px' }}>
        <span style={{ fontSize:'13px', color:MUTED }}>
          {wfList.length} workflow{wfList.length !== 1 ? 's' : ''} saved
        </span>
        <button onClick={openNew}
          style={{ marginLeft:'auto', padding:'6px 14px', borderRadius:'8px', border:'none', background:ORANGE, color:'white', fontSize:'12px', fontWeight:'700', cursor:'pointer' }}>
          + New Workflow
        </button>
      </div>

      {/* Empty state */}
      {wfList.length === 0 && !showForm && (
        <div style={{ padding:'64px 32px', textAlign:'center', color:MUTED }}>
          <div style={{ fontSize:'32px', marginBottom:'12px', opacity:0.3 }}>⚙</div>
          <div style={{ fontSize:'14px', fontWeight:'600', marginBottom:'6px', color:TEXT, opacity:0.5 }}>No workflows yet</div>
          <div style={{ fontSize:'12px', lineHeight:'1.6', opacity:0.6, maxWidth:'320px', margin:'0 auto' }}>
            Create a reusable task template — task names, roles, and dependencies without project-specific details.
          </div>
          <button onClick={openNew} style={{ marginTop:'16px', padding:'8px 18px', borderRadius:'8px', border:`1px solid ${BORDER}`, background:'transparent', color:TEXT, fontSize:'12px', cursor:'pointer' }}>
            Create first workflow
          </button>
        </div>
      )}

      {/* Workflow list */}
      {!showForm && wfList.length > 0 && (
        <div>
          {/* Table header */}
          <div style={{ display:'grid', gridTemplateColumns:'1fr 80px 80px', gap:'0', borderBottom:`1px solid ${BORDER}`, background:'#0A0A0F' }}>
            {['Workflow Name', 'Tasks', ''].map((h, i) => (
              <div key={i} style={{ padding:'10px 16px', fontSize:'11px', color:MUTED, fontWeight:'700', textTransform:'uppercase', letterSpacing:'0.06em' }}>{h}</div>
            ))}
          </div>
          {wfList.map((wf, wi) => (
            <div key={wf.id}>
              {/* Row */}
              <div style={{ display:'grid', gridTemplateColumns:'1fr 80px 80px', background: wi%2===0 ? BG : '#0F0F18', borderBottom:`1px solid ${BORDER}` }}
                onMouseEnter={e=>e.currentTarget.style.background='#1E2535'}
                onMouseLeave={e=>e.currentTarget.style.background=wi%2===0?BG:'#0F0F18'}>
                <div style={{ padding:'12px 16px', display:'flex', alignItems:'center', gap:'10px', cursor:'pointer' }}
                  onClick={() => setExpanded(expanded === wf.id ? null : wf.id)}>
                  <span style={{ fontSize:'10px', color:MUTED, transition:'transform 0.15s', display:'inline-block', transform: expanded===wf.id ? 'rotate(90deg)' : 'none' }}>▶</span>
                  <span style={{ fontWeight:'600', color:TEXT, fontSize:'13px' }}>{wf.name}</span>
                </div>
                <div style={{ padding:'12px 16px', color:MUTED, fontSize:'13px', display:'flex', alignItems:'center' }}>{wf.tasks.length}</div>
                <div style={{ padding:'8px 12px', display:'flex', alignItems:'center', gap:'6px', justifyContent:'flex-end' }}>
                  <button onClick={() => openEdit(wf)}
                    style={{ width:'26px', height:'26px', borderRadius:'6px', border:`1px solid ${BORDER}`, background:'transparent', cursor:'pointer', color:MUTED, fontSize:'13px', display:'flex', alignItems:'center', justifyContent:'center' }}
                    onMouseEnter={e=>e.currentTarget.style.color=ORANGE} onMouseLeave={e=>e.currentTarget.style.color=MUTED}>✎</button>
                  <button onClick={() => deleteWf(wf.id)}
                    style={{ width:'26px', height:'26px', borderRadius:'6px', border:`1px solid ${BORDER}`, background:'transparent', cursor:'pointer', color:MUTED, fontSize:'13px', display:'flex', alignItems:'center', justifyContent:'center' }}
                    onMouseEnter={e=>e.currentTarget.style.color='#EF4444'} onMouseLeave={e=>e.currentTarget.style.color=MUTED}>🗑</button>
                </div>
              </div>
              {/* Expanded task list */}
              {expanded === wf.id && (
                <div style={{ background:'#0A0A0F', borderBottom:`1px solid ${BORDER}`, padding:'10px 24px 14px' }}>
                  <div style={{ display:'grid', gridTemplateColumns:'32px 1fr 120px 120px', gap:'0', marginBottom:'6px' }}>
                    {['Seq','Task Name','Role','Deps'].map((h,i) => (
                      <div key={i} style={{ padding:'5px 8px', fontSize:'10px', color:MUTED, fontWeight:'700', textTransform:'uppercase', letterSpacing:'0.06em' }}>{h}</div>
                    ))}
                  </div>
                  {wf.tasks.map((t, ti) => (
                    <div key={ti} style={{ display:'grid', gridTemplateColumns:'32px 1fr 120px 120px', gap:'0', borderTop:`1px solid ${BORDER}20` }}>
                      <div style={{ padding:'7px 8px', fontSize:'12px', fontWeight:'700', color:ORANGE }}>{t.seq}</div>
                      <div style={{ padding:'7px 8px', fontSize:'12px', color:TEXT }}>{t.name}</div>
                      <div style={{ padding:'7px 8px', fontSize:'12px', color:MUTED }}>{t.role || '—'}</div>
                      <div style={{ padding:'7px 8px', fontSize:'11px', color:MUTED }}>
                        {t.deps?.length ? t.deps.map(d => (
                          <span key={d} style={{ marginRight:'4px', padding:'1px 5px', borderRadius:'4px', background:`${ORANGE}18`, border:`1px solid ${ORANGE}40`, color:ORANGE, fontSize:'10px', fontWeight:'700' }}>
                            {t.depType || 'FS'}:{d}
                          </span>
                        )) : '—'}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Create / Edit form */}
      {showForm && (
        <div style={{ padding:'20px 22px' }}>
          <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:'16px' }}>
            <div style={{ fontSize:'14px', fontWeight:'700', color:TEXT }}>{editing ? `Edit: ${editing.name}` : 'New Workflow'}</div>
            <button onClick={() => setShowForm(false)} style={{ background:'none', border:'none', cursor:'pointer', color:MUTED, fontSize:'20px' }}>×</button>
          </div>

          {/* Workflow name */}
          <div style={{ marginBottom:'16px' }}>
            <div style={{ fontSize:'11px', color:MUTED, marginBottom:'5px', fontWeight:'600' }}>Workflow Name</div>
            <input value={formName} onChange={e => setFormName(e.target.value)} placeholder="e.g. Standard Fit-Out, Heritage Reno…"
              style={{ ...INPUT, maxWidth:'360px' }} />
          </div>

          {/* Task grid */}
          <div style={{ marginBottom:'14px' }}>
            <div style={{ fontSize:'11px', color:MUTED, marginBottom:'8px', fontWeight:'600', textTransform:'uppercase', letterSpacing:'0.06em' }}>Tasks</div>
            <div style={{ display:'grid', gridTemplateColumns:'32px 1fr 120px 140px 24px', gap:'6px', marginBottom:'6px', paddingBottom:'6px', borderBottom:`1px solid ${BORDER}` }}>
              {['Seq','Task Name','Role','Dependencies',''].map((h,i) => (
                <div key={i} style={{ fontSize:'10px', color:MUTED, fontWeight:'700', textTransform:'uppercase', letterSpacing:'0.05em' }}>{h}</div>
              ))}
            </div>
            {formTasks.map((t, i) => {
              const prevSeqs = formTasks.slice(0, i).map(x => x.seq);
              return (
                <div key={i} style={{ display:'grid', gridTemplateColumns:'32px 1fr 120px 140px 24px', gap:'6px', marginBottom:'6px', alignItems:'center' }}>
                  <div style={{ fontSize:'12px', fontWeight:'700', color:ORANGE, textAlign:'center', background:'#F9731615', borderRadius:'5px', padding:'6px 0', border:`1px solid ${ORANGE}40` }}>{t.seq}</div>
                  <input value={t.name} onChange={e => updateFT(i,'name',e.target.value)} placeholder="Task name" style={INPUT} />
                  <input value={t.role} onChange={e => updateFT(i,'role',e.target.value)} placeholder="Role" style={INPUT} />
                  {/* Dep selector */}
                  <div style={{ display:'flex', gap:'4px', flexWrap:'wrap', alignItems:'center' }}>
                    {/* Type toggle */}
                    <div style={{ display:'flex', borderRadius:'6px', overflow:'hidden', border:`1px solid ${BORDER}`, flexShrink:0 }}>
                      {['FS','SS'].map(tp => (
                        <button key={tp} onClick={() => updateFT(i,'depType',tp)}
                          style={{ padding:'3px 7px', border:'none', cursor:'pointer', fontSize:'10px', fontWeight:'700', background: t.depType===tp ? ORANGE : 'transparent', color: t.depType===tp ? 'white' : MUTED }}>
                          {tp}
                        </button>
                      ))}
                    </div>
                    {/* Dep letter toggles */}
                    {prevSeqs.map(seq => (
                      <button key={seq} onClick={() => toggleDep(i, seq)}
                        style={{ padding:'3px 8px', borderRadius:'5px', border:`1px solid ${t.deps.includes(seq) ? ORANGE : BORDER}`, background: t.deps.includes(seq) ? '#F9731620' : 'transparent', cursor:'pointer', fontSize:'10px', fontWeight:'700', color: t.deps.includes(seq) ? ORANGE : MUTED }}>
                        {seq}
                      </button>
                    ))}
                    {prevSeqs.length === 0 && <span style={{ fontSize:'10px', color:MUTED, fontStyle:'italic' }}>—</span>}
                  </div>
                  <button onClick={() => removeFTRow(i)} disabled={formTasks.length === 1}
                    style={{ width:'24px', height:'24px', borderRadius:'5px', border:`1px solid ${BORDER}`, background:'transparent', color:MUTED, cursor:formTasks.length===1?'default':'pointer', fontSize:'14px', display:'flex', alignItems:'center', justifyContent:'center', opacity:formTasks.length===1?0.3:1 }}>×</button>
                </div>
              );
            })}
            <button onClick={addFTRow}
              style={{ display:'flex', alignItems:'center', gap:'6px', marginTop:'4px', padding:'6px 12px', borderRadius:'7px', border:`1px dashed ${BORDER}`, background:'transparent', color:MUTED, fontSize:'12px', cursor:'pointer', width:'100%', justifyContent:'center' }}
              onMouseEnter={e=>e.currentTarget.style.borderColor=ORANGE} onMouseLeave={e=>e.currentTarget.style.borderColor=BORDER}>
              + Add task
            </button>
          </div>

          {formError && <div style={{ marginBottom:'12px', padding:'8px 12px', borderRadius:'7px', background:'#3B1219', border:'1px solid #7F1D1D', color:'#FCA5A5', fontSize:'12px' }}>{formError}</div>}

          <div style={{ display:'flex', gap:'10px', justifyContent:'flex-end' }}>
            <button onClick={() => setShowForm(false)} style={{ padding:'8px 16px', borderRadius:'8px', border:`1px solid ${BORDER}`, background:'transparent', color:MUTED, fontSize:'13px', cursor:'pointer' }}>Cancel</button>
            <button onClick={saveForm} style={{ padding:'8px 20px', borderRadius:'8px', border:'none', background:ORANGE, color:'white', fontSize:'13px', fontWeight:'700', cursor:'pointer' }}>
              {editing ? 'Save Changes' : 'Save Workflow'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── AddTasksModal ─────────────────────────────────────────────────────────────
function AddTasksModal({ proj, existingTasks, existingPeople, onAdd, onClose }) {
  const CARD   = '#1C1C27';
  const BORDER = '#2A2A3A';
  const ORANGE = '#F97316';
  const TEXT   = '#E8E8F0';
  const MUTED  = '#6B7280';
  const INPUT  = { width:'100%', padding:'8px 10px', borderRadius:'8px', border:`1px solid ${BORDER}`, background:'#0F0F18', color:TEXT, fontSize:'12px', outline:'none', boxSizing:'border-box', fontFamily:'inherit' };

  const nextLetter = () => {
    const used = existingTasks.map(t => t.id.split('-')[1] || '').filter(Boolean);
    for (let i = 0; i < 26; i++) {
      const l = String.fromCharCode(65 + i);
      if (!used.includes(l)) return l;
    }
    return String(existingTasks.length + 1);
  };

  const [tasks, setTasks] = useState([
    { seq: nextLetter(), name:'', person:'', role:'', rate:'', start:'', end:'', deps:[], depType:'FS' }
  ]);
  const [error, setError] = useState('');
  const [workflows] = useState(() => loadWorkflows());

  const updateTask = (i, f, v) => setTasks(prev => prev.map((t, idx) => idx===i ? {...t,[f]:v} : t));

  const toggleDep = (i, seq) => setTasks(prev => prev.map((t, idx) => {
    if (idx !== i) return t;
    const deps = t.deps.includes(seq) ? t.deps.filter(d => d !== seq) : [...t.deps, seq];
    return { ...t, deps };
  }));

  const addRow = () => {
    const used = [...existingTasks.map(t => t.id.split('-')[1]), ...tasks.map(t => t.seq)];
    let seq = 'A';
    for (let i = 0; i < 52; i++) {
      const l = i < 26 ? String.fromCharCode(65+i) : String.fromCharCode(65+i-26).repeat(2);
      if (!used.includes(l)) { seq = l; break; }
    }
    setTasks(prev => [...prev, { seq, name:'', person:'', role:'', rate:'', start:'', end:'', deps:[], depType:'FS' }]);
  };

  const removeRow = i => setTasks(prev => prev.filter((_, idx) => idx !== i));

  const loadWorkflow = wfId => {
    const wf = workflows.get(wfId);
    if (!wf) return;
    const used = existingTasks.map(t => t.id.split('-')[1] || '');
    let letterIdx = 0;
    const nextSeq = () => {
      while (letterIdx < 26 && used.includes(String.fromCharCode(65+letterIdx))) letterIdx++;
      return String.fromCharCode(65 + (letterIdx++));
    };
    const newRows = wf.tasks.map(t => ({
      seq: nextSeq(), name: t.name, person:'', role: t.role||'', rate:'', start:'', end:'',
      deps: t.deps || [], depType: t.depType || 'FS',
    }));
    setTasks(newRows);
  };

  const handleAdd = () => {
    const valid = tasks.filter(t => t.name.trim() && t.start.trim() && t.end.trim());
    if (!valid.length) { setError('Each task needs a name, start date, and end date.'); return; }
    const newTasks = valid.map(t => ({
      id: `${proj.id}-${t.seq}`,
      proj: proj.id,
      name: t.name.trim(),
      person: t.person.trim(),
      role: t.role.trim(),
      dur: 1,
      start: t.start.trim(),
      end: t.end.trim(),
      deps: t.deps.map(d => `${proj.id}-${d}`),
    }));
    // Save typed deps via depOverrides
    const depMap = loadDepOverrides();
    for (const t of valid) {
      if (t.deps.length) {
        depMap.set(`${proj.id}-${t.seq}`, t.deps.map(d => ({ id:`${proj.id}-${d}`, type: t.depType })));
      }
    }
    saveDepOverrides(depMap);

    const newPeople = [];
    for (const t of newTasks) {
      if (t.person && !existingPeople.find(p => p.name === t.person) && !newPeople.find(p => p.name === t.person)) {
        const src = valid.find(v => v.name === t.name);
        const init = t.person.split(' ').map(w=>w[0]).join('').slice(0,2).toUpperCase();
        newPeople.push({ name:t.person, role:src?.role||'', init, color:PERSON_COLORS[existingPeople.length % PERSON_COLORS.length], rate:src?.rate||'$42/hr' });
      }
    }
    onAdd({ tasks:newTasks, people:newPeople });
    onClose();
  };

  const wfList = [...workflows.values()];

  return (
    <div style={{ position:'fixed', inset:0, zIndex:1000, background:'rgba(10,10,15,0.7)', backdropFilter:'blur(4px)', display:'flex', alignItems:'center', justifyContent:'center' }}
      onClick={e => { if (e.target===e.currentTarget) onClose(); }}>
      <div style={{ background:CARD, borderRadius:'16px', width:'700px', maxWidth:'95vw', maxHeight:'85vh', display:'flex', flexDirection:'column', boxShadow:'0 24px 64px rgba(0,0,0,0.5)', border:`1px solid ${BORDER}`, overflow:'hidden' }}>
        <div style={{ padding:'18px 22px 14px', borderBottom:`2px solid ${proj.color}`, background:'#17171F', flexShrink:0 }}>
          <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between' }}>
            <div>
              <div style={{ display:'flex', alignItems:'center', gap:'8px' }}>
                <div style={{ width:'10px', height:'10px', borderRadius:'50%', background:proj.color }} />
                <div style={{ fontSize:'15px', fontWeight:'700', color:TEXT }}>Add Tasks to {proj.id}</div>
              </div>
              <div style={{ fontSize:'11px', color:MUTED, marginTop:'3px' }}>{proj.name} · {existingTasks.length} existing tasks</div>
            </div>
            <button onClick={onClose} style={{ background:'none', border:'none', cursor:'pointer', color:MUTED, fontSize:'22px', lineHeight:1, padding:0 }}>×</button>
          </div>
        </div>

        <div style={{ overflowY:'auto', flex:1, padding:'18px 22px' }}>
          {/* Workflow loader */}
          {wfList.length > 0 && (
            <div style={{ marginBottom:'16px', padding:'10px 14px', borderRadius:'9px', background:'#17171F', border:`1px solid ${BORDER}`, display:'flex', alignItems:'center', gap:'10px' }}>
              <span style={{ fontSize:'11px', color:MUTED, fontWeight:'600', flexShrink:0 }}>Load workflow:</span>
              <select onChange={e => { if (e.target.value) loadWorkflow(e.target.value); e.target.value=''; }}
                style={{ flex:1, padding:'5px 9px', borderRadius:'7px', border:`1px solid ${BORDER}`, background:'#0F0F18', color:TEXT, fontSize:'12px', outline:'none', cursor:'pointer' }}>
                <option value=''>— select a workflow —</option>
                {wfList.map(wf => <option key={wf.id} value={wf.id}>{wf.name} ({wf.tasks.length} tasks)</option>)}
              </select>
            </div>
          )}

          {/* Column headers */}
          <div style={{ display:'grid', gridTemplateColumns:'36px 1fr 100px 90px 90px 150px 24px', gap:'6px', marginBottom:'8px', paddingBottom:'6px', borderBottom:`1px solid ${BORDER}` }}>
            {['ID','Task Name','Assigned','Start','End','Dependencies',''].map((h,i) => (
              <div key={i} style={{ fontSize:'10px', color:MUTED, fontWeight:'600', textTransform:'uppercase', letterSpacing:'0.05em' }}>{h}</div>
            ))}
          </div>
          {tasks.map((t, i) => {
            const prevSeqs = tasks.slice(0, i).map(x => x.seq);
            return (
              <div key={i} style={{ display:'grid', gridTemplateColumns:'36px 1fr 100px 90px 90px 150px 24px', gap:'6px', marginBottom:'6px', alignItems:'center' }}>
                <div style={{ fontSize:'11px', fontWeight:'700', color:proj.color, textAlign:'center', background:proj.color+'15', borderRadius:'5px', padding:'6px 0', border:`1px solid ${proj.color}40`, whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>{proj.id}-{t.seq}</div>
                <input value={t.name}   onChange={e=>updateTask(i,'name',  e.target.value)} placeholder="Task name"   style={INPUT} />
                <input value={t.person} onChange={e=>updateTask(i,'person',e.target.value)} placeholder="Name" list="known-people-add" style={INPUT} />
                <input value={t.start}  onChange={e=>updateTask(i,'start', e.target.value)} placeholder="DD/MM/YYYY" style={INPUT} />
                <input value={t.end}    onChange={e=>updateTask(i,'end',   e.target.value)} placeholder="DD/MM/YYYY" style={INPUT} />
                {/* Dep type + letter selector */}
                <div style={{ display:'flex', gap:'4px', flexWrap:'wrap', alignItems:'center' }}>
                  <div style={{ display:'flex', borderRadius:'6px', overflow:'hidden', border:`1px solid ${BORDER}`, flexShrink:0 }}>
                    {['FS','SS'].map(tp => (
                      <button key={tp} onClick={() => updateTask(i,'depType',tp)}
                        style={{ padding:'3px 7px', border:'none', cursor:'pointer', fontSize:'10px', fontWeight:'700', background: t.depType===tp ? proj.color : 'transparent', color: t.depType===tp ? 'white' : MUTED }}>
                        {tp}
                      </button>
                    ))}
                  </div>
                  {prevSeqs.map(seq => (
                    <button key={seq} onClick={() => toggleDep(i, seq)}
                      style={{ padding:'3px 8px', borderRadius:'5px', border:`1px solid ${t.deps.includes(seq) ? proj.color : BORDER}`, background: t.deps.includes(seq) ? proj.color+'20' : 'transparent', cursor:'pointer', fontSize:'10px', fontWeight:'700', color: t.deps.includes(seq) ? proj.color : MUTED }}>
                      {seq}
                    </button>
                  ))}
                  {prevSeqs.length === 0 && <span style={{ fontSize:'10px', color:MUTED, fontStyle:'italic' }}>—</span>}
                </div>
                <button onClick={()=>removeRow(i)} disabled={tasks.length===1}
                  style={{ width:'24px', height:'24px', borderRadius:'5px', border:`1px solid ${BORDER}`, background:'transparent', color:MUTED, cursor:tasks.length===1?'default':'pointer', fontSize:'14px', display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0, opacity:tasks.length===1?0.3:1 }}>×</button>
              </div>
            );
          })}
          <datalist id="known-people-add">{existingPeople.map(p=><option key={p.name} value={p.name}/>)}</datalist>
          <button onClick={addRow}
            style={{ display:'flex', alignItems:'center', gap:'6px', marginTop:'6px', padding:'6px 12px', borderRadius:'7px', border:`1px dashed ${BORDER}`, background:'transparent', color:MUTED, fontSize:'12px', cursor:'pointer', width:'100%', justifyContent:'center' }}
            onMouseEnter={e=>e.currentTarget.style.borderColor=proj.color}
            onMouseLeave={e=>e.currentTarget.style.borderColor=BORDER}>
            + Add task row
          </button>
          {error && <div style={{ marginTop:'12px', padding:'9px 12px', borderRadius:'8px', background:'#3B1219', border:'1px solid #7F1D1D', color:'#FCA5A5', fontSize:'12px' }}>{error}</div>}
        </div>

        <div style={{ padding:'14px 22px', borderTop:`1px solid ${BORDER}`, display:'flex', gap:'10px', justifyContent:'flex-end', flexShrink:0, background:'#17171F' }}>
          <button onClick={onClose} style={{ padding:'8px 18px', borderRadius:'8px', border:`1px solid ${BORDER}`, background:'transparent', color:MUTED, fontSize:'13px', cursor:'pointer' }}>Cancel</button>
          <button onClick={handleAdd} style={{ padding:'8px 22px', borderRadius:'8px', border:'none', background:proj.color, color:'white', fontSize:'13px', fontWeight:'700', cursor:'pointer' }}>
            + Add Tasks
          </button>
        </div>
      </div>
    </div>
  );
}

// ── NewProjectModal ───────────────────────────────────────────────────────────
function NewProjectModal({ existingProjs, existingPeople, onAdd, onClose }) {
  const CARD   = '#1C1C27';
  const BORDER = '#2A2A3A';
  const ORANGE = '#F97316';
  const TEXT   = '#E8E8F0';
  const MUTED  = '#6B7280';
  const INPUT  = { width:'100%', padding:'8px 10px', borderRadius:'8px', border:`1px solid ${BORDER}`, background:'#0F0F18', color:TEXT, fontSize:'12px', outline:'none', boxSizing:'border-box', fontFamily:'inherit' };

  const nextId = (() => {
    const nums = existingProjs.map(p => parseInt(p.id.replace(/\D/g,''))).filter(n => !isNaN(n));
    return `P${nums.length ? Math.max(...nums) + 1 : existingProjs.length + 1}`;
  })();

  const [projId,    setProjId]   = useState(nextId);
  const [projName,  setProjName] = useState('');
  const [color,     setColor]    = useState(PROJ_COLORS[existingProjs.length % PROJ_COLORS.length]);
  const [tasks,     setTasks]    = useState([
    { seq:'A', name:'', person:'', role:'', rate:'', start:'', end:'', deps:[], depType:'FS' },
  ]);
  const [error,     setError]    = useState('');
  const [workflows] = useState(() => loadWorkflows());

  const updateTask = (i, field, val) => setTasks(prev => prev.map((t, idx) => idx === i ? {...t, [field]:val} : t));

  const toggleDep = (i, seq) => setTasks(prev => prev.map((t, idx) => {
    if (idx !== i) return t;
    const deps = t.deps.includes(seq) ? t.deps.filter(d => d !== seq) : [...t.deps, seq];
    return { ...t, deps };
  }));

  const addTaskRow = () => setTasks(prev => [...prev, {
    seq: String.fromCharCode(65 + prev.length), name:'', person:'', role:'', rate:'', start:'', end:'', deps:[], depType:'FS'
  }]);

  const removeTask = i => setTasks(prev => prev.filter((_, idx) => idx !== i));

  const loadWorkflow = wfId => {
    const wf = workflows.get(wfId);
    if (!wf) return;
    setTasks(wf.tasks.map((t, i) => ({
      seq: String.fromCharCode(65 + i),
      name: t.name, person:'', role: t.role||'', rate:'', start:'', end:'',
      deps: t.deps || [], depType: t.depType || 'FS',
    })));
  };

  const knownNames = existingPeople.map(p => p.name);

  const handleAdd = () => {
    if (!projId.trim()) { setError('Project ID is required.'); return; }
    if (existingProjs.find(p => p.id === projId.trim())) { setError(`Project "${projId}" already exists.`); return; }
    if (!tasks.some(t => t.name.trim())) { setError('Add at least one task.'); return; }
    const validTasks = tasks.filter(t => t.name.trim() && t.start.trim() && t.end.trim());
    if (!validTasks.length) { setError('Each task needs a name, start date, and end date.'); return; }

    const pid = projId.trim().toUpperCase();
    const newProj = { id:pid, name: projName.trim() || `${pid} — New Build`, color };

    const newRawTasks = validTasks.map(t => ({
      id:     `${pid}-${t.seq}`,
      proj:   pid,
      name:   t.name.trim(),
      person: t.person.trim(),
      role:   t.role.trim() || '',
      dur:    1,
      start:  t.start.trim(),
      end:    t.end.trim(),
      deps:   (t.deps || []).map(d => `${pid}-${d}`),
    }));

    const depMap = loadDepOverrides();
    for (const t of validTasks) {
      if ((t.deps || []).length) {
        depMap.set(`${pid}-${t.seq}`, t.deps.map(d => ({ id:`${pid}-${d}`, type: t.depType || 'FS' })));
      }
    }
    saveDepOverrides(depMap);

    const newPeople = [];
    for (const t of newRawTasks) {
      if (t.person && !existingPeople.find(p => p.name === t.person) && !newPeople.find(p => p.name === t.person)) {
        const task = validTasks.find(vt => vt.name === t.name);
        const init = t.person.split(' ').map(w=>w[0]).join('').slice(0,2).toUpperCase();
        newPeople.push({ name:t.person, role:task?.role||'', init, color:PERSON_COLORS[(existingPeople.length+newPeople.length)%PERSON_COLORS.length], rate:task?.rate||'$42/hr' });
      }
    }

    onAdd({ proj:newProj, rawTasks:newRawTasks, people:newPeople });
    onClose();
  };

  const wfList = [...workflows.values()];

  return (
    <div style={{ position:'fixed', inset:0, zIndex:1000, background:'rgba(10,10,15,0.7)', backdropFilter:'blur(4px)', display:'flex', alignItems:'center', justifyContent:'center' }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{ background:CARD, borderRadius:'16px', width:'700px', maxWidth:'95vw', maxHeight:'88vh', display:'flex', flexDirection:'column', boxShadow:'0 24px 64px rgba(0,0,0,0.5)', border:`1px solid ${BORDER}`, overflow:'hidden' }}>
        <div style={{ padding:'18px 22px 14px', borderBottom:`2px solid ${ORANGE}`, background:'#17171F', flexShrink:0 }}>
          <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between' }}>
            <div>
              <div style={{ fontSize:'15px', fontWeight:'700', color:TEXT }}>New Project</div>
              <div style={{ fontSize:'11px', color:MUTED, marginTop:'3px' }}>Add a project and its tasks to the schedule</div>
            </div>
            <button onClick={onClose} style={{ background:'none', border:'none', cursor:'pointer', color:MUTED, fontSize:'22px', lineHeight:1, padding:0 }}>×</button>
          </div>
        </div>

        <div style={{ overflowY:'auto', flex:1, padding:'18px 22px' }}>
          <div style={{ marginBottom:'20px' }}>
            <div style={{ fontSize:'11px', fontWeight:'700', color:MUTED, textTransform:'uppercase', letterSpacing:'0.07em', marginBottom:'10px' }}>Project Details</div>
            <div style={{ display:'grid', gridTemplateColumns:'1fr 2fr auto', gap:'10px', alignItems:'end' }}>
              <div>
                <div style={{ fontSize:'11px', color:MUTED, marginBottom:'5px' }}>Project ID</div>
                <input value={projId} onChange={e => setProjId(e.target.value.toUpperCase())} placeholder="P4" style={INPUT} />
              </div>
              <div>
                <div style={{ fontSize:'11px', color:MUTED, marginBottom:'5px' }}>Project Name</div>
                <input value={projName} onChange={e => setProjName(e.target.value)} placeholder="New Build, Renovation\u2026" style={INPUT} />
              </div>
              <div>
                <div style={{ fontSize:'11px', color:MUTED, marginBottom:'5px' }}>Colour</div>
                <div style={{ display:'flex', gap:'5px' }}>
                  {PROJ_COLORS.slice(0,6).map(c => (
                    <div key={c} onClick={() => setColor(c)} style={{ width:'22px', height:'22px', borderRadius:'50%', background:c, cursor:'pointer', border: color===c ? '2px solid white' : '2px solid transparent', flexShrink:0 }} />
                  ))}
                </div>
              </div>
            </div>
          </div>

          <div>
            <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:'10px' }}>
              <div style={{ fontSize:'11px', fontWeight:'700', color:MUTED, textTransform:'uppercase', letterSpacing:'0.07em' }}>Tasks</div>
              {wfList.length > 0 && (
                <div style={{ display:'flex', alignItems:'center', gap:'8px' }}>
                  <span style={{ fontSize:'11px', color:MUTED }}>From workflow:</span>
                  <select onChange={e => { if (e.target.value) loadWorkflow(e.target.value); e.target.value=''; }}
                    style={{ padding:'4px 8px', borderRadius:'7px', border:`1px solid ${BORDER}`, background:'#0F0F18', color:TEXT, fontSize:'11px', outline:'none', cursor:'pointer' }}>
                    <option value=''>\u2014 select \u2014</option>
                    {wfList.map(wf => <option key={wf.id} value={wf.id}>{wf.name}</option>)}
                  </select>
                </div>
              )}
            </div>

            <div style={{ display:'grid', gridTemplateColumns:'32px 1fr 100px 90px 90px 160px 24px', gap:'6px', marginBottom:'6px', paddingBottom:'6px', borderBottom:`1px solid ${BORDER}` }}>
              {['ID','Task Name','Assigned','Start','End','Dependencies',''].map((h,i) => (
                <div key={i} style={{ fontSize:'10px', color:MUTED, fontWeight:'600', textTransform:'uppercase', letterSpacing:'0.05em' }}>{h}</div>
              ))}
            </div>

            {tasks.map((t, i) => {
              const prevSeqs = tasks.slice(0, i).map(x => x.seq);
              return (
                <div key={i} style={{ display:'grid', gridTemplateColumns:'32px 1fr 100px 90px 90px 160px 24px', gap:'6px', marginBottom:'6px', alignItems:'center' }}>
                  <div style={{ fontSize:'12px', fontWeight:'700', color:ORANGE, textAlign:'center', background:'#F9731615', borderRadius:'5px', padding:'6px 0', border:`1px solid ${ORANGE}40` }}>{projId}-{t.seq}</div>
                  <input value={t.name}   onChange={e => updateTask(i,'name',  e.target.value)} placeholder="Task name"   style={INPUT} />
                  <input value={t.person} onChange={e => updateTask(i,'person',e.target.value)} placeholder="Name" list="known-people-npm" style={INPUT} />
                  <input value={t.start}  onChange={e => updateTask(i,'start', e.target.value)} placeholder="DD/MM/YYYY" style={INPUT} />
                  <input value={t.end}    onChange={e => updateTask(i,'end',   e.target.value)} placeholder="DD/MM/YYYY" style={INPUT} />
                  <div style={{ display:'flex', gap:'4px', flexWrap:'wrap', alignItems:'center' }}>
                    <div style={{ display:'flex', borderRadius:'6px', overflow:'hidden', border:`1px solid ${BORDER}`, flexShrink:0 }}>
                      {['FS','SS'].map(tp => (
                        <button key={tp} onClick={() => updateTask(i,'depType',tp)}
                          style={{ padding:'3px 7px', border:'none', cursor:'pointer', fontSize:'10px', fontWeight:'700', background: t.depType===tp ? ORANGE : 'transparent', color: t.depType===tp ? 'white' : MUTED }}>
                          {tp}
                        </button>
                      ))}
                    </div>
                    {prevSeqs.map(seq => (
                      <button key={seq} onClick={() => toggleDep(i, seq)}
                        style={{ padding:'3px 8px', borderRadius:'5px', border:`1px solid ${t.deps.includes(seq) ? ORANGE : BORDER}`, background: t.deps.includes(seq) ? '#F9731620' : 'transparent', cursor:'pointer', fontSize:'10px', fontWeight:'700', color: t.deps.includes(seq) ? ORANGE : MUTED }}>
                        {seq}
                      </button>
                    ))}
                    {prevSeqs.length === 0 && <span style={{ fontSize:'10px', color:MUTED, fontStyle:'italic' }}>\u2014</span>}
                  </div>
                  <button onClick={() => removeTask(i)} disabled={tasks.length === 1}
                    style={{ width:'24px', height:'24px', borderRadius:'5px', border:`1px solid ${BORDER}`, background:'transparent', color:MUTED, cursor:tasks.length===1?'default':'pointer', fontSize:'14px', display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0, opacity:tasks.length===1?0.3:1 }}>×</button>
                </div>
              );
            })}

            <datalist id="known-people-npm">
              {knownNames.map(n => <option key={n} value={n} />)}
            </datalist>

            <button onClick={addTaskRow}
              style={{ display:'flex', alignItems:'center', gap:'6px', marginTop:'6px', padding:'6px 12px', borderRadius:'7px', border:`1px dashed ${BORDER}`, background:'transparent', color:MUTED, fontSize:'12px', cursor:'pointer', width:'100%', justifyContent:'center' }}
              onMouseEnter={e => e.currentTarget.style.borderColor=ORANGE}
              onMouseLeave={e => e.currentTarget.style.borderColor=BORDER}>
              + Add task row
            </button>
          </div>

          {error && <div style={{ marginTop:'12px', padding:'9px 12px', borderRadius:'8px', background:'#3B1219', border:'1px solid #7F1D1D', color:'#FCA5A5', fontSize:'12px' }}>{error}</div>}
        </div>

        <div style={{ padding:'14px 22px', borderTop:`1px solid ${BORDER}`, display:'flex', gap:'10px', justifyContent:'flex-end', flexShrink:0, background:'#17171F' }}>
          <button onClick={onClose} style={{ padding:'8px 18px', borderRadius:'8px', border:`1px solid ${BORDER}`, background:'transparent', color:MUTED, fontSize:'13px', cursor:'pointer' }}>Cancel</button>
          <button onClick={handleAdd} style={{ padding:'8px 22px', borderRadius:'8px', border:'none', background:ORANGE, color:'white', fontSize:'13px', fontWeight:'700', cursor:'pointer' }}>
            Create Project
          </button>
        </div>
      </div>
    </div>
  );
}


export default function App() {
  const [schedData,    setSchedData]    = useState(null);
  const [baseData,     setBaseData]     = useState(null);
  const [importing,    setImporting]    = useState(false);
  const [importError,  setImportError]  = useState(null);
  const [showNewProj,  setShowNewProj]  = useState(false);
  const fileInputRef = useRef(null);

  useEffect(() => {
    const buf = loadFromStorage();
    if (buf) {
      parseXlsx(buf).then(data => {
        setBaseData(data);
        const edits = loadSchedEdits();
        setSchedData(edits ? applyEditsToData(data, edits) : data);
      }).catch(() => localStorage.removeItem(LS_KEY));
    }
  }, []);

  const handleFileChange = async e => {
    const file = e.target.files?.[0];
    if (!file) return;
    setImporting(true); setImportError(null);
    try {
      const buf = await file.arrayBuffer();
      const data = await parseXlsx(buf);
      saveToStorage(buf);
      localStorage.removeItem(LS_EDITS_KEY);
      setBaseData(data);
      setSchedData(data);
    } catch (err) {
      setImportError(err.message || 'Failed to parse file.');
    } finally {
      setImporting(false); e.target.value = '';
    }
  };

  const handleAddProject = ({ proj, rawTasks: newTasks, people: newPeople }) => {
    setSchedData(prev => {
      const updated = {
        ...prev,
        rawTasks: [...prev.rawTasks, ...newTasks],
        projs:    [...prev.projs, proj],
        people:   [...prev.people, ...newPeople],
        tdepMap:  Object.fromEntries([...prev.rawTasks, ...newTasks].map(t => [t.id, t.deps])),
      };
      const existing = loadSchedEdits() || { rawTasks:[], projs:[], people:[] };
      saveSchedEdits({
        rawTasks: [...existing.rawTasks, ...newTasks],
        projs:    [...existing.projs,    proj],
        people:   [...existing.people,   ...newPeople],
      });
      return updated;
    });
  };

  const triggerImport = () => fileInputRef.current?.click();
  const clearData = () => {
    localStorage.removeItem(LS_KEY);
    localStorage.removeItem(LS_EDITS_KEY);
    localStorage.removeItem(LS_COMPLETED_KEY);
    localStorage.removeItem(LS_STATUS_KEY);
    localStorage.removeItem(LS_DEPS_KEY);
    setSchedData(null); setBaseData(null);
  };

  const NAV    = '#0A0A0F';
  const SURFACE= '#13131A';
  const CARD   = '#1C1C27';
  const BORDER = '#2A2A3A';
  const ORANGE = '#F97316';
  const TEXT   = '#E8E8F0';
  const MUTED  = '#6B7280';

  // ── Empty state ────────────────────────────────────────────────────────────
  if (!schedData) {
    return (
      <ErrorBoundary>
      <div style={{ fontFamily:'-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif', background:SURFACE, minHeight:'100vh', color:TEXT }}>
        <input ref={fileInputRef} type="file" accept=".xlsx,.xls" onChange={handleFileChange} style={{ display:'none' }} />

        {showNewProj && (
          <NewProjectModal existingProjs={[]} existingPeople={[]} onAdd={()=>{}} onClose={() => setShowNewProj(false)} />
        )}

        {/* Nav */}
        <div style={{ background:NAV, padding:'0 28px', height:'52px', display:'flex', alignItems:'center', justifyContent:'space-between', borderBottom:`1px solid ${BORDER}` }}>
          <div style={{ display:'flex', alignItems:'center' }}>
            <span style={{ color:ORANGE, fontWeight:'800', fontSize:'18px', letterSpacing:'-0.5px', marginRight:'32px' }}>FlowIQ</span>
            {['Gantt Chart','Project View','Conflicts','Resource'].map((l, i) => (
              <button key={i} style={{ padding:'0 18px', height:'52px', border:'none', background:'none', cursor:'default', fontSize:'13px', fontWeight:'500', color:i===0?ORANGE:MUTED, borderBottom:i===0?`2px solid ${ORANGE}`:'2px solid transparent', whiteSpace:'nowrap', opacity:0.5 }}>{l}</button>
            ))}
          </div>
          <div style={{ display:'flex', alignItems:'center', gap:'12px' }}>
            <div style={{ display:'flex', alignItems:'center', gap:'8px', background:'#1E1E2A', border:`1px solid ${BORDER}`, borderRadius:'8px', padding:'6px 12px', minWidth:'200px' }}>
              <svg width="13" height="13" fill="none" viewBox="0 0 16 16"><circle cx="6.5" cy="6.5" r="5" stroke={MUTED} strokeWidth="1.5"/><path d="M10.5 10.5 14 14" stroke={MUTED} strokeWidth="1.5" strokeLinecap="round"/></svg>
              <span style={{ fontSize:'12px', color:MUTED }}>Search tasks, people...</span>
            </div>
            <button style={{ padding:'6px 14px', borderRadius:'8px', border:`1px solid ${BORDER}`, background:'transparent', color:TEXT, fontSize:'12px', cursor:'pointer' }}>AI Chat and Notifications?</button>
          </div>
        </div>

        {/* KPI row */}
        <div style={{ display:'flex', gap:'12px', padding:'20px 28px 0' }}>
          {[{l:'Total Projects',v:'—'},{l:'Projects On Schedule',v:'—%'},{l:'Project Risk',v:'—',sub:'No data'},{l:'Cross Project Risk',v:'—',sub:'No data'}].map((k,i) => (
            <div key={i} style={{ background:CARD, borderRadius:'10px', padding:'16px 18px', border:`1px solid ${BORDER}`, flex:i>1?1:undefined, minWidth:i===0?'140px':'160px' }}>
              <div style={{ fontSize:'10px', color:MUTED, marginBottom:'6px', textTransform:'uppercase', letterSpacing:'0.06em' }}>{k.l}</div>
              <div style={{ fontSize:'28px', fontWeight:'800', color:MUTED, lineHeight:'1' }}>{k.v}</div>
              {k.sub && <div style={{ fontSize:'11px', color:MUTED, marginTop:'4px' }}>{k.sub}</div>}
            </div>
          ))}
          <div style={{ background:CARD, borderRadius:'10px', padding:'16px 18px', border:`1px dashed ${BORDER}`, minWidth:'120px', display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', gap:'6px' }}>
            <span style={{ fontSize:'11px', color:MUTED }}>Add KPI</span>
            <div style={{ width:'28px', height:'28px', borderRadius:'50%', border:`1.5px solid ${BORDER}`, display:'flex', alignItems:'center', justifyContent:'center', color:MUTED, fontSize:'18px' }}>+</div>
          </div>
        </div>

        {/* Action row */}
        <div style={{ display:'flex', justifyContent:'flex-end', gap:'10px', padding:'14px 28px 0' }}>
          <button onClick={triggerImport} disabled={importing}
            style={{ display:'flex', alignItems:'center', gap:'6px', padding:'7px 16px', borderRadius:'8px', border:`1px solid ${BORDER}`, background:'transparent', color:TEXT, fontSize:'12px', cursor:'pointer', fontWeight:'500' }}>
            <svg width="13" height="13" fill="none" viewBox="0 0 16 16"><path d="M8 2v9M4 8l4 4 4-4" stroke={TEXT} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/><path d="M2 13h12" stroke={TEXT} strokeWidth="1.5" strokeLinecap="round"/></svg>
            {importing ? 'Importing...' : 'Import'}
          </button>
          <button onClick={() => setShowNewProj(true)}
            style={{ padding:'7px 16px', borderRadius:'8px', border:'none', background:ORANGE, color:'white', fontSize:'12px', cursor:'pointer', fontWeight:'700' }}>
            + New Project
          </button>
        </div>

        {/* Tab shell */}
        <div style={{ margin:'14px 28px 28px', background:CARD, borderRadius:'12px', border:`1px solid ${BORDER}`, overflow:'hidden' }}>
          <div style={{ display:'flex', alignItems:'center', borderBottom:`1px solid ${BORDER}`, background:'#1C1C27', padding:'0 6px' }}>
            {['Gantt Chart','Project View','Conflicts','Resource'].map((l,i) => (
              <button key={i} style={{ padding:'12px 18px', border:'none', background:'none', cursor:'default', fontSize:'13px', fontWeight:i===0?'600':'400', color:i===0?ORANGE:MUTED, borderBottom:i===0?`2px solid ${ORANGE}`:'2px solid transparent', marginBottom:'-1px', whiteSpace:'nowrap', opacity:i===0?1:0.45 }}>{l}</button>
            ))}
          </div>
          <div style={{ position:'relative', minHeight:'420px', display:'flex', alignItems:'center', justifyContent:'center' }}>
            <div style={{ position:'absolute', inset:0, overflow:'hidden', opacity:0.15 }}>
              {Array.from({length:8}).map((_,i) => <div key={i} style={{ position:'absolute', left:`${(i+1)*12.5}%`, top:0, bottom:0, width:'1px', background:MUTED }} />)}
              {Array.from({length:5}).map((_,i) => <div key={i} style={{ position:'absolute', top:`${(i+1)*16.6}%`, left:0, right:0, height:'1px', background:MUTED }} />)}
            </div>
            <div style={{ textAlign:'center', zIndex:1 }}>
              <div style={{ fontSize:'36px', marginBottom:'14px', opacity:0.4 }}>📊</div>
              <div style={{ fontSize:'16px', fontWeight:'600', color:TEXT, marginBottom:'8px', opacity:0.6 }}>No schedule data</div>
              <div style={{ fontSize:'12px', color:MUTED, lineHeight:'1.7', maxWidth:'340px', margin:'0 auto', opacity:0.7 }}>
                Use the <strong style={{color:TEXT}}>Import</strong> button above to load your schedule.<br/>
                Expects a <strong style={{color:TEXT}}>Schedule</strong> sheet with columns:<br/>
                <span style={{ fontSize:'11px', color:'#6B7280' }}>Project · Task ID · Task Name · Assigned · Role · Rate · Start · End · Dependencies</span>
              </div>
              {importError && (
                <div style={{ marginTop:'16px', padding:'10px 14px', borderRadius:'8px', background:'#3B1219', border:'1px solid #7F1D1D', color:'#FCA5A5', fontSize:'12px', maxWidth:'340px', margin:'16px auto 0', textAlign:'left' }}>
                  <strong>Import failed:</strong> {importError}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
      </ErrorBoundary>
    );
  }

  // ── Loaded ────────────────────────────────────────────────────────────────
  return (
    <ErrorBoundary>
    <ScheduleCtx.Provider value={schedData}>
      {showNewProj && (
        <NewProjectModal
          existingProjs={schedData.projs}
          existingPeople={schedData.people}
          onAdd={handleAddProject}
          onClose={() => setShowNewProj(false)}
        />
      )}
      <ScheduleApp
        schedData={schedData}
        baseData={baseData}
        onImport={triggerImport}
        onClear={clearData}
        onNewProject={() => setShowNewProj(true)}
        onMutate={setSchedData}
        importing={importing}
        importError={importError}
        NAV={NAV} SURFACE={SURFACE} CARD={CARD} BORDER={BORDER} ORANGE={ORANGE} TEXT={TEXT} MUTED={MUTED}
      />
      <input ref={fileInputRef} type="file" accept=".xlsx,.xls" onChange={handleFileChange} style={{ display:'none' }} />
    </ScheduleCtx.Provider>
    </ErrorBoundary>
  );
}


// ── ScheduleApp — the full dashboard once data is loaded ──────────────────────
function ScheduleApp({ schedData, baseData, onImport, onClear, onNewProject, onMutate, importing, importError, NAV, SURFACE, CARD, BORDER, ORANGE, TEXT, MUTED }) {
  const { rawTasks, projs, people, tdepMap, base, todayDay, periods } = schedData;

  const [simDelays,       setSimDelays]       = useState({});
  const [cascadeMode,     setCascadeMode]     = useState('full');
  const [completedIds,    setCompletedIds]    = useState(() => loadCompleted());
  const [statusOverrides, setStatusOverrides] = useState(() => loadStatusOverrides());

  const todayMs = useMemo(() => { const d = new Date(); d.setHours(0,0,0,0); return d.getTime(); }, []);

  const tasks = useMemo(() => buildSched(rawTasks, tdepMap, base, simDelays, cascadeMode, completedIds, todayMs), [rawTasks, tdepMap, base, simDelays, cascadeMode, completedIds, todayMs]);

  const toggleComplete = useCallback(taskId => {
    setCompletedIds(prev => {
      const next = new Set(prev);
      next.has(taskId) ? next.delete(taskId) : next.add(taskId);
      saveCompleted(next);
      return next;
    });
    // Clear any status override when toggling complete — let engine decide
    setStatusOverrides(prev => {
      const next = new Map(prev);
      next.delete(taskId);
      saveStatusOverrides(next);
      return next;
    });
  }, []);

  const setStatusOverride = useCallback((taskId, status) => {
    setStatusOverrides(prev => {
      const next = new Map(prev);
      if (status === null) next.delete(taskId);
      else next.set(taskId, status);
      saveStatusOverrides(next);
      return next;
    });
  }, []);

  // Save a full typed dep list for a task (replaces xlsx deps for that task)
  const saveTaskDeps = useCallback((taskId, typedDeps) => {
    // 1. Persist the override
    const map = loadDepOverrides();
    if (typedDeps.length === 0) map.delete(taskId);
    else map.set(taskId, typedDeps);
    saveDepOverrides(map);
    // 2. Rebuild from baseData so applyEditsToData doesn't double-merge
    if (!baseData) return;
    const currentEdits = loadSchedEdits();
    setSchedData(applyEditsToData(baseData, currentEdits));
  }, [baseData]);

  const [tab,        setTab]        = useState('gantt');
  const [sel,        setSel]        = useState(null);
  const [editTarget, setEditTarget] = useState(null);
  const [showResolver, setShowResolver] = useState(false);
  const [addTasksProj, setAddTasksProj] = useState(null); // project to add tasks to

  const kpi = {
    total:     tasks.length,
    conflicts: tasks.filter(t => t.isC).length,
    fragile:   tasks.filter(t => t.isF).length,
    depViol:   tasks.filter(t => t.isDV).length,
  };

  const handleEdit      = useCallback(target => setEditTarget(target), []);
  const handleApply     = useCallback((nd, mode) => { setSimDelays(nd); if (mode) setCascadeMode(mode); }, []);

  // Persist a real timeline shift — rewrites rawTask dates via the edits layer
  const handleShift = useCallback((taskIds, days, mode) => {
    const bd = { rawTasks, projs, people, tdepMap, base, todayDay, periods };
    const currentEdits = loadSchedEdits();

    // Build the full set of task IDs to shift based on cascade mode
    // For 'full'/'min': also shift tasks that would cascade in buildSched
    // We compute this by running buildSched with a temporary delay and seeing what moved
    let allIds = [...taskIds];
    if (mode !== 'none') {
      const tempDelays = {};
      taskIds.forEach(id => { tempDelays[id] = Math.abs(days); });
      const preview = buildSched(rawTasks, tdepMap, base, tempDelays, mode);
      const orig    = buildSched(rawTasks, tdepMap, base, {}, mode);
      const origMap = Object.fromEntries(orig.map(t => [t.id, t]));
      preview.forEach(t => {
        if (origMap[t.id] && t.sd !== origMap[t.id].sd) allIds.push(t.id);
      });
      allIds = [...new Set(allIds)];
    }

    const updated = mutateSchedData(bd, currentEdits, { type:'shiftTimeline', taskIds: allIds, days });
    onMutate(updated);
    // Clear any simDelays for shifted tasks — they're now baked into rawTasks
    setSimDelays(prev => {
      const nd = { ...prev };
      allIds.forEach(id => delete nd[id]);
      return nd;
    });
  }, [rawTasks, projs, people, tdepMap, base, todayDay, periods]);

  // Called by EditModal or ProjectView delete buttons
  const handleDelete = useCallback(mutation => {
    const baseData = { rawTasks, projs, people, tdepMap, base, todayDay, periods };
    const currentEdits = loadSchedEdits();
    const updated = mutateSchedData(baseData, currentEdits, mutation);
    // Signal parent to update schedData — via a shared setter passed as prop
    onMutate(updated);
    // Also clear any simDelays referencing deleted tasks/projects
    if (mutation.type === 'deleteTask') {
      setSimDelays(prev => { const nd = {...prev}; delete nd[mutation.taskId]; return nd; });
    }
    if (mutation.type === 'deleteProject') {
      setSimDelays(prev => {
        const nd = {...prev};
        rawTasks.filter(t => t.proj === mutation.projId).forEach(t => delete nd[t.id]);
        return nd;
      });
    }
  }, [rawTasks, projs, people, tdepMap, base, todayDay, periods]);

  const handleAddTasks = useCallback(({ tasks: newTasks, people: newPeople }) => {
    const baseData = { rawTasks, projs, people, tdepMap, base, todayDay, periods };
    const currentEdits = loadSchedEdits();
    const updated = mutateSchedData(baseData, currentEdits, { type:'addTasks', tasks:newTasks, people:newPeople });
    onMutate(updated);
  }, [rawTasks, projs, people, tdepMap, base, todayDay, periods]);

  // A task counts as "effectively completed" if either the engine marks it complete
  // or a status override of "Completed" has been applied.
  const isEffectivelyCompleted = t => t.isCompleted || statusOverrides.get(t.id) === 'Completed';

  // A project is "on schedule" if none of its active (non-completed) tasks are:
  // overdue, conflicted, dep-violated, or have a simulated delay applied.
  const delayedTaskIds = new Set(Object.keys(simDelays).filter(id => simDelays[id] > 0));
  const onSchedule    = projs.filter(p => {
    const pt = tasks.filter(t => t.projId === p.id && !isEffectivelyCompleted(t));
    return !pt.some(t => t.isC || t.isDV || t.isOverdue || delayedTaskIds.has(t.id));
  }).length;
  const onSchedulePct = projs.length ? Math.round((onSchedule / projs.length) * 100) : 0;
  const projRisk      = projs.filter(p => tasks.filter(t => t.projId === p.id && !isEffectivelyCompleted(t)).some(t => t.isC));
  const crossRisk     = projs.filter(p => tasks.filter(t => t.projId === p.id && !isEffectivelyCompleted(t)).some(t => t.isDV));

  const TAB_ITEMS = [
    {id:'gantt',l:'Gantt Chart'},{id:'project',l:'Project View'},{id:'workflows',l:'Workflows'},{id:'conflicts',l:'Conflicts'},{id:'people',l:'Resource'}
  ];

  return (
    <ScheduleCtx.Provider value={schedData}>
      <div style={{ fontFamily:'-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif', background:SURFACE, minHeight:'100vh', color:TEXT }}>

        {editTarget && (
          <EditModal target={editTarget} tasks={tasks} simDelays={simDelays} onApply={handleApply} onShift={handleShift} onClose={() => setEditTarget(null)} onDelete={handleDelete} statusOverrides={statusOverrides} onSetStatus={setStatusOverride} todayMs={todayMs} onSaveDeps={saveTaskDeps} />
        )}

        {addTasksProj && (
          <AddTasksModal
            proj={addTasksProj}
            existingTasks={rawTasks.filter(t => t.proj === addTasksProj.id)}
            existingPeople={people}
            onAdd={handleAddTasks}
            onClose={() => setAddTasksProj(null)}
          />
        )}

        {/* Nav */}
        <div style={{ background:NAV, padding:'0 28px', height:'52px', display:'flex', alignItems:'center', justifyContent:'space-between', borderBottom:`1px solid ${BORDER}` }}>
          <div style={{ display:'flex', alignItems:'center' }}>
            <span style={{ color:ORANGE, fontWeight:'800', fontSize:'18px', letterSpacing:'-0.5px', marginRight:'32px' }}>Interscale</span>
            {TAB_ITEMS.map(t => (
              <button key={t.id} onClick={() => { setTab(t.id); if (t.id==='people'&&!sel) setSel(people[0]?.name||null); }}
                style={{ padding:'0 18px', height:'52px', border:'none', background:'none', cursor:'pointer', fontSize:'13px', fontWeight:'500', color:tab===t.id?ORANGE:MUTED, borderBottom:tab===t.id?`2px solid ${ORANGE}`:'2px solid transparent', whiteSpace:'nowrap' }}>
                {t.l}
              </button>
            ))}
          </div>
          <div style={{ display:'flex', alignItems:'center', gap:'12px' }}>
            <div style={{ display:'flex', alignItems:'center', gap:'8px', background:'#1E1E2A', border:`1px solid ${BORDER}`, borderRadius:'8px', padding:'6px 12px', minWidth:'200px' }}>
              <svg width="13" height="13" fill="none" viewBox="0 0 16 16"><circle cx="6.5" cy="6.5" r="5" stroke={MUTED} strokeWidth="1.5"/><path d="M10.5 10.5 14 14" stroke={MUTED} strokeWidth="1.5" strokeLinecap="round"/></svg>
              <span style={{ fontSize:'12px', color:MUTED }}>Search tasks, people...</span>
            </div>
            <button style={{ padding:'6px 14px', borderRadius:'8px', border:`1px solid ${BORDER}`, background:'transparent', color:TEXT, fontSize:'12px', cursor:'pointer' }}>
              AI Chat and Notifications?
            </button>
          </div>
        </div>

        {/* KPI row */}
        <div style={{ display:'flex', gap:'12px', padding:'20px 28px 0' }}>
          <div style={{ background:CARD, borderRadius:'10px', padding:'16px 18px', border:`1px solid ${BORDER}`, minWidth:'140px' }}>
            <div style={{ fontSize:'11px', color:MUTED, marginBottom:'6px' }}>
              <svg width="14" height="14" fill="none" viewBox="0 0 16 16"><rect x="1" y="1" width="6" height="6" rx="1" stroke={MUTED} strokeWidth="1.4"/><rect x="9" y="1" width="6" height="6" rx="1" stroke={MUTED} strokeWidth="1.4"/><rect x="1" y="9" width="6" height="6" rx="1" stroke={MUTED} strokeWidth="1.4"/><rect x="9" y="9" width="6" height="6" rx="1" stroke={MUTED} strokeWidth="1.4"/></svg>
            </div>
            <div style={{ fontSize:'28px', fontWeight:'800', color:TEXT, lineHeight:'1', fontVariantNumeric:'tabular-nums' }}>{projs.length}</div>
            <div style={{ fontSize:'11px', color:MUTED, marginTop:'4px' }}>Total Projects</div>
          </div>

          <div style={{ background:CARD, borderRadius:'10px', padding:'16px 18px', border:`1px solid ${BORDER}`, minWidth:'160px' }}>
            <div style={{ fontSize:'11px', color:MUTED, marginBottom:'6px' }}>
              <svg width="14" height="14" fill="none" viewBox="0 0 16 16"><rect x="1" y="2" width="14" height="12" rx="2" stroke={MUTED} strokeWidth="1.4"/><path d="M1 6h14" stroke={MUTED} strokeWidth="1.4"/><path d="M5 1v2M11 1v2" stroke={MUTED} strokeWidth="1.4" strokeLinecap="round"/></svg>
            </div>
            <div style={{ fontSize:'28px', fontWeight:'800', color:TEXT, lineHeight:'1', fontVariantNumeric:'tabular-nums' }}>{onSchedulePct}<span style={{ fontSize:'16px', fontWeight:'600' }}>%</span></div>
            <div style={{ fontSize:'11px', color:MUTED, marginTop:'4px' }}>Projects On Schedule</div>
          </div>

          <div onClick={() => { if (kpi.conflicts>0) setTab('conflicts'); }}
            style={{ background:kpi.conflicts>0?'#3B1219':CARD, borderRadius:'10px', padding:'16px 18px', border:`1px solid ${kpi.conflicts>0?'#7F1D1D':BORDER}`, minWidth:'160px', cursor:kpi.conflicts>0?'pointer':'default', position:'relative', flex:1 }}>
            <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:'8px' }}>
              <span style={{ fontSize:'12px', fontWeight:'600', color:kpi.conflicts>0?'#FCA5A5':MUTED }}>Project Risk</span>
              {kpi.conflicts>0 && <svg width="14" height="14" fill="none" viewBox="0 0 16 16"><path d="M8 2L14 14H2L8 2Z" stroke="#FCA5A5" strokeWidth="1.4"/><path d="M8 7v3M8 11.5v.5" stroke="#FCA5A5" strokeWidth="1.4" strokeLinecap="round"/></svg>}
            </div>
            <div style={{ display:'flex', alignItems:'baseline', gap:'6px' }}>
              <span style={{ fontSize:'28px', fontWeight:'800', color:kpi.conflicts>0?'#FCA5A5':MUTED, lineHeight:'1', fontVariantNumeric:'tabular-nums' }}>{kpi.conflicts>0?projRisk.length:'—'}</span>
              {kpi.conflicts>0 && projRisk[0] && <span style={{ fontSize:'13px', color:'#FCA5A5', fontWeight:'600' }}>({projRisk[0].id})</span>}
            </div>
            {kpi.conflicts>0
              ? <div style={{ fontSize:'11px', color:'#F87171', marginTop:'6px', display:'flex', alignItems:'center', gap:'4px' }}>View <span>›</span></div>
              : <div style={{ fontSize:'11px', color:MUTED, marginTop:'4px' }}>No issues</div>
            }
            {showResolver && kpi.conflicts>0 && (
              <ConflictResolutionPopover tasks={tasks} simDelays={simDelays} onApply={handleApply} onClose={() => setShowResolver(false)} />
            )}
          </div>

          <div onClick={() => { if (kpi.depViol>0) setTab('conflicts'); }}
            style={{ background:kpi.depViol>0?'#3B1219':CARD, borderRadius:'10px', padding:'16px 18px', border:`1px solid ${kpi.depViol>0?'#7F1D1D':BORDER}`, minWidth:'180px', cursor:kpi.depViol>0?'pointer':'default', flex:1 }}>
            <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:'8px' }}>
              <span style={{ fontSize:'12px', fontWeight:'600', color:kpi.depViol>0?'#FCA5A5':MUTED }}>Cross Project Risk</span>
              {kpi.depViol>0 && <svg width="14" height="14" fill="none" viewBox="0 0 16 16"><path d="M8 2L14 14H2L8 2Z" stroke="#FCA5A5" strokeWidth="1.4"/><path d="M8 7v3M8 11.5v.5" stroke="#FCA5A5" strokeWidth="1.4" strokeLinecap="round"/></svg>}
            </div>
            <div style={{ display:'flex', alignItems:'baseline', gap:'6px' }}>
              <span style={{ fontSize:'28px', fontWeight:'800', color:kpi.depViol>0?'#FCA5A5':MUTED, lineHeight:'1', fontVariantNumeric:'tabular-nums' }}>{kpi.depViol>0?crossRisk.length:'—'}</span>
              {kpi.depViol>0 && crossRisk[0] && <span style={{ fontSize:'13px', color:'#FCA5A5', fontWeight:'600' }}>({crossRisk[0].id})</span>}
            </div>
            {kpi.depViol>0
              ? <div style={{ fontSize:'11px', color:'#F87171', marginTop:'6px', display:'flex', alignItems:'center', gap:'4px' }}>View <span>›</span></div>
              : <div style={{ fontSize:'11px', color:MUTED, marginTop:'4px' }}>No issues</div>
            }
          </div>

          <div style={{ background:CARD, borderRadius:'10px', padding:'16px 18px', border:`1px dashed ${BORDER}`, minWidth:'120px', display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', cursor:'pointer', gap:'6px' }}>
            <span style={{ fontSize:'11px', color:MUTED }}>Add KPI</span>
            <div style={{ width:'28px', height:'28px', borderRadius:'50%', border:`1.5px solid ${BORDER}`, display:'flex', alignItems:'center', justifyContent:'center', color:MUTED, fontSize:'18px', lineHeight:'1' }}>+</div>
          </div>
        </div>

        {/* Action row */}
        <div style={{ display:'flex', justifyContent:'flex-end', gap:'10px', padding:'14px 28px 0' }}>
          <button onClick={onImport}
            style={{ display:'flex', alignItems:'center', gap:'6px', padding:'7px 16px', borderRadius:'8px', border:`1px solid ${BORDER}`, background:'transparent', color:TEXT, fontSize:'12px', cursor:'pointer', fontWeight:'500' }}>
            <svg width="13" height="13" fill="none" viewBox="0 0 16 16"><path d="M8 2v9M4 8l4 4 4-4" stroke={TEXT} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/><path d="M2 13h12" stroke={TEXT} strokeWidth="1.5" strokeLinecap="round"/></svg>
            Import
          </button>
          <button onClick={onClear}
            style={{ display:'flex', alignItems:'center', gap:'6px', padding:'7px 16px', borderRadius:'8px', border:`1px solid #7F1D1D`, background:'transparent', color:'#F87171', fontSize:'12px', cursor:'pointer', fontWeight:'500' }}>
            Clear Data
          </button>
          <button onClick={onNewProject}
            style={{ padding:'7px 16px', borderRadius:'8px', border:'none', background:ORANGE, color:'white', fontSize:'12px', cursor:'pointer', fontWeight:'700' }}>
            + New Project
          </button>
        </div>

        {/* Tab panel */}
        <div style={{ margin:'14px 28px 28px', background:CARD, borderRadius:'12px', border:`1px solid ${BORDER}`, overflow:'hidden' }}>
          {tab==='gantt'     && <ProjectGanttTab tasks={tasks} simDelays={simDelays} setSimDelays={setSimDelays} onEdit={handleEdit} setAddTasksProj={setAddTasksProj} onToggleComplete={toggleComplete} statusOverrides={statusOverrides} todayMs={todayMs} />}
          {tab==='project'   && <ProjectViewTab tasks={tasks} onDelete={handleDelete} onEdit={handleEdit} onToggleComplete={toggleComplete} statusOverrides={statusOverrides} onSetStatus={setStatusOverride} todayMs={todayMs} />}
          {tab==='workflows' && <WorkflowsTab />}
          {tab==='conflicts' && <ConflictsTab tasks={tasks} />}
          {tab==='people'    && <PeopleTab tasks={tasks} sel={sel} onSel={setSel} statusOverrides={statusOverrides} todayMs={todayMs} />}
        </div>
      </div>
    </ScheduleCtx.Provider>
  );
}