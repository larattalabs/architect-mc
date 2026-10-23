// (6c close-out A, §6) Steward's first recordings of the 59 asks: the slices before close-out A judged them, so their asks items read the 12
// plans Steward re-recorded since (steward-mc 0c8f4a8) from kit/test/fixtures/plan/asks-8703dbd/ when the tree has it (a base tree from
// before close-out A has only asks/, which then holds them).
import fs from 'node:fs';
import path from 'node:path';

/** The file an earlier slice reads for ask `f` of the asks dir `asksDir` (`.../fixtures/plan/asks`). */
export function firstAsk(asksDir, f) {
  const p = path.join(path.dirname(asksDir), 'asks-8703dbd', f);
  return fs.existsSync(p) ? p : path.join(asksDir, f);
}
