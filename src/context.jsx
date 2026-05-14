// ── Schedule context ─────────────────────────────────────────────────────────
// All components read rawTasks, projs, people, tdepMap, base, todayDay,
// periods through this context — no prop drilling for shared data.

import { createContext, useContext } from 'react';

export const ScheduleCtx = createContext(null);

/**
 * Access the parsed schedule data. Returns null if no data is loaded yet —
 * components should guard with `if (!ctx) return null;` or similar.
 */
export const useSched = () => useContext(ScheduleCtx);
