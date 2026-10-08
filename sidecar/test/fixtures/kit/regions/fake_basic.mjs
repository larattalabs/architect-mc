// FAKE bundled region program (sidecar tests). params: pad (bytes of padding in the IR), throw (a message), loop
// (spin forever), net (try the network), writeOutside (a path to write), notes ([string]), stages ([name]),
// slowMs (every tile takes that long), tileGrid (n: tiles 0..n-1 squared, for the bench).
import fs from 'node:fs';

export default async function plan(ctx) {
  const p = ctx.params;
  if (p.throw) throw new Error(p.throw);
  if (p.loop) for (;;);
  if (p.net) await fetch('http://127.0.0.1:9/');
  if (p.writeOutside) fs.writeFileSync(p.writeOutside, 'escaped');
  if (p.readOutside) fs.readFileSync(p.readOutside);
  return {
    ...(p.pad ? { padding: 'x'.repeat(p.pad) } : {}),
    ...(p.stages ? { stages: p.stages } : {}),
    ...(p.slowMs ? { slowMs: p.slowMs } : {}),
    ...(p.tileGrid ? { tiles: { ground: { terrain: Array.from({ length: p.tileGrid * p.tileGrid }, (_, i) => `${i % p.tileGrid},${Math.floor(i / p.tileGrid)}`), path: [] } } } : {}),
    lots: [{ id: 'L1', stage: 'ground', at: [ctx.claim.minX + 4, ctx.claim.minZ + 4], size: [8, 8] }],
    notes: p.notes ?? [],
  };
}
