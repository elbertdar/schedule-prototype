// ── WorkflowsTab ─────────────────────────────────────────────────────────────
// Manages reusable task templates (workflows) — project-agnostic.
// Each workflow has: name + tasks with seq, name, role, deps (letters), depType.

import { useState } from 'react';
import { loadWorkflows, saveWorkflows } from '../../storage/persist.jsx';
import { CARD, BORDER, ORANGE, SURFACE, TEXT, MUTED } from '../../theme.jsx';

// WorkflowsTab uses 'BG' for the page background in a couple of places; use SURFACE.
const BG = SURFACE;

export function WorkflowsTab() {
  const INPUT = { width:'100%', padding:'6px 9px', borderRadius:'7px', border:`1px solid ${BORDER}`, background:'#0F0F18', color:TEXT, fontSize:'12px', outline:'none', boxSizing:'border-box', fontFamily:'inherit' };

  const [workflows, setWorkflows] = useState(() => loadWorkflows());
  const [expanded,  setExpanded]  = useState(null);    // workflow id being viewed
  const [editing,   setEditing]   = useState(null);    // {id,name,tasks} being edited, null=new
  const [showForm,  setShowForm]  = useState(false);
  const [formName,  setFormName]  = useState('');
  const [formTasks, setFormTasks] = useState([{ seq:'A', name:'', role:'', deps:[], depType:'FS' }]);
  const [formError, setFormError] = useState('');

  const persist = map => { saveWorkflows(map); setWorkflows(new Map(map)); };

  const openNew = () => {
    setEditing(null);
    setFormName('');
    setFormTasks([{ seq:'A', name:'', role:'', deps:[], depType:'FS' }]);
    setFormError('');
    setShowForm(true);
  };

  const openEdit = wf => {
    setEditing(wf);
    setFormName(wf.name);
    setFormTasks(wf.tasks.map(t => ({ ...t, deps: t.deps || [], depType: t.depType || 'FS' })));
    setFormError('');
    setShowForm(true);
  };

  const deleteWf = id => {
    const next = new Map(workflows);
    next.delete(id);
    persist(next);
    if (expanded === id) setExpanded(null);
  };

  const saveForm = () => {
    if (!formName.trim()) { setFormError('Workflow name is required.'); return; }
    const validTasks = formTasks.filter(t => t.name.trim());
    if (!validTasks.length) { setFormError('Add at least one task with a name.'); return; }
    const id = editing ? editing.id : `wf_${Date.now()}`;
    const wf = { id, name: formName.trim(), tasks: validTasks };
    const next = new Map(workflows);
    next.set(id, wf);
    persist(next);
    setShowForm(false);
  };

  const updateFT = (i, f, v) => setFormTasks(prev => prev.map((t, idx) => idx === i ? { ...t, [f]: v } : t));
  const addFTRow = () => {
    const seq = String.fromCharCode(65 + formTasks.length);
    setFormTasks(prev => [...prev, { seq, name:'', role:'', deps:[], depType:'FS' }]);
  };
  const removeFTRow = i => setFormTasks(prev => {
    const next = prev.filter((_, idx) => idx !== i).map((t, idx) => ({ ...t, seq: String.fromCharCode(65 + idx) }));
    return next.length ? next : [{ seq:'A', name:'', role:'', deps:[], depType:'FS' }];
  });
  const toggleDep = (i, seq) => setFormTasks(prev => prev.map((t, idx) => {
    if (idx !== i) return t;
    const deps = t.deps.includes(seq) ? t.deps.filter(d => d !== seq) : [...t.deps, seq];
    return { ...t, deps };
  }));

  const wfList = [...workflows.values()];

  return (
    <div style={{ fontFamily:'-apple-system,system-ui,sans-serif' }}>
      {/* Toolbar */}
      <div style={{ display:'flex', alignItems:'center', padding:'0 16px', height:'48px', borderBottom:`1px solid ${BORDER}`, background:CARD, gap:'12px' }}>
        <span style={{ fontSize:'13px', color:MUTED }}>
          {wfList.length} workflow{wfList.length !== 1 ? 's' : ''} saved
        </span>
        <button onClick={openNew}
          style={{ marginLeft:'auto', padding:'6px 14px', borderRadius:'8px', border:'none', background:ORANGE, color:'white', fontSize:'12px', fontWeight:'700', cursor:'pointer' }}>
          + New Workflow
        </button>
      </div>

      {/* Empty state */}
      {wfList.length === 0 && !showForm && (
        <div style={{ padding:'64px 32px', textAlign:'center', color:MUTED }}>
          <div style={{ fontSize:'32px', marginBottom:'12px', opacity:0.3 }}>⚙</div>
          <div style={{ fontSize:'14px', fontWeight:'600', marginBottom:'6px', color:TEXT, opacity:0.5 }}>No workflows yet</div>
          <div style={{ fontSize:'12px', lineHeight:'1.6', opacity:0.6, maxWidth:'320px', margin:'0 auto' }}>
            Create a reusable task template — task names, roles, and dependencies without project-specific details.
          </div>
          <button onClick={openNew} style={{ marginTop:'16px', padding:'8px 18px', borderRadius:'8px', border:`1px solid ${BORDER}`, background:'transparent', color:TEXT, fontSize:'12px', cursor:'pointer' }}>
            Create first workflow
          </button>
        </div>
      )}

      {/* Workflow list */}
      {!showForm && wfList.length > 0 && (
        <div>
          {/* Table header */}
          <div style={{ display:'grid', gridTemplateColumns:'1fr 80px 80px', gap:'0', borderBottom:`1px solid ${BORDER}`, background:'#0A0A0F' }}>
            {['Workflow Name', 'Tasks', ''].map((h, i) => (
              <div key={i} style={{ padding:'10px 16px', fontSize:'11px', color:MUTED, fontWeight:'700', textTransform:'uppercase', letterSpacing:'0.06em' }}>{h}</div>
            ))}
          </div>
          {wfList.map((wf, wi) => (
            <div key={wf.id}>
              {/* Row */}
              <div style={{ display:'grid', gridTemplateColumns:'1fr 80px 80px', background: wi%2===0 ? BG : '#0F0F18', borderBottom:`1px solid ${BORDER}` }}
                onMouseEnter={e=>e.currentTarget.style.background='#1E2535'}
                onMouseLeave={e=>e.currentTarget.style.background=wi%2===0?BG:'#0F0F18'}>
                <div style={{ padding:'12px 16px', display:'flex', alignItems:'center', gap:'10px', cursor:'pointer' }}
                  onClick={() => setExpanded(expanded === wf.id ? null : wf.id)}>
                  <span style={{ fontSize:'10px', color:MUTED, transition:'transform 0.15s', display:'inline-block', transform: expanded===wf.id ? 'rotate(90deg)' : 'none' }}>▶</span>
                  <span style={{ fontWeight:'600', color:TEXT, fontSize:'13px' }}>{wf.name}</span>
                </div>
                <div style={{ padding:'12px 16px', color:MUTED, fontSize:'13px', display:'flex', alignItems:'center' }}>{wf.tasks.length}</div>
                <div style={{ padding:'8px 12px', display:'flex', alignItems:'center', gap:'6px', justifyContent:'flex-end' }}>
                  <button onClick={() => openEdit(wf)}
                    style={{ width:'26px', height:'26px', borderRadius:'6px', border:`1px solid ${BORDER}`, background:'transparent', cursor:'pointer', color:MUTED, fontSize:'13px', display:'flex', alignItems:'center', justifyContent:'center' }}
                    onMouseEnter={e=>e.currentTarget.style.color=ORANGE} onMouseLeave={e=>e.currentTarget.style.color=MUTED}>✎</button>
                  <button onClick={() => deleteWf(wf.id)}
                    style={{ width:'26px', height:'26px', borderRadius:'6px', border:`1px solid ${BORDER}`, background:'transparent', cursor:'pointer', color:MUTED, fontSize:'13px', display:'flex', alignItems:'center', justifyContent:'center' }}
                    onMouseEnter={e=>e.currentTarget.style.color='#EF4444'} onMouseLeave={e=>e.currentTarget.style.color=MUTED}>🗑</button>
                </div>
              </div>
              {/* Expanded task list */}
              {expanded === wf.id && (
                <div style={{ background:'#0A0A0F', borderBottom:`1px solid ${BORDER}`, padding:'10px 24px 14px' }}>
                  <div style={{ display:'grid', gridTemplateColumns:'32px 1fr 120px 120px', gap:'0', marginBottom:'6px' }}>
                    {['Seq','Task Name','Role','Deps'].map((h,i) => (
                      <div key={i} style={{ padding:'5px 8px', fontSize:'10px', color:MUTED, fontWeight:'700', textTransform:'uppercase', letterSpacing:'0.06em' }}>{h}</div>
                    ))}
                  </div>
                  {wf.tasks.map((t, ti) => (
                    <div key={ti} style={{ display:'grid', gridTemplateColumns:'32px 1fr 120px 120px', gap:'0', borderTop:`1px solid ${BORDER}20` }}>
                      <div style={{ padding:'7px 8px', fontSize:'12px', fontWeight:'700', color:ORANGE }}>{t.seq}</div>
                      <div style={{ padding:'7px 8px', fontSize:'12px', color:TEXT }}>{t.name}</div>
                      <div style={{ padding:'7px 8px', fontSize:'12px', color:MUTED }}>{t.role || '—'}</div>
                      <div style={{ padding:'7px 8px', fontSize:'11px', color:MUTED }}>
                        {t.deps?.length ? t.deps.map(d => (
                          <span key={d} style={{ marginRight:'4px', padding:'1px 5px', borderRadius:'4px', background:`${ORANGE}18`, border:`1px solid ${ORANGE}40`, color:ORANGE, fontSize:'10px', fontWeight:'700' }}>
                            {t.depType || 'FS'}:{d}
                          </span>
                        )) : '—'}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Create / Edit form */}
      {showForm && (
        <div style={{ padding:'20px 22px' }}>
          <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:'16px' }}>
            <div style={{ fontSize:'14px', fontWeight:'700', color:TEXT }}>{editing ? `Edit: ${editing.name}` : 'New Workflow'}</div>
            <button onClick={() => setShowForm(false)} style={{ background:'none', border:'none', cursor:'pointer', color:MUTED, fontSize:'20px' }}>×</button>
          </div>

          {/* Workflow name */}
          <div style={{ marginBottom:'16px' }}>
            <div style={{ fontSize:'11px', color:MUTED, marginBottom:'5px', fontWeight:'600' }}>Workflow Name</div>
            <input value={formName} onChange={e => setFormName(e.target.value)} placeholder="e.g. Standard Fit-Out, Heritage Reno…"
              style={{ ...INPUT, maxWidth:'360px' }} />
          </div>

          {/* Task grid */}
          <div style={{ marginBottom:'14px' }}>
            <div style={{ fontSize:'11px', color:MUTED, marginBottom:'8px', fontWeight:'600', textTransform:'uppercase', letterSpacing:'0.06em' }}>Tasks</div>
            <div style={{ display:'grid', gridTemplateColumns:'32px 1fr 120px 140px 24px', gap:'6px', marginBottom:'6px', paddingBottom:'6px', borderBottom:`1px solid ${BORDER}` }}>
              {['Seq','Task Name','Role','Dependencies',''].map((h,i) => (
                <div key={i} style={{ fontSize:'10px', color:MUTED, fontWeight:'700', textTransform:'uppercase', letterSpacing:'0.05em' }}>{h}</div>
              ))}
            </div>
            {formTasks.map((t, i) => {
              const prevSeqs = formTasks.slice(0, i).map(x => x.seq);
              return (
                <div key={i} style={{ display:'grid', gridTemplateColumns:'32px 1fr 120px 140px 24px', gap:'6px', marginBottom:'6px', alignItems:'center' }}>
                  <div style={{ fontSize:'12px', fontWeight:'700', color:ORANGE, textAlign:'center', background:'#F9731615', borderRadius:'5px', padding:'6px 0', border:`1px solid ${ORANGE}40` }}>{t.seq}</div>
                  <input value={t.name} onChange={e => updateFT(i,'name',e.target.value)} placeholder="Task name" style={INPUT} />
                  <input value={t.role} onChange={e => updateFT(i,'role',e.target.value)} placeholder="Role" style={INPUT} />
                  {/* Dep selector */}
                  <div style={{ display:'flex', gap:'4px', flexWrap:'wrap', alignItems:'center' }}>
                    {/* Type toggle */}
                    <div style={{ display:'flex', borderRadius:'6px', overflow:'hidden', border:`1px solid ${BORDER}`, flexShrink:0 }}>
                      {['FS','SS'].map(tp => (
                        <button key={tp} onClick={() => updateFT(i,'depType',tp)}
                          style={{ padding:'3px 7px', border:'none', cursor:'pointer', fontSize:'10px', fontWeight:'700', background: t.depType===tp ? ORANGE : 'transparent', color: t.depType===tp ? 'white' : MUTED }}>
                          {tp}
                        </button>
                      ))}
                    </div>
                    {/* Dep letter toggles */}
                    {prevSeqs.map(seq => (
                      <button key={seq} onClick={() => toggleDep(i, seq)}
                        style={{ padding:'3px 8px', borderRadius:'5px', border:`1px solid ${t.deps.includes(seq) ? ORANGE : BORDER}`, background: t.deps.includes(seq) ? '#F9731620' : 'transparent', cursor:'pointer', fontSize:'10px', fontWeight:'700', color: t.deps.includes(seq) ? ORANGE : MUTED }}>
                        {seq}
                      </button>
                    ))}
                    {prevSeqs.length === 0 && <span style={{ fontSize:'10px', color:MUTED, fontStyle:'italic' }}>—</span>}
                  </div>
                  <button onClick={() => removeFTRow(i)} disabled={formTasks.length === 1}
                    style={{ width:'24px', height:'24px', borderRadius:'5px', border:`1px solid ${BORDER}`, background:'transparent', color:MUTED, cursor:formTasks.length===1?'default':'pointer', fontSize:'14px', display:'flex', alignItems:'center', justifyContent:'center', opacity:formTasks.length===1?0.3:1 }}>×</button>
                </div>
              );
            })}
            <button onClick={addFTRow}
              style={{ display:'flex', alignItems:'center', gap:'6px', marginTop:'4px', padding:'6px 12px', borderRadius:'7px', border:`1px dashed ${BORDER}`, background:'transparent', color:MUTED, fontSize:'12px', cursor:'pointer', width:'100%', justifyContent:'center' }}
              onMouseEnter={e=>e.currentTarget.style.borderColor=ORANGE} onMouseLeave={e=>e.currentTarget.style.borderColor=BORDER}>
              + Add task
            </button>
          </div>

          {formError && <div style={{ marginBottom:'12px', padding:'8px 12px', borderRadius:'7px', background:'#3B1219', border:'1px solid #7F1D1D', color:'#FCA5A5', fontSize:'12px' }}>{formError}</div>}

          <div style={{ display:'flex', gap:'10px', justifyContent:'flex-end' }}>
            <button onClick={() => setShowForm(false)} style={{ padding:'8px 16px', borderRadius:'8px', border:`1px solid ${BORDER}`, background:'transparent', color:MUTED, fontSize:'13px', cursor:'pointer' }}>Cancel</button>
            <button onClick={saveForm} style={{ padding:'8px 20px', borderRadius:'8px', border:'none', background:ORANGE, color:'white', fontSize:'13px', fontWeight:'700', cursor:'pointer' }}>
              {editing ? 'Save Changes' : 'Save Workflow'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
