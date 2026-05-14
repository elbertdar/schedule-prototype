// ── Edits layer ──────────────────────────────────────────────────────────────
// Manages user mutations (add task, delete project, shift timeline, etc) on top
// of the base parsed xlsx data. Edits are persisted as a single JSON blob;
// applying them rebuilds the schedData object.

import { addW, parseDate, fmtDDMMYYYY } from './dates.jsx';
import { loadDepOverrides, saveSchedEdits } from '../storage/persist.jsx';

/**
 * Merge saved edits into a parsed schedData object.
 * Edits shape: { rawTasks, projs, people, deletedIds, deletedProjs }
 *
 * @param {object} base - Parsed schedData (from parseXlsx)
 * @param {object|null} edits
 * @returns {object} New schedData with edits applied
 */
export function applyEditsToData(base, edits) {
  if (!edits) return base;

  const deletedIds   = new Set(edits.deletedIds   || []);
  const deletedProjs = new Set(edits.deletedProjs || []);

  let rawTasks = [
    ...base.rawTasks,
    ...(edits.rawTasks || []),
  ].filter(t => !deletedIds.has(t.id) && !deletedProjs.has(t.proj));

  let projs = [
    ...base.projs,
    ...(edits.projs || []).filter(p => !base.projs.find(x => x.id === p.id)),
  ].filter(p => !deletedProjs.has(p.id));

  let people = [
    ...base.people,
    ...(edits.people || []).filter(p => !base.people.find(x => x.name === p.name)),
  ];

  // Prune people with no remaining tasks
  const activePeople = new Set(rawTasks.map(t => t.person));
  people = people.filter(p => activePeople.has(p.name));

  const tdepMap = Object.fromEntries(rawTasks.map(t => [t.id, t.deps]));

  // Overlay typed dep overrides
  const depOverrides = loadDepOverrides();
  for (const [taskId, typedDeps] of depOverrides.entries()) {
    if (rawTasks.find(t => t.id === taskId)) {
      tdepMap[taskId] = typedDeps;
    }
  }

  return { ...base, rawTasks, projs, people, tdepMap };
}

/**
 * Apply a mutation: persists the new edits blob and returns the updated schedData.
 *
 * @param {object} baseData - Parsed schedData
 * @param {object|null} currentEdits - Previously saved edits (or null)
 * @param {object} mutation - One of:
 *   { type:'deleteTask', taskId }
 *   { type:'deleteProject', projId }
 *   { type:'addTasks', tasks, people }
 *   { type:'shiftTimeline', taskIds, days }
 * @returns {object} New schedData
 */
export function mutateSchedData(baseData, currentEdits, mutation) {
  const edits = {
    rawTasks:     [...(currentEdits?.rawTasks     || [])],
    projs:        [...(currentEdits?.projs        || [])],
    people:       [...(currentEdits?.people       || [])],
    deletedIds:   [...(currentEdits?.deletedIds   || [])],
    deletedProjs: [...(currentEdits?.deletedProjs || [])],
  };

  switch (mutation.type) {
    case 'deleteTask': {
      if (!edits.deletedIds.includes(mutation.taskId)) edits.deletedIds.push(mutation.taskId);
      edits.rawTasks = edits.rawTasks.filter(t => t.id !== mutation.taskId);
      break;
    }
    case 'deleteProject': {
      if (!edits.deletedProjs.includes(mutation.projId)) edits.deletedProjs.push(mutation.projId);
      edits.rawTasks = edits.rawTasks.filter(t => t.proj !== mutation.projId);
      edits.projs    = edits.projs.filter(p => p.id !== mutation.projId);
      break;
    }
    case 'addTasks': {
      edits.rawTasks.push(...mutation.tasks);
      for (const p of (mutation.people || [])) {
        if (!edits.people.find(x => x.name === p.name)) edits.people.push(p);
      }
      break;
    }
    case 'shiftTimeline': {
      const { taskIds, days } = mutation;
      // Most up-to-date raw task for each id (base + already-edited)
      const rawMap = {};
      for (const t of [...baseData.rawTasks, ...edits.rawTasks]) rawMap[t.id] = t;

      for (const id of taskIds) {
        const t = rawMap[id];
        if (!t) continue;
        const sDate = parseDate(t.start);
        const eDate = parseDate(t.end);
        if (!sDate || !eDate) continue;
        const shifted = {
          ...t,
          start: fmtDDMMYYYY(addW(sDate, days)),
          end:   fmtDDMMYYYY(addW(eDate, days)),
        };
        const idx = edits.rawTasks.findIndex(x => x.id === id);
        if (idx >= 0) edits.rawTasks[idx] = shifted;
        else edits.rawTasks.push(shifted);
        edits.deletedIds = edits.deletedIds.filter(x => x !== id);
      }
      break;
    }
    default: {
      // Unknown mutation — no-op, but warn in dev
      console.warn('mutateSchedData: unknown mutation type', mutation);
    }
  }

  saveSchedEdits(edits);
  return applyEditsToData(baseData, edits);
}
