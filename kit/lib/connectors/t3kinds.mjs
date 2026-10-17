// (6c T3) The connector kinds slice T3 compiles (docs/CONTRACT.md "Phase 6c slice T3"). A leaf module (no imports), so the compiler,
// the connector hook modules and the region program can all read the constants without an import cycle (K1's integration lesson:
// a cycle left ROPE_KINDS uninitialised when compile.mjs built K1_KINDS).

/** The kinds bridges compile (T3a: lib/connectors/bridge.mjs). */
export const BRIDGE_KINDS = Object.freeze(['bridge']);
/** The kinds tunnels compile (T3b: lib/connectors/tunnel.mjs). */
export const TUNNEL_KINDS = Object.freeze(['tunnel']);
/** Every T3 kind. */
export const T3_KINDS = Object.freeze([...BRIDGE_KINDS, ...TUNNEL_KINDS]);
/** The routed kinds that fall back to a bridge when every route crosses water (S-T3-2). */
export const FALLBACK_KINDS = Object.freeze(['street', 'road', 'path']);
/** A connector's test-only switches (its `ext`), as K1's. */
export const T3_UNSAFE_EXT = 'architect_mc:unsafe';
