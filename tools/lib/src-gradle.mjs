// One gradle at a time in a checkout's mod/ (docs/GATES.md "Gradle in the source checkout"). The gate drivers' unit and
// apicompat steps run `./gradlew test --tests ...` or `compileJava` in this checkout's mod/, and the runner may run several of
// them at once on different shards. Two gradle builds in one project dir fight over its build dir and caches: K1a's b-unit and
// pt-unit started 5 s apart and both ended `gradlew` exit 1 with every test passing. srcGradle() serialises those calls across
// processes with a small lock directory (mkdir is atomic); a lock whose pid is dead is stale and taken over.

import fs from 'node:fs';
import path from 'node:path';

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
};

/** Runs fn() (a synchronous gradle call in `<root>/mod`) holding that checkout's gradle lock; returns fn()'s result. */
export function srcGradle(root, fn, { maxWaitMs = 45 * 60_000 } = {}) {
  const dir = path.join(root, 'mod', '.gradle');
  fs.mkdirSync(dir, { recursive: true });
  const lock = path.join(dir, 'gate-gradle.lock');
  const t0 = Date.now();
  let told = false;
  let held = false;
  while (!held) {
    try {
      fs.mkdirSync(lock);
      fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, since: new Date().toISOString(), argv: process.argv.slice(1).join(' ') }));
      held = true;
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
    let owner = null;
    try {
      owner = JSON.parse(fs.readFileSync(path.join(lock, 'owner.json'), 'utf8'));
    } catch {
      // being written: wait a moment; an owner-less lock older than 30 s is stale
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > 30_000) fs.rmSync(lock, { recursive: true, force: true });
      } catch {
        // raced
      }
    }
    if (owner?.pid && !alive(owner.pid)) {
      fs.rmSync(lock, { recursive: true, force: true });
      continue;
    }
    if (!told) {
      console.log(`  gradle: waiting for another gate step's gradle in ${path.join(root, 'mod')} (pid ${owner?.pid ?? '?'}: ${owner?.argv ?? ''})`);
      told = true;
    }
    if (Date.now() - t0 > maxWaitMs) {
      console.log(`  gradle: still locked after ${Math.round(maxWaitMs / 60_000)} min: running anyway`);
      break;
    }
    sleepSync(1000);
  }
  if (told && held) console.log(`  gradle: lock taken after ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  try {
    return fn();
  } finally {
    if (held) {
      try {
        fs.rmSync(lock, { recursive: true, force: true });
      } catch {
        // gone
      }
    }
  }
}
