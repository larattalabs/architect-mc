#!/usr/bin/env node
// Slice US gate (7c inverted builds; docs/CONTRACT.md "Phase 7c" §3 row 10, "Slice US as built") against the headless server of the run
// worktree (GATE6B_RUN; the sim sidecar, no Claude). $0.
//
//   node tools/gate7cus.mjs survival   (us-survival) the inverted house `fit_suspend_inverted` (bp.invert(); kit/designs/site) on the 7bF
//                                       fixture `overhang`'s land, built in the world from the frozen volume (a sculpted overhang: an
//                                       OVERHANG made by a region's own forms can't host a site lot, the land being read before the plan),
//                                       through SO's survival flow (tools/gate7bso.mjs survival with GATE7BSO_HOUSES): Sites.place with its
//                                       site in construction mode in a survival world, fed from a hopper chain on its crate: a) a partial
//                                       build deconstructed with its scaffolding standing (every item back, no scaffolding item, E-flat 0);
//                                       b) the full build in SO's support order from the ceiling anchors, the built set recorded every 100
//                                       cells and each record connected to the rock by an independent scan over the fixture volume's
//                                       classes (every prefix connected), a save/quit/reload half way, built: the scaffolding down,
//                                       items in = items out, deconstructed: every item back and E-flat 0; c) identical to its INSTANT
//                                       placement (the inverted house placed) and that placement's Remove exact (removed, E-flat 0).
//
// Evidence: artifacts/gate7c-us/survival.json in the main checkout (GATE7CUS_OUT overrides), all.log, spend.json ($0.00).
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.GATE7BSO_HOUSES = 'fit_suspend_inverted:overhang';
process.env.GATE7BSO_OUT = process.env.GATE7CUS_OUT ?? process.env.GATE7BSO_OUT ?? path.join(path.resolve(here, '..', 'architect-mc'), 'artifacts', 'gate7c-us');
const step = process.argv[2];
if (step !== 'survival' && step !== 'report') { console.error('usage: node tools/gate7cus.mjs survival|report'); process.exit(2); }
await import('./gate7bso.mjs');
