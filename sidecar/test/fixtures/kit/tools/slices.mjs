// Test fixture: `node kit/tools/slices.mjs <nbt> [--sidecar f] [--storeys] [--max-chars N]` prints a fake slice.
import fs from 'node:fs';
const nbt = process.argv[2];
if (!nbt || !fs.existsSync(nbt)) { console.error('usage: slices.mjs <nbt>'); process.exit(2); }
console.log('-- y=1 --\n    0123\n  0 AAAA\n  1 A..A\nlegend: A=spruce_planks');
