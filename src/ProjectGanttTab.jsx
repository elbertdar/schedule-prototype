// ── ProjectGanttTab ──────────────────────────────────────────────────────────
// The main Gantt view — collapsible projects, role groupings, person-level bars,
// dependency arrows, today line, drag-shift, conflict highlighting.

import { useState, useMemo, useRef, useEffect } from 'react';
import { useSched } from '../../context.jsx';
import { fmtDate as fd } from '../../engine/dates.jsx';
import { normDep } from '../../engine/schedule.jsx';
import { computeStatus } from '../../engine/status.jsx';
import { DPX, HH, LW, PRH, RRH, SRH, SBH, ROLES, ALL_MONS } from '../../theme.jsx';

export function ProjectGanttTab({ tasks, simDelays, setSimDelays, onEdit, setAddTasksProj, onToggleComplete, statusOverrides, todayMs }) {
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
