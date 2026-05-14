// ── XLSX parser ──────────────────────────────────────────────────────────────
// Reads an ArrayBuffer from an .xlsx file.
// Expected sheet "Schedule" (or first sheet) with columns:
//   Project | Task ID | Task Name | Assigned | Role | Rate | Start | End | Dependencies | Status
// Optional second sheet matching /people|resource|team/ to provide person metadata.

import { parseDate, calDiff } from './dates.jsx';
import { PROJ_COLORS, PERSON_COLORS } from '../theme.jsx';

/**
 * @param {ArrayBuffer} buffer
 * @returns {Promise<{rawTasks, projs, people, tdepMap, base, todayDay, periods}>}
 */
export async function parseXlsx(buffer) {
  // Dynamic import — works in Vite. If you migrate to a bundler that doesn't
  // support HTTP imports (Next/CRA), `npm install xlsx` and change to:
  //   import * as XLSX from 'xlsx';
  const XLSX = await import('https://cdn.sheetjs.com/xlsx-0.20.1/package/xlsx.mjs');
  const wb = XLSX.read(buffer, { type:'array', cellDates:true });

  // ── Schedule sheet ─────────────────────────────────────────────────────────
  const sheetName = wb.SheetNames.find(n => /schedule/i.test(n)) || wb.SheetNames[0];
  const ws = wb.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(ws, { defval:'' });
  if (!rows.length) throw new Error('Schedule sheet is empty.');

  const norm = obj => {
    const out = {};
    for (const [k, v] of Object.entries(obj)) out[k.trim().toLowerCase().replace(/\s+/g,'_')] = v;
    return out;
  };
  const data = rows.map(norm);

  const col = (row, ...keys) => {
    for (const k of keys) { if (row[k] !== undefined && row[k] !== '') return row[k]; }
    return '';
  };

  const rawTasks = [];
  const projOrder = [], personOrder = [];
  const projMap = {}, personMap = {};

  for (const row of data) {
    const projId   = String(col(row, 'project', 'proj')).trim();
    const seqId    = String(col(row, 'task_id', 'taskid', 'id')).trim();
    const name     = String(col(row, 'task_name', 'taskname', 'name')).trim();
    const person   = String(col(row, 'assigned', 'person', 'resource')).trim();
    const role     = String(col(row, 'role')).trim();
    const rate     = String(col(row, 'rate')).trim();
    const startRaw = col(row, 'start', 'start_date');
    const endRaw   = col(row, 'end', 'end_date', 'finish');
    const depsRaw  = String(col(row, 'dependencies', 'depends_on', 'deps')).trim();

    if (!projId || !seqId || !name) continue;

    const id = `${projId}-${seqId}`;
    const startD = startRaw instanceof Date ? startRaw : parseDate(startRaw);
    const endD   = endRaw   instanceof Date ? endRaw   : parseDate(endRaw);
    if (!startD || !endD) continue;

    const fmt = d => `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}/${d.getFullYear()}`;
    const dur = Math.max(1, Math.round(Math.abs(endD - startD) / (864e5 * 7 / 5)));

    const deps = depsRaw
      ? depsRaw.split(/[,;]+/).map(d => {
          const clean = d.trim();
          if (!clean) return null;
          return clean.includes('-') ? clean : `${projId}-${clean}`;
        }).filter(Boolean)
      : [];

    if (!projMap[projId]) {
      projMap[projId] = {
        id: projId,
        name: `${projId} — New Build`,
        color: PROJ_COLORS[projOrder.length % PROJ_COLORS.length],
        base: startD,
      };
      projOrder.push(projId);
    } else if (startD < projMap[projId].base) {
      projMap[projId].base = startD;
    }

    if (person && !personMap[person]) {
      const init = person.split(' ').map(w=>w[0]).join('').slice(0,2).toUpperCase();
      personMap[person] = {
        name: person, role, init,
        color: PERSON_COLORS[personOrder.length % PERSON_COLORS.length],
        rate: rate || '$42/hr',
      };
      personOrder.push(person);
    }
    if (person && rate && personMap[person]) personMap[person].rate = rate;

    rawTasks.push({ id, proj:projId, name, person, dur, start:fmt(startD), end:fmt(endD), deps });
  }

  // ── Optional People sheet ──────────────────────────────────────────────────
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

  const allStarts = rawTasks.map(t => parseDate(t.start)).filter(Boolean);
  const earliest = new Date(Math.min(...allStarts.map(d => d.getTime())));
  const baseYear = new Date(earliest.getFullYear(), 0, 1);

  const today = new Date();
  today.setHours(0,0,0,0);
  const todayDay = calDiff(baseYear, today);

  // Build month periods covering all tasks (up to 24 months)
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
