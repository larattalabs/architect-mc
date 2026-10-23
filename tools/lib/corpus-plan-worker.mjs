// (gate speed 3) A prewarm worker (corpus-plan.mjs prewarm): runs { module, export, args } jobs, one at a time, and answers each.
import { parentPort } from 'node:worker_threads';

parentPort.on('message', async (j) => {
  try {
    const m = await import(j.module);
    await m[j.export](...j.args);
    parentPort.postMessage({ ok: true, id: j.id });
  } catch (e) {
    parentPort.postMessage({ ok: false, id: j.id, err: String(e?.message ?? e).slice(0, 300) });
  }
});
