import { defineConfig } from 'vitest/config';
import { useRamTmp, loudEnospc } from '../tools/lib/ram-tmp.mjs';

// slice TS: the workers (forks inherit the env) make their temp dirs on the RAM disk when usable (ARCH_NO_RAMDISK=1 off)
useRamTmp();
loudEnospc();

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    setupFiles: ['test/setup-tmp.ts'],
    testTimeout: 1_800_000,
    hookTimeout: 1_800_000,
    pool: 'forks',
  },
});
