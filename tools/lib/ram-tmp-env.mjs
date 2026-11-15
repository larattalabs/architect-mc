// Import first (a side effect): point this process's TMPDIR, and so its children's, at the RAM disk when usable, and print a
// full RAM disk's ENOSPC with the fix (tools/lib/ram-tmp.mjs; slice TS). The gate runner, eval and run-headless-server import it.
import { useRamTmp, loudEnospc } from './ram-tmp.mjs';

export const ramTmpNote = useRamTmp();
loudEnospc();
