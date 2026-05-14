// ── Tile ─────────────────────────────────────────────────────────────────────
// Small numeric tile used in the EditModal impact grid.

export function Tile({ v, label, color, bg, border }) {
  return (
    <div style={{ padding:'8px 10px', borderRadius:'8px', background:bg, border:`1px solid ${border}`, textAlign:'center' }}>
      <div style={{ fontSize:'18px', fontWeight:'800', color, fontVariantNumeric:'tabular-nums' }}>{v}</div>
      <div style={{ fontSize:'10px', color, marginTop:'2px', fontWeight:'600', opacity:0.85 }}>{label}</div>
    </div>
  );
}
