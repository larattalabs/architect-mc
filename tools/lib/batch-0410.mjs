// (batch v0.41.0: FL, F3, S3, RS-a, RS-b merged on main v0.40.1) What each slice of the batch moves for its siblings' checks against the
// merge base. Each slice's byte-identity item compares every committed plan fixture with main; merged together, a fixture another slice
// moves by name differs there too. It is judged by that slice's own item, so the others skip it (named) and normalise what that slice adds
// to every IR (FL's street ext). Nothing here changes what a slice judges of its own changes.
//   normSiblingIr(json)  an IR's JSON with kitVersion normalised and FL's S-FL-5 street ext dropped (fl-norm.mjs normIrJson)
//   SIBLING_MOVED        fixture -> the slice that moves it by name (FL's §8 list; F3's §8 exception)
//   siblingAsks(text)    an asks table without the five asks FL moves by name (fl-norm.mjs flAsksFilter)
//   SIBLING_FILES        files a sibling changes that a slice's "untouched" item lists (S3's terraced districts in districtsEmit.mjs)
import { FL_MOVED, flAsksFilter, normIrJson } from './fl-norm.mjs';

export const normSiblingIr = (json) => normIrJson(json);
export const siblingAsks = (text) => flAsksFilter(text);

export const SIBLING_MOVED = Object.freeze({
  ...Object.fromEntries(FL_MOVED.map((f) => [f, 'FL moves it by name (CONTRACT "Phase 6c slice FL" §8: a free layout, locator.around or sketch.outline supported)'])),
  'extension/e16_every_reserved_b.json': 'F3 moves it by name (CONTRACT "Phase 6c slice F3" §8: form.giant_tree supported)',
});

export const SIBLING_FILES = Object.freeze({
  'kit/lib/region/districtsEmit.mjs': 'S3 changes it (terraced districts: CONTRACT "Phase 6c slice S3"); judged by s3-unit and s3-plan',
});
