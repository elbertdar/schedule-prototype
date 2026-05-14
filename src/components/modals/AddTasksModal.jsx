// ── AddTasksModal ────────────────────────────────────────────────────────────
// Form modal for adding new tasks to an existing project. Pulls from saved
// workflows and dep overrides for type-correct dependency setup.

import { useState } from 'react';
import { loadWorkflows, loadDepOverrides, saveDepOverrides } from '../../storage/persist.jsx';
import { PERSON_COLORS, CARD, BORDER, ORANGE, TEXT, MUTED } from '../../theme.jsx';

export function AddTasksModal({ proj, existingTasks, existingPeople, onAdd, onClose }) {
  const INPUT  = { width:'100%', padding:'8px 10px', borderRadius:'8px', border:`1px solid ${BORDER}`, background:'#0F0F18', color:TEXT, fontSize:'12px', outline:'none', boxSizing:'border-box', fontFamily:'inherit' };

  const nextLetter = () => {
    const used = existingTasks.map(t => t.id.split('-')[1] || '').filter(Boolean);
    for (let i = 0; i < 26; i++) {
      const l = String.fromCharCode(65 + i);
      if (!used.includes(l)) return l;
    }
    return String(existingTasks.length + 1);
  };

  const [tasks, setTasks] = useState([
    { seq: nextLetter(), name:'', person:'', role:'', rate:'', start:'', end:'', deps:[], depType:'FS' }
  ]);
  const [error, setError] = useState('');
  const [workflows] = useState(() => loadWorkflows());

  const updateTask = (i, f, v) => setTasks(prev => prev.map((t, idx) => idx===i ? {...t,[f]:v} : t));

  const toggleDep = (i, seq) => setTasks(prev => prev.map((t, idx) => {
    if (idx !== i) return t;
    const deps = t.deps.includes(seq) ? t.deps.filter(d => d !== seq) : [...t.deps, seq];
    return { ...t, deps };
  }));

  const addRow = () => {
    const used = [...existingTasks.map(t => t.id.split('-')[1]), ...tasks.map(t => t.seq)];
    let seq = 'A';
    for (let i = 0; i < 52; i++) {
      const l = i < 26 ? String.fromCharCode(65+i) : String.fromCharCode(65+i-26).repeat(2);
      if (!used.includes(l)) { seq = l; break; }
    }
    setTasks(prev => [...prev, { seq, name:'', person:'', role:'', rate:'', start:'', end:'', deps:[], depType:'FS' }]);
  };

  const removeRow = i => setTasks(prev => prev.filter((_, idx) => idx !== i));

  const loadWorkflow = wfId => {
    const wf = workflows.get(wfId);
    if (!wf) return;
    const used = existingTasks.map(t => t.id.split('-')[1] || '');
    let letterIdx = 0;
    const nextSeq = () => {
      while (letterIdx < 26 && used.includes(String.fromCharCode(65+letterIdx))) letterIdx++;
      return String.fromCharCode(65 + (letterIdx++));
    };
    const newRows = wf.tasks.map(t => ({
      seq: nextSeq(), name: t.name, person:'', role: t.role||'', rate:'', start:'', end:'',
      deps: t.deps || [], depType: t.depType || 'FS',
    }));
    setTasks(newRows);
  };

  const handleAdd = () => {
    const valid = tasks.filter(t => t.name.trim() && t.start.trim() && t.end.trim());
    if (!valid.length) { setError('Each task needs a name, start date, and end date.'); return; }
    const newTasks = valid.map(t => ({
      id: `${proj.id}-${t.seq}`,
      proj: proj.id,
      name: t.name.trim(),
      person: t.person.trim(),
      role: t.role.trim(),
      dur: 1,
      start: t.start.trim(),
      end: t.end.trim(),
      deps: t.deps.map(d => `${proj.id}-${d}`),
    }));
    // Save typed deps via depOverrides
    const depMap = loadDepOverrides();
    for (const t of valid) {
      if (t.deps.length) {
        depMap.set(`${proj.id}-${t.seq}`, t.deps.map(d => ({ id:`${proj.id}-${d}`, type: t.depType })));
      }
    }
    saveDepOverrides(depMap);

    const newPeople = [];
    for (const t of newTasks) {
      if (t.person && !existingPeople.find(p => p.name === t.person) && !newPeople.find(p => p.name === t.person)) {
        const src = valid.find(v => v.name === t.name);
        const init = t.person.split(' ').map(w=>w[0]).join('').slice(0,2).toUpperCase();
        newPeople.push({ name:t.person, role:src?.role||'', init, color:PERSON_COLORS[existingPeople.length % PERSON_COLORS.length], rate:src?.rate||'$42/hr' });
      }
    }
    onAdd({ tasks:newTasks, people:newPeople });
    onClose();
  };

  const wfList = [...workflows.values()];

  return (
    <div style={{ position:'fixed', inset:0, zIndex:1000, background:'rgba(10,10,15,0.7)', backdropFilter:'blur(4px)', display:'flex', alignItems:'center', justifyContent:'center' }}
      onClick={e => { if (e.target===e.currentTarget) onClose(); }}>
      <div style={{ background:CARD, borderRadius:'16px', width:'700px', maxWidth:'95vw', maxHeight:'85vh', display:'flex', flexDirection:'column', boxShadow:'0 24px 64px rgba(0,0,0,0.5)', border:`1px solid ${BORDER}`, overflow:'hidden' }}>
        <div style={{ padding:'18px 22px 14px', borderBottom:`2px solid ${proj.color}`, background:'#17171F', flexShrink:0 }}>
          <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between' }}>
            <div>
              <div style={{ display:'flex', alignItems:'center', gap:'8px' }}>
                <div style={{ width:'10px', height:'10px', borderRadius:'50%', background:proj.color }} />
                <div style={{ fontSize:'15px', fontWeight:'700', color:TEXT }}>Add Tasks to {proj.id}</div>
              </div>
              <div style={{ fontSize:'11px', color:MUTED, marginTop:'3px' }}>{proj.name} · {existingTasks.length} existing tasks</div>
            </div>
            <button onClick={onClose} style={{ background:'none', border:'none', cursor:'pointer', color:MUTED, fontSize:'22px', lineHeight:1, padding:0 }}>×</button>
          </div>
        </div>

        <div style={{ overflowY:'auto', flex:1, padding:'18px 22px' }}>
          {/* Workflow loader */}
          {wfList.length > 0 && (
            <div style={{ marginBottom:'16px', padding:'10px 14px', borderRadius:'9px', background:'#17171F', border:`1px solid ${BORDER}`, display:'flex', alignItems:'center', gap:'10px' }}>
              <span style={{ fontSize:'11px', color:MUTED, fontWeight:'600', flexShrink:0 }}>Load workflow:</span>
              <select onChange={e => { if (e.target.value) loadWorkflow(e.target.value); e.target.value=''; }}
                style={{ flex:1, padding:'5px 9px', borderRadius:'7px', border:`1px solid ${BORDER}`, background:'#0F0F18', color:TEXT, fontSize:'12px', outline:'none', cursor:'pointer' }}>
                <option value=''>— select a workflow —</option>
                {wfList.map(wf => <option key={wf.id} value={wf.id}>{wf.name} ({wf.tasks.length} tasks)</option>)}
              </select>
            </div>
          )}

          {/* Column headers */}
          <div style={{ display:'grid', gridTemplateColumns:'36px 1fr 100px 90px 90px 150px 24px', gap:'6px', marginBottom:'8px', paddingBottom:'6px', borderBottom:`1px solid ${BORDER}` }}>
            {['ID','Task Name','Assigned','Start','End','Dependencies',''].map((h,i) => (
              <div key={i} style={{ fontSize:'10px', color:MUTED, fontWeight:'600', textTransform:'uppercase', letterSpacing:'0.05em' }}>{h}</div>
            ))}
          </div>
          {tasks.map((t, i) => {
            const prevSeqs = tasks.slice(0, i).map(x => x.seq);
            return (
              <div key={i} style={{ display:'grid', gridTemplateColumns:'36px 1fr 100px 90px 90px 150px 24px', gap:'6px', marginBottom:'6px', alignItems:'center' }}>
                <div style={{ fontSize:'11px', fontWeight:'700', color:proj.color, textAlign:'center', background:proj.color+'15', borderRadius:'5px', padding:'6px 0', border:`1px solid ${proj.color}40`, whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>{proj.id}-{t.seq}</div>
                <input value={t.name}   onChange={e=>updateTask(i,'name',  e.target.value)} placeholder="Task name"   style={INPUT} />
                <input value={t.person} onChange={e=>updateTask(i,'person',e.target.value)} placeholder="Name" list="known-people-add" style={INPUT} />
                <input value={t.start}  onChange={e=>updateTask(i,'start', e.target.value)} placeholder="DD/MM/YYYY" style={INPUT} />
                <input value={t.end}    onChange={e=>updateTask(i,'end',   e.target.value)} placeholder="DD/MM/YYYY" style={INPUT} />
                {/* Dep type + letter selector */}
                <div style={{ display:'flex', gap:'4px', flexWrap:'wrap', alignItems:'center' }}>
                  <div style={{ display:'flex', borderRadius:'6px', overflow:'hidden', border:`1px solid ${BORDER}`, flexShrink:0 }}>
                    {['FS','SS'].map(tp => (
                      <button key={tp} onClick={() => updateTask(i,'depType',tp)}
                        style={{ padding:'3px 7px', border:'none', cursor:'pointer', fontSize:'10px', fontWeight:'700', background: t.depType===tp ? proj.color : 'transparent', color: t.depType===tp ? 'white' : MUTED }}>
                        {tp}
                      </button>
                    ))}
                  </div>
                  {prevSeqs.map(seq => (
                    <button key={seq} onClick={() => toggleDep(i, seq)}
                      style={{ padding:'3px 8px', borderRadius:'5px', border:`1px solid ${t.deps.includes(seq) ? proj.color : BORDER}`, background: t.deps.includes(seq) ? proj.color+'20' : 'transparent', cursor:'pointer', fontSize:'10px', fontWeight:'700', color: t.deps.includes(seq) ? proj.color : MUTED }}>
                      {seq}
                    </button>
                  ))}
                  {prevSeqs.length === 0 && <span style={{ fontSize:'10px', color:MUTED, fontStyle:'italic' }}>—</span>}
                </div>
                <button onClick={()=>removeRow(i)} disabled={tasks.length===1}
                  style={{ width:'24px', height:'24px', borderRadius:'5px', border:`1px solid ${BORDER}`, background:'transparent', color:MUTED, cursor:tasks.length===1?'default':'pointer', fontSize:'14px', display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0, opacity:tasks.length===1?0.3:1 }}>×</button>
              </div>
            );
          })}
          <datalist id="known-people-add">{existingPeople.map(p=><option key={p.name} value={p.name}/>)}</datalist>
          <button onClick={addRow}
            style={{ display:'flex', alignItems:'center', gap:'6px', marginTop:'6px', padding:'6px 12px', borderRadius:'7px', border:`1px dashed ${BORDER}`, background:'transparent', color:MUTED, fontSize:'12px', cursor:'pointer', width:'100%', justifyContent:'center' }}
            onMouseEnter={e=>e.currentTarget.style.borderColor=proj.color}
            onMouseLeave={e=>e.currentTarget.style.borderColor=BORDER}>
            + Add task row
          </button>
          {error && <div style={{ marginTop:'12px', padding:'9px 12px', borderRadius:'8px', background:'#3B1219', border:'1px solid #7F1D1D', color:'#FCA5A5', fontSize:'12px' }}>{error}</div>}
        </div>

        <div style={{ padding:'14px 22px', borderTop:`1px solid ${BORDER}`, display:'flex', gap:'10px', justifyContent:'flex-end', flexShrink:0, background:'#17171F' }}>
          <button onClick={onClose} style={{ padding:'8px 18px', borderRadius:'8px', border:`1px solid ${BORDER}`, background:'transparent', color:MUTED, fontSize:'13px', cursor:'pointer' }}>Cancel</button>
          <button onClick={handleAdd} style={{ padding:'8px 22px', borderRadius:'8px', border:'none', background:proj.color, color:'white', fontSize:'13px', fontWeight:'700', cursor:'pointer' }}>
            + Add Tasks
          </button>
        </div>
      </div>
    </div>
  );
}
