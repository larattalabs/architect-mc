// (6c H) The plan kinds slice H compiles (docs/CONTRACT.md "Phase 6c slice H" §5, §15): a leaf module (no import of compile.mjs,
// program.mjs or any generator), so the compiler, the checker and the hook modules all read the same lists without an import cycle.

/** Forms that make a fluid body (H-a): their compile places a body in the `fluids` stage. */
export const BODY_FORM_KINDS = Object.freeze(['pond', 'fountain', 'waterfall']);
/** Forms that write into natural water without a body (H-b). */
export const WET_FORM_KINDS = Object.freeze(['quay']);
/** Every H form kind (resolved and emitted with the forms, compile step 2 and 3). */
export const H_FORM_KINDS = Object.freeze([...BODY_FORM_KINDS, ...WET_FORM_KINDS]);
/** Connector kinds H compiles with the forms (step 2), so the route pass sees their water: the moat (`channel.moat`). */
export const H_CONNECTOR_KINDS = Object.freeze(['channel']);
/** The stage every body's sources are written in: appended last, and only when the plan has a body (§3.1). */
export const FLUIDS_STAGE = 'fluids';
/** The fluids a body may hold (§1.1). */
export const FLUIDS = Object.freeze(['water', 'lava']);

/** Whether a validated plan part is one of H's (resolved in compile step 2). */
export function isHPart(p) {
  return (p.family === 'form' && H_FORM_KINDS.includes(p.kind)) || (p.family === 'connector' && H_CONNECTOR_KINDS.includes(p.kind));
}

/** Whether a validated plan part makes a fluid body when it fits (the `fluids` stage and, in a check, the two-plan flow). */
export function isBodyPart(p) {
  return (p.family === 'form' && BODY_FORM_KINDS.includes(p.kind)) || (p.family === 'connector' && H_CONNECTOR_KINDS.includes(p.kind));
}
