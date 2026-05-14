// ── Scheduling engine ────────────────────────────────────────────────────────
// Pure functions. No React, no DOM, no localStorage. Given raw tasks + delays,
// returns the computed schedule with conflict/fragile/dep-violation flags.

import { addW, calDiff, wdayGap, parseDate } from './dates.jsx';

// ── Dependency normalization ────────────────────────────────────────────────
/**
 * Normalize a dep entry (string or {id,type}) into {id, type}.
 * Default type is 'FS' (Finish-to-Start).
 * @param {string|{id:string,type?:string}} d
 * @returns {{id:string, type:string}}
 */
export function normDep(d) {
  if (typeof d === 'string') return { id: d, type: 'FS' };
  return { id: d.id, type: d.type || 'FS' };
}

/**
 * DFS cycle check: would adding fromId → toId create a cycle in typedDepMap?
 * @param {string} fromId
 * @param {string} toId
 * @param {Record<string, Array<string|object>>} typedDepMap
 * @returns {boolean}
 */
export function hasCycle(fromId, toId, typedDepMap) {
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

// ── Bezier midpoint ─────────────────────────────────────────────────────────
/**
 * Cubic bezier midpoint (t=0.5) + tangent angle in degrees.
 * Used by Gantt arrows to place the mid-arrow marker.
 */
export function bezierMid(x0, y0, cx1, cy1, cx2, cy2, x1, y1) {
  const t = 0.5, mt = 0.5;
  const mx = mt*mt*mt*x0 + 3*mt*mt*t*cx1 + 3*mt*t*t*cx2 + t*t*t*x1;
  const my = mt*mt*mt*y0 + 3*mt*mt*t*cy1 + 3*mt*t*t*cy2 + t*t*t*y1;
  const dx = 3*(mt*mt*(cx1-x0) + 2*mt*t*(cx2-cx1) + t*t*(x1-cx2));
  const dy = 3*(mt*mt*(cy1-y0) + 2*mt*t*(cy2-cy1) + t*t*(y1-cy2));
  return { mx, my, angle: Math.atan2(dy, dx) * 180 / Math.PI };
}

// ── buildSched ───────────────────────────────────────────────────────────────
/**
 * Build the full computed schedule from raw tasks, dependencies, and delays.
 *
 * @param {Array} rawTasks - Each: { id, proj, name, person, dur, start, end, deps }
 * @param {Record<string, Array>} tdepMap - Task id → array of dep entries (string or {id,type})
 * @param {Date} base - Timeline base date (used for sd offset)
 * @param {Record<string, number>} [extraDelays] - Task id → working-day delay
 * @param {'full'|'min'|'none'} [cascadeMode] - How delays propagate
 * @param {Set<string>} [completedIds] - Tasks marked completed
 * @param {number} [todayMs] - Today at 00:00 in ms
 * @returns {Array} Computed task objects with conflict/fragile/dep-violation flags
 */
export function buildSched(rawTasks, tdepMap, base, extraDelays = {}, cascadeMode = 'full', completedIds = new Set(), todayMs = Date.now()) {
  if (!rawTasks || !rawTasks.length || !base) return [];

  // ── Index rawTasks once. Original used .find() inside getStart which was O(n)
  //    per recursive call. This is a free win — same behavior, cleaner code.
  const taskById = new Map();
  for (const t of rawTasks) taskById.set(t.id, t);

  // Compute originals once
  const origStart = {};
  const origEnd   = {};
  for (const t of rawTasks) {
    origStart[t.id] = parseDate(t.start);
    origEnd[t.id]   = parseDate(t.end);
  }

  const computedStart = {};
  const computedEnd   = {};
  const directlyDelayed = new Set(Object.keys(extraDelays));

  function getStart(id) {
    if (computedStart[id] !== undefined) return computedStart[id];
    const t = taskById.get(id);
    if (!t) return (computedStart[id] = base);

    const oS = origStart[id];
    const ownDelay = extraDelays[id] || 0;
    let actualStart = ownDelay > 0 ? addW(oS, ownDelay) : new Date(oS);

    // 'none' mode: frozen — only directly delayed tasks move
    if (cascadeMode === 'none') {
      if (!directlyDelayed.has(id)) {
        computedStart[id] = new Date(oS);
        return computedStart[id];
      }
      computedStart[id] = actualStart;
      return actualStart;
    }

    // Latest constraint from deps (respects FS vs SS type)
    let latestDepEnd = null;
    for (const depRaw of (t.deps || [])) {
      const { id: depId, type: depType } = normDep(depRaw);
      const constraint = depType === 'SS' ? getStart(depId) : getEnd(depId);
      if (!latestDepEnd || constraint > latestDepEnd) latestDepEnd = constraint;
    }

    if (latestDepEnd && latestDepEnd > actualStart) {
      // Both 'full' and 'min' must wait until dep finishes if it ends after our start.
      // ('min' previously had a dead-code branch here — both sides of the ternary
      //  called wdayGap with the same args and the result was discarded. Removed.)
      actualStart = addW(latestDepEnd, 1);
    }
    // For 'min': if dep ends BEFORE our original start, we absorb. No movement.
    // floatConsumed is computed below from the original gap shrinking.

    computedStart[id] = actualStart;
    return actualStart;
  }

  function getEnd(id) {
    if (computedEnd[id] !== undefined) return computedEnd[id];
    const t = taskById.get(id);
    if (!t) return (computedEnd[id] = base);
    const dur = calDiff(origStart[id], origEnd[id]);
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

    // Float consumed (min mode): how much of our original gap-to-deps got eaten
    let floatConsumed = 0;
    if (cascadeMode === 'min' && t.deps.length > 0 && totalPush === 0 && ownDelay === 0) {
      for (const depRaw of t.deps) {
        const { id: depId } = normDep(depRaw);
        const depNewEnd = computedEnd[depId];
        const depOrigEnd = origEnd[depId];
        if (depNewEnd && depOrigEnd && depNewEnd > depOrigEnd) {
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

  // ── Conflict detection (resource overlap, same person) ─────────────────────
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      const a = all[i], b = all[j];
      if (a.person !== b.person) continue;
      if (a.s <= b.e && b.s <= a.e) {
        a.isC = b.isC = true;
        a.cw.push(b.id);
        b.cw.push(a.id);
      }
    }
  }

  // ── Fragile detection (consecutive same-person tasks with ≤1 day gap) ──────
  const byP = {};
  for (const t of all) (byP[t.person] = byP[t.person] || []).push(t);
  for (const ts of Object.values(byP)) {
    ts.sort((a, b) => a.s - b.s);
    for (let i = 0; i < ts.length - 1; i++) {
      const gap = wdayGap(ts[i].e, ts[i + 1].s);
      if (gap <= 1) {
        ts[i].isF = ts[i + 1].isF = true;
      }
      // Min mode: tightened gap due to consumed float is also fragile
      if (cascadeMode === 'min' && ts[i + 1].floatConsumed > 0 && gap <= 2) {
        ts[i].isF = ts[i + 1].isF = true;
      }
    }
  }

  // ── Dep violation detection (none mode only) ───────────────────────────────
  if (cascadeMode === 'none') {
    const taskMap = Object.fromEntries(all.map(t => [t.id, t]));
    for (const t of all) {
      for (const depRaw of (tdepMap[t.id] || [])) {
        const { id: depId } = normDep(depRaw);
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

// ── computeResolution ────────────────────────────────────────────────────────
/**
 * Find the minimum extra delays that eliminate all current conflicts.
 * Iteratively pushes the later project's root task forward to clear each overlap.
 *
 * @param {Array} rawTasks
 * @param {object} tdepMap
 * @param {Date} base
 * @param {Array} projs
 * @param {Record<string, number>} currentDelays
 * @param {Array} currentTasks - Current computed tasks (must have .isC, .cw, .s, .e)
 * @returns {null | {resDelays, addedDelays, affectedProjects, newEnd}}
 */
export function computeResolution(rawTasks, tdepMap, base, projs, currentDelays, currentTasks) {
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
        const toBePushed = t.s > other.s ? t : other.s > t.s ? other : (tIdx > oIdx ? t : other);

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
