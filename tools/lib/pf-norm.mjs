// (7c PF) The committed plan fixtures slice PF moves, by name, for the earlier slices' byte-identity checks (their unchanged() over the
// fixtures against the base): every aqueduct whose span stands on arches. AQ's arches now come from the promoted archSpan module's round
// soffit (kit/lib/fluids/course.mjs archRise), so the span part's cells move (+14 on a 7-clear arch run); the answers, the overall and
// every other part are unchanged (kit/test/pf.test.mjs, the pre-PF x01 IR).
const WHY = "7c PF: the aqueduct's arches are the archSpan module's round soffit (the span part's cells move; the answers unchanged)";
export const PF_MOVED = Object.freeze(Object.fromEntries([
  'aq/x01_valley_aqueduct.json', 'aq/d16_deep.json', 'valid/v7c_aq_valley.json', 'hy/r03_aqueduct.json', 'extension/e18_aqueduct.json',
].map((n) => [n, WHY])));
