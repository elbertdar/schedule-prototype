// ── ProjectViewTab ───────────────────────────────────────────────────────────
// Excel-style filterable, sortable table. One row per task.

import { useState, useMemo, useRef, useEffect } from 'react';
import { useSched } from '../../context.jsx';
import { fmtDate as fd } from '../../engine/dates.jsx';
import { computeStatus, STATUS_STYLES } from '../../engine/status.jsx';
import { loadSchedEdits, saveSchedEdits } from '../../storage/persist.jsx';
import { CARD, BORDER, ORANGE, TEXT, MUTED } from '../../theme.jsx';

export function ProjectViewTab({ tasks, onDelete, onEdit, onToggleComplete, statusOverrides, onSetStatus, todayMs }) {
  const { rawTasks, projs, people, tdepMap, base, todayDay, periods } = useSched();

  const [sortCol,      setSortCol]      = useState('projId');
  const [sortDir,      setSortDir]      = useState('asc');
  const [showCompleted,setShowCompleted]= useState(true);
  const [filters,      setFilters]      = useState({});
  const [openFilter,   setOpenFilter]   = useState(null);
  const [filterSearch, setFilterSearch] = useState('');
  const filterRef = useRef(null);


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
