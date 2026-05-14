// ── TaskList ─────────────────────────────────────────────────────────────────
// Used inside EditModal to show a short list of tasks affected by a shift.

import { useSched } from '../../context.jsx';

export function TaskList({ items, tasks, icon, label, labelColor, bg, getValue, valueColor, overflow = 0 }) {
  const { projs } = useSched() || {};
  if (!items.length) return null;

  return (
    <div style={{ marginBottom:'8px' }}>
      <div style={{ fontSize:'10px', fontWeight:'700', color:labelColor, marginBottom:'5px', display:'flex', alignItems:'center', gap:'4px' }}>
        <span>{icon}</span> {label}
      </div>
      {items.map(t => {
        const pc = projs?.find(p => p.id === t.projId)?.color || '#888';
        return (
          <div key={t.id} style={{ display:'flex', alignItems:'center', gap:'8px', padding:'4px 6px', borderRadius:'5px', marginBottom:'3px', background:bg }}>
            <div style={{ width:'3px', height:'20px', borderRadius:'2px', background:pc, flexShrink:0 }} />
            <span style={{ fontSize:'11px', color:'#0F172A', flex:1, minWidth:0, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{t.name}</span>
            <span style={{ fontSize:'10px', color:valueColor, fontWeight:'700', flexShrink:0 }}>{getValue(t)}</span>
          </div>
        );
      })}
      {overflow > 0 && <div style={{ fontSize:'10px', color:'#94A3B8', marginTop:'3px', paddingLeft:'6px' }}>+{overflow} more</div>}
    </div>
  );
}
