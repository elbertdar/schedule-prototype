// ── NewProjectModal ──────────────────────────────────────────────────────────
// Multi-step modal for creating a new project from scratch or from a workflow.
// Handles project id/name, people assignments, and dep wiring.

import { useState } from 'react';
import { loadWorkflows, loadDepOverrides, saveDepOverrides } from '../../storage/persist.jsx';
import { PROJ_COLORS, PERSON_COLORS, CARD, BORDER, ORANGE, TEXT, MUTED } from '../../theme.jsx';

export function NewProjectModal({ existingProjs, existingPeople, onAdd, onClose }) {
  const INPUT  = { width:'100%', padding:'8px 10px', borderRadius:'8px', border:`1px solid ${BORDER}`, background:'#0F0F18', color:TEXT, fontSize:'12px', outline:'none', boxSizing:'border-box', fontFamily:'inherit' };

  const nextId = (() => {
    const nums = existingProjs.map(p => parseInt(p.id.replace(/\D/g,''))).filter(n => !isNaN(n));
    return `P${nums.length ? Math.max(...nums) + 1 : existingProjs.length + 1}`;
  })();

  const [projId,    setProjId]   = useState(nextId);
  const [projName,  setProjName] = useState('');
  const [color,     setColor]    = useState(PROJ_COLORS[existingProjs.length % PROJ_COLORS.length]);
  const [tasks,     setTasks]    = useState([
    { seq:'A', name:'', person:'', role:'', rate:'', start:'', end:'', deps:[], depType:'FS' },
  ]);
  const [error,     setError]    = useState('');
  const [workflows] = useState(() => loadWorkflows());

  const updateTask = (i, field, val) => setTasks(prev => prev.map((t, idx) => idx === i ? {...t, [field]:val} : t));

  const toggleDep = (i, seq) => setTasks(prev => prev.map((t, idx) => {
    if (idx !== i) return t;
    const deps = t.deps.includes(seq) ? t.deps.filter(d => d !== seq) : [...t.deps, seq];
    return { ...t, deps };
  }));

  const addTaskRow = () => setTasks(prev => [...prev, {
    seq: String.fromCharCode(65 + prev.length), name:'', person:'', role:'', rate:'', start:'', end:'', deps:[], depType:'FS'
  }]);

  const removeTask = i => setTasks(prev => prev.filter((_, idx) => idx !== i));

  const loadWorkflow = wfId => {
    const wf = workflows.get(wfId);
    if (!wf) return;
    setTasks(wf.tasks.map((t, i) => ({
      seq: String.fromCharCode(65 + i),
      name: t.name, person:'', role: t.role||'', rate:'', start:'', end:'',
      deps: t.deps || [], depType: t.depType || 'FS',
    })));
  };

  const knownNames = existingPeople.map(p => p.name);

  const handleAdd = () => {
    if (!projId.trim()) { setError('Project ID is required.'); return; }
    if (existingProjs.find(p => p.id === projId.trim())) { setError(`Project "${projId}" already exists.`); return; }
    if (!tasks.some(t => t.name.trim())) { setError('Add at least one task.'); return; }
    const validTasks = tasks.filter(t => t.name.trim() && t.start.trim() && t.end.trim());
    if (!validTasks.length) { setError('Each task needs a name, start date, and end date.'); return; }

    const pid = projId.trim().toUpperCase();
    const newProj = { id:pid, name: projName.trim() || `${pid} — New Build`, color };

    const newRawTasks = validTasks.map(t => ({
      id:     `${pid}-${t.seq}`,
      proj:   pid,
      name:   t.name.trim(),
      person: t.person.trim(),
      role:   t.role.trim() || '',
      dur:    1,
      start:  t.start.trim(),
      end:    t.end.trim(),
      deps:   (t.deps || []).map(d => `${pid}-${d}`),
    }));

    const depMap = loadDepOverrides();
    for (const t of validTasks) {
      if ((t.deps || []).length) {
        depMap.set(`${pid}-${t.seq}`, t.deps.map(d => ({ id:`${pid}-${d}`, type: t.depType || 'FS' })));
      }
    }
    saveDepOverrides(depMap);

    const newPeople = [];
    for (const t of newRawTasks) {
      if (t.person && !existingPeople.find(p => p.name === t.person) && !newPeople.find(p => p.name === t.person)) {
        const task = validTasks.find(vt => vt.name === t.name);
        const init = t.person.split(' ').map(w=>w[0]).join('').slice(0,2).toUpperCase();
        newPeople.push({ name:t.person, role:task?.role||'', init, color:PERSON_COLORS[(existingPeople.length+newPeople.length)%PERSON_COLORS.length], rate:task?.rate||'$42/hr' });
      }
    }

    onAdd({ proj:newProj, rawTasks:newRawTasks, people:newPeople });
    onClose();
  };

  const wfList = [...workflows.values()];

  return (
    <div style={{ position:'fixed', inset:0, zIndex:1000, background:'rgba(10,10,15,0.7)', backdropFilter:'blur(4px)', display:'flex', alignItems:'center', justifyContent:'center' }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{ background:CARD, borderRadius:'16px', width:'700px', maxWidth:'95vw', maxHeight:'88vh', display:'flex', flexDirection:'column', boxShadow:'0 24px 64px rgba(0,0,0,0.5)', border:`1px solid ${BORDER}`, overflow:'hidden' }}>
        <div style={{ padding:'18px 22px 14px', borderBottom:`2px solid ${ORANGE}`, background:'#17171F', flexShrink:0 }}>
          <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between' }}>
            <div>
              <div style={{ fontSize:'15px', fontWeight:'700', color:TEXT }}>New Project</div>
              <div style={{ fontSize:'11px', color:MUTED, marginTop:'3px' }}>Add a project and its tasks to the schedule</div>
            </div>
            <button onClick={onClose} style={{ background:'none', border:'none', cursor:'pointer', color:MUTED, fontSize:'22px', lineHeight:1, padding:0 }}>×</button>
          </div>
        </div>

        <div style={{ overflowY:'auto', flex:1, padding:'18px 22px' }}>
          <div style={{ marginBottom:'20px' }}>
            <div style={{ fontSize:'11px', fontWeight:'700', color:MUTED, textTransform:'uppercase', letterSpacing:'0.07em', marginBottom:'10px' }}>Project Details</div>
            <div style={{ display:'grid', gridTemplateColumns:'1fr 2fr auto', gap:'10px', alignItems:'end' }}>
              <div>
                <div style={{ fontSize:'11px', color:MUTED, marginBottom:'5px' }}>Project ID</div>
                <input value={projId} onChange={e => setProjId(e.target.value.toUpperCase())} placeholder="P4" style={INPUT} />
              </div>
              <div>
                <div style={{ fontSize:'11px', color:MUTED, marginBottom:'5px' }}>Project Name</div>
                <input value={projName} onChange={e => setProjName(e.target.value)} placeholder="New Build, Renovation\u2026" style={INPUT} />
              </div>
              <div>
                <div style={{ fontSize:'11px', color:MUTED, marginBottom:'5px' }}>Colour</div>
                <div style={{ display:'flex', gap:'5px' }}>
                  {PROJ_COLORS.slice(0,6).map(c => (
                    <div key={c} onClick={() => setColor(c)} style={{ width:'22px', height:'22px', borderRadius:'50%', background:c, cursor:'pointer', border: color===c ? '2px solid white' : '2px solid transparent', flexShrink:0 }} />
                  ))}
                </div>
              </div>
            </div>
          </div>

          <div>
            <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:'10px' }}>
              <div style={{ fontSize:'11px', fontWeight:'700', color:MUTED, textTransform:'uppercase', letterSpacing:'0.07em' }}>Tasks</div>
              {wfList.length > 0 && (
                <div style={{ display:'flex', alignItems:'center', gap:'8px' }}>
                  <span style={{ fontSize:'11px', color:MUTED }}>From workflow:</span>
                  <select onChange={e => { if (e.target.value) loadWorkflow(e.target.value); e.target.value=''; }}
                    style={{ padding:'4px 8px', borderRadius:'7px', border:`1px solid ${BORDER}`, background:'#0F0F18', color:TEXT, fontSize:'11px', outline:'none', cursor:'pointer' }}>
                    <option value=''>\u2014 select \u2014</option>
                    {wfList.map(wf => <option key={wf.id} value={wf.id}>{wf.name}</option>)}
                  </select>
                </div>
              )}
            </div>

            <div style={{ display:'grid', gridTemplateColumns:'32px 1fr 100px 90px 90px 160px 24px', gap:'6px', marginBottom:'6px', paddingBottom:'6px', borderBottom:`1px solid ${BORDER}` }}>
              {['ID','Task Name','Assigned','Start','End','Dependencies',''].map((h,i) => (
                <div key={i} style={{ fontSize:'10px', color:MUTED, fontWeight:'600', textTransform:'uppercase', letterSpacing:'0.05em' }}>{h}</div>
              ))}
            </div>

            {tasks.map((t, i) => {
              const prevSeqs = tasks.slice(0, i).map(x => x.seq);
              return (
                <div key={i} style={{ display:'grid', gridTemplateColumns:'32px 1fr 100px 90px 90px 160px 24px', gap:'6px', marginBottom:'6px', alignItems:'center' }}>
                  <div style={{ fontSize:'12px', fontWeight:'700', color:ORANGE, textAlign:'center', background:'#F9731615', borderRadius:'5px', padding:'6px 0', border:`1px solid ${ORANGE}40` }}>{projId}-{t.seq}</div>
                  <input value={t.name}   onChange={e => updateTask(i,'name',  e.target.value)} placeholder="Task name"   style={INPUT} />
                  <input value={t.person} onChange={e => updateTask(i,'person',e.target.value)} placeholder="Name" list="known-people-npm" style={INPUT} />
                  <input value={t.start}  onChange={e => updateTask(i,'start', e.target.value)} placeholder="DD/MM/YYYY" style={INPUT} />
                  <input value={t.end}    onChange={e => updateTask(i,'end',   e.target.value)} placeholder="DD/MM/YYYY" style={INPUT} />
                  <div style={{ display:'flex', gap:'4px', flexWrap:'wrap', alignItems:'center' }}>
                    <div style={{ display:'flex', borderRadius:'6px', overflow:'hidden', border:`1px solid ${BORDER}`, flexShrink:0 }}>
                      {['FS','SS'].map(tp => (
                        <button key={tp} onClick={() => updateTask(i,'depType',tp)}
                          style={{ padding:'3px 7px', border:'none', cursor:'pointer', fontSize:'10px', fontWeight:'700', background: t.depType===tp ? ORANGE : 'transparent', color: t.depType===tp ? 'white' : MUTED }}>
                          {tp}
                        </button>
                      ))}
                    </div>
                    {prevSeqs.map(seq => (
                      <button key={seq} onClick={() => toggleDep(i, seq)}
                        style={{ padding:'3px 8px', borderRadius:'5px', border:`1px solid ${t.deps.includes(seq) ? ORANGE : BORDER}`, background: t.deps.includes(seq) ? '#F9731620' : 'transparent', cursor:'pointer', fontSize:'10px', fontWeight:'700', color: t.deps.includes(seq) ? ORANGE : MUTED }}>
                        {seq}
                      </button>
                    ))}
                    {prevSeqs.length === 0 && <span style={{ fontSize:'10px', color:MUTED, fontStyle:'italic' }}>\u2014</span>}
                  </div>
                  <button onClick={() => removeTask(i)} disabled={tasks.length === 1}
                    style={{ width:'24px', height:'24px', borderRadius:'5px', border:`1px solid ${BORDER}`, background:'transparent', color:MUTED, cursor:tasks.length===1?'default':'pointer', fontSize:'14px', display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0, opacity:tasks.length===1?0.3:1 }}>×</button>
                </div>
              );
            })}

            <datalist id="known-people-npm">
              {knownNames.map(n => <option key={n} value={n} />)}
            </datalist>

            <button onClick={addTaskRow}
              style={{ display:'flex', alignItems:'center', gap:'6px', marginTop:'6px', padding:'6px 12px', borderRadius:'7px', border:`1px dashed ${BORDER}`, background:'transparent', color:MUTED, fontSize:'12px', cursor:'pointer', width:'100%', justifyContent:'center' }}
              onMouseEnter={e => e.currentTarget.style.borderColor=ORANGE}
              onMouseLeave={e => e.currentTarget.style.borderColor=BORDER}>
              + Add task row
            </button>
          </div>

          {error && <div style={{ marginTop:'12px', padding:'9px 12px', borderRadius:'8px', background:'#3B1219', border:'1px solid #7F1D1D', color:'#FCA5A5', fontSize:'12px' }}>{error}</div>}
        </div>

        <div style={{ padding:'14px 22px', borderTop:`1px solid ${BORDER}`, display:'flex', gap:'10px', justifyContent:'flex-end', flexShrink:0, background:'#17171F' }}>
          <button onClick={onClose} style={{ padding:'8px 18px', borderRadius:'8px', border:`1px solid ${BORDER}`, background:'transparent', color:MUTED, fontSize:'13px', cursor:'pointer' }}>Cancel</button>
          <button onClick={handleAdd} style={{ padding:'8px 22px', borderRadius:'8px', border:'none', background:ORANGE, color:'white', fontSize:'13px', fontWeight:'700', cursor:'pointer' }}>
            Create Project
          </button>
        </div>
      </div>
    </div>
  );
}


