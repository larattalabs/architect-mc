// (7c AU) Authored region programs (docs/CONTRACT.md "Phase 7c" §3 row 13, "Slice AU as built"): a program an authoring session wrote for
// one claim, installed world-local and named by a plan as a zone's program {template: "authored", params: {id, sha, params?}}. This file is
// the kit's half: the source's sha, the lint every authored source passes (install and every load), staging (the closed import list
// rewritten to this kit's file URLs) and the loader the plan CLI uses (`region.mjs plan --authored <dir>`).
//
// The lint is static and conservative. It guards determinism (the realise lint's rules: no trig or other approximated Math, no `**`, no
// Date, no Math.random) and keeps the program on the plan path (no clocks, timers, I/O, process, dynamic code or imports outside the closed
// list). It is NOT the security boundary: that is the plan child's sandbox (Node's permission model reading the kit and the plan dir and
// writing the plan dir only, no child processes, the NO_NETWORK preload, a heap cap and a wall-clock limit), the same as every region
// program's. An authored program reaches the world only through its IR, which the checker and the realise judge as any program's.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** The largest authored source (UTF-8 bytes): Limits.PROGRAM_SOURCE_MAX's. */
export const AUTHORED_SOURCE_MAX = 262144;
/** At most this many authored programs in one plan (each a whole-claim zone; v0 compiles one, the rest refuse OVERLAP). */
export const AUTHORED_PER_PLAN = 4;
export const AUTHORED_ID = /^[a-z][a-z0-9_]{0,47}$/;
const SHA = /^[0-9a-f]{64}$/;

/** The kit modules an authored program may import (written as a bundled program writes them, from kit/regions/), and nothing else. */
export const AUTHORED_IMPORTS = Object.freeze(['../lib/region/program.mjs', '../lib/region/geom.mjs', '../lib/noise.mjs']);
/** Math members exact by spec (the realise lint's set plus the exact rounding ones). */
export const AUTHORED_MATH = Object.freeze(['floor', 'ceil', 'round', 'trunc', 'sign', 'sqrt', 'abs', 'min', 'max', 'imul']);
/** Identifiers an authored program never names (clocks, timers, I/O, process, dynamic code, reflection, globals). */
export const AUTHORED_BANNED = Object.freeze([
  'Date', 'performance', 'process', 'require', 'module', 'exports', 'globalThis', 'global', 'self', 'window', 'eval', 'Function', 'AsyncFunction',
  'GeneratorFunction', 'Reflect', 'Proxy', 'WebAssembly', 'Atomics', 'SharedArrayBuffer', 'Worker', 'fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource',
  'setTimeout', 'setInterval', 'setImmediate', 'clearTimeout', 'clearInterval', 'clearImmediate', 'queueMicrotask', 'structuredClone', 'constructor',
  '__proto__', 'prototype', 'getPrototypeOf', 'setPrototypeOf', 'defineProperty', '__defineGetter__', '__defineSetter__', '__lookupGetter__',
  'arguments', 'with', 'debugger', 'Buffer', 'createRequire', 'Symbol',
]);
const BANNED = new Set(AUTHORED_BANNED);
const MATH_OK = new Set(AUTHORED_MATH);

/** sha256 (hex) of the source's exact UTF-8 bytes. */
export function authoredSha(source) {
  return createHash('sha256').update(typeof source === 'string' ? Buffer.from(source, 'utf8') : source).digest('hex');
}

const ID_START = /[A-Za-z_$]/;
const ID_PART = /[\w$]/;
// a `/` after one of these (or at the start) begins a regular expression literal, else it is division
const REGEX_AFTER = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^', 'return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'new', 'delete', 'void', 'throw', 'yield', 'await', '=>']);

/**
 * Tokens of a JS source: {t: 'id'|'num'|'str'|'tpl'|'punc'|'regex', v, line}. Comments are dropped; a template literal's text is one 'tpl'
 * token and each `${...}` inside it is tokenized as code (nothing hides in a template). Throws on an unterminated string, comment or template.
 */
export function tokens(src) {
  const out = [];
  let i = 0, line = 1;
  const prevSig = () => out[out.length - 1];
  const regexAllowed = () => { const p = prevSig(); return !p || (p.t === 'punc' && REGEX_AFTER.has(p.v)) || (p.t === 'id' && REGEX_AFTER.has(p.v)); };
  // a stack of open `${` braces: the brace depth at which each template expression closes
  const tplStack = [];
  let depth = 0;
  const readString = (q) => {
    let j = i + 1, v = '';
    while (j < src.length && src[j] !== q) {
      if (src[j] === '\n') throw new Error(`line ${line}: unterminated string`);
      if (src[j] === '\\') { v += src[j + 1] ?? ''; j += 2; continue; }
      v += src[j++];
    }
    if (j >= src.length) throw new Error(`line ${line}: unterminated string`);
    out.push({ t: 'str', v, line });
    i = j + 1;
  };
  // template text from i (just past ` or }) up to the next ${ (push the stack) or the closing `
  const readTemplate = () => {
    let v = '';
    while (i < src.length) {
      const c = src[i];
      if (c === '\\') { v += src[i + 1] ?? ''; i += 2; continue; }
      if (c === '`') { i++; out.push({ t: 'tpl', v, line }); return; }
      if (c === '$' && src[i + 1] === '{') { i += 2; out.push({ t: 'tpl', v, line }); tplStack.push(depth); depth++; out.push({ t: 'punc', v: '${', line }); return; }
      if (c === '\n') line++;
      v += c; i++;
    }
    throw new Error(`line ${line}: unterminated template literal`);
  };
  while (i < src.length) {
    const c = src[i], n = src[i + 1];
    if (c === '\n') { line++; i++; continue; }
    if (/\s/.test(c)) { i++; continue; }
    if (c === '/' && n === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && n === '*') {
      const e = src.indexOf('*/', i + 2);
      if (e < 0) throw new Error(`line ${line}: unterminated comment`);
      for (let k = i; k < e; k++) if (src[k] === '\n') line++;
      i = e + 2;
      continue;
    }
    if (c === '"' || c === "'") { readString(c); continue; }
    if (c === '`') { i++; readTemplate(); continue; }
    if (c === '}' && tplStack.length && tplStack[tplStack.length - 1] === depth - 1) {
      tplStack.pop(); depth--; i++; out.push({ t: 'punc', v: '}$', line }); readTemplate(); continue;
    }
    if (ID_START.test(c) || c === '\\' || c.charCodeAt(0) > 127) {
      // a unicode escape or non-ASCII identifier could spell a banned name: refuse them outright
      if (c === '\\' || c.charCodeAt(0) > 127) throw new Error(`line ${line}: identifiers must be plain ASCII (no escapes or non-ASCII letters)`);
      let j = i + 1;
      while (j < src.length && ID_PART.test(src[j])) j++;
      if (src[j] === '\\' || (j < src.length && src.charCodeAt(j) > 127 && !/\s/.test(src[j]))) throw new Error(`line ${line}: identifiers must be plain ASCII (no escapes or non-ASCII letters)`);
      out.push({ t: 'id', v: src.slice(i, j), line });
      i = j;
      continue;
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(n ?? ''))) {
      let j = i + 1;
      while (j < src.length && /[\w.]/.test(src[j])) j++;
      out.push({ t: 'num', v: src.slice(i, j), line });
      i = j;
      continue;
    }
    if (c === '/' && regexAllowed()) {
      let j = i + 1, cls = false;
      while (j < src.length && (cls || src[j] !== '/')) {
        if (src[j] === '\n') throw new Error(`line ${line}: unterminated regular expression`);
        if (src[j] === '\\') j++;
        else if (src[j] === '[') cls = true;
        else if (src[j] === ']') cls = false;
        j++;
      }
      j++;
      while (j < src.length && /[a-z]/.test(src[j])) j++;
      out.push({ t: 'regex', v: src.slice(i, j), line });
      i = j;
      continue;
    }
    // punctuators, longest first
    const p3 = src.slice(i, i + 4);
    const P = ['>>>=', '...', '===', '!==', '**=', '<<=', '>>=', '>>>', '&&=', '||=', '??=', '=>', '==', '!=', '<=', '>=', '&&', '||', '??', '?.', '++', '--', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '**', '<<', '>>'];
    const m = P.find((x) => p3.startsWith(x));
    const v = m ?? c;
    if (v === '{') depth++;
    if (v === '}') depth--;
    out.push({ t: 'punc', v, line });
    i += v.length;
  }
  if (tplStack.length) throw new Error('unterminated template expression');
  return out;
}

/**
 * The lint's findings for an authored source: [{rule, message, line?}] (empty: clean). `rule` is `lint` for a banned form, `imports` for an
 * import outside the closed list, `size` and `encoding` for the source itself, `exports` for a missing id or default export.
 */
export function lintAuthored(source) {
  const f = [];
  if (typeof source !== 'string') return [{ rule: 'encoding', message: 'the source is not text' }];
  if (Buffer.byteLength(source, 'utf8') > AUTHORED_SOURCE_MAX) f.push({ rule: 'size', message: `the source is ${Buffer.byteLength(source, 'utf8')} bytes (at most ${AUTHORED_SOURCE_MAX})` });
  if (typeof source.isWellFormed === 'function' ? !source.isWellFormed() : /[\uD800-\uDFFF]/.test(source.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, ''))) {
    f.push({ rule: 'encoding', message: 'the source has a lone UTF-16 surrogate (it would not round-trip through UTF-8)' });
    return f;
  }
  if (source.includes('\u0000')) f.push({ rule: 'encoding', message: 'the source has a NUL character' });
  let T;
  try { T = tokens(source); } catch (e) { return [...f, { rule: 'lint', message: e.message }]; }
  const add = (tok, message) => f.push({ rule: 'lint', message, line: tok.line });
  let hasId = false, hasDefault = false;
  for (let k = 0; k < T.length; k++) {
    const t = T[k], prev = T[k - 1], next = T[k + 1];
    if (t.t === 'punc' && (t.v === '**' || t.v === '**=')) add(t, 'the ** operator (implementation-approximated): multiply, or use Math.sqrt');
    else if (t.t === 'regex') add(t, 'regular expressions are not allowed in an authored program');
    else if (t.t === 'str' || t.t === 'tpl') {
      if (BANNED.has(t.v) || t.v === 'Math') add(t, `the string "${t.v}" (a banned name, as a computed member)`);
    } else if (t.t === 'id') {
      const member = prev && prev.t === 'punc' && (prev.v === '.' || prev.v === '?.');
      if (t.v === 'Math' && !member) {
        if (next?.t === 'punc' && next.v === '.' && T[k + 2]?.t === 'id') {
          if (!MATH_OK.has(T[k + 2].v)) add(t, `Math.${T[k + 2].v} (only ${AUTHORED_MATH.join(', ')}: exact by spec; trig and the rest are approximated per Node)`);
        } else add(t, 'Math used other than as Math.<member> (only exact members, named)');
      } else if (t.v === 'random' && member && T[k - 2]?.v === 'Math') add(t, 'Math.random (use ctx.rng(label))');
      else if (BANNED.has(t.v)) add(t, `${t.v} is not allowed in an authored program (the plan path only: no clocks, timers, I/O, process, dynamic code or reflection)`);
      else if (t.v === 'import' && !member) {
        // only `import {...} from '<allowed>'` / `import x from '<allowed>'` at a statement start; never import(), import.meta
        const atStart = !prev || (prev.t === 'punc' && (prev.v === ';' || prev.v === '}'));
        if (!atStart || next?.v === '(' || next?.v === '.') add(t, 'only static imports of the kit modules, at the top (no import(), no import.meta)');
        else {
          let j = k + 1;
          while (j < T.length && !(T[j].t === 'id' && T[j].v === 'from') && T[j].t !== 'str') j++;
          const spec = T[j]?.t === 'id' ? T[j + 1] : T[j];
          if (!spec || spec.t !== 'str' || !AUTHORED_IMPORTS.includes(spec.v)) f.push({ rule: 'imports', message: `import ${spec?.t === 'str' ? `'${spec.v}'` : '(no source)'}: an authored program imports only ${AUTHORED_IMPORTS.join(', ')}`, line: t.line });
        }
      } else if (t.v === 'export' && !member) {
        if (next?.v === '*') add(t, 'export * is not allowed');
        if (next?.v === 'const' && T[k + 2]?.v === 'id') hasId = true;
        if (next?.v === 'default') hasDefault = true;
        // export { x } from '...' re-exports a module
        let j = k + 1;
        if (next?.v === '{') { while (j < T.length && T[j].v !== '}') j++; if (T[j + 1]?.v === 'from') f.push({ rule: 'imports', message: 'export ... from re-exports a module', line: t.line }); }
      }
    }
  }
  if (!hasId) f.push({ rule: 'exports', message: 'the program must export const id (matching [a-z][a-z0-9_]{0,47})' });
  if (!hasDefault) f.push({ rule: 'exports', message: 'the program must export default (ctx) => Region' });
  return f;
}

/** The source with its kit imports pointed at `kitDir`'s files (the closed list only; lint first). */
export function stageAuthored(source, kitDir) {
  let out = source;
  for (const spec of AUTHORED_IMPORTS) {
    const url = pathToFileURL(path.join(kitDir, 'regions', spec)).href;
    out = out.split(`'${spec}'`).join(JSON.stringify(url)).split(`"${spec}"`).join(JSON.stringify(url));
  }
  return out;
}

/**
 * The authored programs staged in `dir` for a plan (the sidecar writes `<dir>/<id>.mjs`, each the installed source's exact bytes): id ->
 * {sha, module | null, problem | null}. Each is hashed, linted and, when clean, staged (`<stageDir>/<id>-<sha>.mjs`, imports rewritten to
 * this kit; the plan's --out, so a replay that may write only its own output dir stages there) and imported. A problem is the lint's first finding or the import's error; the plan compile refuses the zone with it.
 */
export async function loadAuthoredDir(dir, kitDir, stageDir = path.join(dir, '.staged')) {
  const out = new Map();
  let files;
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.mjs')).sort(); } catch (e) { throw new Error(`--authored: ${e.message}`); }
  if (files.length > AUTHORED_PER_PLAN) throw new Error(`--authored: ${files.length} programs (at most ${AUTHORED_PER_PLAN} a plan)`);
  for (const f of files) {
    const id = f.slice(0, -4);
    if (!AUTHORED_ID.test(id)) throw new Error(`--authored: ${f} is not <id>.mjs`);
    const bytes = fs.readFileSync(path.join(dir, f));
    const sha = authoredSha(bytes);
    const source = bytes.toString('utf8');
    const lint = lintAuthored(source);
    if (lint.length) { out.set(id, { sha, module: null, problem: `${lint[0].rule}: ${lint[0].message}` }); continue; }
    fs.mkdirSync(stageDir, { recursive: true });
    const file = path.join(stageDir, `${id}-${sha.slice(0, 16)}.mjs`);
    fs.writeFileSync(file, stageAuthored(source, kitDir));
    try {
      const module = await import(pathToFileURL(file).href);
      if (typeof module.default !== 'function') throw new Error('no default export');
      out.set(id, { sha, module, problem: null });
    } catch (e) {
      out.set(id, { sha, module: null, problem: `program: ${String(e?.message ?? e).split('\n')[0]}` });
    }
  }
  return out;
}

/** A zone program naming an authored program: {id, sha, params} or {error} (a malformed reference). */
export function authoredRef(program) {
  const p = program?.params;
  if (!p || typeof p !== 'object' || Array.isArray(p)) return { error: { path: '$.program.params', message: 'an authored program is {template: "authored", params: {id, sha, params?}}' } };
  if (typeof p.id !== 'string' || !AUTHORED_ID.test(p.id)) return { error: { path: '$.program.params.id', message: 'id must match [a-z][a-z0-9_]{0,47}' } };
  if (typeof p.sha !== 'string' || !SHA.test(p.sha)) return { error: { path: '$.program.params.sha', message: 'sha must be 64 hex digits (the source\'s sha256)' } };
  if (p.params !== undefined && (!p.params || typeof p.params !== 'object' || Array.isArray(p.params))) return { error: { path: '$.program.params.params', message: 'params must be an object' } };
  return { id: p.id, sha: p.sha, params: p.params ?? {} };
}
