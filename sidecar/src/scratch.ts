// A design job's scratch dir (docs/CONTRACT.md "Kit CLI"): <data>/designs/<designId>/ with
//   kit/          a fresh copy of the kit (the agent's own design module is kept across refreshes)
//   BRIEF.md      the request, written for the design agent
//   CONTRACT.md   the blueprint and checker sections of the contract
//   remix/        the source (or sidecar) of the design being remixed, when there is one
import fs from 'node:fs';
import path from 'node:path';
import { designBrief } from './claude/brief.js';
import { CONTRACT_EXCERPT } from './claude/contract.js';
import { KIT, refreshKit, rendererIn } from './designs.js';
import type { Design } from './protocol.js';

export function scratchDirFor(dataDir: string, designId: string): string {
  return path.join(dataDir, 'designs', designId);
}

/** Example designs in a kit (designs/<id>.mjs), sorted. */
export function kitExamples(kitDir: string): string[] {
  try {
    return fs
      .readdirSync(path.join(kitDir, 'designs'))
      .filter((f) => /^[a-z0-9_]+\.mjs$/.test(f))
      .map((f) => f.slice(0, -4))
      .sort();
  } catch {
    return [];
  }
}

export interface PrepareInput {
  dataDir: string;
  kitDir: string;
  libraryDir: string;
  design: Design;
  /** the id the agent builds under */
  bp: string;
}

/** Create / refresh the scratch dir: fresh kit, BRIEF.md, CONTRACT.md and the remix source. */
export function prepareScratch(input: PrepareInput): string {
  const { design: d, bp } = input;
  fs.mkdirSync(scratchDirFor(input.dataDir, d.id), { recursive: true });
  // the physical path: the agent's cwd, the policy and the guards then all see the same prefix
  // (a data dir reached through a link, e.g. /var -> /private/var on macOS)
  const scratch = fs.realpathSync(scratchDirFor(input.dataDir, d.id));
  refreshKit(input.kitDir, scratch, [bp]);
  fs.writeFileSync(path.join(scratch, 'CONTRACT.md'), CONTRACT_EXCERPT);
  let remix: string | undefined;
  const r = d.request.remix;
  if (r) {
    const dir = path.join(input.libraryDir, r);
    const src = path.join(dir, `${r}.mjs`);
    const sidecar = path.join(dir, `${r}.blueprint.json`);
    if (fs.existsSync(src)) {
      fs.mkdirSync(path.join(scratch, 'remix'), { recursive: true });
      fs.copyFileSync(src, path.join(scratch, 'remix', `${r}.mjs`));
      if (fs.existsSync(sidecar)) fs.copyFileSync(sidecar, path.join(scratch, 'remix', `${r}.blueprint.json`));
      remix = `Its source is remix/${r}.mjs (with its sidecar remix/${r}.blueprint.json): copy it into your file, set your id, fix its kit imports to point into kit/lib/, and change it as the request says (keep it parametric: its params, and every material from the palette).`;
    } else if (fs.existsSync(path.join(scratch, KIT, 'designs', `${r}.mjs`))) {
      remix = `Its source is kit/designs/${r}.mjs (a kit example): copy it into your file, set your id and change it as the request says.`;
    } else if (fs.existsSync(sidecar)) {
      fs.mkdirSync(path.join(scratch, 'remix'), { recursive: true });
      fs.copyFileSync(sidecar, path.join(scratch, 'remix', `${r}.blueprint.json`));
      remix = `Only its sidecar is available (remix/${r}.blueprint.json: size, anchors, materials); design in its spirit.`;
    }
  }
  const examples = kitExamples(path.join(scratch, KIT)).filter((e) => e !== bp);
  fs.writeFileSync(path.join(scratch, 'BRIEF.md'), designBrief(d.request, bp, { renderer: !!rendererIn(scratch), examples, ...(remix ? { remix } : {}) }));
  return scratch;
}
