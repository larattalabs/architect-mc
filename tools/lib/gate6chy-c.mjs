// (6c HY) HY-c's items of the HY gate (tools/gate6chy.mjs; docs/CONTRACT.md "Phase 6c slice HY" §14, §15). Slice HY-c owns this file.
// `items` maps a step of the driver (unit, ingame, crash, natural, cold, look) to a list of {name, async run(ctx)}: each runs after
// HY-core's items of that step, with ctx = {L (tools/lib/run6b.mjs), OUT, KIT, imp, json, root, check, log, core} (core: HY-core's
// helpers, tools/lib/gate6chy-core.mjs: planCheck through Regions.checkPlan, realiseApproved, census, snapshots, removal).
//
// The foundation's stub (HY-core): no items.
export const items = {};
