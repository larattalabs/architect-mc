// (6c VOC) VOC-b's items of the VOC gate (tools/gate6cvoc.mjs; docs/CONTRACT.md "Phase 6c slice VOC" §8): budgets and rules. VOC-b owns
// this file. A map of the driver's step -> named items `{name, async run(ctx)}`, run after VOC-a's items of the same step
// (tools/lib/gate6cvoc-a.mjs). The steps (frozen with voc/core): unit (voc-unit: items 6, 7), ingame (voc-ingame: item 8), natural
// (voc-natural: item 9), survival (voc-survival: item 11), look (6cvoc-look: item 15); registry and probe are VOC-a's.
// `ctx`: {L (tools/lib/run6b.mjs), OUT, KIT, imp(kit path), json, root, check, log}.
//
// Empty until VOC-b adds its items. When it does, it adds its in-game steps (voc-ingame, voc-natural, 6cvoc-look) to the slice list
// of the "6c VOC" impact rule in tools/gate-chains.json (VOC-a's rule lists only the steps that have items).
export const items = {};
