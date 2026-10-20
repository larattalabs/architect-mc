# Architect ↔ Steward sync

The shared view of what Architect ships, what Steward has adopted, and the agreed order. The coordinator keeps it current at each
release and after each sync. Contracts and as-builts stay in `docs/CONTRACT.md`; Steward's design stays in steward-mc
`docs/COMPOSITION.md`.

## Last sync: 2026-10-20 (Steward at steward-mc main f7acef1, on v0.37.1)

### Steward has shipped against Architect
- **Plan v0 (composition).** Claude writes a plan on describe (systemRef `plan/0#compact`), runs checkPlan, makes up to 2 repairs
  within $1, and keeps the plan with its pending parts.
- **Plan v1 (whole build).**
  - At Start: re-check with pending parts `required:false`, every street zone `orientation: "ew"` with rotate off, and lot ext.
  - Then: pin, design within the fitBox height, and the C37b `Entry.cells()` pre-check.
  - Then `realiseApproved`, with one stale retry under a second key that survives a restart.
- **PT / PT2.** Builds on the settlement screen, `/steward builds` (list, claim, release, adopt), and "add a floor" via `versionOf`.
- **C38 + K1-target.** The waiting-part offer: `planCatalogue()` at world start, then a one-part plan `wall.around {feature:
  {region}}`, realised and undone alone.
- **T3.** `load` bounded (512) whenever a plan holds a tunnel (composition, Start, stale re-check, offer); past the caps, the
  player is told where to stand.
- **H.** `farmPond` on homely farms; drained bodies reported from `architect_mc:fluids`.
- **Strange asks (2026-10-20).** The plan writer has rules for the 20 non-fitting parts (6 patterns): zones always have lots,
  terraces sit beside zones, bridges only over a real gap (treetop huts as `layout.elevated`), gates on their wall, water only
  where the land has it, reserved layouts written as such. It knows the live catalogue. Recorded plans are not re-recorded yet
  (paid; Noah's call).
- **D1 districts through plan v1** (a `program.districts` plan's lots are read, tagged, designed and realised).
- **North-south lots.** Front gains EAST/WEST, and plan v1 no longer falls back for east/west-facing lots. The town's own
  zone keeps `ew` with rotate off.
- **T3 `crossing.span` / `length` / `lands` on the card** (from the check's preview siteplan edges).

### Not started on Steward's side (none blocked on Architect)
- Steward's own districts on Architect's region districts and boundary districts (D2). Waits on D3 (D-S1, D-S3). Known limit: additions after a D1 build
  don't recognise `road:<district>_street_*` keys as a street, so they lay a fresh one.
- Plan v1 for Supplied builds (waits for RS); the offer in survival (RS).
- VOC: `BibleRequest.Rarity`, and `vocab/1` for the plan writer once VOC-c lands.

### Agreed order (Architect)
1. **Released 2026-10-19:** v0.37.1 patch (kit 0.35.1): even-width rope bridges and tunnels; malformed guards answer
   ARTIFACT_STALE. Old IRs go PLAN_STALE, so Steward re-checks. Steward checks it after release.
2. **Released 2026-10-20:** VOC, v0.38.0 (API 1.35.0, no RC): `BibleRequest.Rarity`, `vocab/1`, `VOCAB`, `cost.rarity` / `cost.creativeOnly`.
3. **Released 2026-10-20:** HY, v0.39.0, API 1.36.0 (Steward RC passed): channel.course / race / ditch, wall.water_gate, per-reach `architect_mc:fluids` rows.
3b. **Released 2026-10-20:** v0.39.1 patch (kit 0.37.1): KC, parts keep clear of fluid bodies (OVERLAP {kind: body}, M25:clear), plus the
   relief undo fix (restored flowing water gets a fluid tick). Old IRs go PLAN_STALE.
4. **Released 2026-10-20:** v0.40.0 (API 1.37.0, kit 0.38.0, catalogue 9, Steward RC passed): CU copper undo, IRR farm irrigation
   (`irrigate`, `$.lots[].irrigation`, `DesignRequest.reserved`), VOC-c `rule.palette` (`Regions.checkPalette`, `Reason.PALETTE`).
5. FL, F3, S3, RS (all frozen 2026-10-20 and building). FL and S3 ship with no RC (S3 after Noah's gallery approval); F3 and RS
   each get a Steward RC.
6. D3, districts beside a standing region town (Steward round 11: D-S1 join inside the town's claim to its street network,
   D-S3 land taken in the view ext, D-S4 dry beside check). Contract drafting; builds after FL merges. D-S2 (grow a district) is
   with 6d.
7. The 6c close-out.
8. D3 and 7a-1 (CL, K2, CW). 7a is frozen; Steward accepted every default.
9. 6d growth first (Noah, 2026-10-20, from Steward's ask): RV v3, additive-only revisions (add parts, lots, street extensions,
   new bodies; LIFO undo; never remove or change what stands), plus GR (towns and districts, D-S2). Full revisions (RV2) come
   later, with a better design.
10. 7a-2 (RK, LF, SA) and 7a-3 (K3, GJ, FB).
11. The rest of 6d: FS, LC (report), AD.
12. 7b, 7c.

### Open asks either way
- None blocking.
- For Noah: re-record Steward's recorded plans with the new plan-writer rules (paid). Steward is waiting on his go.
