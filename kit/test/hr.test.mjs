// (7c HR, docs/CONTRACT.md "Phase 7c" §3 row 3 and "Slice HR as built") Hidden rooms: form.hidden_room supported; a room behind a
// concealed entrance in each host (a hollow mountain, a waterfall, a building's lot: the builder-written examples fixtures/plan/hr/x01-x03,
// checked clean); the entrance only in the artifact's $.secrets[] (never in an answer, a preview or siteplan.json); survival (the hollow
// free, the entrance a construction target); the refusals; the recorded asks hidden_village and secret_tunnels re-planned.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { planCatalogue, planCatalogueKinds } from '../lib/plan/catalogue.mjs';
import { PLAN_SCHEMA, validatePlan } from '../lib/plan/schema.mjs';
import { checkRegion } from '../lib/region/check.mjs';
import { buildVirtual } from '../lib/region/vworld.mjs';
import { renderPreviews } from '../lib/region/preview.mjs';
import { themeOffenders } from '../lib/lint/theme.mjs';
import { ROOM, roomSize, trapdoorOf } from '../lib/forms/hiddenRoom.mjs';
import { asksSurvey, checkPlanVolumes, flatSurvey, stewardAnchors } from './plan-helpers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(HERE, 'fixtures', 'plan', 'hr');
const ASKS = path.join(HERE, 'fixtures', 'plan', 'asks');
const fixture = (n) => JSON.parse(fs.readFileSync(path.join(FIX, `${n}.json`), 'utf8'));
const clone = (o) => JSON.parse(JSON.stringify(o));

async function planFx(fx, { survival = false } = {}) {
  const s = flatSurvey(fx.terrain ?? {});
  const r = await checkPlanVolumes(fx.plan, { survey: s.bytes, claim: s.claim, anchors: stewardAnchors(s.claim), volume: fx.volume ?? {}, ...(survival ? { survival: true } : {}) });
  const blobs = (sha) => r.res.blobs.get(sha) ?? null;
  const volumes = r.volumes.map((v) => v.decoded);
  return { ...r, s, blobs, volumes, report: () => checkRegion({ ir: r.res.ir, survey: s.bytes, blobs, meta: r.res.meta, volumes }), world: () => buildVirtual({ ir: r.res.ir, survey: s.bytes, blobs, volumes }).vw };
}
const partOf = (r, id) => r.check.parts.find((a) => a.part === id);
const errors = (rep) => rep.findings.filter((f) => f.severity === 'error').map((f) => `${f.rule} ${f.part}: ${f.message}`);
const at = (vw, x, y, z) => vw.pal.states[vw.get(x, y, z)];
const inBox = ([x, y, z], b) => x >= b[0] && x <= b[3] && y >= b[1] && y <= b[4] && z >= b[2] && z <= b[5];

test('catalogue: form.hidden_room supported with its def and limits, sinceApi NEXT (or stamped), no until; served on demand', () => {
  const e = planCatalogue().entries.find((x) => x.id === 'form.hidden_room');
  assert.equal(e.state, 'supported');
  assert.equal(e.until, undefined);
  assert.ok(e.sinceApi === 'NEXT' || /^\d+\.\d+\.\d+$/.test(e.sinceApi));
  assert.deepEqual(e.limits.size, [ROOM.min, ROOM.max]);
  assert.deepEqual(e.limits.entrances.slice().sort(), ['bookshelf', 'trapdoor', 'wall', 'waterfall']);
  const raw = PLAN_SCHEMA['x-catalogue'].entries.find((x) => x.id === 'form.hidden_room');
  assert.equal(raw.def, '#/$defs/form.hidden_room');
  assert.equal(raw.draft, undefined);
  const def = PLAN_SCHEMA.$defs['form.hidden_room'];
  assert.equal(def['x-state'], undefined);
  assert.equal(def.additionalProperties, false);
  assert.deepEqual(def.required, ['id', 'kind', 'host']);
  const k = planCatalogueKinds(['form.hidden_room']);
  assert.ok(k.entries[0].def && !k.entries[0].def['x-state']);
});

test('schema: strict (unknown member, size past its limits, no host: malformed); host a dependency (an unknown one malformed); sizes', () => {
  const mk = (f, extra = {}) => validatePlan({ schemaVersion: 'plan/0', planId: 't', forms: [{ id: 'h', kind: 'hollow_mountain' }, { id: 'r', kind: 'hidden_room', ...f }], ...extra });
  const v = (f, extra) => mk(f, extra).parts.find((p) => p.id === 'r');
  assert.equal(v({ host: 'h', entrance: 'wall', params: { x: 1 } }).verdict, 'compile');
  assert.deepEqual(v({ host: 'h' }).deps, ['h'], 'the host is a dependency');
  assert.equal(v({ host: 'h', colour: 'red' }).verdict, 'malformed');
  assert.equal(v({ entrance: 'wall' }).verdict, 'malformed');
  assert.equal(v({ host: 'h', size: { w: 16, d: 5 } }).verdict, 'malformed');
  assert.equal(v({ host: 'h', size: { w: 5, d: 2 } }).verdict, 'malformed');
  assert.equal(v({ host: 'nowhere' }).verdict, 'malformed');
  assert.equal(v({ host: 'h', entrance: 'portal' }).verdict, 'malformed');
  // a lot as host: its zone is the dependency
  const z = { zones: [{ id: 'town', program: { lots: [{ id: 'c1', type: 'cottage', size: [9, 9] }] } }] };
  assert.deepEqual(v({ host: 'c1' }, z).deps, ['town']);
  // a host outside the plan (<planId>@<n>#<part>) is no dependency (refused at compile)
  assert.equal(v({ host: 'other@3#tower' }).verdict, 'compile');
  assert.deepEqual(roomSize({}), [5, 5, 3]);
  assert.deepEqual(roomSize({ size: { preset: 'L' } }), [9, 9, 4]);
  assert.deepEqual(roomSize({ size: { w: [4, 6], d: 3 } }), [6, 3, 3]);
  assert.equal(trapdoorOf({ trim: 'minecraft:oak_planks' }), 'minecraft:oak_trapdoor');
  assert.equal(trapdoorOf({ wall: 'minecraft:iron_block' }), 'minecraft:spruce_trapdoor', 'never an iron trapdoor (it needs redstone)');
});

test('x01 a hidden room in a hollow mountain: fits; the room carved off the cavern wall, lit, behind its wall (the rock it is cut from); checks clean', async () => {
  const r = await planFx(fixture('x01_mountain_room'));
  assert.equal(r.check.overall, 'READY');
  const a = partOf(r, 'vault');
  assert.equal(a.class, 'fits', JSON.stringify(a.reasons));
  assert.equal(a.geometry, undefined, 'no geometry in the answer');
  assert.deepEqual(errors(r.report()), []);
  const [sec] = r.artifact.secrets;
  assert.deepEqual(Object.keys(sec).sort(), ['entrance', 'host', 'part', 'room']);
  assert.equal(sec.part, 'vault'); assert.equal(sec.host, 'hold'); assert.equal(sec.entrance.kind, 'wall');
  const vw = r.world();
  const [x0, y0, z0, x1, y1, z1] = sec.room;
  assert.equal((x1 - x0 + 1) * (z1 - z0 + 1), 25);
  for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) for (let y = y0; y <= y1; y++) assert.equal(at(vw, x, y, z), 'minecraft:air', `${x},${y},${z}`);
  let lights = 0;
  for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) if (at(vw, x, y0 - 1, z) === 'minecraft:shroomlight') lights++;
  assert.ok(lights >= 1);
  // the doorway: the host's rock, twice; behind it the room, in front the cavern's air
  const [ex, ey, ez] = sec.entrance.cell;
  assert.equal(at(vw, ex, ey, ez), at(vw, ex, ey + 1, ez));
  assert.ok(/stone|deepslate|rock/.test(at(vw, ex, ey, ez)), at(vw, ex, ey, ez));
  const hold = partOf(r, 'hold').geometry;
  assert.ok(ey >= hold.floorY && ey <= hold.floorY + 3);
  // the shell: every cell round the room the host's (no other way in)
  for (let x = x0 - 1; x <= x1 + 1; x++) for (let z = z0 - 1; z <= z1 + 1; z++) for (let y = y0 - 1; y <= y1 + 1; y++) {
    if (inBox([x, y, z], sec.room) || (x === ex && z === ez && (y === ey || y === ey + 1))) continue;
    assert.notEqual(at(vw, x, y, z), 'minecraft:air', `shell ${x},${y},${z}`);
  }
  // the bookshelf variant: two bookshelves in the doorway
  const b = clone(fixture('x01_mountain_room'));
  b.plan.forms[1].entrance = 'bookshelf';
  const rb = await planFx(b);
  assert.equal(partOf(rb, 'vault').class, 'fits');
  const [bx, by, bz] = rb.artifact.secrets[0].entrance.cell;
  const vb = rb.world();
  assert.equal(at(vb, bx, by, bz), 'minecraft:bookshelf');
  assert.equal(at(vb, bx, by + 1, bz), 'minecraft:bookshelf');
  // deterministic
  const again = await planFx(fixture('x01_mountain_room'));
  assert.equal(again.res.irSha, r.res.irSha);
});

test('x01 with three halls (no free side of the cavern): the room goes off a hall\'s side wall', async () => {
  const f = clone(fixture('x01_mountain_room'));
  f.plan.forms[0].halls = 3;
  const r = await planFx(f);
  assert.equal(partOf(r, 'vault').class, 'fits', JSON.stringify(partOf(r, 'vault').reasons));
  assert.deepEqual(errors(r.report()), []);
});

test('x02 the hollow behind a waterfall: fits; the doorway open behind the falling water, the room under the header pool; checks clean (M25)', async () => {
  const r = await planFx(fixture('x02_waterfall_hollow'));
  assert.equal(r.check.overall, 'READY');
  const a = partOf(r, 'hollow');
  assert.equal(a.class, 'fits', JSON.stringify(a.reasons));
  assert.ok(partOf(r, 'falls').notes.some((n) => /its own part \(form\.hidden_room hollow\)/.test(n)));
  assert.equal((partOf(r, 'falls').deviations ?? []).length, 0);
  assert.deepEqual(errors(r.report()), []);
  const [sec] = r.artifact.secrets;
  assert.equal(sec.entrance.kind, 'waterfall');
  const vw = r.world();
  const [ex, ey, ez] = sec.entrance.cell;
  assert.equal(at(vw, ex, ey, ez), 'minecraft:air');
  assert.equal(at(vw, ex, ey + 1, ez), 'minecraft:air');
  // the curtain: water falls one cell out from the doorway (the pool's spill over the doorway's row)
  const ops = r.res.ir.parts.flatMap((p) => p.ops).filter((o) => o.op === 'fluid');
  const spill = new Set(ops.flatMap((o) => (o.predicted ?? []).map(([x, y, z]) => `${x},${y},${z}`)));
  const out = [[1, 0], [-1, 0], [0, 1], [0, -1]].filter(([dx, dz]) => spill.has(`${ex + dx},${ey},${ez + dz}`));
  assert.equal(out.length, 1, 'the falling water stands right outside the doorway');
  // asked bigger than the outcrop holds: shrunk (adjusted, a size deviation: S's 5x5 to 5x3 loses 40%, past 25, under the ceiling 50)
  const big = clone(fixture('x02_waterfall_hollow'));
  big.plan.forms[1].size = { preset: 'S' };
  const rb = await planFx(big);
  const ab = partOf(rb, 'hollow');
  assert.equal(ab.class, 'adjusted', JSON.stringify(ab));
  assert.ok(ab.deviations.some((d) => d.what === 'size' && d.value === 40));
  // past the ceiling (M's 7x7 to 5x3): refused TOLERANCE
  const huge = clone(fixture('x02_waterfall_hollow'));
  huge.plan.forms[1].size = { preset: 'M' };
  const ah = partOf(await planFx(huge), 'hollow');
  assert.equal(ah.class, 'refused');
  assert.equal(ah.reasons[0].code, 'TOLERANCE');
  // the default drop (6): a room 2 high (fits: the floor is as asked, the height noted)
  const six = clone(fixture('x02_waterfall_hollow'));
  six.plan.forms[0].drop = 6;
  const a6 = partOf(await planFx(six), 'hollow');
  assert.equal(a6.class, 'fits', JSON.stringify(a6));
  assert.ok(a6.notes.some((n) => /2 high \(asked 5x3, 3 high\)/.test(n)), JSON.stringify(a6.notes));
  // a drop too short for any room under the pool: refused NO_ROOM, naming the drop it needs
  const low = clone(fixture('x02_waterfall_hollow'));
  low.plan.forms[0].drop = 5;
  const rl = await planFx(low);
  const al = partOf(rl, 'hollow');
  assert.equal(al.class, 'refused');
  assert.equal(al.reasons[0].code, 'NO_ROOM');
  assert.match(al.reasons[0].message, /drop of 6/);
});

test('x03 a hidden cellar under a building: fits; under the lot\'s box (two layers left), the hatch beside it flush with the ground, a ladder down', async () => {
  const r = await planFx(fixture('x03_cellar'));
  assert.equal(r.check.overall, 'READY');
  assert.equal(partOf(r, 'cellar').class, 'fits', JSON.stringify(partOf(r, 'cellar').reasons));
  assert.deepEqual(errors(r.report()), []);
  const [sec] = r.artifact.secrets;
  assert.equal(sec.entrance.kind, 'trapdoor');
  const lot = r.artifact.lots.find((l) => l.id === 'cottage_1');
  const [bx0, by0, bz0, bx1, , bz1] = lot.box;
  const [, ry0, , , ry1] = sec.room;
  assert.equal(ry1, by0 - 1 - ROOM.roof, 'the room\'s top under the floor\'s two layers');
  assert.ok(ry0 < ry1);
  const [hx, hy, hz] = sec.entrance.cell;
  assert.ok(hx < bx0 || hx > bx1 || hz < bz0 || hz > bz1, 'the hatch is outside the lot\'s box');
  for (const l of r.artifact.lots) assert.ok(!(hx >= l.box[0] && hx <= l.box[3] && hz >= l.box[2] && hz <= l.box[5]), `not in ${l.id}'s box`);
  const vw = r.world();
  assert.match(at(vw, hx, hy, hz), /_trapdoor\[.*half=top.*open=false/);
  assert.ok(!/iron/.test(at(vw, hx, hy, hz)));
  assert.equal(at(vw, hx, hy + 1, hz), 'minecraft:air');
  for (let y = ry0; y < hy; y++) assert.match(at(vw, hx, y, hz), /^minecraft:ladder/, `ladder at ${y}`);
});

test('S-THEME: every block x01-x03 write outside their lots traces to a role or is natural; a bookshelf entrance\'s own two cells exempt, a bookshelf elsewhere still warns', async () => {
  for (const n of ['x01_mountain_room', 'x02_waterfall_hollow', 'x03_cellar']) {
    const r = await planFx(fixture(n));
    assert.deepEqual(themeOffenders(r.res.ir, r.world(), { meta: r.res.meta }).offenders, [], n);
  }
  const b = clone(fixture('x01_mountain_room'));
  b.plan.forms[1].entrance = 'bookshelf';
  const rb = await planFx(b);
  const vw = rb.world();
  // the entrance's two cells (recorded in its door part's meta) are exempt: no offender; the structure lint reads the same meta
  assert.deepEqual(themeOffenders(rb.res.ir, vw, { meta: rb.res.meta }).offenders, []);
  assert.deepEqual(rb.report().findings.filter((f) => f.rule === 'S-THEME').map((f) => f.message), []);
  // without the meta (or with the cells one over), the same bookshelves warn: nothing but those two cells is exempt
  const off = (m) => themeOffenders(rb.res.ir, vw, { meta: m }).offenders.map((o) => `${o.block} ${o.count}`);
  assert.deepEqual(off(null), ['minecraft:bookshelf 2']);
  const moved = clone(rb.res.meta);
  for (const m of Object.values(moved.parts)) if (m.entranceCells) m.entranceCells = m.entranceCells.map(([x, y, z]) => [x + 1, y, z]);
  assert.deepEqual(off(moved), ['minecraft:bookshelf 2'], 'a bookshelf at any other cell still warns');
});

test('secrets: the entrance and the room only in the artifact\'s $.secrets[]; never in the answers, the preview, the class map or siteplan.json; the renders as without the room', async () => {
  for (const [n, id] of [['x01_mountain_room', 'vault'], ['x02_waterfall_hollow', 'hollow'], ['x03_cellar', 'cellar']]) {
    const fx = fixture(n);
    const r = await planFx(fx);
    const [sec] = r.artifact.secrets;
    const cell = sec.entrance.cell.join(',');
    const json = JSON.stringify(r.check).replaceAll(' ', '');
    assert.ok(!json.includes(`[${cell}]`), `${n}: the entrance cell is not in the check`);
    assert.ok(!json.includes(JSON.stringify(sec.room)), `${n}: the room box is not in the check`);
    assert.equal(r.check.preview.bounds[id], undefined);
    assert.ok(!JSON.stringify(r.artifact.parts).includes(`[${cell}]`), `${n}: nor in the artifact's parts`);
    // the previews (a plan dir: the kit's preview over the IR and its meta, as the sidecar runs it)
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hr-'));
    try {
      const out = renderPreviews({ ir: r.res.ir, survey: r.s.bytes, blobs: r.blobs, volumes: r.volumes, meta: r.res.meta, views: ['top', 'iso', 'siteplan'], outDir: dir });
      const sp = fs.readFileSync(out.sitePlanFile, 'utf8');
      assert.ok(!sp.includes(`f_${id}`), `${n}: the room's parts are not in siteplan.json`);
      assert.ok(!sp.includes(`[${cell}]`) && !sp.includes(sec.entrance.cell.join(', ')), `${n}: nor its entrance`);
      // the same IR with the room's parts taken out (and no secret marks) renders the same pixels: the room is left out, not drawn over
      const secretIds = new Set(Object.entries(r.res.meta.parts).filter(([, m]) => m.secret).map(([k]) => k));
      assert.ok(secretIds.has(`f_${id}`));
      const bareIr = { ...r.res.ir, parts: r.res.ir.parts.filter((q) => !secretIds.has(q.id)) };
      const bareMeta = clone(r.res.meta);
      for (const k of secretIds) delete bareMeta.parts[k];
      const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'hr-'));
      try {
        const o2 = renderPreviews({ ir: bareIr, survey: r.s.bytes, blobs: r.blobs, volumes: r.volumes, meta: bareMeta, views: ['top', 'iso'], outDir: dir2 });
        assert.equal(out.pixels['top.png'], o2.pixels['top.png'], `${n}: top as without the room`);
        assert.equal(out.pixels['iso.png'], o2.pixels['iso.png'], `${n}: iso as without the room`);
      } finally { fs.rmSync(dir2, { recursive: true, force: true }); }
      // the discriminator: the cellar's hatch shows from the top when the meta's secret marks are dropped
      if (n === 'x03_cellar') {
        const meta = clone(r.res.meta);
        for (const m of Object.values(meta.parts)) delete m.secret;
        const dir3 = fs.mkdtempSync(path.join(os.tmpdir(), 'hr-'));
        try {
          const o3 = renderPreviews({ ir: r.res.ir, survey: r.s.bytes, blobs: r.blobs, volumes: r.volumes, meta, views: ['top', 'siteplan'], outDir: dir3 });
          assert.notEqual(o3.pixels['top.png'], out.pixels['top.png'], 'unmarked, the hatch would show');
          assert.ok(fs.readFileSync(o3.sitePlanFile, 'utf8').includes(`f_${id}`));
        } finally { fs.rmSync(dir3, { recursive: true, force: true }); }
      }
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
  // a plan without a hidden room: no secrets member (its artifact as before)
  const r0 = await planFx({ plan: { schemaVersion: 'plan/0', planId: 'none', forms: [{ id: 'hold', kind: 'hollow_mountain', where: { inside: { claim: true } } }] } });
  assert.equal(r0.artifact.secrets, undefined);
});

test('survival: the hollow free (the free pass), the entrance its own construction target (its bill); a waterfall\'s hollow free whole', async () => {
  const m = await planFx(fixture('x01_mountain_room'), { survival: true });
  const sv = partOf(m, 'vault').cost.survival;
  assert.ok(sv.free > 0 && sv.held === 0, JSON.stringify(sv));
  assert.deepEqual(sv.entrance.bom, sv.bom);
  assert.equal(Object.values(sv.bom).reduce((a, b) => a + b, 0), 2, 'the walled doorway: two blocks of the host\'s rock');
  assert.ok(m.res.ir.survival.groups.includes('vault:entrance') && m.res.ir.survival.groups.includes('vault'));
  assert.deepEqual(partOf(m, 'hold').cost.survival.bom, {}, 'the mountain still bills nothing');
  const c = await planFx(fixture('x03_cellar'), { survival: true });
  const cs = partOf(c, 'cellar').cost.survival;
  assert.ok(cs.free > 0 && cs.held === 0);
  const items = Object.keys(cs.bom);
  assert.ok(items.includes('minecraft:ladder') && items.some((i) => /_trapdoor$/.test(i)), JSON.stringify(cs.bom));
  const w = await planFx(fixture('x02_waterfall_hollow'), { survival: true });
  const ws = partOf(w, 'hollow').cost.survival;
  assert.deepEqual(ws.bom, {});
  assert.ok(ws.free > 0 && ws.held === 0 && ws.entrance === undefined);
});

test('refusals: an entrance the host does not give (NO_FEATURE, wouldFit with its own); a host that is not one; a host outside the plan; a blocked host', async () => {
  const base = fixture('x01_mountain_room');
  const a = clone(base); a.plan.forms[1].entrance = 'trapdoor';
  const ra = await planFx(a);
  const pa = partOf(ra, 'vault');
  assert.equal(pa.class, 'refused'); assert.equal(pa.reasons[0].code, 'NO_FEATURE');
  assert.equal(pa.wouldFit[0].fragment.entrance, 'wall');
  assert.equal(ra.artifact?.secrets, undefined);
  const b = clone(base); b.plan.forms[0] = { id: 'hold', kind: 'crater', where: { inside: { claim: true } } };
  const pb = partOf(await planFx(b), 'vault');
  assert.equal(pb.class, 'refused'); assert.equal(pb.reasons[0].code, 'NO_FEATURE');
  const c = clone(base); c.plan.forms[1].host = 'old_town@2#keep';
  const pc = partOf(await planFx(c), 'vault');
  assert.equal(pc.class, 'refused'); assert.match(pc.reasons[0].message, /outside this plan/);
  const d = clone(base); d.plan.forms[0].size = { w: 200, d: 200 };
  const rd = await planFx(d);
  assert.equal(partOf(rd, 'vault').class, 'blocked');
});

test('the recorded asks: hidden_village and secret_tunnels re-planned as recorded, and each with a hidden room added', async () => {
  const s = asksSurvey();
  const plan = (f) => JSON.parse(fs.readFileSync(path.join(ASKS, `${f}.json`), 'utf8')).answer.plan;
  const run = (p) => checkPlanVolumes(p, { survey: s.bytes, claim: s.claim, anchors: stewardAnchors(s.claim), volume: {} });
  // hidden_village as recorded: its hollow is a village zone (a cavern behind the falls is lots on a region-made form: the BF follow-up),
  // and the waterfall's own words ask for the hollow: still adjusted, the deviation now naming the part kind that builds it
  const hv = await run(plan('hidden_village'));
  const wf = partOf(hv, 'waterfall_curtain');
  assert.equal(wf.class, 'adjusted');
  const dv = wf.deviations.find((x) => x.kind === 'hollow');
  assert.equal(dv.block, 'form.hidden_room'); assert.equal(dv.until, undefined); assert.match(dv.note, /hosted by this waterfall/);
  // with a hidden room hosted by the waterfall
  const hv2 = clone(plan('hidden_village'));
  hv2.forms.push({ id: 'falls_hollow', kind: 'hidden_room', host: 'waterfall_curtain', entrance: 'waterfall' });
  const rh = await run(hv2);
  // (its waterfall the default drop, 6: the hollow 2 high; its floor 5x3 of S's 5x5, 40% less: adjusted)
  const ah = partOf(rh, 'falls_hollow');
  assert.equal(ah.class, 'adjusted', JSON.stringify(ah));
  assert.equal(partOf(rh, 'waterfall_curtain').deviations, undefined, 'the waterfall: its hollow is a part now, no deviation');
  // secret_tunnels as recorded: its tunnels are tunnel.under between site lots' cellar doors (LP): still refused NO_FEATURE (its lots
  // are street lots with no cellar door)
  const st = await run(plan('secret_tunnels'));
  for (const id of ['tunnel_cellar', 'tunnel_dock', 'tunnel_hatch']) assert.equal(partOf(st, id).reasons[0].code, 'NO_FEATURE', id);
  // with the tavern's hidden cellar (the hatch the brief asks for): fits
  const st2 = clone(plan('secret_tunnels'));
  st2.forms = [{ id: 'tavern_cellar', kind: 'hidden_room', host: 'tavern_1', entrance: 'trapdoor' }];
  const rs = await run(st2);
  assert.ok(['fits', 'adjusted'].includes(partOf(rs, 'tavern_cellar').class), JSON.stringify(partOf(rs, 'tavern_cellar')));
});
