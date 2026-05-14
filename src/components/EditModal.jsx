// ── EditModal ────────────────────────────────────────────────────────────────
// Opens when user clicks a task bar or the "✎ Delay Px" toolbar buttons.
// Shows delay slider, live impact preview, cross-project warning, and confirm step.
// Also hosts the Details tab — dependency editor, status override, delete confirm.

import { useState, useMemo } from 'react';
import { useSched } from '../context.jsx';
import { addW, parseDate, fmtDate as fd, fmtDDMMYYYY } from '../engine/dates.jsx';
import { buildSched, normDep, hasCycle } from '../engine/schedule.jsx';
import { computeStatus, STATUS_STYLES, ALL_STATUSES } from '../engine/status.jsx';
import { BORDER, TEXT, MUTED } from '../theme.jsx';
import { Tile } from './shared/Tile.jsx';
import { TaskList } from './shared/TaskList.jsx';

export function EditModal({ target, tasks, simDelays, onApply, onShift, onClose, onDelete, statusOverrides, onSetStatus, todayMs, onSaveDeps }) {
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

  // ── Colour constants come from theme.jsx — no local re-declaration ────────

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
