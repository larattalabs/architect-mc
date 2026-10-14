// (6c T1) The kit's plan-time passes (docs/SETTLEMENTS.md §4): bundled, deterministic functions (survey, volumes, intent) ->
// {fields, ops, data}, called from a program through r.pass(name, intent). A program declares the passes it calls
// (`export const passes = ['relief']`, a literal array: the helper reads it to pick the plan budget). Under the realise lint.
import { reliefPass } from './relief.mjs';
import { routePass } from './route.mjs';
import { districtsPass } from './districts.mjs';

/** name -> the pass function. (6c T2) `route`; (6c D1) `districts` (the pure half; r.pass emits through districtsEmit.mjs); HY adds `hydrology`. */
export const PASSES = Object.freeze({ relief: reliefPass, route: routePass, districts: districtsPass });
export const PASS_NAMES = Object.freeze(Object.keys(PASSES));
