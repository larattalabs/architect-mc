// FAKE kit/lib/region/survey.mjs (sidecar tests): windowFromSurvey(survey, key) -> a deterministic stand-in for the
// tile's 80x80 window (bytes derived from the survey and the key; the fake evaluator only hashes its heights).
import crypto from 'node:crypto';

export function windowFromSurvey(survey, key) {
  const h = crypto.createHash('sha256').update('window|').update(String(key)).update('|').update(survey).digest();
  const out = Buffer.alloc(64);
  out.write('ARSV', 0, 'latin1');
  h.copy(out, 32);
  return out;
}
