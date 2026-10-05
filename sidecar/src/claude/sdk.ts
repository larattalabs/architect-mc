// The Claude Agent SDK, loaded on demand. The sidecar must start and serve status without it (the
// mod's launcher installs it with `npm ci --omit=dev` on first run), so nothing imports it
// statically: dist/main.mjs leaves it external and this resolves it from <sidecarDir>/node_modules.
// A failed load is retried on the next call (the install may have finished since).
import type * as SdkModule from '@anthropic-ai/claude-agent-sdk';

export type Sdk = typeof SdkModule;

// specifiers in variables: esbuild leaves these imports alone, so both resolve from node_modules
// at run time (the SDK's tool() schemas then use the same zod copy as the SDK itself)
const SDK_SPEC = '@anthropic-ai/claude-agent-sdk';
const ZOD_SPEC = 'zod';

let cached: Sdk | undefined;
let override: (() => Promise<Sdk | undefined>) | undefined;

export async function loadSdk(): Promise<Sdk | undefined> {
  if (override) return override();
  if (cached) return cached;
  try {
    cached = (await import(SDK_SPEC)) as Sdk;
    return cached;
  } catch {
    return undefined;
  }
}

/** zod as the SDK sees it (for tool() input schemas). */
export async function loadZod(): Promise<typeof import('zod')> {
  return (await import(ZOD_SPEC)) as typeof import('zod');
}

/** Tests: pretend the SDK is (not) installed. `undefined` restores the real loader. */
export function setSdkLoaderForTests(fn: (() => Promise<Sdk | undefined>) | undefined): void {
  override = fn;
}
