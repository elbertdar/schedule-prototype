// ── ConflictMiniGantt ────────────────────────────────────────────────────────
// Compact conflict-focused Gantt. Shows every person with at least one
// conflict or dep-violation. Conflict bars are red, dep-violation bars amber
// dashed, clean bars dimmed purple for context.

import { useState, useMemo, useRef, useEffect } from 'react';
import { useSched } from '../context.jsx';
import { fmtDate as fd } from '../engine/dates.jsx';
import { DPX, RH, BH, HH, LW, ALL_MONS, CARD, BORDER, ORANGE, TEXT, MUTED } from '../theme.jsx';

export function ConflictMiniGantt({ tasks, conflicts, depViolations }) {
  const { rawTasks, projs, people, tdepMap, base, todayDay, periods } = useSched();

  const scrollRef = useRef(null);
  const [hov, setHov] = useState(null);
  const [mouse, setMouse] = useState({ x:0, y:0 });
  const outerRef = useRef(null);

  // Gather all people involved in any conflict or dep-violation
  const involvedPeople = useMemo(() => {
    const names = new Set([
      ...conflicts.map(t => t.person),
      ...depViolations.map(t => t.person),
    ]);
    return people.filter(p => names.has(p.name));
  }, [conflicts, depViolations]);

  // For each involved person, get ALL their tasks (for context) plus flag which are hot
  const rows = useMemo(() => involvedPeople.map(per => {
    const allTasks = tasks.filter(t => t.person === per.name).sort((a,b) => a.s - b.s);
    return { per, allTasks };
  }), [involvedPeople, tasks]);

  // Timeline bounds: earliest start to latest end across all rows, with padding
  const { minDay, maxDay } = useMemo(() => {
    const allT = rows.flatMap(r => r.allTasks).filter(t => t.cd > 0);
    if (!allT.length) return { minDay:0, maxDay:120 };
    return {
      minDay: Math.max(0, Math.min(...allT.map(t => t.sd)) - 7),
      maxDay: Math.max(...allT.map(t => t.sd + t.cd)) + 7,
    };
  }, [rows]);

  const DPX  = 11;          // pixels per calendar day
  const RH   = 56;          // row height
  const BH   = 30;          // bar height
  const HH   = 64;          // header height (month + week rows)
  const LW   = 160;         // left label width
  const totalW = (maxDay - minDay) * DPX;
  const totalH = HH + rows.length * RH;

  const tx = d => (d - minDay) * DPX;  // day → x coordinate

  // Build month/week columns for the visible range
  const visibleMons = ALL_MONS.filter((m, i) =>
    i < ALL_MONS.length - 1 &&
    ALL_MONS[i+1].d > minDay &&
    m.d < maxDay
  );

  const todayX = tx(todayDay);

  // Scroll to today on mount
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollLeft = Math.max(0, todayX - 120);
    }
  }, [todayX]);

  const hotIds = useMemo(() => new Set([
    ...conflicts.map(t => t.id),
    ...depViolations.map(t => t.id),
  ]), [conflicts, depViolations]);

  const ht = hov ? tasks.find(t => t.id === hov) : null;

  return (
    <div style={{ background:'#13131A' }}>
      {/* Mini toolbar */}
      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', padding:'10px 16px', borderBottom:`1px solid ${BORDER}`, background:CARD }}>
        <div style={{ display:'flex', alignItems:'center', gap:'16px' }}>
          <span style={{ fontSize:'12px', fontWeight:'600', color:TEXT }}>{conflicts.length} conflict{conflicts.length!==1?'s':''}</span>
          {depViolations.length > 0 && <span style={{ fontSize:'12px', fontWeight:'600', color:'#FBBF24' }}>{depViolations.length} dep. violation{depViolations.length!==1?'s':''}</span>}
          <span style={{ fontSize:'11px', color:MUTED }}>{involvedPeople.length} people affected</span>
        </div>
        {/* Legend */}
        <div style={{ display:'flex', alignItems:'center', gap:'14px', marginRight:'8px' }}>
          {[
            { color:'#EF4444', label:'Conflict' },
            { color:'#F59E0B', label:'Dep. Violation', dashed:true },
            { color:'#6366F1', label:'Clean task', dim:true },
          ].map(l => (
            <div key={l.label} style={{ display:'flex', alignItems:'center', gap:'5px' }}>
              <div style={{ width:'20px', height:'8px', borderRadius:'3px', background:l.dim?l.color+'50':l.color, border:l.dashed?`1px dashed ${l.color}`:'none' }} />
              <span style={{ fontSize:'10px', color:MUTED }}>{l.label}</span>
            </div>
          ))}
        </div>
        <button
          onClick={() => { if (scrollRef.current) scrollRef.current.scrollLeft = Math.max(0, todayX - 120); }}
          style={{ padding:'5px 12px', borderRadius:'6px', border:`1px solid ${BORDER}`, background:'transparent', color:TEXT, fontSize:'12px', cursor:'pointer' }}>
          Full Timeline
        </button>
      </div>

      <div ref={outerRef} style={{ position:'relative', display:'flex' }}
        onMouseMove={e => { const r=outerRef.current?.getBoundingClientRect(); if(r) setMouse({x:e.clientX-r.left,y:e.clientY-r.top}); }}
        onMouseLeave={() => setHov(null)}>

        {/* Left label panel */}
        <div style={{ width:LW, flexShrink:0, zIndex:5, boxShadow:'4px 0 10px rgba(0,0,0,0.4)' }}>
          <svg width={LW} height={totalH} style={{ display:'block', fontFamily:'-apple-system,system-ui,sans-serif', overflow:'visible' }}>
            {/* Header bg */}
            <rect x={0} y={0} width={LW} height={HH} fill="#0A0A0F" />
            <line x1={0} y1={HH} x2={LW} y2={HH} stroke={BORDER} strokeWidth="1" />
            {/* Person rows */}
            {rows.map(({ per, allTasks: pt }, i) => {
              const y   = HH + i * RH;
              const midY = y + RH / 2;
              const hasC = pt.some(t => t.isC);
              const hasDV = pt.some(t => t.isDV && !t.isC);
              return (
                <g key={per.name}>
                  <rect x={0} y={y} width={LW} height={RH} fill={i%2===0?'#13131A':'#0F0F18'} />
                  <circle cx={22} cy={midY} r={13} fill={per.color+'25'} />
                  <circle cx={22} cy={midY} r={13} fill="none" stroke={per.color} strokeWidth="1.5" />
                  <text x={22} y={midY+1} textAnchor="middle" dominantBaseline="middle" fill={per.color} fontSize="8" fontWeight="700">{per.init}</text>
                  <text x={42} y={midY-6} fill={TEXT} fontSize="12" fontWeight="600">{per.name}</text>
                  <text x={42} y={midY+8} fill={MUTED} fontSize="9.5">{per.role.split(' ')[0]}</text>
                  {hasC  && <circle cx={LW-10} cy={y+12} r={6} fill="#EF4444" />}
                  {hasC  && <text x={LW-10} y={y+12} textAnchor="middle" dominantBaseline="middle" fill="white" fontSize="8" fontWeight="700">!</text>}
                  {hasDV && !hasC && <circle cx={LW-10} cy={y+12} r={6} fill="#F59E0B" />}
                  {hasDV && !hasC && <text x={LW-10} y={y+12} textAnchor="middle" dominantBaseline="middle" fill="white" fontSize="8" fontWeight="700">⊗</text>}
                  <line x1={0} y1={y+RH} x2={LW} y2={y+RH} stroke={BORDER} strokeWidth="0.8" />
                </g>
              );
            })}
            <line x1={LW-1} y1={0} x2={LW-1} y2={totalH} stroke={BORDER} strokeWidth="1" />
          </svg>
        </div>

        {/* Scrollable timeline */}
        <div ref={scrollRef} style={{ overflowX:'auto', flex:1 }}>
          <svg width={totalW} height={totalH} style={{ display:'block', fontFamily:'-apple-system,system-ui,sans-serif' }}>

            {/* Month header row */}
            {visibleMons.map((m, i) => {
              const x1 = tx(m.d);
              const nextMon = ALL_MONS[ALL_MONS.indexOf(m)+1];
              const x2 = nextMon ? Math.min(tx(nextMon.d), totalW) : totalW;
              return (
                <g key={m.n+i}>
                  <rect x={x1} y={0} width={x2-x1} height={HH*0.52} fill={i%2?'#17171F':'#1C1C27'} />
                  <text x={(x1+x2)/2} y={HH*0.52/2+4} textAnchor="middle" fill="#9CA3AF" fontSize="11" fontWeight="500">{m.n} 2026</text>
                  <line x1={x1} y1={0} x2={x1} y2={totalH} stroke={BORDER} strokeWidth="0.5" />
                </g>
              );
            })}

            {/* Week sub-header row */}
            {visibleMons.map((m, i) => {
              const nextMon = ALL_MONS[ALL_MONS.indexOf(m)+1];
              const monEnd  = nextMon ? nextMon.d : maxDay;
              const span    = monEnd - m.d;
              const wSpan   = span / 4;
              return Array.from({length:4}, (_, w) => {
                const wx1 = tx(m.d + w * wSpan);
                const wx2 = tx(m.d + (w+1) * wSpan);
                return (
                  <g key={`${i}-w${w}`}>
                    <rect x={wx1} y={HH*0.52} width={wx2-wx1} height={HH*0.48} fill={w%2?'#13131A':'#17171F'} />
                    <text x={(wx1+wx2)/2} y={HH*0.52+HH*0.48/2+4} textAnchor="middle" fill="#374151" fontSize="9.5" fontWeight="500">W{w+1}</text>
                    <line x1={wx1} y1={HH*0.52} x2={wx1} y2={totalH} stroke={BORDER} strokeWidth="0.3" opacity="0.6" />
                  </g>
                );
              });
            })}

            <line x1={0} y1={HH} x2={totalW} y2={HH} stroke={BORDER} strokeWidth="1" />

            {/* Vertical gridlines (weekly) */}
            {Array.from({length: Math.ceil((maxDay - minDay) / 7)}, (_, i) => minDay + i*7).map(d => (
              <line key={d} x1={tx(d)} y1={HH} x2={tx(d)} y2={totalH} stroke={BORDER} strokeWidth="0.4" opacity="0.5" />
            ))}

            {/* Today line */}
            {todayDay >= minDay && todayDay <= maxDay && (
              <g>
                <line x1={todayX} y1={0} x2={todayX} y2={totalH} stroke={ORANGE} strokeWidth="1.5" strokeDasharray="4 3" opacity="0.8" />
                <rect x={todayX-22} y={HH*0.52-10} width={44} height={18} rx="4" fill={ORANGE} />
                <text x={todayX} y={HH*0.52-1} textAnchor="middle" dominantBaseline="middle" fill="white" fontSize="9" fontWeight="700">Today</text>
              </g>
            )}

            {/* Rows + bars */}
            {rows.map(({ per, allTasks: pt }, i) => {
              const y   = HH + i * RH;
              const by0 = y + (RH - BH) / 2;
              const midY = y + RH / 2;
              return (
                <g key={per.name}>
                  <rect x={0} y={y} width={totalW} height={RH} fill={i%2===0?'#13131A':'#0F0F18'} />
                  <line x1={0} y1={y+RH} x2={totalW} y2={y+RH} stroke={BORDER} strokeWidth="0.8" />
                  {pt.filter(t => t.cd > 0 && t.sd + t.cd > minDay && t.sd < maxDay).map(t => {
                    const x = tx(t.sd);
                    const w = Math.max(t.cd * DPX, 4);
                    const isHot = hotIds.has(t.id);
                    const isDV  = t.isDV && !t.isC;
                    const isC   = t.isC;
                    const ih    = hov === t.id;

                    const barColor = isC ? '#EF4444' : isDV ? '#F59E0B' : per.color;
                    const barFill  = isC ? '#EF444430' : isDV ? '#F59E0B25' : per.color+'18';
                    const opacity  = isHot ? 1 : (hov && !ih) ? 0.3 : isHot ? 1 : 0.65;

                    return (
                      <g key={t.id} opacity={opacity} style={{ cursor:'default' }}
                        onMouseEnter={() => setHov(t.id)}
                        onMouseLeave={() => setHov(null)}>
                        {/* Shadow */}
                        <rect x={x+2} y={by0+2} width={w} height={BH} rx="4" fill="rgba(0,0,0,0.3)" />
                        {/* Bar */}
                        <rect x={x} y={by0} width={w} height={BH} rx="4"
                          fill={barFill}
                          stroke={barColor}
                          strokeWidth={ih ? 2 : isHot ? 1.8 : 1.2}
                          strokeDasharray={isDV ? '5 3' : 'none'} />
                        {/* Left accent stripe */}
                        <rect x={x+1.5} y={by0+1.5} width={4} height={BH-3} rx="2" fill={barColor} opacity={isHot?1:0.8} />
                        {/* Label */}
                        {w > 48 && (
                          <text x={x+10} y={midY+1} dominantBaseline="middle" fill={barColor}
                            fontSize="9.5" fontWeight={isHot?'700':'600'}
                            style={{ pointerEvents:'none', userSelect:'none' }}>
                            {(()=>{ const mc=Math.floor((w-14)/5.5); return t.name.length>mc?t.name.slice(0,mc)+'…':t.name; })()}
                          </text>
                        )}
                        {/* Badge */}
                        {isC && (
                          <g style={{ pointerEvents:'none' }}>
                            <circle cx={x+w-7} cy={by0+7} r={5.5} fill="#EF4444" />
                            <text x={x+w-7} y={by0+7} textAnchor="middle" dominantBaseline="middle" fill="white" fontSize="7" fontWeight="800">!</text>
                          </g>
                        )}
                        {isDV && (
                          <g style={{ pointerEvents:'none' }}>
                            <circle cx={x+w-7} cy={by0+7} r={5.5} fill="#F59E0B" />
                            <text x={x+w-7} y={by0+7} textAnchor="middle" dominantBaseline="middle" fill="white" fontSize="7" fontWeight="800">⊗</text>
                          </g>
                        )}
                      </g>
                    );
                  })}
                </g>
              );
            })}
          </svg>
        </div>

        {/* Tooltip */}
        {ht && (() => {
          const pc  = projs.find(p => p.id === ht.projId)?.color || '#888';
          const ttx = Math.min(mouse.x + 14, (outerRef.current?.clientWidth||700) - 220);
          const tty = Math.max(mouse.y - 100, HH + 4);
          const cNames = ht.cw.map(id => { const c=tasks.find(x=>x.id===id); return c?`${c.id} (${c.person})`:id; });
          const dvNames = (ht.dvDeps||[]).map(id => { const d=tasks.find(x=>x.id===id); return d?`${id} – ${d.name}`:id; });
          return (
            <div style={{ position:'absolute', left:ttx, top:tty, pointerEvents:'none', background:'#0A0A0F', color:TEXT, padding:'11px 14px', borderRadius:'10px', fontSize:'12px', lineHeight:'1.6', boxShadow:'0 10px 30px rgba(0,0,0,0.5)', width:'210px', zIndex:50, borderTop:`3px solid ${pc}` }}>
              <div style={{ fontWeight:'700', marginBottom:'3px' }}>{ht.name}</div>
              <div style={{ color:MUTED, fontSize:'10px', marginBottom:'7px' }}>{ht.projId} · {ht.id} · {ht.person}</div>
              <div style={{ display:'grid', gridTemplateColumns:'52px 1fr', gap:'2px 8px', fontSize:'11px' }}>
                <span style={{ color:MUTED }}>Start</span><span>{fd(ht.s)}</span>
                <span style={{ color:MUTED }}>End</span><span>{fd(ht.e)}</span>
                <span style={{ color:MUTED }}>Duration</span><span>{ht.dur} wdays</span>
              </div>
              {ht.isC && cNames.length > 0 && (
                <div style={{ marginTop:'8px', padding:'5px 8px', background:'rgba(239,68,68,0.15)', borderRadius:'5px', fontSize:'10px', color:'#FCA5A5', fontWeight:'700', border:'1px solid rgba(239,68,68,0.3)' }}>
                  ⚠ Clashes with: {cNames.join(', ')}
                </div>
              )}
              {ht.isDV && dvNames.length > 0 && (
                <div style={{ marginTop:'8px', padding:'5px 8px', background:'rgba(245,158,11,0.15)', borderRadius:'5px', fontSize:'10px', color:'#FDE68A', fontWeight:'700', border:'1px solid rgba(245,158,11,0.3)', borderStyle:'dashed' }}>
                  ⊗ Needs: {dvNames.join(', ')}
                </div>
              )}
            </div>
          );
        })()}
      </div>

      {/* Empty state */}
      {rows.length === 0 && (
        <div style={{ padding:'48px', textAlign:'center', color:MUTED, fontSize:'13px' }}>
          <div style={{ fontSize:'28px', marginBottom:'10px' }}>✓</div>
          No conflicts to display.
        </div>
      )}
    </div>
  );
}

