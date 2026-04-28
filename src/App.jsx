import { useState, useMemo, useRef, useEffect } from "react";

// ── Schedule engine ───────────────────────────────────────────────────────────
const BASE = new Date(2025, 0, 1);
function addW(d, n) {
  if (!n) return new Date(d);
  const r = new Date(d); let c = 0, s = n > 0 ? 1 : -1;
  while (c < Math.abs(n)) { r.setDate(r.getDate() + s); if (r.getDay() % 6) c++; }
  return r;
}
function calDiff(a, b) { return Math.round((b - a) / 864e5); }
function wdayGap(e, s) {
  if (s <= e) return 0;
  let g = 0; const c = new Date(e);
  while (c < s) { c.setDate(c.getDate() + 1); if (c.getDay() % 6) g++; }
  return g;
}

// [seq, name, offset, dur, stage, deps]
const TDEFS = [
  [1,  "Sales Accept completed",                0,  0, "Sales",    []],
  [2,  "Drafting – Masters set up",             0,  1, "Design",   [1]],
  [3,  "Property Information received",         5,  0, "Design",   [1]],
  [4,  "Drafting Masters complete",             0,  3, "Design",   [2, 3]],
  [5,  "Town Planning Drawings Set Saved",      0,  3, "Tender",   [4]],
  [6,  "Town Planning Application Submitted",   0,  0, "Tender",   [5]],
  [7,  "RFI received – Town Planning",         20,  1, "Tender",   [6]],
  [8,  "Town Planning Permit Approved",        15,  0, "Tender",   [6, 7]],
  [9,  "Slab engineering ordered",              0,  0, "Tender",   [8]],
  [10, "Estimating – Fixed Priced Tender",      2,  6, "Tender",   [4]],
  [11, "Appointment – Tender",                  5,  1, "Tender",   [10]],
  [12, "Tender V1 Comments Received",           5,  0, "Tender",   [11]],
  [13, "Estimating – Fixed Priced Tender V2",   2,  2, "Tender",   [12]],
  [14, "Tender Signed",                         1,  0, "Tender",   [10, 11, 13]],
  [15, "Drafting – Contract Drawings",          2,  6, "Contract", [14]],
  [16, "Drafting – Services Check",             0,  1, "Contract", [15]],
  [17, "Estimating – Fixed Priced Contract",    1,  1, "Contract", [15]],
  [18, "Contract signed",                       2,  0, "Contract", [17]],
  [19, "Estimating – Production Estimating",    1,  4, "ACC",      [18]],
  [20, "Building Permit requested",             0,  0, "ACC",      [18]],
  [21, "Drafting – Final Drawings",             0,  1, "ACC",      [19]],
  [22, "Estimating – Check final engineering",  0,  1, "ACC",      [21]],
  [23, "Building Permit issued",                1,  0, "ACC",      [20, 21]],
  [24, "Estimating – Finalise Purchase Orders", 0,  1, "ACC",      [22, 23]],
  [25, "ACC'd",                                 0,  0, "ACC",      [23, 24]],
];

// seq → dep seqs lookup (used for drawing dep lines)
const TDEP_MAP = Object.fromEntries(TDEFS.map(([seq,,,,, deps]) => [seq, deps]));

const PMAP = {
  P1: { 1:'Alex',2:'Jake',3:'Alex',4:'Jake',5:'Mia',6:'Alex',7:'Mia',8:'Alex',9:'Jake',10:'Sam',11:'Alex',12:'Alex',13:'Sam',14:'Alex',15:'Mia',16:'Jake',17:'Sam',18:'Alex',19:'Sam',20:'Alex',21:'Jake',22:'Sam',23:'Alex',24:'Lee',25:'Alex' },
  P2: { 1:'Alex',2:'Mia',3:'Alex',4:'Mia',5:'Jake',6:'Alex',7:'Jake',8:'Alex',9:'Jake',10:'Lee',11:'Alex',12:'Alex',13:'Lee',14:'Alex',15:'Jake',16:'Tom',17:'Lee',18:'Alex',19:'Sam',20:'Alex',21:'Jake',22:'Sam',23:'Alex',24:'Lee',25:'Alex' },
  P3: { 1:'Alex',2:'Tom',3:'Alex',4:'Tom',5:'Jake',6:'Alex',7:'Tom',8:'Alex',9:'Jake',10:'Lee',11:'Alex',12:'Alex',13:'Sam',14:'Alex',15:'Tom',16:'Jake',17:'Lee',18:'Alex',19:'Lee',20:'Alex',21:'Jake',22:'Lee',23:'Alex',24:'Sam',25:'Alex' },
};

const DELAYS = { 'P1-4': 5, 'P2-15': 4, 'P3-10': 3, 'P2-19': 2 };
// Tasks shown as overdue for demo (today = day 73, Mar 15)
const OVERDUE = new Set(['P1-15', 'P1-16']);
// Day number for "today" in the chart
const TODAY_DAY = 73;

// Named time periods — startDay/endDay are calendar-day offsets from BASE (Jan 1)
const PERIODS = [
  { key:'jan',  label:"Jan '25",   startDay:0,   endDay:30  },
  { key:'feb',  label:"Feb '25",   startDay:31,  endDay:58  },
  { key:'mar',  label:"Mar '25",   startDay:59,  endDay:89  },
  { key:'apr',  label:"Apr '25",   startDay:90,  endDay:119 },
  { key:'may',  label:"May '25",   startDay:120, endDay:150 },
  { key:'jun',  label:"Jun '25",   startDay:151, endDay:180 },
  { key:'q1',   label:"Q1 '25",    startDay:0,   endDay:89  },
  { key:'q2',   label:"Q2 '25",    startDay:90,  endDay:180 },
];

const PROJS = [
  { id:'P1', name:'Project 1 – New Build', base:new Date(2025,0,1),  color:'#6366F1' },
  { id:'P2', name:'Project 2 – New Build', base:new Date(2025,2,17), color:'#10B981' },
  { id:'P3', name:'Project 3 – New Build', base:new Date(2025,3,2),  color:'#F59E0B' },
];

const PEOPLE = [
  { name:'Alex', role:'Project Coordinator', color:'#6366F1', init:'AX' },
  { name:'Jake', role:'Draftee',             color:'#10B981', init:'JK' },
  { name:'Mia',  role:'Draftee',             color:'#EC4899', init:'MI' },
  { name:'Tom',  role:'Draftee',             color:'#F59E0B', init:'TM' },
  { name:'Sam',  role:'Sales Estimator',     color:'#EF4444', init:'SM' },
  { name:'Lee',  role:'Sales Estimator',     color:'#06B6D4', init:'LE' },
];

const SC = {
  Sales:    { bg:'#BBFCCE', bd:'#22C55E', tx:'#14532D' },
  Design:   { bg:'#DBEAFE', bd:'#60A5FA', tx:'#1E3A8A' },
  Tender:   { bg:'#FEF08A', bd:'#EAB308', tx:'#713F12' },
  Contract: { bg:'#FED7AA', bd:'#F97316', tx:'#7C2D12' },
  ACC:      { bg:'#E9D5FF', bd:'#A855F7', tx:'#3B0764' },
};

function buildSched(extraDelays = {}) {
  const _d = k => (DELAYS[k] || 0) + (extraDelays[k] || 0);
  const all = [];
  for (const proj of PROJS) {
    const sd = {}, ed = {};
    for (const [seq,, off, dur,, deps] of TDEFS) {
      let lat = new Date(proj.base);
      for (const d of deps) if (ed[d] && ed[d] > lat) lat = new Date(ed[d]);
      const s = addW(lat, off);
      const delay = _d(`${proj.id}-${seq}`);
      sd[seq] = s; ed[seq] = addW(s, dur + delay);
    }
    for (const [seq, name, off, dur, stage, deps] of TDEFS) {
      const delay = _d(`${proj.id}-${seq}`);
      all.push({
        id: `${proj.id}-${seq}`, projId: proj.id, seq, name, stage, dur,
        person: PMAP[proj.id][seq], delay,
        s: new Date(sd[seq]), e: new Date(ed[seq]),
        sd: calDiff(BASE, sd[seq]),
        cd: calDiff(sd[seq], ed[seq]),
        isC: false, isF: false, cw: [],
      });
    }
  }
  for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) {
    const a = all[i], b = all[j];
    if (a.person !== b.person || !a.cd || !b.cd) continue;
    if (a.s <= b.e && b.s <= a.e) { a.isC = b.isC = true; a.cw.push(b.id); b.cw.push(a.id); }
  }
  const byP = {};
  for (const t of all)(byP[t.person] = byP[t.person] || []).push(t);
  for (const ts of Object.values(byP)) {
    ts.sort((a, b) => a.s - b.s);
    for (let i = 0; i < ts.length - 1; i++)
      if (wdayGap(ts[i].e, ts[i + 1].s) <= 1) { ts[i].isF = ts[i + 1].isF = true; }
  }
  return all;
}

// ── Bezier midpoint helper ───────────────────────────────────────────────────
// Given cubic bezier control points, returns the x/y at t=0.5 and the
// tangent angle there (degrees) — used to place the mid-arrow marker.
function bezierMid(x0, y0, cx1, cy1, cx2, cy2, x1, y1) {
  const t = 0.5, mt = 0.5;
  const mx = mt*mt*mt*x0 + 3*mt*mt*t*cx1 + 3*mt*t*t*cx2 + t*t*t*x1;
  const my = mt*mt*mt*y0 + 3*mt*mt*t*cy1 + 3*mt*t*t*cy2 + t*t*t*y1;
  const dx = 3*(mt*mt*(cx1-x0) + 2*mt*t*(cx2-cx1) + t*t*(x1-cx2));
  const dy = 3*(mt*mt*(cy1-y0) + 2*mt*t*(cy2-cy1) + t*t*(y1-cy2));
  return { mx, my, angle: Math.atan2(dy, dx) * 180 / Math.PI };
}

// ── Gantt constants ───────────────────────────────────────────────────────────
const DPX = 9, RH = 76, BH = 42, HH = 56, LW = 190, TD = 181;
const MONS = [
  { n:'Jan', d:0 }, { n:'Feb', d:31 }, { n:'Mar', d:59 },
  { n:'Apr', d:90 }, { n:'May', d:120 }, { n:'Jun', d:151 }, { n:'', d:181 },
];
const fd = d => d.toLocaleDateString('en-AU', { day:'2-digit', month:'short' });

// ── Gantt tab ─────────────────────────────────────────────────────────────────
function ConflictsTab({ tasks }) {
  const [activeTask, setActiveTask] = useState(null);   // taskId whose dropdown is open
  const [reassigned, setReassigned] = useState({});     // taskId → { to, from }

  const conflicts = useMemo(() => tasks.filter(t => t.isC).sort((a, b) => a.s - b.s), [tasks]);

  // Same-role candidates for a task (excludes current assignee)
  const getCandidates = task => {
    const per = PEOPLE.find(p => p.name === task.person);
    return per ? PEOPLE.filter(p => p.role === per.role && p.name !== task.person) : [];
  };

  // How busy is a person during a given window [s, e]?
  // Returns { count: overlapping tasks, days: total calendar days of overlap }
  const getAvail = (personName, s, e) => {
    const overlap = tasks.filter(t =>
      t.person === personName && t.cd > 0 && t.s <= e && t.e >= s
    );
    return { count: overlap.length, days: overlap.reduce((sum, t) => sum + t.cd, 0) };
  };

  const handleReassign = (taskId, toPerson, fromPerson) => {
    setReassigned(prev => ({ ...prev, [taskId]: { to: toPerson, from: fromPerson } }));
    setActiveTask(null);
  };

  const undoReassign = taskId => setReassigned(prev => {
    const next = { ...prev }; delete next[taskId]; return next;
  });

  const pending   = conflicts.filter(t => !reassigned[t.id]);
  const resolved  = conflicts.filter(t =>  reassigned[t.id]);

  const byPerson = {};
  for (const t of pending)(byPerson[t.person] = byPerson[t.person] || []).push(t);

  return (
    <div style={{ padding: '16px' }}>

      {/* Summary banner */}
      <div style={{ marginBottom: '14px', padding: '10px 14px', background: '#FFF1F2', borderRadius: '8px', border: '1px solid #FECDD3', fontSize: '12px', color: '#9F1239', lineHeight: '1.5', display: 'flex', alignItems: 'center', gap: '12px' }}>
        <div style={{ flex: 1 }}>
          <strong>{pending.length} unresolved</strong> of {conflicts.length} conflicts ·
          Root causes: Jake/P1 Seq4 +5d · Jake/P2 Seq15 +4d · Lee/P3 Seq10 +3d · Sam/P2 Seq19 +2d.
        </div>
        {resolved.length > 0 && (
          <span style={{ background: '#DCFCE7', color: '#14532D', border: '1px solid #86EFAC', padding: '2px 10px', borderRadius: '20px', fontSize: '11px', fontWeight: '700', flexShrink: 0 }}>
            ✓ {resolved.length} reassigned
          </span>
        )}
      </div>

      {/* Pending conflicts grouped by person */}
      {Object.entries(byPerson).map(([person, ts]) => {
        const per = PEOPLE.find(p => p.name === person);
        return (
          <div key={person} style={{ marginBottom: '16px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px', padding: '8px 12px', background: per.color + '10', borderRadius: '8px', border: `1px solid ${per.color}20` }}>
              <div style={{ width: '30px', height: '30px', borderRadius: '50%', background: per.color + '20', border: `1.5px solid ${per.color}`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '10px', fontWeight: '700', color: per.color, flexShrink: 0 }}>{per.init}</div>
              <span style={{ fontWeight: '600', fontSize: '13px' }}>{person}</span>
              <span style={{ color: '#94A3B8', fontSize: '11px' }}>{per.role}</span>
              <span style={{ marginLeft: 'auto', background: '#FEF2F2', border: '1px solid #FECACA', color: '#DC2626', padding: '2px 8px', borderRadius: '20px', fontSize: '11px', fontWeight: '600' }}>
                {ts.length} conflict{ts.length > 1 ? 's' : ''}
              </span>
            </div>

            <div style={{ display: 'grid', gap: '6px', paddingLeft: '6px' }}>
              {ts.map(t => {
                const pc = PROJS.find(p => p.id === t.projId)?.color || '#888';
                const cNames = t.cw.map(id => { const c = tasks.find(x => x.id === id); return c ? `${c.projId} Seq ${c.seq}` : id; });
                const isOpen = activeTask === t.id;
                const candidates = getCandidates(t).map(p => ({ ...p, avail: getAvail(p.name, t.s, t.e) })).sort((a, b) => a.avail.days - b.avail.days);

                return (
                  <div key={t.id}>
                    {/* Task card */}
                    <div style={{ display: 'flex', alignItems: 'flex-start', gap: '10px', padding: '10px 12px', borderRadius: isOpen ? '8px 8px 0 0' : '8px', background: '#FEF2F2', border: '1px solid #FECACA', borderBottom: isOpen ? 'none' : '1px solid #FECACA', cursor: 'default' }}>
                      <div style={{ width: '4px', height: '40px', borderRadius: '2px', background: pc, flexShrink: 0, marginTop: '2px' }} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: '12px', fontWeight: '600', color: '#0F172A' }}>{t.name}</div>
                        <div style={{ fontSize: '11px', color: '#64748B', marginTop: '2px', display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center' }}>
                          <span style={{ background: SC[t.stage]?.bg, color: SC[t.stage]?.tx, padding: '0 5px', borderRadius: '3px', fontSize: '10px', fontWeight: '500' }}>{t.stage}</span>
                          <span>{t.projId} · Seq {t.seq}</span>
                          {t.delay > 0 && <span style={{ color: '#DC2626', fontWeight: '700' }}>+{t.delay}d delay</span>}
                        </div>
                        {cNames.length > 0 && <div style={{ fontSize: '10px', color: '#EF4444', marginTop: '4px', fontWeight: '500' }}>Clashes with: {cNames.join(', ')}</div>}
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '6px', flexShrink: 0 }}>
                        <div style={{ textAlign: 'right', fontSize: '11px', color: '#64748B' }}>
                          <div style={{ fontWeight: '600', color: '#374151' }}>{fd(t.s)}</div>
                          <div>→ {fd(t.e)}</div>
                        </div>
                        {candidates.length > 0 && (
                          <button onClick={() => setActiveTask(isOpen ? null : t.id)} style={{
                            padding: '4px 10px', borderRadius: '6px', fontSize: '11px', fontWeight: '600',
                            border: `1px solid ${isOpen ? '#6366F1' : '#CBD5E1'}`,
                            background: isOpen ? '#6366F1' : 'white',
                            color: isOpen ? 'white' : '#374151',
                            cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '4px',
                            transition: 'all 0.12s',
                          }}>
                            Reassign {isOpen ? '▲' : '▼'}
                          </button>
                        )}
                        {candidates.length === 0 && (
                          <span style={{ fontSize: '10px', color: '#94A3B8', fontStyle: 'italic' }}>No alternatives</span>
                        )}
                      </div>
                    </div>

                    {/* Reassign dropdown */}
                    {isOpen && (
                      <div style={{
                        border: '1px solid #FECACA', borderTop: '1px solid #E2E8F0',
                        borderRadius: '0 0 8px 8px', background: 'white',
                        overflow: 'hidden', marginBottom: '0',
                      }}>
                        <div style={{ padding: '8px 14px', background: '#F8FAFC', borderBottom: '1px solid #F1F5F9', display: 'flex', alignItems: 'center', gap: '8px' }}>
                          <span style={{ fontSize: '10px', fontWeight: '700', color: '#64748B', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                            Reassign to — {per.role}
                          </span>
                          <span style={{ fontSize: '10px', color: '#94A3B8' }}>sorted by availability in this window</span>
                        </div>
                        <div style={{ maxHeight: '220px', overflowY: 'auto' }}>
                          {candidates.map((cand, ci) => {
                            const isRec = ci === 0;
                            const freeLabel = cand.avail.count === 0
                              ? 'Free in this window'
                              : `${cand.avail.count} task${cand.avail.count > 1 ? 's' : ''} · ${cand.avail.days}d busy`;
                            return (
                              <div key={cand.name}
                                onClick={() => handleReassign(t.id, cand.name, t.person)}
                                style={{
                                  display: 'flex', alignItems: 'center', gap: '12px',
                                  padding: '10px 14px', cursor: 'pointer',
                                  borderBottom: ci < candidates.length - 1 ? '1px solid #F1F5F9' : 'none',
                                  background: isRec ? '#F5F3FF' : 'white',
                                  transition: 'background 0.1s',
                                }}
                                onMouseEnter={e => e.currentTarget.style.background = isRec ? '#EDE9FE' : '#F8FAFC'}
                                onMouseLeave={e => e.currentTarget.style.background = isRec ? '#F5F3FF' : 'white'}>

                                {/* Avatar */}
                                <div style={{ width: '34px', height: '34px', borderRadius: '50%', background: cand.color + '20', border: `2px solid ${cand.color}`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '10px', fontWeight: '700', color: cand.color, flexShrink: 0 }}>
                                  {cand.init}
                                </div>

                                {/* Name + availability */}
                                <div style={{ flex: 1 }}>
                                  <div style={{ display: 'flex', alignItems: 'center', gap: '7px' }}>
                                    <span style={{ fontSize: '13px', fontWeight: '600', color: '#0F172A' }}>{cand.name}</span>
                                    {isRec && (
                                      <span style={{ fontSize: '9px', fontWeight: '700', background: '#6366F1', color: 'white', padding: '1px 7px', borderRadius: '20px', letterSpacing: '0.04em' }}>
                                        RECOMMENDED
                                      </span>
                                    )}
                                  </div>
                                  <div style={{ fontSize: '11px', color: cand.avail.count === 0 ? '#10B981' : '#64748B', marginTop: '2px', fontWeight: cand.avail.count === 0 ? '600' : '400' }}>
                                    {freeLabel}
                                  </div>
                                </div>

                                {/* Busyness bar */}
                                <div style={{ width: '60px', flexShrink: 0 }}>
                                  <div style={{ height: '4px', background: '#F1F5F9', borderRadius: '2px', overflow: 'hidden' }}>
                                    <div style={{
                                      height: '100%', borderRadius: '2px',
                                      width: `${Math.min(100, cand.avail.days * 5)}%`,
                                      background: cand.avail.days === 0 ? '#10B981' : cand.avail.days < 10 ? '#F59E0B' : '#EF4444',
                                    }} />
                                  </div>
                                  <div style={{ fontSize: '9px', color: '#94A3B8', marginTop: '3px', textAlign: 'right' }}>{cand.avail.days}d</div>
                                </div>

                                {/* Select arrow */}
                                <div style={{ color: '#CBD5E1', fontSize: '14px', flexShrink: 0 }}>›</div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}

      {/* Resolved / reassigned section */}
      {resolved.length > 0 && (
        <div style={{ marginTop: '8px' }}>
          <div style={{ fontSize: '10px', fontWeight: '700', color: '#94A3B8', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: '8px' }}>
            Reassigned ({resolved.length})
          </div>
          <div style={{ display: 'grid', gap: '5px' }}>
            {resolved.map(t => {
              const ra = reassigned[t.id];
              const toPer = PEOPLE.find(p => p.name === ra.to);
              const pc = PROJS.find(p => p.id === t.projId)?.color || '#888';
              return (
                <div key={t.id} style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '9px 12px', borderRadius: '8px', background: '#F0FDF4', border: '1px solid #BBF7D0' }}>
                  <div style={{ width: '4px', height: '32px', borderRadius: '2px', background: pc, flexShrink: 0 }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: '12px', fontWeight: '600', color: '#0F172A', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.name}</div>
                    <div style={{ fontSize: '11px', color: '#64748B', marginTop: '2px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                      <span style={{ color: '#94A3B8', textDecoration: 'line-through' }}>{ra.from}</span>
                      <span style={{ color: '#94A3B8' }}>→</span>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                        <div style={{ width: '16px', height: '16px', borderRadius: '50%', background: toPer?.color + '20', border: `1px solid ${toPer?.color}`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '7px', fontWeight: '700', color: toPer?.color }}>{toPer?.init}</div>
                        <span style={{ fontWeight: '600', color: '#14532D' }}>{ra.to}</span>
                      </div>
                    </div>
                  </div>
                  <button onClick={() => undoReassign(t.id)} style={{ padding: '3px 9px', borderRadius: '6px', border: '1px solid #D1D5DB', background: 'white', cursor: 'pointer', fontSize: '11px', color: '#64748B', fontWeight: '500' }}>
                    Undo
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// ── People tab ────────────────────────────────────────────────────────────────
function PeopleTab({ tasks, sel, onSel }) {
  const pt = useMemo(()=>sel?tasks.filter(t=>t.person===sel).sort((a,b)=>a.s-b.s):[],[tasks,sel]);
  const per = PEOPLE.find(p=>p.name===sel);
  return (
    <div style={{ display:'flex', minHeight:'420px' }}>
      <div style={{ width:'182px', borderRight:'1px solid #F1F5F9', padding:'10px', flexShrink:0, overflowY:'auto' }}>
        {PEOPLE.map(p=>{
          const mt=tasks.filter(t=>t.person===p.name);
          const mc=mt.filter(t=>t.isC).length;
          return (
            <div key={p.name} onClick={()=>onSel(p.name)} style={{ padding:'10px', borderRadius:'8px', cursor:'pointer', marginBottom:'4px', background:sel===p.name?p.color+'18':'transparent', border:sel===p.name?`1px solid ${p.color}40`:'1px solid transparent' }}>
              <div style={{ display:'flex', alignItems:'center', gap:'8px' }}>
                <div style={{ width:'32px', height:'32px', borderRadius:'50%', background:p.color+'20', border:`1.5px solid ${p.color}`, display:'flex', alignItems:'center', justifyContent:'center', fontSize:'10px', fontWeight:'700', color:p.color, flexShrink:0 }}>{p.init}</div>
                <div>
                  <div style={{ fontSize:'13px', fontWeight:'600', color:'#0F172A' }}>{p.name}</div>
                  <div style={{ fontSize:'10px', color:'#94A3B8' }}>{p.role.split(' ')[0]}</div>
                </div>
              </div>
              <div style={{ display:'flex', gap:'8px', marginTop:'6px', paddingLeft:'40px', fontSize:'10px' }}>
                <span style={{ color:'#64748B' }}>{mt.length} tasks</span>
                {mc>0 && <span style={{ color:'#EF4444', fontWeight:'700' }}>{mc} ⚠</span>}
              </div>
            </div>
          );
        })}
      </div>
      <div style={{ flex:1, padding:'16px', overflowY:'auto' }}>
        {!sel ? (
          <div style={{ display:'flex', alignItems:'center', justifyContent:'center', height:'100%', color:'#94A3B8', fontSize:'13px' }}>← Select a team member to view their schedule</div>
        ) : (
          <>
            <div style={{ display:'flex', alignItems:'center', gap:'14px', marginBottom:'16px', padding:'14px 16px', background:per.color+'0D', borderRadius:'10px', border:`1px solid ${per.color}25` }}>
              <div style={{ width:'46px', height:'46px', borderRadius:'50%', background:per.color+'20', border:`2px solid ${per.color}`, display:'flex', alignItems:'center', justifyContent:'center', fontSize:'14px', fontWeight:'700', color:per.color }}>{per.init}</div>
              <div>
                <div style={{ fontWeight:'700', fontSize:'16px', color:'#0F172A' }}>{per.name}</div>
                <div style={{ fontSize:'12px', color:'#64748B' }}>{per.role}</div>
              </div>
              <div style={{ marginLeft:'auto', display:'flex', gap:'20px' }}>
                {[{l:'Tasks',v:pt.length,c:'#6366F1'},{l:'Conflicts',v:pt.filter(t=>t.isC).length,c:'#EF4444'},{l:'Projects',v:[...new Set(pt.map(t=>t.projId))].length,c:'#10B981'}].map(s=>(
                  <div key={s.l} style={{ textAlign:'center' }}>
                    <div style={{ fontSize:'22px', fontWeight:'800', color:s.v>0&&s.c==='#EF4444'?s.c:'#0F172A', fontVariantNumeric:'tabular-nums' }}>{s.v}</div>
                    <div style={{ fontSize:'10px', color:'#94A3B8', marginTop:'1px' }}>{s.l}</div>
                  </div>
                ))}
              </div>
            </div>
            <div style={{ display:'grid', gap:'5px' }}>
              {pt.map((t,i)=>{
                const sc=SC[t.stage], pc=PROJS.find(p=>p.id===t.projId)?.color||'#888';
                return (
                  <div key={t.id} style={{ display:'flex', alignItems:'center', gap:'10px', padding:'9px 12px', borderRadius:'8px', background:t.isC?'#FEF2F2':'#F8FAFC', border:t.isC?'1px solid #FECACA':'1px solid #F1F5F9' }}>
                    <span style={{ fontSize:'10px', color:'#CBD5E1', width:'16px', textAlign:'right', flexShrink:0, fontVariantNumeric:'tabular-nums' }}>{i+1}</span>
                    <div style={{ width:'4px', height:'36px', borderRadius:'2px', background:pc, flexShrink:0 }} />
                    <div style={{ flex:1, minWidth:0 }}>
                      <div style={{ fontSize:'12px', fontWeight:'600', color:t.isC?'#991B1B':'#0F172A', whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>{t.name}</div>
                      <div style={{ fontSize:'11px', color:'#94A3B8', marginTop:'2px', display:'flex', gap:'5px', alignItems:'center' }}>
                        <span style={{ background:sc.bg, color:sc.tx, padding:'0 4px', borderRadius:'3px', fontSize:'10px', fontWeight:'500' }}>{t.stage}</span>
                        <span>{t.projId}</span>
                        {t.delay>0 && <span style={{ color:'#DC2626', fontWeight:'700' }}>+{t.delay}d</span>}
                      </div>
                    </div>
                    <div style={{ textAlign:'right', fontSize:'11px', color:'#64748B', flexShrink:0 }}>
                      <div style={{ fontWeight:'600', color:'#374151' }}>{fd(t.s)}</div>
                      <div>{t.cd>0?`${t.cd}d`:'Milestone'}</div>
                    </div>
                    {t.isC && <div style={{ width:'20px', height:'20px', borderRadius:'50%', background:'#EF4444', display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
                      <span style={{ color:'white', fontSize:'10px', fontWeight:'700' }}>!</span>
                    </div>}
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>
    </div>
  );
}


// ── Project Gantt tab ─────────────────────────────────────────────────────────
const PRH = 52;   // project header row height
const RRH = 44;   // role sub-header row height
const SRH = 68;   // person leaf-row height
const SBH = 38;   // person bar height

// Role definitions — color, label, which PEOPLE belong to it
const ROLES = [
  { key:'coordinator', label:'Project Coordinator', color:'#6366F1', people:['Alex'] },
  { key:'draftee',     label:'Draftee',             color:'#10B981', people:['Jake','Mia','Tom'] },
  { key:'estimator',   label:'Sales Estimator',     color:'#F97316', people:['Sam','Lee'] },
];
const roleOf = name => ROLES.find(r => r.people.includes(name)) || ROLES[0];

function ProjectGanttTab({ tasks, zoomProj, zoomPeriod, simDelays, setSimDelays }) {
  const fp = zoomProj || 'All'; // filter alias
  const [expanded, setExpanded] = useState(() => {
    const s = new Set(PROJS.map(p => p.id));
    PROJS.forEach(p => ROLES.forEach(r => s.add(`${p.id}-${r.key}`)));
    return s;
  });
  const [hov, setHov] = useState(null);
  const [mouse, setMouse] = useState({ x: 0, y: 0 });
  const [showDeps, setShowDeps] = useState(false);
  const [showSim,  setShowSim]  = useState(false);
  const [simProj,  setSimProj]  = useState('');
  const [simSeq,   setSimSeq]   = useState('');
  const [simDays,  setSimDays]  = useState(1);
  const outerRef  = useRef(null);
  const scrollRef = useRef(null);  // ref on the right scrollable div

  // ── Dynamic DPX — period takes priority, then project, then default ──────────
  const dpx = useMemo(() => {
    const viewW = (outerRef.current?.clientWidth || 1100) - LW - 40;
    if (zoomPeriod) {
      const period = PERIODS.find(p => p.key === zoomPeriod);
      if (period) {
        const span = period.endDay - period.startDay + 1;
        return Math.min(38, Math.max(14, Math.floor(viewW * 0.92 / span)));
      }
    }
    if (zoomProj) {
      const pt = tasks.filter(t => t.projId === zoomProj && t.cd > 0);
      if (pt.length) {
        const span = Math.max(...pt.map(t => t.sd + t.cd)) - Math.min(...pt.map(t => t.sd));
        return Math.min(28, Math.max(16, Math.floor(viewW * 0.85 / span)));
      }
    }
    return DPX;
  }, [zoomProj, zoomPeriod, tasks]);

  const txR = d => d * dpx; // right SVG: no LW offset

  // ── Unified scroll + auto-behaviour effect ───────────────────────────────────
  useEffect(() => {
    const anyZoom = zoomProj || zoomPeriod;
    if (!anyZoom) {
      setShowDeps(false);
      return;
    }
    setShowDeps(true);

    // If project is focused, expand it
    if (zoomProj) {
      setExpanded(prev => {
        const next = new Set(prev);
        next.add(zoomProj);
        ROLES.forEach(r => next.add(`${zoomProj}-${r.key}`));
        return next;
      });
    }

    // Scroll to the correct position after SVG re-renders
    requestAnimationFrame(() => {
      if (!scrollRef.current) return;
      let scrollDay = 0;

      if (zoomPeriod) {
        // Period takes priority for scroll position
        const period = PERIODS.find(p => p.key === zoomPeriod);
        if (period) scrollDay = period.startDay;
      } else if (zoomProj) {
        // Scroll to project start
        const pt = tasks.filter(t => t.projId === zoomProj && t.cd > 0);
        if (pt.length) scrollDay = Math.min(...pt.map(t => t.sd));
      }

      scrollRef.current.scrollLeft = Math.max(0, scrollDay * dpx - 36);
    });
  }, [zoomProj, zoomPeriod]);

  const toggle = id => setExpanded(prev => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });

  // One entry per project with role → person breakdown
  const projData = useMemo(() => {
    return PROJS
      .filter(p => fp === 'All' || p.id === fp)
      .map(proj => {
        const pt = tasks.filter(t => t.projId === proj.id);
        const withDur = pt.filter(t => t.cd > 0);
        const minSd = withDur.length ? Math.min(...withDur.map(t => t.sd)) : 0;
        const maxEd = withDur.length ? Math.max(...withDur.map(t => t.sd + t.cd)) : 0;
        // Group people by role, only roles that appear in this project
        const roleGroups = ROLES
          .map(role => {
            const members = PEOPLE.filter(per =>
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
      });
  }, [tasks, fp]);

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
  // Works regardless of whether tasks are in person rows or collapsed role rows
  const depLines = useMemo(() => {
    const lines = [];
    for (const pd of projData) {
      for (const t of pd.pt) {
        const toPos = posMap[t.id];
        if (!toPos) continue; // task not visible
        for (const dseq of (TDEP_MAP[t.seq] || [])) {
          const depId = `${t.projId}-${dseq}`;
          const fromPos = posMap[depId];
          if (fromPos) {
            lines.push({
              from: fromPos, to: toPos,
              taskId: t.id, depId,
              projId: t.projId,
              sameRow: Math.abs(fromPos.yc - toPos.yc) < 4,
            });
          }
        }
      }
    }
    return lines;
  }, [projData, posMap]);

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
      {/* ── Toolbar ── */}
      <div style={{ display:'flex', alignItems:'center', gap:'8px', padding:'8px 14px', borderBottom:'1px solid #F1F5F9', background:'#FAFAFA', flexWrap:'wrap' }}>
        {/* Dependencies toggle */}
        <button onClick={() => setShowDeps(v => !v)} style={{ display:'flex', alignItems:'center', gap:'5px', padding:'4px 11px', borderRadius:'20px', border:'none', cursor:'pointer', fontSize:'11px', fontWeight:'600', transition:'all 0.15s', background:showDeps?'#0F172A':'#F1F5F9', color:showDeps?'white':'#64748B' }}>
          <svg width="11" height="11" viewBox="0 0 12 12" fill="none">
            <circle cx="2" cy="6" r="1.5" fill="currentColor"/><circle cx="10" cy="2" r="1.5" fill="currentColor"/><circle cx="10" cy="10" r="1.5" fill="currentColor"/>
            <path d="M3.5 6 Q6.5 2 8.5 2" stroke="currentColor" strokeWidth="1.2" fill="none"/><path d="M3.5 6 Q6.5 10 8.5 10" stroke="currentColor" strokeWidth="1.2" fill="none"/>
          </svg>
          Dependencies {showDeps ? 'ON' : 'OFF'}
        </button>
        <div style={{ width:'1px', height:'18px', background:'#E2E8F0' }} />
        {/* Delay simulation toggle */}
        <button onClick={() => setShowSim(v => !v)} style={{ display:'flex', alignItems:'center', gap:'5px', padding:'4px 11px', borderRadius:'20px', border:'none', cursor:'pointer', fontSize:'11px', fontWeight:'600', transition:'all 0.15s', background:showSim?'#F59E0B':'#F1F5F9', color:showSim?'white':'#64748B' }}>
          ⚡ Simulate Delay {showSim ? '▲' : '▼'}
        </button>
        {Object.keys(simDelays).length > 0 && (
          <>
            <span style={{ fontSize:'11px', color:'#F59E0B', fontWeight:'600' }}>
              {Object.keys(simDelays).length} sim{Object.keys(simDelays).length > 1 ? 's' : ''} active
            </span>
            <button onClick={() => setSimDelays({})} style={{ padding:'3px 9px', borderRadius:'12px', border:'1px solid #FDE68A', background:'#FFFBEB', cursor:'pointer', fontSize:'11px', color:'#92400E', fontWeight:'600' }}>
              Reset all
            </button>
          </>
        )}
        <span style={{ marginLeft:'auto', fontSize:'11px', fontStyle: (!zoomProj && !zoomPeriod) ? 'italic' : 'normal', fontWeight: (zoomProj || zoomPeriod) ? '600' : '400', color: zoomPeriod ? '#10B981' : zoomProj ? '#6366F1' : '#94A3B8' }}>
          {zoomPeriod && zoomProj
            ? `🔍 ${zoomProj} · ${PERIODS.find(p=>p.key===zoomPeriod)?.label} · ${dpx}px/day`
            : zoomPeriod
            ? `🗓 ${PERIODS.find(p=>p.key===zoomPeriod)?.label} · ${dpx}px/day`
            : zoomProj
            ? `🔍 ${zoomProj} · ${dpx}px/day`
            : 'Click row to expand'}
        </span>
      </div>

      {/* ── Delay simulation panel ── */}
      {showSim && (() => {
        const simKey = simProj && simSeq ? `${simProj}-${simSeq}` : null;
        const currentExtra = simKey ? (simDelays[simKey] || 0) : 0;
        // Compute preview impact
        const previewImpact = useMemo ? null : null; // computed inline below
        let shiftedCount = 0, newEndStr = '';
        if (simKey && simDays > 0) {
          const preview = buildSched({ ...simDelays, [simKey]: currentExtra + simDays });
          for (const t of preview) {
            const orig = tasks.find(x => x.id === t.id);
            if (orig && (t.sd !== orig.sd || t.cd !== orig.cd)) shiftedCount++;
          }
          const maxDay = Math.max(...preview.map(t => t.sd + t.cd));
          const d = new Date(BASE); d.setDate(d.getDate() + maxDay);
          newEndStr = d.toLocaleDateString('en-AU', { day:'2-digit', month:'short' });
        }
        const applyKey = simKey;
        return (
          <div style={{ padding:'12px 16px', borderBottom:'1px solid #F1F5F9', background:'#FFFBEB', border:'1px solid #FDE68A', display:'flex', gap:'12px', alignItems:'center', flexWrap:'wrap' }}>
            <span style={{ fontSize:'11px', fontWeight:'800', color:'#92400E', letterSpacing:'0.05em' }}>⚡ DELAY SIM</span>
            {/* Project */}
            <select value={simProj} onChange={e => { setSimProj(e.target.value); setSimSeq(''); }} style={{ padding:'4px 8px', borderRadius:'6px', border:'1px solid #FDE68A', fontSize:'12px', background:'white', cursor:'pointer' }}>
              <option value="">Project…</option>
              {PROJS.filter(p => fp === 'All' || p.id === fp).map(p => <option key={p.id} value={p.id}>{p.id} – {p.name.split('–')[1]?.trim()}</option>)}
            </select>
            {/* Task */}
            <select value={simSeq} onChange={e => setSimSeq(e.target.value)} disabled={!simProj} style={{ padding:'4px 8px', borderRadius:'6px', border:'1px solid #FDE68A', fontSize:'12px', background:'white', cursor:'pointer', maxWidth:'220px' }}>
              <option value="">Task…</option>
              {TDEFS.filter(([,, , dur]) => dur > 0).map(([seq, name]) => <option key={seq} value={String(seq)}>#{seq} {name.slice(0, 32)}</option>)}
            </select>
            {/* Days */}
            <div style={{ display:'flex', alignItems:'center', gap:'6px' }}>
              <span style={{ fontSize:'11px', color:'#92400E', fontWeight:'600' }}>+</span>
              <input type="number" min="1" max="30" value={simDays} onChange={e => setSimDays(Math.max(1, Number(e.target.value)))} style={{ width:'52px', padding:'4px 6px', borderRadius:'6px', border:'1px solid #FDE68A', fontSize:'12px', textAlign:'center', fontWeight:'700' }} />
              <span style={{ fontSize:'11px', color:'#92400E' }}>days</span>
            </div>
            {/* Impact preview */}
            {simKey && simDays > 0 && shiftedCount > 0 && (
              <span style={{ fontSize:'11px', color:'#92400E', background:'#FEF3C7', padding:'3px 10px', borderRadius:'20px', border:'1px solid #FDE68A', fontWeight:'600' }}>
                {shiftedCount} tasks shift · end → {newEndStr}
              </span>
            )}
            {/* Apply */}
            {simKey && simDays > 0 && (
              <button onClick={() => { setSimDelays(prev => ({ ...prev, [applyKey]: (prev[applyKey] || 0) + simDays })); setSimSeq(''); setSimDays(1); }} style={{ padding:'5px 14px', borderRadius:'8px', border:'none', background:'#F59E0B', color:'white', fontSize:'12px', fontWeight:'700', cursor:'pointer' }}>
                Apply
              </button>
            )}
            {/* Current sim list */}
            {Object.keys(simDelays).length > 0 && (
              <div style={{ display:'flex', gap:'6px', flexWrap:'wrap', marginLeft:'4px' }}>
                {Object.entries(simDelays).map(([k, d]) => (
                  <span key={k} style={{ fontSize:'10px', background:'#FEF3C7', border:'1px solid #FDE68A', padding:'2px 8px', borderRadius:'12px', color:'#92400E', fontWeight:'600', display:'flex', alignItems:'center', gap:'4px' }}>
                    {k} +{d}d
                    <span onClick={() => setSimDelays(prev => { const n={...prev}; delete n[k]; return n; })} style={{ cursor:'pointer', color:'#B45309', fontWeight:'800' }}>×</span>
                  </span>
                ))}
              </div>
            )}
          </div>
        );
      })()}

      <div ref={outerRef} style={{ position:'relative', display:'flex' }}
        onMouseMove={e => { const r = outerRef.current?.getBoundingClientRect(); if (r) setMouse({ x: e.clientX - r.left, y: e.clientY - r.top }); }}
        onMouseLeave={() => setHov(null)}>

        {/* ── STICKY LEFT PANEL — does not scroll ── */}
        <div style={{ width:LW, flexShrink:0, position:'relative', zIndex:5, boxShadow:'4px 0 12px rgba(0,0,0,0.07)' }}>
          <svg width={LW} height={totalH} style={{ display:'block', fontFamily:'-apple-system,system-ui,sans-serif' }}>
            {/* Header bg */}
            <rect x={0} y={0} width={LW} height={HH} fill="#F1F5F9" />
            <line x1={0} y1={HH} x2={LW} y2={HH} stroke="#E2E8F0" strokeWidth="1.5" />

            {rowList.map(row => {
              if (row.kind === 'proj') {
                const { pd, y } = row;
                const { proj, pt } = pd;
                const isExp = expanded.has(proj.id);
                const midY = y + PRH / 2;
                const hasC = pt.some(t => t.isC);
                return (
                  <g key={proj.id+'-lbl'} style={{ cursor:'pointer' }} onClick={() => toggle(proj.id)}>
                    <rect x={0} y={y} width={LW} height={PRH} fill={proj.color+'0B'} />
                    <rect x={10} y={midY-11} width={22} height={22} rx="6" fill={proj.color+'25'} />
                    <text x={21} y={midY+1} textAnchor="middle" dominantBaseline="middle" fill={proj.color} fontSize="14" fontWeight="800" style={{userSelect:'none'}}>{isExp?'−':'+'}</text>
                    <text x={40} y={midY-6} fill={proj.color} fontSize="14" fontWeight="800">{proj.id}</text>
                    <text x={40} y={midY+9} fill="#64748B" fontSize="10">New Build · {pt.length} tasks</text>
                    <rect x={LW-46} y={midY-11} width={36} height={22} rx="11" fill={proj.color+'20'} />
                    <text x={LW-28} y={midY+1} textAnchor="middle" dominantBaseline="middle" fill={proj.color} fontSize="11" fontWeight="700">{pt.length}</text>
                    {hasC && <g>
                      <circle cx={LW-8} cy={y+14} r={7} fill="#EF4444" />
                      <text x={LW-8} y={y+14} textAnchor="middle" dominantBaseline="middle" fill="white" fontSize="9" fontWeight="700">!</text>
                    </g>}
                    <line x1={0} y1={y+PRH} x2={LW} y2={y+PRH} stroke={isExp?proj.color+'50':'#E2E8F0'} strokeWidth={isExp?1.5:1} />
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
                    <rect x={0} y={ry} width={LW} height={RRH} fill={rg.role.color+'08'} />
                    <line x1={18} y1={ry} x2={18} y2={ry+RRH} stroke={rpd.proj.color+'40'} strokeWidth="1.5" />
                    <rect x={26} y={rMidY-9} width={18} height={18} rx="5" fill={rg.role.color+'22'} />
                    <text x={35} y={rMidY+1} textAnchor="middle" dominantBaseline="middle" fill={rg.role.color} fontSize="12" fontWeight="800" style={{userSelect:'none'}}>{isRExp?'−':'+'}</text>
                    <text x={51} y={rMidY-5} fill={rg.role.color} fontSize="11.5" fontWeight="700">{rg.role.label}</text>
                    <text x={51} y={rMidY+8} fill="#94A3B8" fontSize="9.5">{rg.personRows.length} member{rg.personRows.length>1?'s':''} · {allTasks.length} tasks</text>
                    {rHasC && <g>
                      <circle cx={LW-8} cy={ry+12} r={7} fill="#EF4444" />
                      <text x={LW-8} y={ry+12} textAnchor="middle" dominantBaseline="middle" fill="white" fontSize="9" fontWeight="700">!</text>
                    </g>}
                    <line x1={0} y1={ry+RRH} x2={LW} y2={ry+RRH} stroke={isRExp?rg.role.color+'40':'#F1F5F9'} strokeWidth={isRExp?1.2:0.8} />
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
                    <rect x={0} y={py} width={LW} height={SRH} fill="white" />
                    <line x1={18} y1={py} x2={18} y2={py+SRH} stroke={ppd.proj.color+'30'} strokeWidth="1.5" />
                    <line x1={32} y1={py} x2={32} y2={py+SRH} stroke={prg.role.color+'40'} strokeWidth="1.5" />
                    <line x1={32} y1={pMidY} x2={44} y2={pMidY} stroke={prg.role.color+'40'} strokeWidth="1.5" />
                    <circle cx={56} cy={pMidY} r={13} fill={prg.role.color+'20'} />
                    <circle cx={56} cy={pMidY} r={13} fill="none" stroke={prg.role.color} strokeWidth="1.5" />
                    <text x={56} y={pMidY+1} textAnchor="middle" dominantBaseline="middle" fill={prg.role.color} fontSize="8.5" fontWeight="700">{pr.per.init}</text>
                    <text x={75} y={pMidY-7} fill="#0F172A" fontSize="12" fontWeight="600">{pr.per.name}</text>
                    <text x={75} y={pMidY+8} fill="#94A3B8" fontSize="9.5">{pTasks.length} tasks</text>
                    <rect x={LW-40} y={pMidY-10} width={28} height={20} rx="10" fill="#F1F5F9" />
                    <text x={LW-26} y={pMidY+1} textAnchor="middle" dominantBaseline="middle" fill="#64748B" fontSize="10" fontWeight="600">{pTasks.length}</text>
                    {pHasC && <g>
                      <circle cx={LW-8} cy={py+13} r={7} fill="#EF4444" />
                      <text x={LW-8} y={py+13} textAnchor="middle" dominantBaseline="middle" fill="white" fontSize="9" fontWeight="700">!</text>
                    </g>}
                    {pHasF && !pHasC && <g>
                      <circle cx={LW-8} cy={py+13} r={7} fill="#F59E0B" />
                      <text x={LW-8} y={py+13} textAnchor="middle" dominantBaseline="middle" fill="white" fontSize="10" fontWeight="800">~</text>
                    </g>}
                    <line x1={0} y1={py+SRH} x2={py} y2={py+SRH} stroke="#F1F5F9" strokeWidth="1" />
                    <line x1={0} y1={py+SRH} x2={LW} y2={py+SRH} stroke="#F1F5F9" strokeWidth="1" />
                  </g>
                );
              }
              return null;
            })}

            <line x1={LW-1} y1={0} x2={LW-1} y2={totalH} stroke="#CBD5E1" strokeWidth="1" />
          </svg>
        </div>

        {/* ── SCROLLABLE TIMELINE — right side only ── */}
        <div ref={scrollRef} style={{ overflowX:'auto', flex:1 }}>
          <svg width={TD*dpx} height={totalH} style={{ display:'block', fontFamily:'-apple-system,system-ui,sans-serif' }}>

            {/* Month headers */}
            {MONS.slice(0,-1).map((m, i) => {
              const x1 = txR(m.d), x2 = txR(MONS[i+1].d);
              return (
                <g key={m.n}>
                  <rect x={x1} y={0} width={x2-x1} height={HH} fill={i%2?'#F8FAFC':'#F1F5F9'} />
                  <text x={(x1+x2)/2} y={HH/2+5} textAnchor="middle" fill="#64748B" fontSize="11.5" fontWeight="600">{m.n} '25</text>
                  <line x1={x1} y1={0} x2={x1} y2={totalH} stroke="#E2E8F0" strokeWidth={i===0?1:0.5} />
                </g>
              );
            })}

            {/* Weekly gridlines */}
            {Array.from({length:Math.floor(TD/7)},(_,i)=>(i+1)*7).map(d=>(
              <line key={d} x1={txR(d)} y1={HH} x2={txR(d)} y2={totalH} stroke="#E2E8F0" strokeWidth="0.5" strokeDasharray="2 4" opacity="0.7" />
            ))}

            {/* Period highlight band */}
            {zoomPeriod && (() => {
              const period = PERIODS.find(p => p.key === zoomPeriod);
              if (!period) return null;
              const px1 = txR(period.startDay), px2 = txR(period.endDay + 1);
              return (
                <g>
                  <rect x={px1} y={0} width={px2-px1} height={totalH} fill="#10B981" opacity="0.04" />
                  <line x1={px1} y1={0} x2={px1} y2={totalH} stroke="#10B981" strokeWidth="1.5" opacity="0.4" strokeDasharray="4 3"/>
                  <line x1={px2} y1={0} x2={px2} y2={totalH} stroke="#10B981" strokeWidth="1.5" opacity="0.4" strokeDasharray="4 3"/>
                  <rect x={px1} y={2} width={px2-px1} height={20} rx="4" fill="#10B981" opacity="0.15" />
                  <text x={(px1+px2)/2} y={13} textAnchor="middle" fill="#10B981" fontSize="10" fontWeight="700" opacity="0.8">
                    {period.label}
                  </text>
                </g>
              );
            })()}

            {/* Today */}
            <line x1={txR(73)} y1={0} x2={txR(73)} y2={totalH} stroke="#EF4444" strokeWidth="1.5" strokeDasharray="4 3" opacity="0.65" />
            <rect x={txR(73)-20} y={3} width={40} height={19} rx="5" fill="#EF4444" />
            <text x={txR(73)} y={15.5} textAnchor="middle" fill="white" fontSize="9.5" fontWeight="700">TODAY</text>

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
                    <rect x={0} y={y} width={TD*dpx} height={PRH} fill={proj.color+'0B'} />
                    <rect x={bx+2} y={midY-11} width={bw} height={22} rx="11" fill={proj.color+'18'} />
                    <rect x={bx} y={midY-11} width={bw} height={22} rx="11" fill="none" stroke={proj.color} strokeWidth="2" />
                    {bw>80 && <text x={bx+bw/2} y={midY+1} textAnchor="middle" dominantBaseline="middle" fill={proj.color} fontSize="11" fontWeight="700" style={{pointerEvents:'none',userSelect:'none'}}>
                      {proj.id} · {pt.filter(t=>t.cd>0).length} tasks with duration
                    </text>}
                    <line x1={0} y1={y+PRH} x2={TD*dpx} y2={y+PRH} stroke={isExp?proj.color+'50':'#E2E8F0'} strokeWidth={isExp?1.5:1} />
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
                          onMouseLeave={() => setHov(null)}>
                          <rect x={tx2+1} y={mbY+1} width={tw} height={mbH} rx="3" fill="rgba(0,0,0,0.05)" />
                          <rect x={tx2} y={mbY} width={tw} height={mbH} rx="3"
                            fill={rg.role.color+'30'}
                            stroke={isHovT ? rg.role.color : rg.role.color+'70'}
                            strokeWidth={isHovT ? 1.5 : 1} />
                          {/* Left stripe per person for identity */}
                          <rect x={tx2+1} y={mbY+1} width={3} height={mbH-2} rx="2"
                            fill={rg.role.color} />
                          {/* Conflict/overdue dots */}
                          {t.isC && <circle cx={tx2+tw-5} cy={mbY+5} r={4} fill="#EF4444" />}
                          {OVERDUE.has(t.id) && <circle cx={tx2+tw-(t.isC?12:5)} cy={mbY+5} r={4} fill="#DC2626" />}
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
                    <line x1={0} y1={ry2+RRH} x2={TD*DPX} y2={ry2+RRH}
                      stroke={isRExp ? rg.role.color+'40' : rg.role.color+'60'}
                      strokeWidth={isRExp ? 1 : 1.2} />
                  </g>
                );
              }
              const { rg: prg, pd, pr, y } = row;
              const { proj } = pd;
              const { per, tasks: pTasks } = pr;
              const roleColor = prg.role.color;
              const by0 = y + (SRH-SBH)/2;
              const midY = y + SRH/2;
              return (
                <g key={`${proj.id}-${per.name}-bars`}>
                  <rect x={0} y={y} width={TD*dpx} height={SRH} fill="white" />
                  <line x1={0} y1={y+SRH} x2={TD*dpx} y2={y+SRH} stroke="#F1F5F9" strokeWidth="1" />
                  {pTasks.map(t => {
                    const x = txR(t.sd), w = Math.max(t.cd*DPX, t.cd?4:0);
                    const ih = hov===t.id;
                    const dimmed = showDeps && hov && !hovRelated.has(t.id);
                    if (!t.cd) return (
                      <polygon key={t.id}
                        points={`${x},${midY-5} ${x+5},${midY} ${x},${midY+5} ${x-5},${midY}`}
                        fill={roleColor} opacity={dimmed?0.2:0.85}
                        style={{cursor:'pointer'}}
                        onMouseEnter={()=>setHov(t.id)} onMouseLeave={()=>setHov(null)} />
                    );
                    return (
                      <g key={t.id} style={{cursor:'pointer'}} opacity={dimmed?0.28:1}
                        onMouseEnter={()=>setHov(t.id)} onMouseLeave={()=>setHov(null)}>

                        <rect x={x+2} y={by0+2} width={w} height={SBH} rx="4" fill="rgba(0,0,0,0.06)" />
                        <rect x={x} y={by0} width={w} height={SBH} rx="4"
                          fill={roleColor+'28'}
                          stroke={roleColor}
                          strokeWidth={ih?2:1.5} />
                        <rect x={x+1.5} y={by0+1.5} width={5} height={SBH-3} rx="3" fill={roleColor} />
                        {t.delay>0 && w>10 && <rect x={x+w-7} y={by0} width={7} height={SBH} fill="#FCA5A5" opacity="0.75" rx="4" />}
                        {w>52 && <text x={x+12} y={by0+SBH/2} dominantBaseline="middle"
                          fill={roleColor} fontSize="10" fontWeight="600"
                          style={{pointerEvents:'none',userSelect:'none'}}>
                          {(()=>{const mc=Math.floor((w-18)/5.8);return t.name.length>mc?t.name.slice(0,mc)+'…':t.name;})()}
                        </text>}
                        {/* Top-left corner badge — conflict ! or fragile ~ */}
                        {t.isC && <g style={{pointerEvents:'none'}}>
                          <circle cx={x+8} cy={by0+8} r={7} fill="#EF4444" />
                          <text x={x+8} y={by0+8} textAnchor="middle" dominantBaseline="middle" fill="white" fontSize="8.5" fontWeight="800">!</text>
                        </g>}
                        {t.isF && !t.isC && <g style={{pointerEvents:'none'}}>
                          <circle cx={x+8} cy={by0+8} r={7} fill="#F59E0B" />
                          <text x={x+8} y={by0+8} textAnchor="middle" dominantBaseline="middle" fill="white" fontSize="11" fontWeight="800" dy="0.5">~</text>
                        </g>}
                        {/* Top-right corner badge — overdue clock */}
                        {OVERDUE.has(t.id) && w > 12 && <g style={{pointerEvents:'none'}}>
                          <circle cx={x+w-8} cy={by0+8} r={7} fill="#DC2626" />
                          <text x={x+w-8} y={by0+8} textAnchor="middle" dominantBaseline="middle" fill="white" fontSize="9" fontWeight="800">⏰</text>
                        </g>}
                      </g>
                    );
                  })}
                </g>
              );
            })}

            {/* Dep lines — last so they paint on top */}
            {showDeps && (
              <g style={{ pointerEvents:'none' }}>
                {depLines.map((line, i) => {
                  const { from, to, projId, taskId, depId } = line;
                  const pc = PROJS.find(p => p.id === projId)?.color || '#888';
                  const isHov = hov && (hovRelated.has(taskId) || hovRelated.has(depId));
                  const opacity = hov ? (isHov?1:0.07) : 0.35;
                  const sw = isHov ? 2 : 1.2;
                  const gap     = to.xs - from.xe;
                  const rowDiff = to.yc - from.yc;
                  // Half-bar height: collapsed role rows use RRH, person rows use SBH
                  const fromHalf = from.collapsed ? RRH/2 : SBH/2;
                  const toHalf   = to.collapsed   ? RRH/2 : SBH/2;
                  let pathD, arrowDir, ax, ay, bz;

                  if (line.sameRow && gap > 0) {
                    // ── Same row (both in same collapsed role): arc above the row ──
                    const archY = from.yc - Math.max(RRH * 0.7, 20 + gap * 0.04);
                    bz = { x0:from.xe, y0:from.yc, cx1:from.xe+20, cy1:archY, cx2:to.xs-20, cy2:archY, x1:to.xs, y1:to.yc };
                    arrowDir = 'right'; ax = to.xs; ay = to.yc;

                  } else if (line.sameRow && gap <= 0) {
                    // ── Same row, backwards: arc below ──
                    const archY = from.yc + Math.max(RRH * 0.7, 20);
                    bz = { x0:from.xe, y0:from.yc, cx1:from.xe+20, cy1:archY, cx2:to.xs-20, cy2:archY, x1:to.xs, y1:to.yc };
                    arrowDir = 'right'; ax = to.xs; ay = to.yc;

                  } else if (gap > 50) {
                    // ── Forward, plenty of room: S-curve into left edge ──
                    const mid = from.xe + gap / 2;
                    bz = { x0:from.xe, y0:from.yc, cx1:mid, cy1:from.yc, cx2:mid, cy2:to.yc, x1:to.xs, y1:to.yc };
                    arrowDir = 'right'; ax = to.xs; ay = to.yc;

                  } else if (rowDiff > 8 && gap > -30) {
                    // ── Dep row is above target: drop into TOP of bar ──
                    const entryX = Math.min(Math.max(from.xe + 5, to.xs + 10), to.xe - 8);
                    const topY   = to.yc - toHalf;
                    bz = { x0:from.xe, y0:from.yc, cx1:from.xe+10, cy1:from.yc+rowDiff*0.4, cx2:entryX, cy2:topY-16, x1:entryX, y1:topY };
                    arrowDir = 'down'; ax = entryX; ay = topY;

                  } else if (rowDiff < -8 && gap > -30) {
                    // ── Dep row is below target: rise into BOTTOM of bar ──
                    const entryX = Math.min(Math.max(from.xe + 5, to.xs + 10), to.xe - 8);
                    const botY   = to.yc + toHalf;
                    bz = { x0:from.xe, y0:from.yc, cx1:from.xe+10, cy1:from.yc+rowDiff*0.4, cx2:entryX, cy2:botY+16, x1:entryX, y1:botY };
                    arrowDir = 'up'; ax = entryX; ay = botY;

                  } else {
                    // ── Backwards/overlap: arch below both rows ──
                    const archY = Math.max(from.yc, to.yc) + Math.max(SRH * 0.55, 24);
                    bz = { x0:from.xe, y0:from.yc, cx1:from.xe+22, cy1:archY, cx2:to.xs-22, cy2:archY, x1:to.xs, y1:to.yc };
                    arrowDir = 'right'; ax = to.xs; ay = to.yc;
                  }

                  pathD = `M ${bz.x0} ${bz.y0} C ${bz.cx1} ${bz.cy1} ${bz.cx2} ${bz.cy2} ${bz.x1} ${bz.y1}`;
                  const { mx, my, angle } = bezierMid(bz.x0,bz.y0,bz.cx1,bz.cy1,bz.cx2,bz.cy2,bz.x1,bz.y1);
                  const arrowPts = arrowDir === 'right'
                    ? `${ax},${ay} ${ax-7},${ay-3.5} ${ax-7},${ay+3.5}`
                    : arrowDir === 'down'
                    ? `${ax},${ay} ${ax-3.5},${ay-7} ${ax+3.5},${ay-7}`
                    : `${ax},${ay} ${ax-3.5},${ay+7} ${ax+3.5},${ay+7}`;

                  return (
                    <g key={i} opacity={opacity}>
                      <path d={pathD} fill="none" stroke={pc} strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" />
                      <polygon points="-4.5,-3 4.5,0 -4.5,3" transform={`translate(${mx},${my}) rotate(${angle})`} fill={pc} />
                      <polygon points={arrowPts} fill={pc} />
                    </g>
                  );
                })}
              </g>
            )}
          </svg>
        </div>

        {/* Tooltip */}
        {ht && (() => {
          const sc = SC[ht.stage] || SC.Design;
          const pc = PROJS.find(p => p.id === ht.projId)?.color || '#888';
          const cNames = ht.cw.map(id => { const c = tasks.find(x => x.id === id); return c ? `${c.projId} Seq ${c.seq} (${c.person})` : id; });
          const depSeqs = TDEP_MAP[ht.seq] || [];
          const depNames = depSeqs.map(ds => { const dt = tasks.find(x => x.id === `${ht.projId}-${ds}`); return dt ? `Seq ${ds} – ${dt.name.split("–")[0].trim()}` : `Seq ${ds}`; });
          const ttx = Math.min(mouse.x + 14, (outerRef.current?.clientWidth || 800) - 240);
          const tty = Math.max(mouse.y - 130, 52);
          return (
            <div style={{ position:'absolute', left:ttx, top:tty, pointerEvents:'none', background:'#0F172A', color:'white', padding:'12px 14px', borderRadius:'10px', fontSize:'12px', lineHeight:'1.65', boxShadow:'0 10px 30px rgba(0,0,0,0.3)', width:'228px', zIndex:50, borderTop:`3px solid ${pc}` }}>
              <div style={{ fontWeight:'700', fontSize:'12px', lineHeight:'1.35', marginBottom:'5px' }}>{ht.name}</div>
              <div style={{ color:'#64748B', fontSize:'10px', marginBottom:'8px' }}>{ht.projId} · {ht.person} · Seq {ht.seq}</div>
              <div style={{ display:'grid', gridTemplateColumns:'60px 1fr', gap:'3px 8px', fontSize:'11px' }}>
                <span style={{ color:'#475569' }}>Stage</span>
                <span style={{ background:sc.bg, color:sc.tx, padding:'0 5px', borderRadius:'3px', fontSize:'10px', fontWeight:'600' }}>{ht.stage}</span>
                <span style={{ color:'#475569' }}>Start</span><span>{fd(ht.s)}</span>
                <span style={{ color:'#475569' }}>End</span><span>{fd(ht.e)}</span>
                <span style={{ color:'#475569' }}>Duration</span>
                <span>{ht.dur > 0 ? `${ht.dur} wdays` : 'Milestone'}{ht.delay ? ` (+${ht.delay}d delay)` : ''}</span>
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
              {ht.isC && <div style={{ marginTop:'8px', padding:'4px 8px', background:'rgba(239,68,68,0.18)', borderRadius:'4px', color:'#FCA5A5', fontSize:'10px', fontWeight:'700', border:'1px solid rgba(239,68,68,0.3)' }}>
                ⚠ CONFLICT{cNames[0] ? ` – clashes with ${cNames[0]}` : ''}
              </div>}
              {ht.isF && !ht.isC && <div style={{ marginTop:'8px', padding:'4px 8px', background:'rgba(245,158,11,0.15)', borderRadius:'4px', color:'#FDE68A', fontSize:'10px', fontWeight:'700', border:'1px solid rgba(245,158,11,0.3)' }}>
                ⚡ FRAGILE — ≤1 working day gap to next task
              </div>}
            </div>
          );
        })()}
      </div>
    </div>
  );
}


// ── Project View tab — Excel-style filterable table ──────────────────────────
function ProjectViewTab({ tasks }) {
  const [filters, setFilters] = useState({});
  const [sort, setSort] = useState({ col: 'projId', dir: 'asc' });
  const [openFilter, setOpenFilter] = useState(null);

  const COLS = [
    { key:'projId',  label:'Project',    w:82  },
    { key:'seq',     label:'#',          w:46  },
    { key:'name',    label:'Task Name',  w:228 },
    { key:'person',  label:'Assigned',   w:100 },
    { key:'role',    label:'Role',       w:148 },
    { key:'stage',   label:'Stage',      w:100 },
    { key:'start',   label:'Start',      w:94  },
    { key:'end',     label:'End',        w:94  },
    { key:'dur',     label:'Duration',   w:82  },
    { key:'deps',    label:'Depends On', w:200 },
    { key:'status',  label:'Status',     w:108 },
  ];

  const rows = useMemo(() => tasks.map(t => {
    const depSeqs = TDEP_MAP[t.seq] || [];
    const depNames = depSeqs.map(ds => {
      const dt = tasks.find(x => x.id === `${t.projId}-${ds}`);
      return dt ? `#${ds} ${dt.name.split('–')[0].trim().slice(0, 22)}` : `#${ds}`;
    });
    const per = PEOPLE.find(p => p.name === t.person);
    const todayDate = new Date(BASE.getTime() + TODAY_DAY * 864e5);
    const isOverdue = OVERDUE.has(t.id);
    const isCompleted = !t.isC && !isOverdue && !t.isF && t.e < todayDate;
    const status = t.isC ? 'Conflict' : isOverdue ? 'Overdue' : t.isF ? 'Fragile' : isCompleted ? 'Completed' : 'In Progress';
    return {
      ...t,
      role:   per?.role || '',
      start:  fd(t.s),
      end:    fd(t.e),
      dur:    t.cd > 0 ? `${t.cd}d` : 'Milestone',
      deps:   depNames.join('  ·  ') || '—',
      status,
    };
  }), [tasks]);

  // Unique sorted values per column — used to populate filter checkboxes
  const colValues = useMemo(() => {
    const m = {};
    for (const col of COLS) {
      m[col.key] = [...new Set(rows.map(r => String(r[col.key] ?? '')))].sort((a, b) => {
        const na = Number(a), nb = Number(b);
        return (!isNaN(na) && !isNaN(nb)) ? na - nb : a.localeCompare(b);
      });
    }
    return m;
  }, [rows]);

  const filtered = useMemo(() => rows.filter(r => {
    for (const [key, allowed] of Object.entries(filters)) {
      if (!allowed || allowed.size === 0) continue;
      if (!allowed.has(String(r[key] ?? ''))) return false;
    }
    return true;
  }), [rows, filters]);

  const sorted = useMemo(() => [...filtered].sort((a, b) => {
    let va = a[sort.col], vb = b[sort.col];
    if (sort.col === 'start') { va = a.s; vb = b.s; }
    if (sort.col === 'end')   { va = a.e; vb = b.e; }
    if (sort.col === 'seq')   { va = Number(va); vb = Number(vb); }
    if (va < vb) return sort.dir === 'asc' ? -1 : 1;
    if (va > vb) return sort.dir === 'asc' ?  1 : -1;
    return 0;
  }), [filtered, sort]);

  const toggleVal = (colKey, val) => setFilters(prev => {
    const curr = new Set(prev[colKey] || []);
    curr.has(val) ? curr.delete(val) : curr.add(val);
    return { ...prev, [colKey]: curr };
  });
  const clearCol   = colKey => setFilters(prev => ({ ...prev, [colKey]: new Set() }));
  const clearAll   = () => setFilters({});
  const handleSort = col => {
    setSort(prev => prev.col === col ? { col, dir: prev.dir === 'asc' ? 'desc' : 'asc' } : { col, dir: 'asc' });
    setOpenFilter(null);
  };

  const activeCount = Object.values(filters).filter(s => s && s.size > 0).length;

  const STATUS_STYLE = {
    'Conflict':    { bg:'#FEE2E2', tx:'#991B1B', bd:'#FECACA', ic:'!' },
    'Overdue':     { bg:'#FFE4E6', tx:'#9F1239', bd:'#FECDD3', ic:'⏰' },
    'Fragile':     { bg:'#FEF9C3', tx:'#854D0E', bd:'#FDE047', ic:'~' },
    'Completed':   { bg:'#DCFCE7', tx:'#14532D', bd:'#86EFAC', ic:'✓' },
    'In Progress': { bg:'#EFF6FF', tx:'#1E3A8A', bd:'#93C5FD', ic:'▶' },
  };

  return (
    <div style={{ fontFamily:'-apple-system,system-ui,sans-serif' }}
      onClick={e => { if (!e.target.closest('[data-fp]')) setOpenFilter(null); }}>

      {/* Toolbar */}
      <div style={{ display:'flex', alignItems:'center', gap:'10px', padding:'9px 16px', borderBottom:'1px solid #F1F5F9', background:'#FAFAFA', flexWrap:'wrap' }}>
        <span style={{ fontSize:'12px', color:'#64748B', fontWeight:'500' }}>
          <strong style={{ color:'#0F172A' }}>{sorted.length}</strong> of {rows.length} tasks
        </span>
        {activeCount > 0 && (
          <button onClick={clearAll} style={{ padding:'3px 11px', borderRadius:'12px', border:'1px solid #FECACA', background:'#FEF2F2', cursor:'pointer', fontSize:'11px', color:'#EF4444', fontWeight:'600' }}>
            ✕ Clear {activeCount} filter{activeCount > 1 ? 's' : ''}
          </button>
        )}
        <div style={{ marginLeft:'auto', display:'flex', gap:'16px', fontSize:'11px', color:'#94A3B8' }}>
          {Object.entries(STATUS_STYLE).map(([s, st]) => (
            <span key={s} style={{ display:'flex', alignItems:'center', gap:'4px' }}>
              <span style={{ background:st.bg, color:st.tx, padding:'1px 7px', borderRadius:'10px', fontSize:'10px', fontWeight:'600', border:`1px solid ${st.bd}` }}>{st.ic} {s}</span>
            </span>
          ))}
        </div>
      </div>

      {/* Table */}
      <div style={{ overflowX:'auto', overflowY:'auto', maxHeight:'calc(100vh - 290px)' }}>
        <table style={{ borderCollapse:'collapse', width:'100%', fontSize:'12px' }}>

          <thead style={{ position:'sticky', top:0, zIndex:20 }}>
            <tr>
              {COLS.map(col => {
                const isFiltered = filters[col.key]?.size > 0;
                const isSorted   = sort.col === col.key;
                const isOpen     = openFilter === col.key;
                const vals       = colValues[col.key] || [];
                const selected   = filters[col.key] || new Set();

                return (
                  <th key={col.key} data-fp style={{
                    width:col.w, minWidth:col.w, padding:0, textAlign:'left',
                    background: isFiltered ? '#EFF6FF' : '#F8FAFC',
                    borderBottom: `2px solid ${isFiltered ? '#6366F1' : '#E2E8F0'}`,
                    borderRight:'1px solid #EAECF0',
                    position:'relative',
                  }}>
                    <div style={{ display:'flex', alignItems:'stretch' }}>
                      {/* Sort button */}
                      <div data-fp onClick={() => handleSort(col.key)} style={{
                        flex:1, padding:'9px 4px 9px 12px', cursor:'pointer',
                        display:'flex', alignItems:'center', gap:'4px',
                        color: isSorted ? '#6366F1' : '#475569',
                        fontWeight: isSorted ? '700' : '600',
                        fontSize:'10.5px', letterSpacing:'0.05em', textTransform:'uppercase',
                        userSelect:'none',
                      }}>
                        {col.label}
                        <span style={{ fontSize:'8px', color: isSorted ? '#6366F1' : '#D1D5DB' }}>
                          {isSorted ? (sort.dir === 'asc' ? '▲' : '▼') : '⇅'}
                        </span>
                      </div>
                      {/* Filter arrow */}
                      <div data-fp onClick={() => setOpenFilter(isOpen ? null : col.key)} style={{
                        padding:'9px 9px', cursor:'pointer', flexShrink:0,
                        color: isFiltered ? '#6366F1' : '#CBD5E1',
                        fontSize:'11px', display:'flex', alignItems:'center',
                        borderLeft:'1px solid #F1F5F9',
                        background: isOpen ? '#EFF6FF' : 'transparent',
                      }}>
                        {isFiltered ? '◉' : '▾'}
                      </div>
                    </div>

                    {/* Dropdown panel */}
                    {isOpen && (
                      <div data-fp style={{
                        position:'absolute', top:'100%', left:0, zIndex:100,
                        background:'white', border:'1px solid #E2E8F0',
                        borderRadius:'8px', boxShadow:'0 8px 28px rgba(0,0,0,0.14)',
                        minWidth:'200px', maxWidth:'260px',
                      }}>
                        <div style={{ padding:'8px 12px', borderBottom:'1px solid #F1F5F9', display:'flex', justifyContent:'space-between', alignItems:'center' }}>
                          <span style={{ fontSize:'10px', fontWeight:'700', color:'#64748B', textTransform:'uppercase', letterSpacing:'0.08em' }}>
                            Filter · {selected.size > 0 ? `${selected.size} selected` : 'all shown'}
                          </span>
                          {selected.size > 0 && (
                            <button data-fp onClick={() => clearCol(col.key)} style={{ fontSize:'10px', color:'#EF4444', border:'none', background:'none', cursor:'pointer', fontWeight:'600' }}>
                              Clear
                            </button>
                          )}
                        </div>
                        <div style={{ maxHeight:'210px', overflowY:'auto', padding:'4px 0' }}>
                          {vals.map(val => (
                            <label key={val} data-fp style={{
                              display:'flex', alignItems:'center', gap:'9px',
                              padding:'6px 14px', cursor:'pointer', fontSize:'12px', color:'#374151',
                            }}
                              onMouseEnter={e => e.currentTarget.style.background='#F8FAFC'}
                              onMouseLeave={e => e.currentTarget.style.background='transparent'}>
                              <input data-fp type="checkbox"
                                checked={selected.has(val)}
                                onChange={() => toggleVal(col.key, val)}
                                style={{ accentColor:'#6366F1', width:'13px', height:'13px', cursor:'pointer', flexShrink:0 }} />
                              <span style={{ overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', flex:1 }}>
                                {val || '(empty)'}
                              </span>
                            </label>
                          ))}
                        </div>
                      </div>
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>

          <tbody>
            {sorted.map((r, ri) => {
              const proj = PROJS.find(p => p.id === r.projId);
              const per  = PEOPLE.find(p => p.name === r.person);
              const sc   = SC[r.stage] || SC.Design;
              const ss   = STATUS_STYLE[r.status];
              const baseBg = ri % 2 === 0 ? 'white' : '#FAFAFA';

              return (
                <tr key={r.id}
                  style={{ background:baseBg, borderBottom:'1px solid #F1F5F9', transition:'background 0.08s' }}
                  onMouseEnter={e => e.currentTarget.style.background = '#F0F9FF'}
                  onMouseLeave={e => e.currentTarget.style.background = baseBg}>

                  {/* Project */}
                  <td style={{ padding:'8px 12px', borderRight:'1px solid #F5F5F5' }}>
                    <div style={{ display:'flex', alignItems:'center', gap:'7px' }}>
                      <div style={{ width:'9px', height:'9px', borderRadius:'50%', background:proj?.color, flexShrink:0 }} />
                      <span style={{ fontWeight:'700', color:proj?.color, fontSize:'12px' }}>{r.projId}</span>
                    </div>
                  </td>

                  {/* Seq */}
                  <td style={{ padding:'8px 10px', textAlign:'center', color:'#94A3B8', fontSize:'11px', fontVariantNumeric:'tabular-nums', borderRight:'1px solid #F5F5F5' }}>{r.seq}</td>

                  {/* Task Name */}
                  <td style={{ padding:'8px 12px', borderRight:'1px solid #F5F5F5' }}>
                    <div style={{ display:'flex', alignItems:'center', gap:'6px' }}>
                      <div style={{ fontWeight:'500', color:'#0F172A', fontSize:'12px', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', flex:1 }}>{r.name}</div>
                      {r.isC && <span style={{ flexShrink:0, width:'18px', height:'18px', borderRadius:'50%', background:'#EF4444', color:'white', display:'flex', alignItems:'center', justifyContent:'center', fontSize:'9px', fontWeight:'800' }}>!</span>}
                      {r.isF && !r.isC && <span style={{ flexShrink:0, width:'18px', height:'18px', borderRadius:'50%', background:'#F59E0B', color:'white', display:'flex', alignItems:'center', justifyContent:'center', fontSize:'11px', fontWeight:'800', lineHeight:1 }}>~</span>}
                    </div>
                    {r.delay > 0 && <div style={{ fontSize:'10px', color:'#EF4444', fontWeight:'700', marginTop:'2px' }}>+{r.delay}d delay</div>}
                    {r.cd === 0 && <div style={{ fontSize:'10px', color:'#94A3B8', fontStyle:'italic', marginTop:'1px' }}>Milestone</div>}
                  </td>

                  {/* Assigned */}
                  <td style={{ padding:'8px 12px', borderRight:'1px solid #F5F5F5' }}>
                    <div style={{ display:'flex', alignItems:'center', gap:'6px' }}>
                      <div style={{ width:'24px', height:'24px', borderRadius:'50%', background:per?.color+'20', border:`1.5px solid ${per?.color}`, display:'flex', alignItems:'center', justifyContent:'center', fontSize:'8px', fontWeight:'700', color:per?.color, flexShrink:0 }}>
                        {per?.init}
                      </div>
                      <span style={{ fontSize:'11.5px', color:'#374151', fontWeight:'500' }}>{r.person}</span>
                    </div>
                  </td>

                  {/* Role */}
                  <td style={{ padding:'8px 12px', color:'#64748B', fontSize:'11px', borderRight:'1px solid #F5F5F5', whiteSpace:'nowrap' }}>{r.role}</td>

                  {/* Stage */}
                  <td style={{ padding:'8px 12px', borderRight:'1px solid #F5F5F5' }}>
                    <span style={{ background:sc.bg, color:sc.tx, border:`1px solid ${sc.bd}`, padding:'2px 8px', borderRadius:'20px', fontSize:'10.5px', fontWeight:'600', whiteSpace:'nowrap' }}>
                      {r.stage}
                    </span>
                  </td>

                  {/* Start */}
                  <td style={{ padding:'8px 12px', color:'#374151', fontSize:'11.5px', whiteSpace:'nowrap', fontVariantNumeric:'tabular-nums', borderRight:'1px solid #F5F5F5' }}>{r.start}</td>

                  {/* End */}
                  <td style={{ padding:'8px 12px', color:'#374151', fontSize:'11.5px', whiteSpace:'nowrap', fontVariantNumeric:'tabular-nums', borderRight:'1px solid #F5F5F5' }}>{r.end}</td>

                  {/* Duration */}
                  <td style={{ padding:'8px 12px', textAlign:'center', color: r.cd > 0 ? '#374151' : '#94A3B8', fontSize:'11.5px', fontStyle: r.cd === 0 ? 'italic' : 'normal', fontVariantNumeric:'tabular-nums', borderRight:'1px solid #F5F5F5' }}>{r.dur}</td>

                  {/* Depends On */}
                  <td style={{ padding:'8px 12px', color:'#64748B', fontSize:'11px', maxWidth:'200px', borderRight:'1px solid #F5F5F5' }}>
                    <div style={{ overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }} title={r.deps}>{r.deps}</div>
                  </td>

                  {/* Status */}
                  <td style={{ padding:'8px 12px' }}>
                    <span style={{ background:ss.bg, color:ss.tx, border:`1px solid ${ss.bd}`, padding:'3px 9px', borderRadius:'20px', fontSize:'11px', fontWeight:'700', whiteSpace:'nowrap', letterSpacing:'-0.01em' }}>
                      {ss.ic} {r.status}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>

        {sorted.length === 0 && (
          <div style={{ padding:'48px', textAlign:'center', color:'#94A3B8', fontSize:'13px' }}>
            No tasks match the active filters.{' '}
            <button onClick={clearAll} style={{ color:'#6366F1', border:'none', background:'none', cursor:'pointer', fontWeight:'600', fontSize:'13px' }}>
              Clear all filters
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ── App ───────────────────────────────────────────────────────────────────────
export default function App() {
  const [simDelays, setSimDelays] = useState({});
  const tasks = useMemo(()=>buildSched(simDelays),[simDelays]);
  const [tab, setTab] = useState('gantt');
  const [zoomProj,   setZoomProj]   = useState(null);
  const [zoomPeriod, setZoomPeriod] = useState(null); // e.g. 'jan', 'q1', null
  const [sel, setSel] = useState(null);
  const overdue = tasks.filter(t => OVERDUE.has(t.id)).length;
  const kpi = { total:tasks.length, conflicts:tasks.filter(t=>t.isC).length, fragile:tasks.filter(t=>t.isF).length, overdue, accDate:'13 Jun' };
  return (
    <div style={{ fontFamily:'-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif', background:'#F1F5F9', minHeight:'100vh', color:'#0F172A' }}>
      <div style={{ background:'#0F172A', padding:'0 22px', height:'52px', display:'flex', alignItems:'center', justifyContent:'space-between' }}>
        <div style={{ display:'flex', alignItems:'center', gap:'10px' }}>
          <div style={{ width:'30px', height:'30px', background:'linear-gradient(135deg,#6366F1,#8B5CF6)', borderRadius:'8px', display:'flex', alignItems:'center', justifyContent:'center', fontSize:'15px', fontWeight:'800', color:'white' }}>S</div>
          <span style={{ color:'white', fontWeight:'700', fontSize:'15px', letterSpacing:'-0.3px' }}>Schedule Demo</span>
          <span style={{ color:'#334155', margin:'0 2px' }}>·</span>
          <span style={{ color:'#475569', fontSize:'12px' }}>Thomas Archer</span>
        </div>
        <div style={{ display:'flex', alignItems:'center', gap:'10px' }}>
          {/* Project focus */}
          <span style={{ color:'#475569', fontSize:'11px' }}>Project:</span>
          <div style={{ position:'relative' }}>
            <select
              value={zoomProj || ''}
              onChange={e => { setZoomProj(e.target.value || null); if (e.target.value) setTab('gantt'); }}
              style={{
                appearance:'none', WebkitAppearance:'none',
                padding:'5px 28px 5px 11px', borderRadius:'8px',
                border:`1px solid ${zoomProj ? '#6366F1' : '#334155'}`,
                background: zoomProj ? '#6366F1' : '#1E293B',
                color: zoomProj ? 'white' : '#94A3B8',
                fontSize:'12px', fontWeight:'600', cursor:'pointer',
                outline:'none', minWidth:'140px',
              }}>
              <option value="">All projects</option>
              {PROJS.map(p => <option key={p.id} value={p.id}>{p.id} — {p.name}</option>)}
            </select>
            <span style={{ position:'absolute', right:'8px', top:'50%', transform:'translateY(-50%)', pointerEvents:'none', color: zoomProj ? 'white' : '#475569', fontSize:'10px' }}>▾</span>
          </div>

          {/* Divider */}
          <div style={{ width:'1px', height:'20px', background:'#334155' }} />

          {/* Period focus */}
          <span style={{ color:'#475569', fontSize:'11px' }}>Period:</span>
          <div style={{ position:'relative' }}>
            <select
              value={zoomPeriod || ''}
              onChange={e => { setZoomPeriod(e.target.value || null); if (e.target.value) setTab('gantt'); }}
              style={{
                appearance:'none', WebkitAppearance:'none',
                padding:'5px 28px 5px 11px', borderRadius:'8px',
                border:`1px solid ${zoomPeriod ? '#10B981' : '#334155'}`,
                background: zoomPeriod ? '#10B981' : '#1E293B',
                color: zoomPeriod ? 'white' : '#94A3B8',
                fontSize:'12px', fontWeight:'600', cursor:'pointer',
                outline:'none', minWidth:'110px',
              }}>
              <option value="">Full timeline</option>
              <optgroup label="Months">
                {PERIODS.filter(p => !p.key.startsWith('q')).map(p => <option key={p.key} value={p.key}>{p.label}</option>)}
              </optgroup>
              <optgroup label="Quarters">
                {PERIODS.filter(p => p.key.startsWith('q')).map(p => <option key={p.key} value={p.key}>{p.label}</option>)}
              </optgroup>
            </select>
            <span style={{ position:'absolute', right:'8px', top:'50%', transform:'translateY(-50%)', pointerEvents:'none', color: zoomPeriod ? 'white' : '#475569', fontSize:'10px' }}>▾</span>
          </div>

          {/* Clear both */}
          {(zoomProj || zoomPeriod) && (
            <button onClick={() => { setZoomProj(null); setZoomPeriod(null); }} style={{ padding:'4px 10px', borderRadius:'8px', border:'1px solid #334155', background:'transparent', color:'#94A3B8', fontSize:'11px', cursor:'pointer', fontWeight:'500' }}>
              ← Reset
            </button>
          )}
        </div>
      </div>
      <div style={{ display:'flex', gap:'10px', padding:'16px 22px 0' }}>
        {[
          { l:'Total Tasks',    v:kpi.total,     sub:'across 3 projects', c:'#6366F1', alert:false,              badge:null  },
          { l:'Hard Conflicts', v:kpi.conflicts, sub:'require resolution', c:'#EF4444', alert:kpi.conflicts>0,   badge:'!'   },
          { l:'Fragile Spots',  v:kpi.fragile,   sub:'≤ 1-day buffer',    c:'#F59E0B', alert:false,              badge:'~'   },
          { l:'Overdue Tasks',  v:kpi.overdue,   sub:'past due today',    c:'#DC2626', alert:kpi.overdue>0,      badge:'⏰'  },
          { l:"Latest ACC'd",   v:kpi.accDate,   sub:'schedule end date', c:'#10B981', alert:false,              badge:null  },
        ].map(k=>(
          <div key={k.l} style={{ flex:1, background:'white', borderRadius:'10px', padding:'14px 16px', boxShadow:'0 1px 3px rgba(0,0,0,0.06)', border:k.alert?`1.5px solid ${k.c}50`:'1px solid #F1F5F9', position:'relative', overflow:'hidden' }}>
            {k.alert && <div style={{ position:'absolute', top:0, left:0, right:0, height:'3px', background:k.c }} />}
            <div style={{ fontSize:'10px', color:'#94A3B8', textTransform:'uppercase', letterSpacing:'0.07em', marginBottom:'4px' }}>{k.l}</div>
            <div style={{ display:'flex', alignItems:'center', gap:'8px' }}>
              <span style={{ fontSize:'28px', fontWeight:'800', color:k.alert?k.c:'#0F172A', lineHeight:'1', fontVariantNumeric:'tabular-nums' }}>{k.v}</span>
              {k.badge && <span style={{ width:'22px', height:'22px', borderRadius:'50%', background:k.c, color:'white', display:'flex', alignItems:'center', justifyContent:'center', fontSize:k.badge==='⏰'?'12px':'11px', fontWeight:'800', flexShrink:0 }}>{k.badge}</span>}
            </div>
            <div style={{ fontSize:'11px', color:'#94A3B8', marginTop:'4px' }}>{k.sub}</div>
          </div>
        ))}
      </div>
      <div style={{ margin:'12px 22px 22px', background:'white', borderRadius:'12px', boxShadow:'0 1px 4px rgba(0,0,0,0.07)', overflow:'hidden' }}>
        <div style={{ display:'flex', borderBottom:'1px solid #F1F5F9', background:'#FAFAFA', padding:'0 6px' }}>
          {[{id:'gantt',l:'Gantt Chart'},{id:'project',l:'Project View'},{id:'conflicts',l:`Conflicts (${kpi.conflicts})`},{id:'people',l:'People'}].map(t=>(
            <button key={t.id} onClick={()=>{ setTab(t.id); if(t.id==='people'&&!sel)setSel('Jake'); }} style={{ padding:'12px 18px', border:'none', background:'none', cursor:'pointer', fontSize:'13px', fontWeight:tab===t.id?'600':'400', color:tab===t.id?'#6366F1':'#64748B', borderBottom:tab===t.id?'2px solid #6366F1':'2px solid transparent', marginBottom:'-1px', transition:'color 0.12s', whiteSpace:'nowrap' }}>{t.l}</button>
          ))}
        </div>
        {tab==='gantt'     && <ProjectGanttTab tasks={tasks} zoomProj={zoomProj} zoomPeriod={zoomPeriod} simDelays={simDelays} setSimDelays={setSimDelays} />}
        {tab==='project'   && <ProjectViewTab tasks={tasks} />}
        {tab==='conflicts' && <ConflictsTab tasks={tasks} />}
        {tab==='people'    && <PeopleTab tasks={tasks} sel={sel} onSel={setSel} />}
      </div>
    </div>
  );
}