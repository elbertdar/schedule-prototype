// ── PeopleTab ────────────────────────────────────────────────────────────────
// Resource view — per-person workload summary and task list.

import { useState, useMemo } from 'react';
import { useSched } from '../../context.jsx';
import { fmtDate as fd } from '../../engine/dates.jsx';
import { computeStatus, STATUS_STYLES } from '../../engine/status.jsx';
import { CARD, BORDER, ORANGE, TEXT, MUTED } from '../../theme.jsx';

export function PeopleTab({ tasks, sel, onSel, statusOverrides, todayMs }) {
  const { rawTasks, projs, people, tdepMap, base, todayDay, periods } = useSched();

  const [subTab, setSubTab] = useState('projects');
  const [search, setSearch] = useState('');

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
