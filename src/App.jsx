// ── App ──────────────────────────────────────────────────────────────────────
// Top-level: handles xlsx import, persistence wiring, and the empty state.
// Once data is loaded, renders <ScheduleApp /> which owns the dashboard.

import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { ScheduleCtx } from './context.jsx';
import { ErrorBoundary } from './components/ErrorBoundary.jsx';
import {
  loadFromStorage, saveToStorage,
  loadSchedEdits, saveSchedEdits,
  loadCompleted, saveCompleted,
  loadStatusOverrides, saveStatusOverrides,
  loadDepOverrides, saveDepOverrides,
  clearAllStorage,
  LS_KEY, LS_EDITS_KEY,
} from './storage/persist.jsx';
import { parseXlsx } from './engine/xlsx.jsx';
import { buildSched } from './engine/schedule.jsx';
import { applyEditsToData, mutateSchedData } from './engine/edits.jsx';
import { NAV, SURFACE, CARD, BORDER, ORANGE, TEXT, MUTED } from './theme.jsx';

import { EditModal } from './components/EditModal.jsx';
import { ConflictResolutionPopover } from './components/ConflictResolutionPopover.jsx';
import { ProjectGanttTab } from './components/tabs/ProjectGanttTab.jsx';
import { ProjectViewTab } from './components/tabs/ProjectViewTab.jsx';
import { ConflictsTab } from './components/tabs/ConflictsTab.jsx';
import { PeopleTab } from './components/tabs/PeopleTab.jsx';
import { WorkflowsTab } from './components/tabs/WorkflowsTab.jsx';
import { AddTasksModal } from './components/modals/AddTasksModal.jsx';
import { NewProjectModal } from './components/modals/NewProjectModal.jsx';

const FONT_STACK = '-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif';

// ── App: imports/empty state + ScheduleApp orchestration ────────────────────
export default function App() {
  const [schedData,   setSchedData]   = useState(null);
  const [baseData,    setBaseData]    = useState(null);
  const [importing,   setImporting]   = useState(false);
  const [importError, setImportError] = useState(null);
  const [showNewProj, setShowNewProj] = useState(false);
  const fileInputRef = useRef(null);

  // Restore from localStorage on mount
  useEffect(() => {
    const buf = loadFromStorage();
    if (!buf) return;
    parseXlsx(buf)
      .then(data => {
        setBaseData(data);
        const edits = loadSchedEdits();
        setSchedData(edits ? applyEditsToData(data, edits) : data);
      })
      .catch(() => {
        // Corrupted buffer — clear it so we don't loop forever
        try { localStorage.removeItem(LS_KEY); } catch {}
      });
  }, []);

  const handleFileChange = async e => {
    const file = e.target.files?.[0];
    if (!file) return;
    setImporting(true);
    setImportError(null);
    try {
      const buf = await file.arrayBuffer();
      const data = await parseXlsx(buf);
      saveToStorage(buf);
      try { localStorage.removeItem(LS_EDITS_KEY); } catch {}
      setBaseData(data);
      setSchedData(data);
    } catch (err) {
      setImportError(err.message || 'Failed to parse file.');
    } finally {
      setImporting(false);
      e.target.value = '';
    }
  };

  const handleAddProject = ({ proj, rawTasks: newTasks, people: newPeople }) => {
    setSchedData(prev => {
      const allRaw = [...prev.rawTasks, ...newTasks];
      const updated = {
        ...prev,
        rawTasks: allRaw,
        projs:    [...prev.projs, proj],
        people:   [...prev.people, ...newPeople],
        tdepMap:  Object.fromEntries(allRaw.map(t => [t.id, t.deps])),
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
    clearAllStorage();
    setSchedData(null);
    setBaseData(null);
  };

  // ── Empty state ───────────────────────────────────────────────────────────
  if (!schedData) {
    return (
      <ErrorBoundary>
        <EmptyState
          fileInputRef={fileInputRef}
          showNewProj={showNewProj}
          setShowNewProj={setShowNewProj}
          handleFileChange={handleFileChange}
          triggerImport={triggerImport}
          importing={importing}
          importError={importError}
        />
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
        />
        <input
          ref={fileInputRef}
          type="file"
          accept=".xlsx,.xls"
          onChange={handleFileChange}
          style={{ display:'none' }}
        />
      </ScheduleCtx.Provider>
    </ErrorBoundary>
  );
}

// ── EmptyState ───────────────────────────────────────────────────────────────
// Pre-import shell. Greyed-out KPIs, instructional placeholder, Import button.
function EmptyState({ fileInputRef, showNewProj, setShowNewProj, handleFileChange, triggerImport, importing, importError }) {
  return (
    <div style={{ fontFamily:FONT_STACK, background:SURFACE, minHeight:'100vh', color:TEXT }}>
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

      {/* Placeholder KPI row */}
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

      {/* Empty tab shell */}
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
  );
}

// ── ScheduleApp ──────────────────────────────────────────────────────────────
// Main dashboard once data is loaded. Owns simulated delays, completion state,
// status overrides, and routes between the five tabs.
function ScheduleApp({ schedData, baseData, onImport, onClear, onNewProject, onMutate, importing, importError }) {
  const { rawTasks, projs, people, tdepMap, base, todayDay, periods } = schedData;

  const [simDelays,       setSimDelays]       = useState({});
  const [cascadeMode,     setCascadeMode]     = useState('full');
  const [completedIds,    setCompletedIds]    = useState(() => loadCompleted());
  const [statusOverrides, setStatusOverrides] = useState(() => loadStatusOverrides());

  const todayMs = useMemo(() => { const d = new Date(); d.setHours(0,0,0,0); return d.getTime(); }, []);

  const tasks = useMemo(
    () => buildSched(rawTasks, tdepMap, base, simDelays, cascadeMode, completedIds, todayMs),
    [rawTasks, tdepMap, base, simDelays, cascadeMode, completedIds, todayMs]
  );

  const toggleComplete = useCallback(taskId => {
    setCompletedIds(prev => {
      const next = new Set(prev);
      next.has(taskId) ? next.delete(taskId) : next.add(taskId);
      saveCompleted(next);
      return next;
    });
    // Clear any status override on toggle — let the engine decide
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
    const map = loadDepOverrides();
    if (typedDeps.length === 0) map.delete(taskId);
    else map.set(taskId, typedDeps);
    saveDepOverrides(map);
    // Rebuild from baseData so applyEditsToData doesn't double-merge
    if (!baseData) return;
    const currentEdits = loadSchedEdits();
    onMutate(applyEditsToData(baseData, currentEdits));
  }, [baseData, onMutate]);

  const [tab,        setTab]        = useState('gantt');
  const [sel,        setSel]        = useState(null);
  const [editTarget, setEditTarget] = useState(null);
  const [showResolver, setShowResolver] = useState(false);
  const [addTasksProj, setAddTasksProj] = useState(null);

  const kpi = {
    total:     tasks.length,
    conflicts: tasks.filter(t => t.isC).length,
    fragile:   tasks.filter(t => t.isF).length,
    depViol:   tasks.filter(t => t.isDV).length,
  };

  const handleEdit  = useCallback(target => setEditTarget(target), []);
  const handleApply = useCallback((nd, mode) => { setSimDelays(nd); if (mode) setCascadeMode(mode); }, []);

  // Persist a real timeline shift — rewrites rawTask dates via the edits layer.
  // (Bug fix: original used `bd` as a local re-shadowing `baseData`. Renamed to `currentBaseData`.)
  const handleShift = useCallback((taskIds, days, mode) => {
    const currentBaseData = { rawTasks, projs, people, tdepMap, base, todayDay, periods };
    const currentEdits = loadSchedEdits();

    // Determine full set of task IDs to shift. For 'full'/'min' we also shift
    // tasks that would cascade in buildSched — computed via a preview pass.
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

    const updated = mutateSchedData(currentBaseData, currentEdits, { type:'shiftTimeline', taskIds: allIds, days });
    onMutate(updated);
    // Clear any simDelays for shifted tasks — now baked into rawTasks
    setSimDelays(prev => {
      const nd = { ...prev };
      allIds.forEach(id => delete nd[id]);
      return nd;
    });
  }, [rawTasks, projs, people, tdepMap, base, todayDay, periods, onMutate]);

  // (Bug fix: original re-declared `baseData` inside the callback, shadowing
  //  the prop. Renamed to `currentBaseData` for clarity.)
  const handleDelete = useCallback(mutation => {
    const currentBaseData = { rawTasks, projs, people, tdepMap, base, todayDay, periods };
    const currentEdits = loadSchedEdits();
    const updated = mutateSchedData(currentBaseData, currentEdits, mutation);
    onMutate(updated);
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
  }, [rawTasks, projs, people, tdepMap, base, todayDay, periods, onMutate]);

  const handleAddTasks = useCallback(({ tasks: newTasks, people: newPeople }) => {
    const currentBaseData = { rawTasks, projs, people, tdepMap, base, todayDay, periods };
    const currentEdits = loadSchedEdits();
    const updated = mutateSchedData(currentBaseData, currentEdits, { type:'addTasks', tasks:newTasks, people:newPeople });
    onMutate(updated);
  }, [rawTasks, projs, people, tdepMap, base, todayDay, periods, onMutate]);

  // ── Derived KPIs ──────────────────────────────────────────────────────────
  // A task is "effectively completed" if the engine marks it or an override says so.
  const isEffectivelyCompleted = t => t.isCompleted || statusOverrides.get(t.id) === 'Completed';

  // A project is "on schedule" if none of its active tasks are
  // conflicted, dep-violated, overdue, or have a simulated delay applied.
  const delayedTaskIds = new Set(Object.keys(simDelays).filter(id => simDelays[id] > 0));
  const onSchedule = projs.filter(p => {
    const pt = tasks.filter(t => t.projId === p.id && !isEffectivelyCompleted(t));
    return !pt.some(t => t.isC || t.isDV || t.isOverdue || delayedTaskIds.has(t.id));
  }).length;
  const onSchedulePct = projs.length ? Math.round((onSchedule / projs.length) * 100) : 0;
  const projRisk  = projs.filter(p => tasks.filter(t => t.projId === p.id && !isEffectivelyCompleted(t)).some(t => t.isC));
  const crossRisk = projs.filter(p => tasks.filter(t => t.projId === p.id && !isEffectivelyCompleted(t)).some(t => t.isDV));

  const TAB_ITEMS = [
    { id:'gantt',     l:'Gantt Chart'  },
    { id:'project',   l:'Project View' },
    { id:'workflows', l:'Workflows'    },
    { id:'conflicts', l:'Conflicts'    },
    { id:'people',    l:'Resource'     },
  ];

  return (
    <div style={{ fontFamily:FONT_STACK, background:SURFACE, minHeight:'100vh', color:TEXT }}>

      {editTarget && (
        <EditModal
          target={editTarget}
          tasks={tasks}
          simDelays={simDelays}
          onApply={handleApply}
          onShift={handleShift}
          onClose={() => setEditTarget(null)}
          onDelete={handleDelete}
          statusOverrides={statusOverrides}
          onSetStatus={setStatusOverride}
          todayMs={todayMs}
          onSaveDeps={saveTaskDeps}
        />
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
  );
}