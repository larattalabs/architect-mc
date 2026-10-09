// Phase 6a: the realise lint (docs/CONTRACT.md "Seeds and determinism", D9). lib/sdf.mjs, lib/noise.mjs and
// lib/realise.mjs, and everything they import from lib/region/, may use only Math.floor/sqrt/abs/min/max/imul (exact by
// spec), no Date, no Math.random and no exponent operator. The plan path (program.mjs, plan.mjs, the bundled
// programs) avoids trig and friends too, so the mega_bench IR is the same on every Node major.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const KIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ALLOWED = new Set(['floor', 'sqrt', 'abs', 'min', 'max', 'imul']);

/** The code with comments removed and string/template contents blanked (so prose and messages never trip the scan). */
export function codeOnly(src) {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i], n = src[i + 1];
    if (c === '/' && n === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && n === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? src.length : e + 2; out += ' '; continue; }
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < src.length && src[j] !== c) { if (src[j] === '\\') j++; j++; }
      out += `${c}${c}`;
      i = j + 1;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

function importsOf(file) {
  const src = fs.readFileSync(file, 'utf8');
  return [...src.matchAll(/^\s*import\s[^;]*?from\s+'(\.[^']+)'/gm)].map((m) => path.resolve(path.dirname(file), m[1]));
}

/** The realise set: the three roots plus their transitive imports under lib/region/ (and each other). */
function realiseFiles() {
  // (6b) lib/material.mjs (material rules) is on the realise path too (CONTRACT 6b §2.3)
  const roots = ['lib/sdf.mjs', 'lib/noise.mjs', 'lib/realise.mjs', 'lib/material.mjs'].map((f) => path.join(KIT, f));
  const seen = new Set();
  const todo = [...roots];
  while (todo.length) {
    const f = todo.pop();
    if (seen.has(f)) continue;
    seen.add(f);
    for (const d of importsOf(f)) {
      const rel = path.relative(KIT, d);
      if (rel.startsWith(`lib${path.sep}region${path.sep}`) || roots.includes(d)) todo.push(d);
      else assert.fail(`${path.relative(KIT, f)} imports ${rel}, outside the realise set (lib/region/ and the roots)`);
    }
  }
  return [...seen].sort();
}

test('the realise set uses only exact Math members, no Date, no Math.random, no exponent operator', () => {
  const files = realiseFiles();
  assert.ok(files.some((f) => f.endsWith(path.join('region', 'pack.mjs'))), 'pack.mjs is in the set');
  assert.ok(files.some((f) => f.endsWith('material.mjs')), 'material.mjs is in the set');
  assert.ok(!files.some((f) => /program\.mjs$|plan\.mjs$/.test(f)), 'plan-time code is not imported by realise');
  const bad = [];
  for (const f of files) {
    const code = codeOnly(fs.readFileSync(f, 'utf8'));
    const rel = path.relative(KIT, f);
    for (const m of code.matchAll(/\bMath\s*\.\s*([A-Za-z_$][\w$]*)/g)) if (!ALLOWED.has(m[1])) bad.push(`${rel}: Math.${m[1]}`);
    if (/\bDate\b/.test(code)) bad.push(`${rel}: Date`);
    if (/\*\*/.test(code)) bad.push(`${rel}: ** operator`);
    if (/\bMath\s*\[/.test(code)) bad.push(`${rel}: computed Math member`);
    if (/\bperformance\b|\bprocess\.hrtime\b/.test(code)) bad.push(`${rel}: clock`);
  }
  assert.deepEqual(bad, []);
});

test('the lint catches what it should (self-check on a snippet)', () => {
  const code = codeOnly("// Math.sin in a comment\nconst s = 'Math.cos ** Date';\nconst x = Math.pow(2, 3) + 2 ** 3; /* Date */\n");
  assert.deepEqual([...code.matchAll(/\bMath\s*\.\s*(\w+)/g)].map((m) => m[1]), ['pow']);
  assert.ok(/\*\*/.test(code));
  assert.ok(!/\bDate\b/.test(code));
});

test('the plan path avoids trig, exp/log/pow and the exponent operator (same IR on every Node major)', () => {
  const files = ['lib/region/program.mjs', 'lib/region/plan.mjs', 'lib/region/survey.mjs', 'lib/region/geom.mjs', ...fs.readdirSync(path.join(KIT, 'regions')).filter((f) => f.endsWith('.mjs')).map((f) => `regions/${f}`)];
  const bad = [];
  for (const rel of files) {
    const f = path.join(KIT, rel);
    if (!fs.existsSync(f)) continue;
    const code = codeOnly(fs.readFileSync(f, 'utf8'));
    for (const m of code.matchAll(/\bMath\s*\.\s*(sin|cos|tan|asin|acos|atan|atan2|sinh|cosh|tanh|asinh|acosh|atanh|exp|expm1|log|log1p|log2|log10|pow|hypot|cbrt)\b/g)) bad.push(`${rel}: Math.${m[1]}`);
    if (/\bMath\s*\.\s*random\s*\(/.test(code)) bad.push(`${rel}: Math.random()`);
    if (/\*\*/.test(code)) bad.push(`${rel}: ** operator`);
  }
  assert.deepEqual(bad, []);
});
