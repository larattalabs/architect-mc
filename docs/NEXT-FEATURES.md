# Architect: next features (planning pass, main 1aa754f4, v0.47.0, API 1.42.0 / kit 0.43.0 / catalogue 14)

Cites: C = docs/CONTRACT.md, P = docs/PLAN.md, SS = docs/STEWARD-SYNC.md, S = docs/SETTLEMENTS.md.
All sizes are the frozen contracts' own day counts (work days, one builder). The contracts were frozen 2026-10-20 at main f3f41d43; as-builts of CL/K2/CW/D3 win where they differ.

## Scope note first
"7a" is now the **connector set only** (N-7a-1 yes, C:20028). Affordances, site lots, the link pass, `nav.json`/`seconds`/`risk`, `steward` mover, M15, S4 ravine town moved to **7b** or an unscheduled "nav slice" (C:19871-19890, S-7a-6 C:20003). So "settlement graph work" in the S:73 sense is NOT in the remaining 7a. Done: foundation, CW, CL, K2 (C:20222-20587, merges 2b23af64, 36badab7, 23235708), D3 (C:24566).

## (a) Remaining 7a slices, in order (C:19891-19925 table, batches 7a-2 and 7a-3)
All are unblocked now: F3 (SA's hosts), K2 (K3), D3 (GJ) have merged; the 6c close-out that gated 7a's merge is in (C:19909-19913).

| # | Slice | Player sees | Size | Depends on | Steward RC? |
|---|---|---|---|---|---|
| 1 | **SA** spirals (`connector.stairs_around`, C:21035) **built on `slice/SA` (2026-10-26), ready to merge; as built C "Phase 7a slice SA as built"** | A spiral stair round a rock spire, ice spike, giant tree or mushroom up to a railed lookout | M (1.25 d) | F3 (done) | No |
| 2 | **RK** rock stairs (C:20724) | A straight stair flight carved or bored into a hillside, lined and lit | M (1.5-2 d; Java `hasVolume`) | T3b bore (done) | No |
| 3 | **LF** lifts (C:20861) | Bubble-column lift tower against a cliff face (airlock doors, sea lanterns); player-only | L (2.5 d) | none | **Yes** (global StillOurs row, new fluids-stage body; C:20865, C:19898) |
| 4 | **K3** wall lots (C:21162) **built on `slice/K3` (2026-10-26), waits for Steward's RC (docs/HANDOFF-K3.md); as built C "Phase 7a slice K3 as built"** | Towers on wall corners, gatehouses straddling a gate with a passage; closure re-checked when the lot binds | L (2.5 d) | K2 (done) | **Yes** (new `realiseApproved` refusal, Steward binds these lots) |
| 5 | **GJ** gate joins (C:21357) | A new district beside a walled town joins through a standing gate (fixes D3's `NO_JOIN [wall]`) | M (1.5 d; Java) | D3 (done) | **Yes** (removal both orders, as D3) |
| 6 | **FB** flood behaviour (M16, C:21504) | Warning only: barriers thinner than 2 under a water surface; no visible change | S (0.75 d, kit only) | best after LF (exception list) | No |

Totals: about 10.5 days of work (C:19919 says batch total ~15.5 incl. 7a-1). Two Steward RCs: LF (batch 7a-2) and K3+GJ (batch 7a-3) (C:19918-19923). Left out by design: `rail` (`until: CR`, sketch C:21543), `branch_walk` (7b).
Carry-ins worth bundling into K3: "routes joining gate landings" (P:1157-1177) and the T2 self-crossing retry (P:1195); K3's gate approach is the natural home for a T2 gate-approach special move.

## (b) 6d (region evolution), as frozen (C:21564-21700)
Noah's option A (2026-10-20): **growth first**, additive only; removing/changing standing parts is RV2, a design record, not a slice (C:21572, C:22960). RP (realised provenance) is already in (v0.40.1, C:23465).
- **RV v3** additive revisions: new parts/lots/refills/street extensions/bodies layered over a standing region, head + manifest + LIFO `undoRevision`, additive survival. **L+ (7.5-8.5 d work, ~4.5 elapsed, 4 lanes RV-a..d)**; deps RP (done), D3 (done); RC (C:21590 row).
- **GR** grow a standing region (D-S2: new lots, then a street extension; `growDistrict`; `land` v2). **L (4.5-5.5 d, 3 elapsed)**; needs RV's interface (freezes end of RV-b day 2; GR-a can start then); shares RV's single RC.
- **FS** updates follow the source (a new design version offered to its COPY/SITE followers, $0). **S-M (2-2.5 d)**; independent, any time; no RC.
- **LC** land-change report (`Regions.landCheck`, read-only). **S-M (1.5-2 d)**; after RV; no RC.
- **AD** adopt a VillageLayout settlement as a region (C12's 6d half, lazy at first growth per Steward). **L (4-4.5 d)**; after GR and a 7a link pass; RC (C:21588-21600, C:21690). Note: "link pass" moved to 7b (C:19876), so AD's dependency needs re-checking.
- Deferred: pad delta under standing lots, Sites-level deltas (C:21622); incremental replanning of stages on land change (LC defers it, S:842-858).
Growth = RV + GR (12-14 d work, ~7 elapsed, one RC). FS/LC/AD later batch (~7.5-9 d).

## (c) GM, gate mechanisms (P:1125-1153)
Comes **after K3** (the gatehouse is the host, P:1127), and in practice after GJ so a gate is a joined gate. Not yet a contract. Scope: a piston portcullis, piston drawbridge over a moat/ditch (needs H/HY water), lever/button double doors, redstone-lit gate lamps, pressure-plate sally port. Contract must settle: who opens it and whether villager paths treat closed pistons as passable (vanilla villagers open doors, not pistons), default state, survival bill (pistons, repeaters, observers), journal/undo of piston and powered states, nav through open vs closed, mob sealing, per-bible look, a Steward offer ("add a portcullis"). Gate: in-game open/close cycles, exact undo with pistons extended and retracted, villagers through open gate, survival BOM. Size not estimated: likely L (about 3 d) plus a contract draft, and an RC (changes what a gatehouse contains). `connector.drawbridge` is already reserved `until: mechanism` (C:13368, C:14084), so GM is the slice that unlocks Steward's redstone_gate drawbridge part.

## (d) Recommended sequence (max 3-4 lanes, GATES policy 6: 3 gate runs machine-wide, C:19930)
Noah asked for 7a before growth. The Steward-agreed order (SS:60-62) runs RV+GR *between* 7a-1 and 7a-2/3. I follow Noah's order but start the long pole early.

1. **Wave 1 (parallel, 3 lanes):** SA, RK, LF. One release; one Steward RC (LF). Noah sees: spiral gallery (N-SA-1, C:21159), rock-stair portal/interior (N-RK-1, C:20858), lift tower in 3 bibles (N-LF-1, C:21031).
2. **Wave 2 (3 lanes):** K3, GJ, FB (FB tiny, rides along). One release; one RC (K3+GJ). Noah sees: castle with towers and gatehouse in 3 bibles (N-K3-1, C:21353); a district joining a walled town through its gate.
3. **Wave 3: RV-a + RV-b start** (can start during wave 2 once a slot frees; RV-a is pure kit). Then RV-c/RV-d on the frozen interface, then GR. Noah sees mostly proofs, not looks, until GR: a grown street (N-GR-1) and new lots nearest the square (N-GR-2), C:22582-22583.
4. **Wave 4:** GM contract drafted in parallel with wave 2/3 (docs-only, no slot); GM builds after K3/GJ merge. Noah sees: the gate in action (portcullis cycle) in the gallery.
5. FS (own slot, any time a lane is idle), then LC, then AD.
Next ~6 slices in order: SA, RK, LF | K3, GJ, (FB) | RV v3 | GR | GM | FS.

## (e) Open decisions for Noah
1. **Order.** Run all of 7a (wave 1-2) before RV+GR, as you asked (this plan), or keep the Steward-agreed interleave 7a-1, RV+GR, 7a-2/3 (SS:60-62; C:21586-21589)? Steward expects the latter and is waiting on growth (it asked for D-S2); 7a-2/3 has no Steward consumer yet.
2. **Scope of "typed connectors / settlement graph".** Remaining 7a is only the six connector slices; the nav slice (`seconds`, `risk`, `nav.json`, steward mover, S-7a-6 C:20003) and affordances/site lots/link pass (7b) are not scheduled. Do you want a nav slice pulled forward after wave 2, or leave it until Steward's villager phase asks?
3. **M8 as an error** (fall protection, S-7a-7, C:20008): FB will count plans that would lose READY; decide promote-or-stay-warning at the release tier, or defer.
