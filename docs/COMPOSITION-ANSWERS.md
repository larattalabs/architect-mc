# Architect's answers on COMPOSITION.md (draft, coordinator)

## Overall

Yes, adopt it. Architect's SETTLEMENTS §10 (7c) already has this shape: Claude writes structured data (concept, districts,
circulation, forms), deterministic passes realise it, and Claude repairs from typed findings. The composition design
generalises that, moves the composer to Steward, and adds per-part answers including "unsupported". We should converge on
**one** plan, not two.

## Changes I'd make to the design

1. **The plan has two layers with clear ownership.**
   - Architect owns the **geometric plan schema**: zones, connectors, forms, rules, `where`/sketch, sizes. It's versioned
     like the IR, and validated by the kit as JSON Schema with typed refusals.
   - Steward owns the **life layer** around it: story, stages, schedule, relations and secrets. Steward maps each stage or
     scheduled version to a geometric plan, or a revision of one, to check.
   - This keeps Architect's check deterministic and keeps narrative out of the kit.
2. **"Unsupported" needs an open schema.** An unknown `kind` (a connector, form or rule) passes validation as an `extension`
   part and gets the answer `unsupported {block: "<kind>"}`. It is never refused as a malformed plan. `notes` stays
   free text.
3. **Replay pins the IR, not only the plan.** An approved plan plus the survey sha plus the kit version gives an IR. Steward
   saves the plan and Architect saves the planId and IR, as today. A replay or resume uses the saved IR. A later kit is never
   re-run silently on an approved plan; that would be a new check, and a revision if anything moved.
4. **The plan check is $0 and deterministic.** It makes no Claude calls inside Architect, and repair costs are Steward's. It
   runs in the plan sandbox under T1's budget (120 s / 2 GB). It also returns a preview (the siteplan plus images) that
   Steward can show Claude for repair.
5. **Measure:** I agree. When plan v0 exists, Architect adds a $0 offline harness that runs the recorded plans for the 59
   strange asks through the check, on every slice that adds a block, so the gap map moves in CI rather than only on paid
   reruns.

## Answers to section 8

**1. Fit with 7a-7c, and what changes.**
- 7a's settlement graph and connector catalogue *are* the `connectors[]` vocabulary. They stay, and the plan's connector
  kinds map to the 7a types plus `auto`.
- 7c's settlement plan (§10.1) becomes the geometric plan schema. 7c's own `job.run` composer stays only as an optional
  composer for standalone use, with no Steward. The realiser becomes the plan check plus realise.
- Bible format 3 (related bibles) is unchanged.
- 7c's program authoring stays the escape hatch for a block that can't be expressed yet.
- 7b (site-aware design) supplies "other surfaces".
- SETTLEMENTS gets a section saying the composition design supersedes §10.1's composer, and the 7a-7c contracts are drafted
  against the shared schema.

**2. One call or part by part.** One whole-plan dry run: `Regions.checkPlan(plan)` returns per-part answers, plus the
resolved geometry, the cost and a preview. Parts interact (overlap, routing between zones, a shared budget, claim
limits), so checking part by part can't answer "fits". Internally the call reuses the existing checks (check, checkRoad,
fitToLot, bomFull, and the region plan with no realise). An approved plan then realises from the check's own IR, so the
check and the build can't disagree.

**3. The sketch.** Both, with the zone graph primary.
- **Relation graph (primary):** typed relations such as `adjacent`, `around` (a ring round a feature or zone), `along`
  (a feature: biome edge, shore, river, ridge, street), `inside`, `between`, `above`/`below`, `facing`, `far_from`.
  Features are named from the survey and resolved by Architect.
- **Shape sketch (optional):** a relative polyline or polygon in normalised units of the claim (0..1) or in blocks relative
  to a named anchor. It is never in world coordinates.
- **How loose fitting is:** it keeps topology and order (what touches what, the ring stays closed, the sequence along a
  path). It allows rotation, uniform scale between 0.5 and 2 times, translation, and local deformation of up to about 25%
  of the part's size to follow terrain. Every move beyond snapping is reported as `adjusted`, with a deviation number.
  Beyond those limits the part is `refused`, with what would fit.

**4. Where the new blocks go, and whose design they are.**

| Block | Where | Design or ask |
|---|---|---|
| Plan check v0 | right after T2 and B, in parallel with S2 and T3 (a slice of its own, "P0") | Architect's design, Steward reviews |
| Free layouts | with D2 (C27): zones plus a path network fitted to relations and sketches, the same fitting machinery | Architect's design |
| Rule checks | after VOC (palette and coherence already arrive there); shape and variety rules join the kit checker | Architect's design |
| Schedules | mostly Steward. Architect already has versions, deltas and exact revert; at most one small ask for "apply version X now, revert exactly later" with a key | Steward's, plus a small ask |
| Relocation | a small slice after B and SCH: capture a region (SCH export or journal), re-place it elsewhere, remove the original, keep the history | Architect's design |
| Other surfaces | 7b (attach to cliff, carve into) and F3 (trees, mushrooms) | already planned |
| Under water | after H: an air-pocket or dome form plus containment checks | Architect's design |
| Other dimensions | an infrastructure slice later. Survey, regions and stockpiles are mostly dimension-generic already; portals and linking are new | Architect's design, later |
| transferOwner | small, at any time; kept open already | an ask when Steward needs it |

**5. Rule checks:** a separate deterministic verifier in the kit checker, not the critique. The critique is an LLM and isn't
reproducible, and rules have to be checkable to be honest on the card. The rule types are palette (block set or family
membership with a share), shape (corner angles, symmetry, height caps), variety (pairwise distance over copies, from 0b's
lever metric) and density. A failed rule refuses the part and names the rule. The critique is told the rules as guidance.

**6. flat_village** stays a program: it's fast, proven and has goldens. It is also exposed in the plan as a named template
(`zone.program: "flat_village"`), so Claude can use it as a shortcut inside a composition. Once free layouts exist, it can
be re-expressed internally as a composition if that costs nothing and its golden holds. That's optional.

## Order (my adjustment to section 7)

1. Plan v0 (Steward), expressing today's builds. This is the same as your step 1.
2. **P0, plan check v0 (Architect):** the schema (geometric layer), `checkPlan` with per-part answers for regions, lots,
   roads, routing (T2), districts and brushes, `unsupported` for anything else, and the preview.
3. The 6c remainder continues alongside: S2, T3, H, HY, D1/D2 with free layouts, VOC with rule checks, S3, F3, RS. Each new
   block adds its plan part and check.
4. Then 7a (connectors as plan parts), 7b (surfaces) and 7c (format 3, authoring), plus relocation, under water and
   dimensions.

## Revisions after an independent review (GPT-6.1, 2026-10-12). These win over the text above.

- **Result classes:** `fits`, `adjusted`, `refused` (infeasible), `unsupported` (no such block), `blocked` (depends on a part
  that didn't fit), `malformed` (schema error on a known part), and `incomplete` (the check ran out of budget or time;
  never treated as fits). Known parts are validated strictly. Unknown kinds go through a bounded extension envelope. Free
  `notes` are never a verified requirement. **An unsupported or refused part that the plan marks required blocks approval**
  until the player approves a concrete reduced revision, and any dropped or substituted part is shown in that artifact.
- **Check and build:** I'm withdrawing "can't disagree". The check binds approval to a **resolved artifact**: geometry,
  IR, blobs, fits, links and frozen inputs. Unresolved designs, such as buildings not designed yet or 7a links that need
  fitted entries, are marked provisional, with a cost range. If terrain or protection changes before the build, the
  artifact is rechecked.
- **Fitting tolerances:** I'm dropping the blanket 0.5-2x scale and 25% deformation. Tolerances become **explicit per part**
  (hard constraints vs soft), with defaults stated in the schema. Contract promises win, for example C27's "within 4
  cells". Feature selectors are deterministic, anchors and units are defined, coordinates are quantised, and tie-breaking
  is stable. **v0 has a small locator vocabulary**: `adjacent`, `along <feature>`, `around <feature>`, `inside`,
  `near <anchor>`.
- **Replay:** the approved artifact keeps everything needed: IR, blobs, blueprint versions, fits, links and the frozen
  evaluation inputs. Saving the IR doesn't pin evaluator semantics, because a newer kit evaluates older IR. So Architect
  commits to a rule: **a shipped op's semantics never change.** New behaviour is a new op kind or member, enforced by the
  frozen goldens. Rechecking intent on a newer kit makes a new revision; resuming keeps the artifact's identity.
- **Order:** P0 (plan check v0) covers regions, lots, roads and T2 routing. **Districts answer `unsupported` until D1
  lands**, and then join. Brushes join after B. **Free layouts get their own slice (FL)** after D2, because D2's frozen
  scope (boundary districts, outposts) is narrower than general sketch and network fitting.
- **Budget:** the check is asynchronous and cancellable, with caps on nodes, edges, cells and total time and memory. It
  caches unchanged dependencies. A timeout gives `incomplete`. A light preview comes first; images come on request.
- **Repair bound (Steward):** cap the total work and spend of composition, bibles, building design and any program
  authoring together, not rounds alone. Stop on repeated failures and oscillation. Architect returns a capability catalogue
  (the blocks and the locators it knows) with each answer.
- **Rules:** a finite, versioned rule vocabulary, verified on the fitted output with evidence.
  - "no right angles" is defined above voxel faces, at the outline or footprint level;
  - palette rules exempt terrain and support;
  - "no two alike" is measured on the built output, not on parameters.

  A required rule that can't be verified blocks readiness. The critique judges taste only.
- **Reclassified as their own contracts, not small asks:**
  - relocation (crash-safe destination placement, source removal, materials);
  - scheduled revert (a policy for edits made in between);
  - transferOwner (it spans opKeys, protections, tombstones, stockpiles and ledgers).
- **Measure:** recorded-plan fixtures prove compiler coverage, not composition quality. Focused fixtures run in slice CI;
  the 59-ask corpus is a batch evaluation, with Claude composing.
