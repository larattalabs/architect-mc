#!/usr/bin/env node
// Change-impact mapping for the gate tiers (docs/GATES.md "Change-impact mapping"): which gate steps a diff touches. The map
// is the `impact` section of tools/gate-chains.json: `ignore` globs (docs and the like: nothing to run; they win over the rules)
// and `rules`, each with
// path globs, the steps a `change` run picks (`change`), the extra steps a `slice` run adds (`slice`) and tags (`engine`: the
// diff touches realise, the journal, regions, tiles or the undo; `placement`: realise or placement throughput). Every rule that
// matches a file counts (the union). A file no rule and no ignore glob covers is "unmapped": the tiers then fall back to the
// safe default (every unit suite for `change`, quick for `slice`) and print it, so the map can be extended.
//
//   node tools/gate-impact.mjs --since <ref>        the diff <ref>...HEAD (three dots: since the merge base)
//   node tools/gate-impact.mjs --range A...B        any range, e.g. origin/main...origin/phase/6b
//   node tools/gate-impact.mjs <file> ...           explicit paths
//   [--json]                                        machine-readable
//
// tools/gate-run.mjs uses it for `change --since <ref>` and `slice --since <ref>` (and for the release tier's engine/placement
// test against the last tag).

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** A path glob as a regex: `**` any depth (also none), `*` within one path segment, `?` one character. */
export function globToRe(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      if (glob[i + 2] === '/') {
        re += '(?:.*/)?';
        i += 2;
      } else {
        re += '.*';
        i += 1;
      }
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

/** The changed paths of a range: `A...B` (or `--since ref` = `ref...HEAD`), from `git diff --name-only`. */
export function changedFiles(dir, range) {
  const out = execFileSync('git', ['-C', dir, 'diff', '--name-only', range], { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
  return out.split('\n').map((l) => l.trim()).filter(Boolean);
}

/**
 * The impact of a list of paths under `impact` (gate-chains.json). Returns the files per rule, the unmapped and ignored files,
 * the union of the rules' `change` and `slice` steps (in config order) and the tags.
 */
export function impactOf(files, impact) {
  const ignore = (impact.ignore ?? []).map(globToRe);
  const rules = (impact.rules ?? []).map((r) => ({ ...r, res: r.paths.map(globToRe) }));
  const res = { files: files.length, ignored: [], unmapped: [], rules: {}, change: [], slice: [], tags: [] };
  const change = new Set();
  const slice = new Set();
  const tags = new Set();
  for (const f of files) {
    if (ignore.some((re) => re.test(f))) {
      res.ignored.push(f);
      continue;
    }
    const hit = rules.filter((r) => r.res.some((re) => re.test(f)));
    if (!hit.length) {
      res.unmapped.push(f);
      continue;
    }
    for (const r of hit) {
      (res.rules[r.name] ??= { files: [], change: r.change ?? [], slice: r.slice ?? [], tags: r.tags ?? [] }).files.push(f);
      for (const s of r.change ?? []) change.add(s);
      for (const s of r.slice ?? []) slice.add(s);
      for (const t of r.tags ?? []) tags.add(t);
    }
  }
  res.change = [...change];
  res.slice = [...slice];
  res.tags = [...tags];
  return res;
}

/** Checks the map against the steps it names (so a typo fails loudly instead of selecting nothing). */
export function validateImpact(impact, steps) {
  const bad = [];
  for (const r of impact.rules ?? []) {
    if (!r.name || !Array.isArray(r.paths)) bad.push(`rule ${JSON.stringify(r).slice(0, 60)}: needs name and paths`);
    for (const s of [...(r.change ?? []), ...(r.slice ?? [])]) if (!steps[s]) bad.push(`rule ${r.name}: unknown step ${s}`);
  }
  return bad;
}

/** A short human-readable report of an impact. */
export function describeImpact(imp, { max = 6 } = {}) {
  const lines = [`${imp.files} changed file(s): ${Object.keys(imp.rules).length} rule(s) matched, ${imp.ignored.length} ignored (docs etc.), ${imp.unmapped.length} unmapped`];
  for (const [name, r] of Object.entries(imp.rules)) {
    lines.push(`  ${name}${r.tags.length ? ` [${r.tags.join(',')}]` : ''}: ${r.files.length} file(s) (${r.files.slice(0, 2).join(', ')}${r.files.length > 2 ? ', ...' : ''})`
      + ` -> change: ${r.change.join(' ') || '-'}; slice adds: ${r.slice.join(' ') || '-'}`);
  }
  if (imp.unmapped.length) lines.push(`  UNMAPPED (safe default applies; extend the impact map): ${imp.unmapped.slice(0, max).join(', ')}${imp.unmapped.length > max ? ` (+${imp.unmapped.length - max})` : ''}`);
  if (imp.tags.length) lines.push(`  tags: ${imp.tags.join(', ')}`);
  return lines.join('\n');
}

// ------------------------------------------------------------------ CLI

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const argv = process.argv.slice(2);
  const opt = (f) => {
    const i = argv.indexOf(f);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const cfg = JSON.parse(fs.readFileSync(opt('--config') ?? path.join(SRC, 'tools', 'gate-chains.json'), 'utf8'));
  const bad = validateImpact(cfg.impact ?? {}, cfg.steps);
  if (bad.length) {
    console.error(`impact map: ${bad.join('; ')}`);
    process.exit(2);
  }
  const range = opt('--range') ?? (opt('--since') ? `${opt('--since')}...HEAD` : null);
  const files = range ? changedFiles(SRC, range) : argv.filter((a, i) => !a.startsWith('--') && !['--config', '--since', '--range'].includes(argv[i - 1]));
  if (!range && !files.length) {
    console.error('usage: node tools/gate-impact.mjs --since <ref> | --range A...B | <file> ... [--json]');
    process.exit(2);
  }
  const imp = impactOf(files, cfg.impact ?? {});
  if (argv.includes('--json')) console.log(JSON.stringify({ range, ...imp }, null, 2));
  else console.log(`${range ? `${range}: ` : ''}${describeImpact(imp, { max: 20 })}\nchange steps: ${imp.change.join(' ') || '(none)'}\nslice adds: ${imp.slice.join(' ') || '(none)'}`);
}
