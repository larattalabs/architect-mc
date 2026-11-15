// Slice TS: every arch-* temp dir a test file made (test/helpers.ts tempDir, archTmpDir) goes once the file's own hooks ran
// (setup-file hooks run last). ARCH_KEEP_TMP=1 keeps them for debugging; tools/tmp-sweep.mjs removes them later.
import { afterAll } from 'vitest';
import { cleanupArchTmp } from '../../tools/lib/arch-tmp.mjs';

afterAll(() => cleanupArchTmp());
