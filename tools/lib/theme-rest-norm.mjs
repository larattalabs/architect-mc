// (fix/theme-rest, Noah 2026-10-24: "everything should be themed / fit") The committed plan fixtures the theme-rest slice moves, by
// name, for the earlier slices' byte-identity checks (their unchanged() over the fixtures against the base): every fixture with a
// tunnel, whose flush lamp is now the light role's lantern standing in a niche (connectors/tunnelGeom.mjs tunnelLights), not glowstone.
const WHY = "theme rest: the tunnel's flush lamp is the light role's lantern in a niche, not glowstone (3 fewer glowstone, 3 more lanterns)";
export const THEME_REST_MOVED = Object.freeze(Object.fromEntries([
  'rs/rs04_tunnel.json', 'tunnel/tn05_water_3.json', 'tunnel/tn13_via_lenient.json', 'tunnel/tn14_glass_params.json', 'valid/v37_tunnel.json',
  'valid/v38_auto_crossings.json', 'valid/v38b_auto_tunnel.json', 'valid/v40_postern.json',
].map((n) => [n, WHY])));
