#!/usr/bin/env node
// Binary compatibility of the public API (docs/CONTRACT.md "Phase 5a contract", "Java API (1.6.0)"): every method, constructor and
// field of dev.larattalabs.architect.api that a compiled jar references (its constant pool: Methodref, InterfaceMethodref,
// Fieldref) must still exist, with the same descriptor, in the mod's freshly compiled classes.
//
//   node tools/api-compat.mjs <old.jar> [classesDir]
//   node tools/api-compat.mjs --surface <old architect_mc.jar> [classesDir]
//                     every public or protected member of every class under dev/larattalabs/architect/api in the old MOD jar
//                     (its whole 1.x surface, not only what one jar calls) must still exist with the same descriptor.
//
//   node tools/api-compat.mjs --gate6c0a [--artifacts <dir>] [classesDir]
//                     phase 6c slice 0a: the unchanged 0.12.0, 0.11.0 and 0.10.0 apitest jars (API 1.9.0, 1.8.0, 1.7.0) and the 0.12.0
//                     mod jar's 1.9.0 surface (artifacts/gate6c0a/v0120/).
//
//   node tools/api-compat.mjs --gate6c0b [--artifacts <dir>] [classesDir]
//                     phase 6c slice 0b: the unchanged 0.13.0, 0.12.0 and 0.11.0 apitest jars (API 1.10.0, 1.9.0, 1.8.0) and the 0.13.0
//                     mod jar's 1.10.0 surface (artifacts/gate6c0b/v0130/, built from the v0.13.0 tag).
//
//   node tools/api-compat.mjs --gate6cy2 [--artifacts <dir>] [classesDir]
//                     phase 6c slice Y2: the unchanged 0.17.0, 0.16.0 and 0.15.0 apitest jars (API 1.14.0, 1.13.0, 1.12.0) and the 0.17.0
//                     mod jar's 1.14.0 surface (artifacts/gate6c-y2/v0170/, built from the v0.17.0 tag; 0.16.0 and 0.15.0 from X's and V's gates).
//
//   node tools/api-compat.mjs --gate6cx [--artifacts <dir>] [classesDir]
//                     phase 6c slice X: the unchanged 0.16.0, 0.15.0 and 0.14.0 apitest jars (API 1.13.0, 1.12.0, 1.11.0) and the 0.16.0
//                     mod jar's 1.13.0 surface (artifacts/gate6c-x/v0160/, built from the v0.16.0 tag; 0.15.0 and 0.14.0 from earlier gates).
//
//   node tools/api-compat.mjs --gate6csch [--artifacts <dir>] [classesDir]
//                     phase 6c slice SCH (v0.21.0): the unchanged 0.20.0, 0.19.0 and 0.18.0 apitest jars (API 1.17.0, 1.16.0, 1.15.0) and the
//                     0.20.0 mod jar's 1.17.0 surface (artifacts/gate6c-sch/v0200/, built from the v0.20.0 tag; v0190/ and v0180/ hold Y1's tag builds).
//
//   node tools/api-compat.mjs --gate6cf2 [--artifacts <dir>] [classesDir]
//                     phase 6c slice F2 (over v0.22.0): the unchanged 0.22.0, 0.21.0 and 0.20.0 apitest jars (API 1.19.0, 1.18.0, 1.17.0) and
//                     the 0.22.0 mod jar's 1.19.0 surface (artifacts/gate6c-f2/v0220/ and v0210/, built from their tags; SCH's v0200).
//   node tools/api-compat.mjs --gate6cb [--artifacts <dir>] [classesDir]
//                     phase 6c slice B (over v0.23.1): the unchanged 0.23.0, 0.22.0 and 0.21.0 apitest jars (API 1.20.0, 1.19.0, 1.18.0) and
//                     the 0.23.0 mod jar's 1.20.0 surface (artifacts/gate6c-b/v0230/, v0220/ and v0210/, each built from its tag).
//
//   node tools/api-compat.mjs --gate6cmp [--artifacts <dir>] [classesDir]
//                     phase 6c slice MP: the unchanged 0.18.0, 0.17.0 and 0.16.0 apitest jars (API 1.15.0, 1.14.0, 1.13.0) and the 0.18.0
//                     mod jar's 1.15.0 surface: the same jars as --gate6cf1 (v0.19.0 ships F1 and MP together).
//
//   node tools/api-compat.mjs --gate6cw [--artifacts <dir>] [classesDir]
//                     phase 6c slice W: the unchanged 0.17.0, 0.16.0 and 0.15.0 apitest jars (API 1.14.0, 1.13.0, 1.12.0) and the 0.17.0
//                     mod jar's 1.14.0 surface (artifacts/gate6c-w/v0170/, built from the v0.17.0 tag).
//   node tools/api-compat.mjs --gate6cd [--artifacts <dir>] [classesDir]
//                     phase 6c slice D1 (over v0.27.0): the unchanged 0.27.0, 0.26.0 and 0.25.0 apitest jars (API 1.24.0, 1.23.0, 1.22.0) and
//                     the 0.27.0 mod jar's 1.24.0 surface (artifacts/gate6c-d/v0270, built from the v0.27.0 tag with its tools/; PT's
//                     gate6c-pt/v0260 and v0250).
//   node tools/api-compat.mjs --gate6cs2 [--artifacts <dir>] [classesDir]
//                     phase 6c slice S2 (integrated over v0.30.0): the unchanged 0.30.0, 0.29.0 and 0.28.0 apitest jars (API 1.27.0, 1.26.0,
//                     1.25.0) and the 0.30.0 mod jar's 1.27.0 surface (artifacts/gate6c-s2/v0300, v0290, v0280, each built from its tag with
//                     its tools/).
//   node tools/api-compat.mjs --gate6ct3 [--artifacts <dir>] [classesDir]
//                     phase 6c slice T3 (over v0.35.0): the unchanged 0.35.0, 0.34.0 and 0.33.0 apitest jars (API 1.32.0, 1.31.0, 1.30.0) and
//                     the 0.35.0 mod jar's 1.32.0 surface (artifacts/gate6c-t3/v0350, v0340, v0330, each with its tag's tools/).
//   node tools/api-compat.mjs --gate6ch [--artifacts <dir>] [classesDir]
//                     phase 6c slice H (the H batch, over v0.36.1): the unchanged 0.36.1, 0.36.0 and 0.35.0 apitest jars (API 1.33.0,
//                     1.33.0, 1.32.0) and the 0.36.1 mod jar's 1.33.0 surface (artifacts/gate6c-h/v0361 and v0360, artifacts/gate6c-t3/v0350,
//                     each built from its tag, with its tag's tools/).
//   node tools/api-compat.mjs --gate6cvoc [--artifacts <dir>] [classesDir]
//                     phase 6c slice VOC (the VOC batch, over v0.37.1): the unchanged 0.37.1, 0.37.0 and 0.36.1 apitest jars (API 1.34.0,
//                     1.34.0, 1.33.0) and the 0.37.1 mod jar's 1.34.0 surface (artifacts/gate6c-voc/v0371 and v0370, each built from its tag
//                     with its tools/; H's v0361).
//   node tools/api-compat.mjs --gate6chy [--artifacts <dir>] [classesDir]
//                     phase 6c slice HY (the HY batch, over v0.38.0): the unchanged 0.38.0, 0.37.1 and 0.37.0 apitest jars (API 1.35.0,
//                     1.34.0, 1.34.0) and the 0.38.0 mod jar's 1.35.0 surface (artifacts/gate6c-hy/v0380, built from its tag with its tools/;
//                     VOC's v0371 and v0370). (The HY slices ran it over v0.37.0: 0.37.0, 0.36.1, 0.36.0.)
//   node tools/api-compat.mjs --gate6ckc [--artifacts <dir>] [classesDir]
//                     phase 6c slice KC (the patch over v0.39.0): the unchanged 0.39.0, 0.38.0 and 0.37.1 apitest jars (API 1.36.0, 1.35.0,
//                     1.34.0) and the 0.39.0 mod jar's 1.36.0 surface (artifacts/gate6c-kc/v0390, built from its tag with its tools/; HY's v0380,
//   node tools/api-compat.mjs --gate6ccu [--artifacts <dir>] [classesDir]
//                     phase 6c slice CU (over v0.39.0): the unchanged 0.39.0, 0.38.0 and 0.37.1 apitest jars (API 1.36.0, 1.35.0, 1.34.0)
//                     and the 0.39.0 mod jar's 1.36.0 surface (artifacts/gate6c-cu/v0390, built from its tag with its tools/; HY's v0380,
//                     VOC's v0371).
//   node tools/api-compat.mjs --gate7ak1 [--artifacts <dir>] [classesDir]
//                     phase 7a slice K1 (over v0.32.0): the unchanged 0.32.0, 0.31.1 and 0.31.0 apitest jars (API 1.29.0, 1.28.0, 1.28.0) and
//                     the 0.32.0 mod jar's 1.29.0 surface (artifacts/gate7a-k1/v0320, v0311, v0310, each built from its tag with its tools/).
//   node tools/api-compat.mjs --gate6cpt [--artifacts <dir>] [classesDir]
//                     phase 6c slice PT (over v0.25.0): the unchanged 0.25.0, 0.24.0 and 0.23.0 apitest jars (API 1.22.0, 1.21.0, 1.20.0) and
//                     the 0.25.0 mod jar's 1.22.0 surface (artifacts/gate6c-pt/v0250, built from the v0.25.0 tag with its tools/; T2's
//                     gate6c-t2/v0240 and B's gate6c-b/v0230).
//   node tools/api-compat.mjs --gate6cc33 [--artifacts <dir>] [classesDir]
//                     C33 (over v0.27.0): the unchanged 0.27.0, 0.26.0 and 0.25.0 apitest jars (API 1.24.0, 1.23.0, 1.22.0) and the 0.27.0 mod
//                     jar's 1.24.0 surface (artifacts/gate6c-c33/v0270, built from the v0.27.0 tag with its tools/; PT's gate6c-pt/v0260 and v0250).
//   node tools/api-compat.mjs --gate6ct2 [--artifacts <dir>] [classesDir]
//                     phase 6c slice T2 (over v0.24.0): the unchanged 0.24.0, 0.23.0 and 0.22.0 apitest jars (API 1.21.0, 1.20.0, 1.19.0) and
//                     the 0.24.0 mod jar's 1.21.0 surface (artifacts/gate6c-t2/v0240, built from the v0.24.0 tag with its tools/; B's
//                     gate6c-b/v0230 and v0220).
//
//   node tools/api-compat.mjs --gate6cp0 [--artifacts <dir>] [classesDir]
//                     phase 6c slice P0 (over v0.25.0): the unchanged 0.25.0, 0.24.0 and 0.23.0 apitest jars (API 1.22.0, 1.21.0, 1.20.0) and
//                     the 0.25.0 mod jar's 1.22.0 surface (artifacts/gate6c-p0/v0250, built from the v0.25.0 tag with its tools/; T2's
//                     gate6c-t2/v0240 and B's gate6c-b/v0230).
//   node tools/api-compat.mjs --gate6ct1 [--artifacts <dir>] [classesDir]
//                     phase 6c slice T1 (over v0.20.0): the unchanged 0.20.0, 0.19.0 and 0.18.0 apitest jars (API 1.17.0, 1.16.0, 1.15.0) and
//                     the 0.20.0 mod jar's 1.17.0 surface (SCH's sets in artifacts/gate6c-sch/v0200, v0190, v0180, each built from its tag).
//
//   node tools/api-compat.mjs --gate6cpt2 [--artifacts <dir>] [classesDir]
//                     phase 6c slice PT2 (over v0.27.0): the unchanged 0.27.0, 0.26.0 and 0.25.0 apitest jars (API 1.24.0, 1.23.0, 1.22.0)
//                     and the 0.27.0 mod jar's 1.24.0 surface (artifacts/gate6c-pt2/v0270, built from the v0.27.0 tag with its tools/;
//                     PT's v0260 and v0250).
//
//   node tools/api-compat.mjs --gate6cf1 [--artifacts <dir>] [classesDir]
//                     phase 6c slice F1: the unchanged 0.18.0, 0.17.0 and 0.16.0 apitest jars (API 1.15.0, 1.14.0, 1.13.0) and the 0.18.0
//                     mod jar's 1.15.0 surface (artifacts/gate6c-f1/v0180/, built from the v0.18.0 tag; 0.17.0 and 0.16.0 from earlier gates).
//
//   node tools/api-compat.mjs --gate6b [--artifacts <dir>] [classesDir]
//                     phase 6b (docs/CONTRACT.md "# Phase 6b contract" §6.1): the unchanged 1.8.0, 1.7.0 and 1.6.0 apitest jars by
//                     reference (artifacts/gate6b/v0110/architect_apitest-0.11.0.jar, gate6a/v0100/...-0.10.0.jar,
//                     gate5b/v090/...-0.9.0.jar) and the 0.11.0 mod jar's 1.8.0 surface (gate6b/v0110/architect_mc-0.11.0.jar).
//                     <dir> defaults to $ARCHITECT_ARTIFACTS, else ./artifacts, else ~/Developer/LarattaLabs/architect-mc/artifacts
//                     (the main checkout: artifacts/ is gitignored, so a worktree has none). Exit 1 when any check fails.
//
// classesDir defaults to mod/build/classes/java/{main,client} (run the mod's build first). JAVA_HOME's javap is used (else the PATH's).
// Also lists the old jar's switch maps over api enums (a $SwitchMap resolves constants by name, so inserted constants are safe
// for them; a pattern switch would show up as a MatchException reference). Exit 1 when a reference is missing.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (process.argv[2] === '--gate6b' || process.argv[2] === '--gate6c0a' || process.argv[2] === '--gate6c0b' || process.argv[2] === '--gate6cx' || process.argv[2] === '--gate6cw' || process.argv[2] === '--gate6cmp' || process.argv[2] === '--gate6cy2' || process.argv[2] === '--gate6cf1' || process.argv[2] === '--gate6ct1' || process.argv[2] === '--gate6csch' || process.argv[2] === '--gate6cf2' || process.argv[2] === '--gate6cb' || process.argv[2] === '--gate6ct2' || process.argv[2] === '--gate6cpt' || process.argv[2] === '--gate6cpt2' || process.argv[2] === '--gate6cp0' || process.argv[2] === '--gate6cc33' || process.argv[2] === '--gate6cd' || process.argv[2] === '--gate6cs2' || process.argv[2] === '--gate7ak1' || process.argv[2] === '--gate6ct3' || process.argv[2] === '--gate6ch' || process.argv[2] === '--gate6cvoc' || process.argv[2] === '--gate6chy' || process.argv[2] === '--gate6ckc' || process.argv[2] === '--gate6ccu') {
  const voc = process.argv[2] === '--gate6cvoc';
  const chy = process.argv[2] === '--gate6chy';
  const ckc = process.argv[2] === '--gate6ckc';
  const ccu = process.argv[2] === '--gate6ccu';
  const ch = process.argv[2] === '--gate6ch';
  const t3 = process.argv[2] === '--gate6ct3';
  const cd = process.argv[2] === '--gate6cd';
  const cs2 = process.argv[2] === '--gate6cs2';
  const k1 = process.argv[2] === '--gate7ak1';
  const cpt2 = process.argv[2] === '--gate6cpt2';
  const cc33 = process.argv[2] === '--gate6cc33';
  const cpt = process.argv[2] === '--gate6cpt';
  const cp0 = process.argv[2] === '--gate6cp0';
  const ct2 = process.argv[2] === '--gate6ct2';
  const cf2 = process.argv[2] === '--gate6cf2';
  const cb = process.argv[2] === '--gate6cb';
  const f1 = process.argv[2] === '--gate6cf1';
  const ct1 = process.argv[2] === '--gate6ct1';
  const cy2 = process.argv[2] === '--gate6cy2';
  const csch = process.argv[2] === '--gate6csch';
  const cx = process.argv[2] === '--gate6cx';
  const cw = process.argv[2] === '--gate6cw';
  const cmp = process.argv[2] === '--gate6cmp';
  const c0b = process.argv[2] === '--gate6c0b';
  const c0a = process.argv[2] === '--gate6c0a';
  const rest = process.argv.slice(3);
  let dir = process.env.ARCHITECT_ARTIFACTS;
  const ai = rest.indexOf('--artifacts');
  if (ai >= 0) {
    dir = rest[ai + 1];
    rest.splice(ai, 2);
  }
  if (!dir) {
    const local = path.join(root, 'artifacts');
    dir = ckc ? (fs.existsSync(path.join(local, 'gate6c-kc', 'v0390')) && fs.existsSync(path.join(local, 'gate6c-hy', 'v0380')) && fs.existsSync(path.join(local, 'gate6c-voc', 'v0371')) ? local : path.join(os.homedir(), 'Developer', 'LarattaLabs', 'architect-mc', 'artifacts'))
      : ccu ? (fs.existsSync(path.join(local, 'gate6c-cu', 'v0390')) && fs.existsSync(path.join(local, 'gate6c-hy', 'v0380')) && fs.existsSync(path.join(local, 'gate6c-voc', 'v0371')) ? local : path.join(os.homedir(), 'Developer', 'LarattaLabs', 'architect-mc', 'artifacts'))
      : chy ? (fs.existsSync(path.join(local, 'gate6c-hy', 'v0380')) && fs.existsSync(path.join(local, 'gate6c-voc', 'v0371')) && fs.existsSync(path.join(local, 'gate6c-voc', 'v0370')) ? local : path.join(os.homedir(), 'Developer', 'LarattaLabs', 'architect-mc', 'artifacts'))
      : voc ? (fs.existsSync(path.join(local, 'gate6c-voc', 'v0371')) && fs.existsSync(path.join(local, 'gate6c-voc', 'v0370')) && fs.existsSync(path.join(local, 'gate6c-h', 'v0361')) ? local : path.join(os.homedir(), 'Developer', 'LarattaLabs', 'architect-mc', 'artifacts'))
      : ch ? (fs.existsSync(path.join(local, 'gate6c-h', 'v0361')) && fs.existsSync(path.join(local, 'gate6c-h', 'v0360')) && fs.existsSync(path.join(local, 'gate6c-t3', 'v0350')) ? local : path.join(os.homedir(), 'Developer', 'LarattaLabs', 'architect-mc', 'artifacts'))
      : t3 ? (fs.existsSync(path.join(local, 'gate6c-t3', 'v0350')) && fs.existsSync(path.join(local, 'gate6c-t3', 'v0340')) && fs.existsSync(path.join(local, 'gate6c-t3', 'v0330')) ? local : path.join(os.homedir(), 'Developer', 'LarattaLabs', 'architect-mc', 'artifacts'))
      : k1 ? (fs.existsSync(path.join(local, 'gate7a-k1', 'v0320')) && fs.existsSync(path.join(local, 'gate7a-k1', 'v0311')) && fs.existsSync(path.join(local, 'gate7a-k1', 'v0310')) ? local : path.join(os.homedir(), 'Developer', 'LarattaLabs', 'architect-mc', 'artifacts'))
      : cs2 ? (fs.existsSync(path.join(local, 'gate6c-s2', 'v0300')) && fs.existsSync(path.join(local, 'gate6c-s2', 'v0290')) && fs.existsSync(path.join(local, 'gate6c-s2', 'v0280')) ? local : path.join(os.homedir(), 'Developer', 'LarattaLabs', 'architect-mc', 'artifacts'))
      : cd ? (fs.existsSync(path.join(local, 'gate6c-d', 'v0270')) && fs.existsSync(path.join(local, 'gate6c-pt', 'v0260')) ? local : path.join(os.homedir(), 'Developer', 'LarattaLabs', 'architect-mc', 'artifacts'))
      : cpt2 ? (fs.existsSync(path.join(local, 'gate6c-pt2', 'v0270')) && fs.existsSync(path.join(local, 'gate6c-pt', 'v0260')) ? local : path.join(os.homedir(), 'Developer', 'LarattaLabs', 'architect-mc', 'artifacts'))
      : cc33 ? (fs.existsSync(path.join(local, 'gate6c-c33', 'v0270')) && fs.existsSync(path.join(local, 'gate6c-pt', 'v0260')) ? local : path.join(os.homedir(), 'Developer', 'LarattaLabs', 'architect-mc', 'artifacts'))
      : cpt ? (fs.existsSync(path.join(local, 'gate6c-pt', 'v0260')) && fs.existsSync(path.join(local, 'gate6c-pt', 'v0250')) ? local : path.join(os.homedir(), 'Developer', 'LarattaLabs', 'architect-mc', 'artifacts'))
      : cp0 ? (fs.existsSync(path.join(local, 'gate6c-p0', 'v0250')) && fs.existsSync(path.join(local, 'gate6c-t2', 'v0240')) ? local : path.join(os.homedir(), 'Developer', 'LarattaLabs', 'architect-mc', 'artifacts'))
      : ct2 ? (fs.existsSync(path.join(local, 'gate6c-t2', 'v0240')) && fs.existsSync(path.join(local, 'gate6c-b', 'v0230')) ? local : path.join(os.homedir(), 'Developer', 'LarattaLabs', 'architect-mc', 'artifacts'))
      : cb ? (fs.existsSync(path.join(local, 'gate6c-b', 'v0230')) ? local : path.join(os.homedir(), 'Developer', 'LarattaLabs', 'architect-mc', 'artifacts'))
      : cf2 ? (fs.existsSync(path.join(local, 'gate6c-f2', 'v0220')) && fs.existsSync(path.join(local, 'gate6c-sch', 'v0200')) ? local : path.join(os.homedir(), 'Developer', 'LarattaLabs', 'architect-mc', 'artifacts')) : (ct1 || csch) ? (fs.existsSync(path.join(local, 'gate6c-sch', 'v0200')) ? local : path.join(os.homedir(), 'Developer', 'LarattaLabs', 'architect-mc', 'artifacts')) : fs.existsSync(path.join(local, (f1 || cmp) ? 'gate6c-f1' : (cw || cy2) ? 'gate6c-w' : cx ? 'gate6c-x' : c0a ? 'gate6c0a' : 'gate6b', (f1 || cmp) ? 'v0180' : (cw || cy2) ? 'v0170' : cx ? 'v0160' : c0a ? 'v0120' : 'v0110')) ? local : path.join(os.homedir(), 'Developer', 'LarattaLabs', 'architect-mc', 'artifacts');
  }
  // (6c 0a) the unchanged 0.12.0, 0.11.0 and 0.10.0 apitest jars (API 1.9.0, 1.8.0, 1.7.0) and the 0.12.0 mod jar's 1.9.0 surface
  const checks = ckc ? [ // (6c KC, the patch over v0.39.0) 0.39.0 (built from its tag here), 0.38.0 (HY's) and 0.37.1 (VOC's), each with its tag's tools/
    ['0.39.0 apitest (API 1.36.0)', [path.join(dir, 'gate6c-kc', 'v0390', 'architect_apitest-0.39.0.jar')]],
    ['0.38.0 apitest (API 1.35.0)', [path.join(dir, 'gate6c-hy', 'v0380', 'architect_apitest-0.38.0.jar')]],
    ['0.37.1 apitest (API 1.34.0)', [path.join(dir, 'gate6c-voc', 'v0371', 'architect_apitest-0.37.1.jar')]],
    ['1.36.0 surface (0.39.0)', ['--surface', path.join(dir, 'gate6c-kc', 'v0390', 'architect_mc-0.39.0.jar')]],
  ] : ccu ? [ // (6c CU, over v0.39.0: main's latest three releases) 0.39.0 (built from its tag here), 0.38.0 (HY's), 0.37.1 (VOC's), each with its tag's tools/
    ['0.39.0 apitest (API 1.36.0)', [path.join(dir, 'gate6c-cu', 'v0390', 'architect_apitest-0.39.0.jar')]],
    ['0.38.0 apitest (API 1.35.0)', [path.join(dir, 'gate6c-hy', 'v0380', 'architect_apitest-0.38.0.jar')]],
    ['0.37.1 apitest (API 1.34.0)', [path.join(dir, 'gate6c-voc', 'v0371', 'architect_apitest-0.37.1.jar')]],
    ['1.36.0 surface (0.39.0)', ['--surface', path.join(dir, 'gate6c-cu', 'v0390', 'architect_mc-0.39.0.jar')]],
  ] : chy ? [ // (6c HY, the batch over v0.38.0) 0.38.0 (built from its tag here), 0.37.1 and 0.37.0 (VOC's), each with its tag's tools/
    ['0.38.0 apitest (API 1.35.0)', [path.join(dir, 'gate6c-hy', 'v0380', 'architect_apitest-0.38.0.jar')]],
    ['0.37.1 apitest (API 1.34.0)', [path.join(dir, 'gate6c-voc', 'v0371', 'architect_apitest-0.37.1.jar')]],
    ['0.37.0 apitest (API 1.34.0)', [path.join(dir, 'gate6c-voc', 'v0370', 'architect_apitest-0.37.0.jar')]],
    ['1.35.0 surface (0.38.0)', ['--surface', path.join(dir, 'gate6c-hy', 'v0380', 'architect_mc-0.38.0.jar')]],
  ] : voc ? [ // (6c VOC, the batch over v0.37.1) 0.37.1 and 0.37.0 (built from their tags here), 0.36.1 (H's), each with its tag's tools/
    ['0.37.1 apitest (API 1.34.0)', [path.join(dir, 'gate6c-voc', 'v0371', 'architect_apitest-0.37.1.jar')]],
    ['0.37.0 apitest (API 1.34.0)', [path.join(dir, 'gate6c-voc', 'v0370', 'architect_apitest-0.37.0.jar')]],
    ['0.36.1 apitest (API 1.33.0)', [path.join(dir, 'gate6c-h', 'v0361', 'architect_apitest-0.36.1.jar')]],
    ['1.34.0 surface (0.37.1)', ['--surface', path.join(dir, 'gate6c-voc', 'v0371', 'architect_mc-0.37.1.jar')]],
  ] : ch ? [ // (6c H, the batch over v0.36.1) 0.36.1 and 0.36.0 (built from their tags here), 0.35.0 (T3's), each with its tag's tools/
    ['0.36.1 apitest (API 1.33.0)', [path.join(dir, 'gate6c-h', 'v0361', 'architect_apitest-0.36.1.jar')]],
    ['0.36.0 apitest (API 1.33.0)', [path.join(dir, 'gate6c-h', 'v0360', 'architect_apitest-0.36.0.jar')]],
    ['0.35.0 apitest (API 1.32.0)', [path.join(dir, 'gate6c-t3', 'v0350', 'architect_apitest-0.35.0.jar')]],
    ['1.33.0 surface (0.36.1)', ['--surface', path.join(dir, 'gate6c-h', 'v0361', 'architect_mc-0.36.1.jar')]],
  ] : t3 ? [ // (6c T3, over v0.35.0) 0.35.0, 0.34.0 and 0.33.0, each built from its tag (with its tag's tools/)
    ['0.35.0 apitest (API 1.32.0)', [path.join(dir, 'gate6c-t3', 'v0350', 'architect_apitest-0.35.0.jar')]],
    ['0.34.0 apitest (API 1.31.0)', [path.join(dir, 'gate6c-t3', 'v0340', 'architect_apitest-0.34.0.jar')]],
    ['0.33.0 apitest (API 1.30.0)', [path.join(dir, 'gate6c-t3', 'v0330', 'architect_apitest-0.33.0.jar')]],
    ['1.32.0 surface', ['--surface', path.join(dir, 'gate6c-t3', 'v0350', 'architect_mc-0.35.0.jar')]],
  ] : k1 ? [ // (7a K1, over v0.32.0) 0.32.0, 0.31.1 and 0.31.0, each built from its tag (with its tag's tools/)
    ['0.32.0 apitest (API 1.29.0)', [path.join(dir, 'gate7a-k1', 'v0320', 'architect_apitest-0.32.0.jar')]],
    ['0.31.1 apitest (API 1.28.0)', [path.join(dir, 'gate7a-k1', 'v0311', 'architect_apitest-0.31.1.jar')]],
    ['0.31.0 apitest (API 1.28.0)', [path.join(dir, 'gate7a-k1', 'v0310', 'architect_apitest-0.31.0.jar')]],
    ['1.29.0 surface', ['--surface', path.join(dir, 'gate7a-k1', 'v0320', 'architect_mc-0.32.0.jar')]],
  ] : cs2 ? [ // (S2, integrated over v0.30.0) 0.30.0, 0.29.0 and 0.28.0, each built from its tag (with its tag's tools/)
    ['1.27.0 apitest', [path.join(dir, 'gate6c-s2', 'v0300', 'architect_apitest-0.30.0.jar')]],
    ['1.26.0 apitest', [path.join(dir, 'gate6c-s2', 'v0290', 'architect_apitest-0.29.0.jar')]],
    ['1.25.0 apitest', [path.join(dir, 'gate6c-s2', 'v0280', 'architect_apitest-0.28.0.jar')]],
    ['1.27.0 surface', ['--surface', path.join(dir, 'gate6c-s2', 'v0300', 'architect_mc-0.30.0.jar')]],
  ] : cd ? [ // (6c D1, over v0.27.0) 0.27.0 built from its tag by D (with its tools/); PT's 0.26.0 and 0.25.0 tag builds
    ['1.24.0 apitest', [path.join(dir, 'gate6c-d', 'v0270', 'architect_apitest-0.27.0.jar')]],
    ['1.23.0 apitest', [path.join(dir, 'gate6c-pt', 'v0260', 'architect_apitest-0.26.0.jar')]],
    ['1.22.0 apitest', [path.join(dir, 'gate6c-pt', 'v0250', 'architect_apitest-0.25.0.jar')]],
    ['1.24.0 surface', ['--surface', path.join(dir, 'gate6c-d', 'v0270', 'architect_mc-0.27.0.jar')]],
  ] : cpt2 ? [ // (PT2, over v0.27.0) 0.27.0 built from its tag by PT2; PT's 0.26.0 and 0.25.0 tag builds
    ['1.24.0 apitest', [path.join(dir, 'gate6c-pt2', 'v0270', 'architect_apitest-0.27.0.jar')]],
    ['1.23.0 apitest', [path.join(dir, 'gate6c-pt', 'v0260', 'architect_apitest-0.26.0.jar')]],
    ['1.22.0 apitest', [path.join(dir, 'gate6c-pt', 'v0250', 'architect_apitest-0.25.0.jar')]],
    ['1.24.0 surface', ['--surface', path.join(dir, 'gate6c-pt2', 'v0270', 'architect_mc-0.27.0.jar')]],
  ] : cc33 ? [ // (C33, over v0.27.0) 0.27.0 built from its tag by C33; PT's 0.26.0 and 0.25.0 tag builds
    ['1.24.0 apitest', [path.join(dir, 'gate6c-c33', 'v0270', 'architect_apitest-0.27.0.jar')]],
    ['1.23.0 apitest', [path.join(dir, 'gate6c-pt', 'v0260', 'architect_apitest-0.26.0.jar')]],
    ['1.22.0 apitest', [path.join(dir, 'gate6c-pt', 'v0250', 'architect_apitest-0.25.0.jar')]],
    ['1.24.0 surface', ['--surface', path.join(dir, 'gate6c-c33', 'v0270', 'architect_mc-0.27.0.jar')]],
  ] : cpt ? [ // (PT, over v0.26.0) 0.26.0 and 0.25.0 built from their tags by PT; T2's 0.24.0 tag build
    ['1.23.0 apitest', [path.join(dir, 'gate6c-pt', 'v0260', 'architect_apitest-0.26.0.jar')]],
    ['1.22.0 apitest', [path.join(dir, 'gate6c-pt', 'v0250', 'architect_apitest-0.25.0.jar')]],
    ['1.21.0 apitest', [path.join(dir, 'gate6c-t2', 'v0240', 'architect_apitest-0.24.0.jar')]],
    ['1.23.0 surface', ['--surface', path.join(dir, 'gate6c-pt', 'v0260', 'architect_mc-0.26.0.jar')]],
  ] : cp0 ? [ // (P0, over v0.25.0) 0.25.0 built from its tag by P0; T2's 0.24.0 and B's 0.23.0 tag builds
    ['1.22.0 apitest', [path.join(dir, 'gate6c-p0', 'v0250', 'architect_apitest-0.25.0.jar')]],
    ['1.21.0 apitest', [path.join(dir, 'gate6c-t2', 'v0240', 'architect_apitest-0.24.0.jar')]],
    ['1.20.0 apitest', [path.join(dir, 'gate6c-b', 'v0230', 'architect_apitest-0.23.0.jar')]],
    ['1.22.0 surface', ['--surface', path.join(dir, 'gate6c-p0', 'v0250', 'architect_mc-0.25.0.jar')]],
  ] : ct2 ? [ // (T2, over v0.24.0) 0.24.0 built from its tag by T2; B's 0.23.0 and 0.22.0 tag builds
    ['1.21.0 apitest', [path.join(dir, 'gate6c-t2', 'v0240', 'architect_apitest-0.24.0.jar')]],
    ['1.20.0 apitest', [path.join(dir, 'gate6c-b', 'v0230', 'architect_apitest-0.23.0.jar')]],
    ['1.19.0 apitest', [path.join(dir, 'gate6c-b', 'v0220', 'architect_apitest-0.22.0.jar')]],
    ['1.21.0 surface', ['--surface', path.join(dir, 'gate6c-t2', 'v0240', 'architect_mc-0.24.0.jar')]],
  ] : cb ? [ // (6c B, over v0.23.1) 0.23.0, 0.22.0 and 0.21.0, each built from its tag by B
    ['1.20.0 apitest', [path.join(dir, 'gate6c-b', 'v0230', 'architect_apitest-0.23.0.jar')]],
    ['1.19.0 apitest', [path.join(dir, 'gate6c-b', 'v0220', 'architect_apitest-0.22.0.jar')]],
    ['1.18.0 apitest', [path.join(dir, 'gate6c-b', 'v0210', 'architect_apitest-0.21.0.jar')]],
    ['1.20.0 surface', ['--surface', path.join(dir, 'gate6c-b', 'v0230', 'architect_mc-0.23.0.jar')]],
  ] : cf2 ? [ // (6c F2, over v0.22.0) 0.22.0 and 0.21.0 built from their tags by F2; SCH's 0.20.0
    ['1.19.0 apitest', [path.join(dir, 'gate6c-f2', 'v0220', 'architect_apitest-0.22.0.jar')]],
    ['1.18.0 apitest', [path.join(dir, 'gate6c-f2', 'v0210', 'architect_apitest-0.21.0.jar')]],
    ['1.17.0 apitest', [path.join(dir, 'gate6c-sch', 'v0200', 'architect_apitest-0.20.0.jar')]],
    ['1.19.0 surface', ['--surface', path.join(dir, 'gate6c-f2', 'v0220', 'architect_mc-0.22.0.jar')]],
  ] : (ct1 || csch) ? [ // (v0.21.0, T1 and SCH) SCH's complete jar sets, each built from its tag
    ['1.17.0 apitest', [path.join(dir, 'gate6c-sch', 'v0200', 'architect_apitest-0.20.0.jar')]],
    ['1.16.0 apitest', [path.join(dir, 'gate6c-sch', 'v0190', 'architect_apitest-0.19.0.jar')]],
    ['1.15.0 apitest', [path.join(dir, 'gate6c-sch', 'v0180', 'architect_apitest-0.18.0.jar')]],
    ['1.17.0 surface', ['--surface', path.join(dir, 'gate6c-sch', 'v0200', 'architect_mc-0.20.0.jar')]],
  ] : (f1 || cmp) ? [ // (v0.19.0) F1 and MP share one jar set
    ['1.15.0 apitest', [path.join(dir, 'gate6c-f1', 'v0180', 'architect_apitest-0.18.0.jar')]],
    ['1.14.0 apitest', [path.join(dir, 'gate6c-w', 'v0170', 'architect_apitest-0.17.0.jar')]],
    ['1.13.0 apitest', [path.join(dir, 'gate6c-x', 'v0160', 'architect_apitest-0.16.0.jar')]],
    ['1.15.0 surface', ['--surface', path.join(dir, 'gate6c-f1', 'v0180', 'architect_mc-0.18.0.jar')]],
  ] : (cw || cy2) ? [
    ['1.14.0 apitest', [path.join(dir, 'gate6c-w', 'v0170', 'architect_apitest-0.17.0.jar')]],
    ['1.13.0 apitest', [path.join(dir, 'gate6c-x', 'v0160', 'architect_apitest-0.16.0.jar')]],
    ['1.12.0 apitest', [path.join(dir, 'gate6c-v', 'v0150', 'architect_apitest-0.15.0.jar')]],
    ['1.14.0 surface', ['--surface', path.join(dir, 'gate6c-w', 'v0170', 'architect_mc-0.17.0.jar')]],
  ] : cx ? [
    ['1.13.0 apitest', [path.join(dir, 'gate6c-x', 'v0160', 'architect_apitest-0.16.0.jar')]],
    ['1.12.0 apitest', [path.join(dir, 'gate6c-v', 'v0150', 'architect_apitest-0.15.0.jar')]],
    ['1.11.0 apitest', [path.join(dir, 'gate6c0c', 'v0140', 'architect_apitest-0.14.0.jar')]],
    ['1.13.0 surface', ['--surface', path.join(dir, 'gate6c-x', 'v0160', 'architect_mc-0.16.0.jar')]],
  ] : c0b ? [
    ['1.10.0 apitest', [path.join(dir, 'gate6c0b', 'v0130', 'architect_apitest-0.13.0.jar')]],
    ['1.9.0 apitest', [path.join(dir, 'gate6c0a', 'v0120', 'architect_apitest-0.12.0.jar')]],
    ['1.8.0 apitest', [path.join(dir, 'gate6b', 'v0110', 'architect_apitest-0.11.0.jar')]],
    ['1.10.0 surface', ['--surface', path.join(dir, 'gate6c0b', 'v0130', 'architect_mc-0.13.0.jar')]],
  ] : c0a ? [
    ['1.9.0 apitest', [path.join(dir, 'gate6c0a', 'v0120', 'architect_apitest-0.12.0.jar')]],
    ['1.8.0 apitest', [path.join(dir, 'gate6b', 'v0110', 'architect_apitest-0.11.0.jar')]],
    ['1.7.0 apitest', [path.join(dir, 'gate6a', 'v0100', 'architect_apitest-0.10.0.jar')]],
    ['1.9.0 surface', ['--surface', path.join(dir, 'gate6c0a', 'v0120', 'architect_mc-0.12.0.jar')]],
  ] : [
    ['1.8.0 apitest', [path.join(dir, 'gate6b', 'v0110', 'architect_apitest-0.11.0.jar')]],
    ['1.7.0 apitest', [path.join(dir, 'gate6a', 'v0100', 'architect_apitest-0.10.0.jar')]],
    ['1.6.0 apitest', [path.join(dir, 'gate5b', 'v090', 'architect_apitest-0.9.0.jar')]],
    ['1.8.0 surface', ['--surface', path.join(dir, 'gate6b', 'v0110', 'architect_mc-0.11.0.jar')]],
  ];
  let failed = 0;
  for (const [name, a] of checks) {
    const jarPath = a[a.length - 1];
    if (!fs.existsSync(jarPath)) {
      console.log(`FAIL ${name}: ${jarPath} is missing`);
      failed++;
      continue;
    }
    try {
      const out = execFileSync(process.execPath, [fileURLToPath(import.meta.url), ...a, ...rest], { encoding: 'utf8', maxBuffer: 64 << 20 });
      console.log(`ok   ${name}: ${out.trim().split('\n').pop()}`);
    } catch (e) {
      failed++;
      console.log(`FAIL ${name}:\n${(e.stdout || '') + (e.stderr || '')}`);
    }
  }
  console.log(failed ? `${failed} of ${checks.length} checks failed` : `all ${checks.length} checks clean`);
  process.exit(failed ? 1 : 0);
}
const surface = process.argv[2] === '--surface';
const args = surface ? process.argv.slice(3) : process.argv.slice(2);
const jar = args[0];
// a classesDir may list several dirs (path.delimiter-separated: main and client)
const classDirs = args[1] ? args[1].split(path.delimiter).map((d) => path.resolve(d)) : ['main', 'client'].map((s) => path.join(root, 'mod', 'build', 'classes', 'java', s));
if (!jar) {
  console.error('usage: node tools/api-compat.mjs [--surface] <old.jar> [classesDir]');
  process.exit(2);
}
const javap = process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, 'bin', 'javap') : 'javap';
const API = 'dev/larattalabs/architect/api/';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'api-compat-'));
execFileSync('unzip', ['-q', '-o', path.resolve(jar), '-d', tmp]);
const classFiles = [];
const walk = (d) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.class')) classFiles.push(p);
  }
};
walk(tmp);

// ---- 1. the references (or, with --surface, the old api's public and protected members)
const refs = new Map(); // "owner.name:desc" -> kind
let patternSwitch = false;
const switchMaps = new Set();
for (const f of surface ? [] : classFiles) {
  const out = execFileSync(javap, ['-v', '-p', f], { encoding: 'utf8', maxBuffer: 64 << 20 });
  for (const line of out.split('\n')) {
    const m = /=\s+(Methodref|InterfaceMethodref|Fieldref)\s+#\d+\.#\d+\s+\/\/\s+(\S+)\.("?[^:"]+"?):(\S+)/.exec(line);
    if (m && m[2].startsWith(API)) refs.set(`${m[2]}.${m[3].replace(/"/g, '')}:${m[4]}`, m[1]);
    if (/java\/lang\/MatchException/.test(line)) patternSwitch = true;
    const sm = /\$SwitchMap\$(dev\$larattalabs\$architect\$api\$[A-Za-z0-9$]+)/.exec(line);
    if (sm) switchMaps.add(sm[1].replace(/\$/g, '.'));
  }
}

if (surface) {
  for (const f of classFiles) {
    const rel = path.relative(tmp, f).replace(/\\/g, '/');
    if (!rel.startsWith(API) || !rel.endsWith('.class')) continue;
    const cls = rel.slice(0, -'.class'.length);
    const out = execFileSync(javap, ['-protected', '-s', f], { encoding: 'utf8' }).split('\n');
    for (let i = 0; i < out.length; i++) {
      const d = /^\s+descriptor: (\S+)/.exec(out[i]);
      if (!d) continue;
      const sig = out[i - 1].trim().replace(/;$/, '');
      let name;
      if (sig.includes('(')) {
        const before = sig.slice(0, sig.indexOf('('));
        name = before.split(/\s+/).pop();
        name = sig === 'static {}' ? '<clinit>' : name === cls.replace(/\//g, '.') ? '<init>' : name.split('.').pop();
      } else name = sig.split(/\s+/).pop();
      if (name === '<clinit>') continue;
      refs.set(`${cls}.${name}:${d[1]}`, 'member');
    }
  }
}

// ---- 2. what the new classes declare (and inherit through their api supertypes)
const declared = new Map(); // class -> Set("name:desc")
const supers = new Map();
const load = (cls) => {
  if (declared.has(cls)) return declared.get(cls);
  const file = classDirs.map((d) => path.join(d, `${cls}.class`)).find((f) => fs.existsSync(f));
  const set = new Set();
  declared.set(cls, set);
  // a JDK supertype (an api exception's Throwable, say): its public and protected members, by class name from the running JDK
  const jdk = !file && cls.startsWith('java/');
  if (!file && !jdk) return set;
  let out;
  try {
    out = jdk ? execFileSync(javap, ['-protected', '-s', cls.replace(/\//g, '.')], { encoding: 'utf8' }) : execFileSync(javap, ['-p', '-s', file], { encoding: 'utf8' });
  } catch {
    return set;
  }
  const lines = out.split('\n');
  const head = lines.find((l) => /\b(class|interface|enum|record)\b/.test(l) && l.includes('{')) ?? '';
  const sup = [];
  for (const m of head.matchAll(/(?:extends|implements)\s+([\w.$<>, ]+?)(?=\s+(?:implements|\{))/g)) {
    for (const s of m[1].split(',')) sup.push(s.trim().replace(/<.*$/, '').replace(/\./g, '/'));
  }
  supers.set(cls, sup);
  for (let i = 0; i < lines.length; i++) {
    const d = /^\s+descriptor: (\S+)/.exec(lines[i]);
    if (!d) continue;
    const sig = lines[i - 1].trim().replace(/;$/, '');
    let name;
    if (sig.includes('(')) {
      const before = sig.slice(0, sig.indexOf('('));
      name = before.split(/\s+/).pop();
      if (sig === 'static {}') name = '<clinit>';
      else name = name === cls.replace(/\//g, '.') ? '<init>' : name.split('.').pop();
    } else {
      name = sig.split(/\s+/).pop();
    }
    set.add(`${name}:${d[1]}`);
  }
  return set;
};
// what java.lang.Enum / Object / Record give every api type
const INHERITED = new Set(['name:()Ljava/lang/String;', 'ordinal:()I', 'toString:()Ljava/lang/String;', 'hashCode:()I', 'equals:(Ljava/lang/Object;)Z',
  'getClass:()Ljava/lang/Class;']);
const has = (cls, member, seen = new Set()) => {
  if (seen.has(cls)) return false;
  seen.add(cls);
  if (load(cls).has(member)) return true;
  if (load(cls).size && INHERITED.has(member)) return true;
  // members inherited through api supertypes, and (6c Y1) through JDK supertypes: an api exception's getMessage is Throwable's
  return (supers.get(cls) ?? []).some((s) => (s.startsWith(API) || s.startsWith('java/')) && has(s, member, seen));
};

const missing = [];
for (const [ref, kind] of [...refs].sort()) {
  const dot = ref.indexOf('.', API.length + 1) >= 0 ? ref.lastIndexOf('.', ref.indexOf(':')) : -1;
  const cls = ref.slice(0, dot);
  const member = ref.slice(dot + 1);
  // enum helpers and record methods the compiler made exist on the class too
  if (!has(cls, member)) missing.push(`${kind} ${cls.replace(/\//g, '.')}.${member}`);
}
fs.rmSync(tmp, { recursive: true, force: true });

console.log(surface ? `${refs.size} public/protected api members of ${path.basename(jar)}, checked against ${classDirs.map((d) => path.relative(root, d)).join(' + ')}` : `${refs.size} api references in ${path.basename(jar)} (${classFiles.length} classes), checked against ${classDirs.map((d) => path.relative(root, d)).join(' + ')}`);
if (switchMaps.size) console.log(`switch maps over api enums (resolved by name, safe for inserted constants): ${[...switchMaps].sort().join(', ')}`);
console.log(patternSwitch ? 'WARN: a pattern switch (MatchException) exists in the jar: inserted enum constants may reach its default' : 'no pattern switches (MatchException) in the jar');
if (missing.length) {
  console.log(`MISSING ${missing.length}:`);
  for (const m of missing) console.log(`  ${m}`);
  process.exit(1);
}
console.log('every referenced api member exists with the same descriptor');
