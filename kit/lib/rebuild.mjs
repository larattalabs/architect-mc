// Phase 5b: rebuild an entry (or a stored design round) from its source with its recorded inputs: the palette, the
// values and the bible pin from its blueprint JSON. Used by
//   - the polish base check (docs/CONTRACT.md "The scope check": the base is rebuilt from source; a drift ends base_drift),
//   - `tools/eval.mjs import-round0`'s pre-check (every stored round 0 must rebuild byte-identically, or it refuses),
//   - the 5b round-0 tripwire (the 5a run's 18 sources and the kit examples against the new kit).
// The build runs `node kit/build.mjs` in a CHILD process (the source is agent-written code, and a fresh process has no
// module cache) inside a temp copy of the kit: <tmp>/kit/designs/<id>.mjs, and the bible's files in <tmp>/bible/ (what a
// design imports as ../../bible/components.mjs).
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const KIT_DIR = path.resolve(HERE, '..');
const SKIP = /(^|[\\/])(node_modules|\.git|out|test|examples)([\\/]|$)/;

export const sha256File = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

/** Copy a kit (without node_modules, .git, out/, test/ and examples/) into `<dir>/kit`. */
export function copyKit(kitDir, dir) {
  const dst = path.join(dir, 'kit');
  fs.cpSync(kitDir, dst, { recursive: true, filter: (p) => !SKIP.test(path.relative(kitDir, p)) });
  fs.mkdirSync(path.join(dst, 'designs'), { recursive: true });
  return dst;
}

/**
 * Rebuild `source` (a design module; its file name is the id) with the inputs recorded in `blueprint` (an object or a
 * path): `palette`, `values` and the bible (`bibleDir`: a folder with bible.json and components.mjs, copied to bible/).
 * Writes <out>/<id>.nbt, <id>.blueprint.json and <id>.parts.nbt. Returns { ok, code, nbt, json, parts, output }; ok when
 * the kit wrote the files (exit 0, or 1 = the checker refused it but the files are written).
 */
export function rebuild({ source, blueprint, bibleDir, out, kitDir = KIT_DIR, extraArgs = [], timeoutMs = 120_000 }) {
  const id = path.basename(source).replace(/\.mjs$/, '');
  const bp = typeof blueprint === 'string' ? readJson(blueprint) : (blueprint ?? {});
  // the real path: build.mjs runs its main only when argv[1] is its own (resolved) file path
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'arch-rebuild-')));
  try {
    const kit = copyKit(kitDir, tmp);
    fs.copyFileSync(source, path.join(kit, 'designs', `${id}.mjs`));
    if (bibleDir) {
      fs.mkdirSync(path.join(tmp, 'bible'), { recursive: true });
      for (const f of ['bible.json', 'bible.md', 'components.mjs']) if (fs.existsSync(path.join(bibleDir, f))) fs.copyFileSync(path.join(bibleDir, f), path.join(tmp, 'bible', f));
    }
    fs.mkdirSync(out, { recursive: true });
    const args = [path.join(kit, 'build.mjs'), id, '--out', path.resolve(out)];
    if (bp.palette !== undefined) args.push('--palette', typeof bp.palette === 'string' ? bp.palette : JSON.stringify(bp.palette));
    if (bp.values && Object.keys(bp.values).length) args.push('--values', JSON.stringify(bp.values));
    args.push(...extraArgs, '--json');
    const env = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? tmp, TMPDIR: os.tmpdir() };
    const r = spawnSync(process.execPath, args, { cwd: tmp, env, encoding: 'utf8', timeout: timeoutMs });
    const nbt = path.join(out, `${id}.nbt`);
    const json = path.join(out, `${id}.blueprint.json`);
    const parts = path.join(out, `${id}.parts.nbt`);
    const code = r.status ?? -1;
    const ok = (code === 0 || code === 1) && fs.existsSync(nbt) && fs.existsSync(json);
    return { ok, code, id, nbt, json, parts, output: `${r.stdout ?? ''}${r.stderr ? `\n${r.stderr}` : ''}`.trim() };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * Rebuild a stored build (a folder with <id>.mjs, <id>.nbt and <id>.blueprint.json, e.g. a design's rounds/0/) and
 * byte-compare the .nbt. `bibleFor(pin)` returns the folder of a bible pin ({id, version}) when the build used one.
 * Returns { id, same, stored, rebuilt, bible?, error? } (stored/rebuilt: sha256 of the .nbt).
 */
export function verifyRebuild(dir, { bibleFor, kitDir = KIT_DIR, keep } = {}) {
  const src = fs.readdirSync(dir).find((f) => /^[a-z0-9_]+\.mjs$/.test(f));
  if (!src) return { dir, same: false, error: 'no source (.mjs)' };
  const id = src.slice(0, -4);
  const nbt = path.join(dir, `${id}.nbt`);
  const jsonFile = path.join(dir, `${id}.blueprint.json`);
  if (!fs.existsSync(nbt) || !fs.existsSync(jsonFile)) return { dir, id, same: false, error: `no ${id}.nbt or ${id}.blueprint.json` };
  const bp = readJson(jsonFile);
  const pin = bp.bible && typeof bp.bible === 'object' ? { id: bp.bible.id, version: bp.bible.version ?? 1 } : undefined;
  const bibleDir = pin ? bibleFor?.(pin) : undefined;
  if (pin && !bibleDir) return { dir, id, same: false, bible: pin, error: `no files for bible ${pin.id} v${pin.version}` };
  const out = keep ?? fs.mkdtempSync(path.join(os.tmpdir(), 'arch-verify-'));
  try {
    const r = rebuild({ source: path.join(dir, src), blueprint: bp, bibleDir, out, kitDir });
    if (!r.ok) return { dir, id, same: false, ...(pin ? { bible: pin } : {}), error: `the rebuild failed (exit ${r.code}): ${r.output.split('\n').slice(-3).join(' ').slice(0, 300)}` };
    const stored = sha256File(nbt);
    const rebuilt = sha256File(r.nbt);
    return { dir, id, same: stored === rebuilt && Buffer.compare(fs.readFileSync(nbt), fs.readFileSync(r.nbt)) === 0, stored, rebuilt, ...(pin ? { bible: pin } : {}), ...(keep ? { out: { nbt: r.nbt, json: r.json, parts: r.parts } } : {}) };
  } finally {
    if (!keep) fs.rmSync(out, { recursive: true, force: true });
  }
}
