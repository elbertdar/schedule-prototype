// ── Task status ──────────────────────────────────────────────────────────────
// Single source of truth for how a task's status is determined and styled.

export const ALL_STATUSES = ['On Track', 'In Progress', 'Completed', 'Overdue', 'Conflict', 'Fragile'];

/**
 * Resolve the effective status for a task. An override always wins;
 * otherwise the engine's computed flags decide.
 * @param {object} t - Task object from buildSched (has .id, .isCompleted, .isOverdue, .isC, .isF, .s)
 * @param {Map<string, string>} statusOverrides
 * @param {number} todayMs - Today at 00:00 in ms
 * @returns {string} One of ALL_STATUSES
 */
export function computeStatus(t, statusOverrides, todayMs) {
  if (statusOverrides && statusOverrides.has(t.id)) return statusOverrides.get(t.id);
  if (t.isCompleted)             return 'Completed';
  if (t.isOverdue)               return 'Overdue';
  if (t.isC)                     return 'Conflict';
  if (t.isF)                     return 'Fragile';
  if (t.s.getTime() <= todayMs)  return 'In Progress';
  return 'On Track';
}

/** Badge styles keyed by status. Each value: { bg, tx, bd } (background, text, border). */
export const STATUS_STYLES = {
  'Completed':   { bg:'#0D2B1E', tx:'#34D399', bd:'#065F46' },
  'Overdue':     { bg:'#3B1219', tx:'#FB923C', bd:'#C2410C' },
  'Conflict':    { bg:'#3B1219', tx:'#F87171', bd:'#7F1D1D' },
  'Fragile':     { bg:'#2D2200', tx:'#FBBF24', bd:'#92400E' },
  'In Progress': { bg:'#0D2235', tx:'#38BDF8', bd:'#0369A1' },
  'On Track':    { bg:'#0F1F14', tx:'#4ADE80', bd:'#166534' },
};
