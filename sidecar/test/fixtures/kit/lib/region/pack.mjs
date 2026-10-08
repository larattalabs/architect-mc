// FAKE kit/lib/region/pack.mjs (sidecar tests): gzipPinned only (gzip level 6, mtime 0, OS byte 255).
import zlib from 'node:zlib';

export function gzipPinned(buf) {
  const gz = zlib.gzipSync(buf, { level: 6 });
  gz.writeUInt32LE(0, 4);
  gz[9] = 255;
  return gz;
}
