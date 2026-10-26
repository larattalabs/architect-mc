// (6c T3b) The tunnel rules of the checker (docs/CONTRACT.md "Phase 6c slice T3" §5), for every tunnel the plan meta records
// (`meta.tunnels`, written by lib/connectors/tunnelGeom.mjs `tunnel`). They read the world's blocks (the virtual world at plan time,
// a realised dump world in the gate), so the plan's numbers are only the tunnel's inputs (its line, profile, width, height):
//   M3:tunnel  (warning) cover: at least 2 site-solid cells (solid, not falling, not fluid) over the void of every bore cell, and a
//              bore of at least 4 cells; the shell: every cell face-adjacent to a bore cell's void solid and not falling (lining or rock); no
//              gravity block over a void or cut cell without support (`M3:gravity`)
//   M4:tunnel  (warning) no water, lava or ice within 2 (Chebyshev, 3D) of a void or floor cell; a tunnel whose volume the virtual
//              world does not hold (a 2.5D-only world) is the finding "no volume", never a pass
//   M6         `height` clear over every floor cell (a hanging lantern's cell with 2 clear under it excepted)
// and `metrics.tunnels` (per tunnel: cover, bore cells, shell, gravity, fluids, clear, floor cells, carved, lined). The M5 count over
// the floor cells is check.mjs's (`metrics.M5tunnel`, over each record's `cells`). Called by checkRegion (check.mjs) with K1's
// arguments; leaves `vw` as it found it.
const N6 = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
const nameOf = (s) => String(s ?? '').replace(/\[.*$/, '');

/** The tunnel rules: findings and `metrics.tunnels`. */
export function tunnelRules({ ir, vw, tunnels, want, findings, metrics, finding }) {
  const P = vw.pal, out = [];
  const isIce = (i) => /(^|:)(blue_|packed_|frosted_)?ice$/.test(nameOf(P.states[i]));
  const solid = (i) => P.solid[i] && !P.fluid[i] && !P.air[i];
  const siteSolid = (i) => solid(i) && !P.gravity[i];
  const irVolumes = Object.values(ir?.volumes ?? {});
  for (const t of tunnels) {
    const part = t.part ?? null, stage = t.stage ?? null;
    const f3 = (count, sample, message) => { if (want.has('M3')) findings.push(finding('M3:tunnel', part, stage, count, sample, message)); };
    const fg = (count, sample, message) => { if (want.has('M3')) findings.push(finding('M3:gravity', part, stage, count, sample, message)); };
    const f4 = (count, sample, message) => { if (want.has('M4')) findings.push(finding('M4:tunnel', part, stage, count, sample, message)); };
    const f6 = (count, sample, message) => { if (want.has('M6')) findings.push(finding('M6', part, stage, count, sample, message)); };
    const [fx, , fz] = t.from, [dx, dz] = t.dir;
    const idxOf = (x, z) => (x - fx) * dx + (z - fz) * dz;
    const voids = new Set((t.voids ?? []).map((c) => `${c[0]},${c[1]},${c[2]}`));
    const floor = new Set((t.floor ?? []).map((c) => `${c[0]},${c[1]},${c[2]}`));
    const row = { id: t.id, part, length: t.length, width: t.width, height: t.height, floorCells: (t.floor ?? []).length, carved: t.carved ?? 0, lined: t.lined ?? 0, coverMin: null, bore: 0, boreRun: 0, shell: 0, shellOpen: 0, gravity: 0, fluids: 0, clear: 0, notClear: 0, volume: null };
    // ---- the volume: a tunnel is checked against the frozen rock it was planned over
    const hasVol = !!t.volume && irVolumes.some((v) => v.sha === t.volume.sha);
    row.volume = hasVol ? t.volume.sha.slice(0, 12) : null;
    if (!hasVol) f4(1, [t.from], `tunnel ${t.id}: no volume (a 2.5D-only virtual world can't show its rock, fluids or caves)`);
    // ---- cover over every bore cell, the bore's longest run (from the world's blocks)
    const bore = new Map();
    let run = 0, best = 0, coverMin = Infinity;
    const lowCover = [];
    for (const [x, y, z] of t.floor ?? []) {
      const i = idxOf(x, z);
      if (!t.bore?.[i - 1]) continue;
      const top = y + t.height;
      let n = 0;
      for (let yy = top + 1; yy <= top + 64 && n < 2; yy++) {
        const b = vw.get(x, yy, z);
        if (P.air[b] && vw.colTop && yy > vw.colTop(x, z)) break;
        if (siteSolid(b)) n++;
      }
      bore.set(i, Math.min(bore.get(i) ?? Infinity, n));
    }
    for (let i = 1; i <= t.length; i++) {
      const c = bore.get(i);
      if (c === undefined) { run = 0; continue; }
      coverMin = Math.min(coverMin, c);
      if (c < 2) { lowCover.push(i); run = 0; continue; }
      run++;
      best = Math.max(best, run);
      row.bore++;
    }
    row.coverMin = coverMin === Infinity ? null : coverMin;
    row.boreRun = best;
    if (lowCover.length) f3(lowCover.length, lowCover.slice(0, 12).map((i) => [fx + dx * i, t.from[1], fz + dz * i]), `tunnel ${t.id}: ${lowCover.length} bore cell(s) under fewer than 2 site-solid cells`);
    // ((7a RK) a rock stair's record carries boreMin 0: an all-cut flight is a stair cut into the hillside)
    if (best < (t.boreMin ?? 4)) f3(1, [t.from], `tunnel ${t.id}: its longest bore is ${best} cells (at least 4)`);
    // ---- the shell of the bore cells' voids: solid
    const open = [];
    for (const [x, y, z] of t.floor ?? []) {
      const i = idxOf(x, z);
      if (!t.bore?.[i - 1]) continue;
      for (let h = 1; h <= t.height; h++) for (const [ax, ay, az] of N6) {
        const nx = x + ax, ny = y + h + ay, nz = z + az, k = `${nx},${ny},${nz}`;
        if (voids.has(k) || floor.has(k)) continue;
        // along the bore its next or previous floor cell's void (a step of the profile) is the void too
        if (ay === 0 && (ax === dx && az === dz || ax === -dx && az === -dz)) continue;
        row.shell++;
        const b = vw.get(nx, ny, nz);
        // (a falling block in the shell is no wall: it leaves at the first update; the lining replaces it)
        if ((!solid(b) && !P.stairs[b]) || P.gravity[b]) { row.shellOpen++; if (open.length < 16) open.push([nx, ny, nz]); }
      }
    }
    if (open.length) f3(row.shellOpen, open, `tunnel ${t.id}: ${row.shellOpen} shell cell(s) open or loose (a cave breaching the bore, or sand or gravel not lined)`);
    // ---- gravity: no falling block over a void or cut cell (its own cell under it air)
    const grav = [];
    for (const k of voids) {
      const [x, y, z] = k.split(',').map(Number);
      const b = vw.get(x, y + 1, z);
      if (P.gravity[b] && !solid(vw.get(x, y, z))) { row.gravity++; if (grav.length < 16) grav.push([x, y + 1, z]); }
    }
    if (grav.length) fg(row.gravity, grav, `tunnel ${t.id}: ${row.gravity} falling block(s) over the void`);
    // ---- fluids within 2 of a void or floor cell
    const near = new Set(), wet = [];
    for (const k of [...voids, ...floor]) {
      const [x, y, z] = k.split(',').map(Number);
      for (let ax = -2; ax <= 2; ax++) for (let ay = -2; ay <= 2; ay++) for (let az = -2; az <= 2; az++) {
        const kk = `${x + ax},${y + ay},${z + az}`;
        if (near.has(kk)) continue;
        near.add(kk);
        const b = vw.get(x + ax, y + ay, z + az);
        if (P.water[b] || P.lava[b] || isIce(b)) { row.fluids++; if (wet.length < 16) wet.push([x + ax, y + ay, z + az]); }
      }
    }
    if (wet.length) f4(row.fluids, wet, `tunnel ${t.id}: ${row.fluids} water, lava or ice cell(s) within 2 of the void`);
    // ---- M6: height clear over every floor cell (a hanging lantern with 2 clear under it excepted)
    const lampAt = new Set((t.lamps ?? []).filter((l) => l[3] === 'hanging').map((l) => `${l[0]},${l[1]},${l[2]}`));
    const shut = [];
    for (const [x, y, z] of t.floor ?? []) {
      let ok = true;
      for (let h = 1; h <= t.height; h++) {
        const k = `${x},${y + h},${z}`;
        if (lampAt.has(k) && h >= 3) continue;
        if (!P.passable[vw.get(x, y + h, z)]) { ok = false; break; }
      }
      if (ok) row.clear++; else { row.notClear++; if (shut.length < 16) shut.push([x, y + 1, z]); }
    }
    if (shut.length) f6(row.notClear, shut, `tunnel ${t.id}: ${row.notClear} floor cell(s) without ${t.height} clear over them`);
    out.push(row);
  }
  metrics.tunnels = { per: out, count: out.length };
}
