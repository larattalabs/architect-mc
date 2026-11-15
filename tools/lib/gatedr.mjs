// Slice DR gate (docs/CONTRACT.md "Slice DR", strict, speed rule 11.2: targeted scenarios only): diagnose and repair after a crash
// that lost world writes the journal recorded. Registered into tools/gate6dgr.mjs (its headless server and helpers). Sim, $0.
//
//   node tools/gate6dgr.mjs drcrash   (dr-crash)   one creative flat world, cell sites straddling the region-file line x = 11264 (BOX
//                                                  policy, so a removal restores its box exactly). The fault: sites A, E, F (alone) and
//                                                  D under C (stacked) placed, a /save-all flush, the west region files copied (S0);
//                                                  C, D, A, E, F removed, a flush; B and B2 placed after it (no save); a halt with
//                                                  nothing saved (dev.stockpile.halt); S0's west region files put back (the chunks
//                                                  that "never saved": the removals' west halves and B's whole placement lag). Then:
//                                                  every case: the auto-diagnose's ops line and Sites.suspects() name it; diagnose
//                                                  reports exactly the constructed cells; the dry run changes no byte; repair; a
//                                                  second diagnose finds nothing; a second repair changes nothing.
//                                                  DR1 (F5)  A stuck (KEEP): repaired, released (SITE_REMOVED), the box = before
//                                                  DR2 (H)   B's placement lost: rolled forward, the box = the placed box
//                                                  DR3 (F7)  D then C, stacked: D first (written, kept until C), then C: both settle
//                                                  DR6       E plus a player's block (a PT record) and a hand-changed cell: both
//                                                            FOREIGN, untouched; the rest repaired
//                                                  DR9       B2 lagging, its removal queued (slow jobs): SITE_BUSY, nothing written;
//                                                            a null actor and a non-op player: PERMISSION
//                                                  DR10      F repaired with DRK1 armed: halts mid-repair; after the restart diagnose
//                                                            names the open record, repair finishes it; the box = before
//                                                  DR11      a clean stop and start: no ops line, suspects() empty
//
// Survival cases DR4, DR5, DR7, DR8 are not in this step (docs/CONTRACT.md "Slice DR as built": leftovers).
// Evidence: artifacts/gate6d-gr/drcrash.json (GATE6DGR_OUT), all.log, spend.json ($0.00).
import fs from 'node:fs';
import path from 'node:path';

export async function registerDR(steps, h) {
  const { L, call, check, cmd, log, json, ensure, spendZero, haltWait } = h;
  const FLAT = 'G6B Flat Base';
  const XL = 11264; // the region-file line: r.21 west, r.22 east
  const api = async (args) => {
    const r = await cmd(`/apitest ${args}`);
    const line = (r.messages ?? []).find((m) => m.startsWith('{') || m.startsWith('[') || m === 'null');
    if (line === undefined) throw new Error(`/apitest ${args.slice(0, 200)}: no JSON answer: ${JSON.stringify(r).slice(0, 500)}`);
    return JSON.parse(line);
  };
  const result = async (pending, timeoutMs = 300_000) => {
    const key = pending.pending;
    if (!key) return pending;
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const r = await api(`get ${key}`);
      if (r.value !== undefined && r.value !== null) return r.value;
      await L.sleep(500);
    }
    throw new Error(`no result for ${key}`);
  };
  const hash = async (b) => (await call('dev.box.hash', { min: [b[0], b[1], b[2]], max: [b[3], b[4], b[5]] }, 300_000)).sha256;
  const cellsOf = async (b) => {
    const r = await call('dev.box.hash', { min: [b[0], b[1], b[2]], max: [b[3], b[4], b[5]], cells: true }, 300_000);
    return new Map((r.cells ?? []).map((l) => { const sp = l.indexOf(' '); return [l.slice(0, sp), l.slice(sp + 1).split(' be=')[0]]; }));
  };
  /** Whether a dev.box.hash cell (NbtUtils.writeBlockState text) is block `id`. */
  const isId = (s, id) => typeof s === 'string' && s.includes(`"${id}"`);
  const rep = (op, extra = {}) => call('dev.repair', { op, ...extra }, 300_000);
  const st = () => rep('state');
  const diag = (site) => rep('diagnose', { scope: { kind: 'site', id: site } });
  const repair = (planId, apply, actor = 'player') => rep('repair', { planId, apply, actor });
  const regionDir = (world) => path.join(L.SAVES, world, 'dimensions', 'minecraft', 'overworld', 'region');

  async function started(tag) {
    let s;
    for (let i = 0; i < 120; i++) {
      s = await st().catch(() => null);
      if (s?.startDone && !s.pending) break;
      await L.sleep(1000);
    }
    check(!!s?.startDone && !s.pending, `${tag}: the start's settles done and the auto-diagnose finished (${json(s)})`);
    return s;
  }

  steps.drcrash = async () => {
    await ensure();
    spendZero();
    const W = 'G6B DR Crash';
    await L.fresh(W, FLAT);
    await L.setRules('exact');
    await cmd('/op @s').catch(() => null);
    await L.tp(XL + 0.5, 140, 11400.5);
    const gy = await groundAt(XL + 20, 11300);
    const y0 = gy + 1, y1 = gy + 3;
    await L.tp(XL + 0.5, gy + 40, 11400.5);
    // boxes: x XL-6..XL+5 (6 columns each side of the line), z bands 40 apart, all in region z 22 (11264..11775)
    const box = (z0, dz = 5, x0 = XL - 6, x1 = XL + 5, top = y1) => [x0, y0, z0, x1, top, z0 + dz];
    const BX = { A: box(11300), E: box(11340), F: box(11380), D: box(11420), C: [XL - 3, y0, 11423, XL + 8, y1 + 1, 11428], B: box(11460), B2: box(11500, 9, XL - 12, XL + 11) };
    const h0 = {};
    for (const [k, b] of Object.entries(BX)) h0[k] = await hash(b);
    const ids = {};
    const place = async (k, state) => {
      const b = BX[k];
      const r = await call('dev.cells.place', { kind: 'dr:test', policy: 'BOX', fill: { min: [b[0], b[1], b[2]], max: [b[3], b[4], b[5]], state }, overlap: 'LAYER', force: true }, 600_000);
      check(r.placed === true, `${k}: a cell site of ${state} over ${json(b)} (${r.siteId ?? json(r.refusals)})`);
      ids[k] = r.siteId;
      return r;
    };
    for (const k of ['A', 'E', 'F', 'D']) await place(k, 'minecraft:stone_bricks');
    await place('C', 'minecraft:oak_planks');
    await L.settle(2000);
    const placed = {};
    for (const k of ['A', 'E', 'F', 'D', 'C']) placed[k] = await hash(BX[k]);
    await cmd('/save-all flush');
    await L.settle(3000);
    const RD = regionDir(W);
    const west = fs.readdirSync(RD).filter((f) => /^r\.21\.22\.mca$/.test(f));
    check(west.length === 1, `the west region file r.21.22.mca is on disk (${fs.readdirSync(RD).join(',')})`);
    const S0 = path.join(L.OUT, 'dr-s0');
    fs.mkdirSync(S0, { recursive: true });
    for (const f of west) fs.copyFileSync(path.join(RD, f), path.join(S0, f));
    for (const k of ['C', 'D', 'A', 'E', 'F']) {
      const r = await result(await api(`remove ${ids[k]} - noforce keep`));
      check(r.removed === true, `${k} (${ids[k]}) removed (${json(r.blockers ?? [])})`);
    }
    await L.settle(2000);
    for (const k of ['A', 'E', 'F', 'D']) check(await hash(BX[k]) === h0[k] || k === 'D', `${k}: restored exactly before the fault`);
    await cmd('/save-all flush');
    await L.settle(3000);
    await place('B', 'minecraft:oak_planks');
    await place('B2', 'minecraft:oak_planks');
    await L.settle(1500);
    const placedB = await hash(BX.B), placedB2 = await hash(BX.B2);
    // the halt: nothing saved since the flush (B and B2's chunks unsaved), then S0's west file over the world's
    await call('dev.stockpile.halt', { mode: 'now' }, 10_000).catch(() => null);
    check(await haltWait(), 'dev.stockpile.halt halted the server (nothing saved)');
    for (const f of west) fs.copyFileSync(path.join(S0, f), path.join(RD, f));
    log('  fault: S0 west region file put back (the removals\' west halves and the placements after the flush lost)');
    await L.openWorld(W);
    await L.tp(XL + 0.5, gy + 40, 11400.5);
    const s1 = await started('restart');
    const sus = Object.fromEntries((s1.suspects ?? []).map((x) => [x.site, x.reason]));
    log(`  auto-diagnose: ${s1.opsLine}; suspects ${json(sus)}`);
    for (const k of ['A', 'E', 'F', 'D', 'C']) check(sus[ids[k]] === 'stuck', `${k}: suspects() names ${ids[k]} stuck (${sus[ids[k]]})`);
    for (const k of ['B', 'B2']) check(sus[ids[k]] === 'lagging', `${k}: suspects() names ${ids[k]} lagging (${sus[ids[k]]})`);
    check(typeof s1.opsLine === 'string' && /lag the journal after an unclean stop/.test(s1.opsLine) && s1.opsLine.includes('/architect diagnose all'),
      `the ops line after the unclean stop (${s1.opsLine})`);

    /** The constructed lagging cells of a box: those holding `pre` in the west half (x < XL), or anywhere for a lost placement. */
    const expectLag = async (b, pre, westOnly) => {
      const c = await cellsOf(b);
      let n = 0;
      for (const [k, s] of c) { const x = Number(k.split(',')[0]); if ((!westOnly || x < XL) && isId(s, pre)) n++; }
      return n;
    };
    const out = { ids, opsLine: s1.opsLine, suspects: sus };

    /** One case's checks: diagnose = constructed, dry run changes no byte, repair, second diagnose clean, second repair nothing. */
    async function caseRun(tag, k, { code, lag, foreign = 0, want, settles = true }) {
      const d1 = await diag(ids[k]);
      const f = (d1.findings ?? []).find((x) => x.code === code && x.site === ids[k]);
      check(!!f && f.lagging === lag && f.foreign === foreign, `${tag}: diagnose reports ${code} ${ids[k]} with exactly the ${lag} constructed lagging cell(s) and ${foreign} foreign (${json(f && { lagging: f.lagging, foreign: f.foreign, cells: f.cells })})`, d1);
      const pre = await hash(BX[k]);
      const dry = await repair(d1.planId, false);
      check(dry.applied === false && dry.written === lag && !dry.refused, `${tag}: the dry run would write ${dry.written} (${dry.message})`);
      check(await hash(BX[k]) === pre, `${tag}: the dry run changed no byte`);
      const r = await repair(d1.planId, true);
      check(r.applied === true && r.written === lag && r.left === foreign && !!r.record, `${tag}: repaired: wrote ${r.written}, left ${r.left}; record ${r.record} (${r.message})`, r);
      const rec = r.record && fs.existsSync(r.record) ? JSON.parse(fs.readFileSync(r.record, 'utf8')) : null;
      check(rec?.state === 'final' && rec.cells?.length === lag && !!rec.op, `${tag}: the record is final, names the op and its ${lag} cells (${rec?.state}, ${rec?.cells?.length}, ${rec?.op})`);
      if (want) check(await hash(BX[k]) === want, `${tag}: the box is as the journal committed it`);
      const d2 = await diag(ids[k]);
      const left = (d2.findings ?? []).filter((x) => x.site === ids[k] && x.code !== 'FOREIGN' && (settles || x.lagging > 0));
      check(left.length === 0, `${tag}: a second diagnose finds nothing to repair (${json(left.map((x) => [x.code, x.lagging]))})`);
      const r2 = await repair(d2.planId, true);
      check(r2.written === 0 && (await hash(BX[k])) === (want ?? (await hash(BX[k]))), `${tag}: a second repair changes nothing (wrote ${r2.written}; ${r2.refused ?? ''} ${r2.message})`);
      return { d1: f, r, rec: rec && { state: rec.state, cells: rec.cells.length, settled: rec.settled }, d2: left };
    }

    // DR1 (F5): A stuck, half restored: rolled forward, released
    const ev0 = (await st()).repairedEvents;
    const lagA = await expectLag(BX.A, 'minecraft:stone_bricks', true);
    check(lagA === 6 * 6 * 3, `DR1: the fault left A's west half standing (${lagA} of 108 cells)`);
    out.DR1 = await caseRun('DR1', 'A', { code: 'STUCK', lag: lagA, want: h0.A });
    const s2 = await st();
    check(s2.repairedEvents === ev0 + 1 && s2.lastRepairedSite === ids.A && !(s2.suspects ?? []).some((x) => x.site === ids.A),
      `DR1: SITE_REPAIRED fired once for ${ids.A} (region ${s2.lastRepairedRegion}); suspects() no longer names it`);
    check(!(await api('sites')).all?.some((x) => x.id === ids.A), `DR1: ${ids.A} is not standing (released, not recovered)`);
    // DR2 (H-core): B's placement lost
    const lagB = await expectLag(BX.B, 'minecraft:air', false);
    check(lagB > 0, `DR2: B's placement lagging at ${lagB} of 216 cells (its chunks unsaved)`);
    out.DR2 = await caseRun('DR2', 'B', { code: 'LAGGING', lag: lagB, want: placedB, settles: false });
    // DR3 (F7): D (lower) first: written, kept until C; then C: both settle
    const dD = await diag(ids.D);
    const fD = (dD.findings ?? []).find((x) => x.code === 'STUCK' && x.site === ids.D);
    const stacked = (dD.findings ?? []).some((x) => x.code === 'STACKED');
    const rD = await repair(dD.planId, true);
    check(!!fD && fD.lagging > 0 && rD.applied && rD.written === fD.lagging, `DR3: D (lower) repaired first: wrote ${rD.written} of its ${fD?.lagging} lagging (STACKED reported: ${stacked})`);
    const dC = await diag(ids.C);
    const fC = (dC.findings ?? []).find((x) => x.code === 'STUCK' && x.site === ids.C);
    const dD2 = (await diag(ids.D)).findings?.find((x) => x.code === 'STUCK' && x.site === ids.D);
    check(!!dD2 && dD2.lagging === 0, `DR3: D stays pending with nothing lagging until C is repaired (the upper's values read D's later undo) (${json(dD2 && { lagging: dD2.lagging })})`);
    const rC = await repair(dC.planId, true);
    check(!!fC && rC.applied && rC.written === fC.lagging && /settled/.test(rC.message), `DR3: C repaired: wrote ${rC.written}; both settle (${rC.message})`);
    check(await hash(BX.D) === h0.D && await hash(BX.C) === h0.C, 'DR3: top-down: both boxes are as before both sites (the lower not cut)');
    const d3 = await rep('diagnose', { scope: { kind: 'all' } });
    check(!(d3.findings ?? []).some((x) => [ids.C, ids.D].includes(x.site)), `DR3: a second diagnose finds neither (${json((d3.findings ?? []).map((x) => [x.code, x.site]))})`);
    out.DR3 = { D: fD, C: fC, rD: rD.written, rC: rC.written };
    // DR6: E plus a player's block and a hand-changed cell, both in lagging cells
    const pX = XL - 2, pZ = 11342, hX = XL - 4, hZ = 11343;
    await call('dev.pt.breaks', { at: [[pX, y1, pZ]], placer: 'DRPlayer' }, 60_000);
    const pu = await call('dev.pt.uses', { ops: [{ item: 'minecraft:stone_bricks', at: [pX, y1, pZ], on: [pX, y1 - 1, pZ], face: 'up', placer: 'DRPlayer' }] }, 60_000);
    await cmd(`/setblock ${hX} ${y1} ${hZ} minecraft:glass`);
    const pt = await call('dev.pt.at', { at: [pX, y1, pZ] }, 10_000);
    check(!!pu.results?.[0]?.tracked || !!pt.placer, `DR6: a player's stone bricks at ${pX},${y1},${pZ} with a PT record (${json(pt)})`);
    const lagE = await expectLag(BX.E, 'minecraft:stone_bricks', true) - 1;
    out.DR6 = await caseRun('DR6', 'E', { code: 'STUCK', lag: lagE, foreign: 2, settles: false });
    const cE = await cellsOf([pX, y1, pZ, pX, y1, pZ]);
    const gE = await cellsOf([hX, y1, hZ, hX, y1, hZ]);
    check(isId([...cE.values()][0], 'minecraft:stone_bricks') && isId([...gE.values()][0], 'minecraft:glass'), `DR6: the player's block and the hand-changed glass are untouched (${[...cE.values()][0]}, ${[...gE.values()][0]})`);
    // DR9: B2 lagging, its removal queued: SITE_BUSY; null and non-op actors: PERMISSION
    const d9 = await diag(ids.B2);
    const f9 = (d9.findings ?? []).find((x) => x.code === 'LAGGING' && x.site === ids.B2);
    check(!!f9 && f9.lagging > 0, `DR9: B2 lagging at ${f9?.lagging}`);
    const pn = await repair(d9.planId, true, 'none');
    check(pn.refused === 'PERMISSION' && !pn.applied, `DR9: a null actor is refused PERMISSION (${pn.message})`);
    await cmd('/deop @s').catch(() => null);
    await L.settle(500);
    const po = await repair(d9.planId, true, 'player');
    await cmd('/op @s').catch(() => null);
    check(po.refused === 'PERMISSION' && !po.applied, `DR9: a non-op player is refused PERMISSION (${po.message})`);
    const pre9 = await hash(BX.B2);
    await call('dev.placement.slow', { on: true }, 10_000);
    const pending = api(`remove ${ids.B2} - noforce keep`);
    await L.sleep(300);
    const pb = await repair(d9.planId, true, 'player');
    const pbAt = await hash(BX.B2).catch(() => null);
    check(pb.refused === 'SITE_BUSY' && !pb.applied && pb.written === 0, `DR9: B2's removal queued: SITE_BUSY, nothing written (${pb.refused}: ${pb.message})`, { pre9, pbAt });
    const rm = await result(await pending, 600_000).catch((e) => ({ error: String(e) }));
    await call('dev.placement.slow', { on: false }, 10_000);
    log(`  DR9: B2's removal ${json(rm).slice(0, 200)}`);
    out.DR9 = { lagging: f9?.lagging, permissionNull: pn.refused, permissionNonOp: po.refused, busy: pb.refused };
    // DR10: F repaired with DRK1 armed: halts mid-repair; after the restart the open record is named and finished
    const dF = await diag(ids.F);
    const fF = (dF.findings ?? []).find((x) => x.code === 'STUCK' && x.site === ids.F);
    await rep('killAt', { armed: true });
    rep('repair', { planId: dF.planId, apply: true, actor: 'player' }).catch(() => null);
    check(await haltWait(), 'DR10: DRK1 halted the server mid-repair');
    await L.openWorld(W);
    await L.tp(XL + 0.5, gy + 40, 11400.5);
    const s10 = await started('DR10 restart');
    const recF = path.join(L.SAVES, W, 'architect-repairs', `${dF.planId}.json`);
    const open = fs.existsSync(recF) ? JSON.parse(fs.readFileSync(recF, 'utf8')) : null;
    check(open?.state === 'open', `DR10: the record ${dF.planId} is on disk, open (${open?.state})`);
    check((s10.suspects ?? []).some((x) => x.reason === 'repair_open' && x.site === dF.planId), `DR10: suspects() names the open repair (${json(s10.suspects)})`);
    const d10 = await rep('diagnose', { scope: { kind: 'all' } });
    check((d10.findings ?? []).some((x) => x.key === `repair:${dF.planId}`), `DR10: diagnose names the open repair ${dF.planId}`);
    const r10 = await repair(dF.planId, true);
    check(r10.applied && /settled/.test(r10.message) && await hash(BX.F) === h0.F, `DR10: the open repair finished from its record: wrote ${r10.written} more (of ${fF?.lagging}); F settled, the box = before (${r10.message})`);
    const fin = JSON.parse(fs.readFileSync(recF, 'utf8'));
    check(fin.state === 'final', `DR10: the record is final (${fin.state})`);
    out.DR10 = { lagging: fF?.lagging, finished: r10.written, record: fin.state };
    // DR11: a clean stop and start
    await L.leaveWorld();
    await L.openWorld(W);
    const s11 = await started('DR11 restart');
    check(!s11.opsLine && (s11.suspects ?? []).length === 0, `DR11: after a clean stop: no ops line, suspects() empty (${s11.opsLine}; ${json(s11.suspects)})`);
    out.DR11 = { opsLine: s11.opsLine, suspects: s11.suspects };
    await L.leaveWorld();
    return out;
  };

  async function groundAt(x, z) {
    const r = await call('dev.box.hash', { min: [x, -64, z], max: [x, 255, z], cells: true }, 120_000);
    let g = -64;
    for (const l of r.cells ?? []) {
      const sp = l.indexOf(' ');
      const y = Number(l.slice(0, sp).split(',')[1]);
      if (!isId(l.slice(sp + 1), 'minecraft:air') && y > g) g = y;
    }
    return g;
  }
}
