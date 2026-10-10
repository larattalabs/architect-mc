// 6c slice 0c §5 (the drift guard): the mod's api/Limits.java constants equal the zod bounds of the requests it checks before
// sending (DesignRequest, GroupRequest and its items, BibleRequest, CritiqueSpec, PolishSpec, massing redirect notes). Every
// string or array a schema bounds must map to a Limits constant (a new bound without one fails here), and the patterns match.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as P from '../src/protocol.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const LIMITS = path.resolve(here, '..', '..', 'mod', 'src', 'main', 'java', 'dev', 'larattalabs', 'architect', 'api', 'Limits.java');

function javaLimits(): { ints: Map<string, number>; patterns: Map<string, string> } {
  const src = fs.readFileSync(LIMITS, 'utf8');
  const ints = new Map<string, number>();
  for (const m of src.matchAll(/public static final int (\w+) = (\d+);/g)) ints.set(m[1]!, Number(m[2]));
  const patterns = new Map<string, string>();
  for (const m of src.matchAll(/public static final Pattern (\w+) = Pattern\.compile\("((?:[^"\\]|\\.)*)"\);/g)) patterns.set(m[1]!, m[2]!.replace(/\\\\/g, '\\'));
  return { ints, patterns };
}

type Bound = { path: string; max: number };
/** Every max_length check (strings and arrays) under a schema, by path: `.field`, `[]` for elements, `{key}` for record keys, `|n` for union options. */
function bounds(s: unknown, p: string, out: Bound[], regexes: Map<string, string>): void {
  const d = (s as { _zod?: { def?: Record<string, unknown> } })?._zod?.def as Record<string, any> | undefined;
  if (!d) return;
  for (const c of (d.checks ?? []).map((x: any) => x._zod?.def).filter(Boolean)) {
    if (c.check === 'max_length') out.push({ path: p, max: c.maximum });
    if (c.check === 'string_format' && c.format === 'regex') regexes.set(p, String(c.pattern.source));
  }
  switch (d.type) {
    case 'object': for (const [k, v] of Object.entries(d.shape)) bounds(v, `${p}.${k}`, out, regexes); break;
    case 'array': bounds(d.element, `${p}[]`, out, regexes); break;
    case 'optional': case 'nullable': case 'default': bounds(d.innerType, p, out, regexes); break;
    case 'pipe': bounds(d.in, p, out, regexes); bounds(d.out, p, out, regexes); break;
    case 'union': d.options.forEach((o: unknown, i: number) => bounds(o, `${p}|${i}`, out, regexes)); break;
    case 'record': bounds(d.keyType, `${p}{key}`, out, regexes); bounds(d.valueType, `${p}{}`, out, regexes); break;
  }
}

/** The Limits constant of a bounded path (null: not a request field the mod sends, e.g. the envelope's id). */
function constantOf(p: string): string | null {
  const rules: [RegExp, string | null][] = [
    [/^MassingRedirectMsg\.id$/, null],
    [/\.redirect\.notes$|^MassingRedirectMsg\.notes$/, 'REDIRECT_NOTES_MAX'],
    [/^PolishSpec\.target\.notes$/, 'POLISH_NOTES_MAX'],
    [/^PolishSpec\.target\.issues$/, 'POLISH_ISSUES_MAX'],
    [/^PolishSpec\.target\.parts$/, 'POLISH_PARTS_MAX'],
    [/^PolishSpec\.apply\.sites\|\d+$/, 'POLISH_SITES_MAX'],
    [/^PolishSpec\.apply\.sites\|\d+\[\]$/, 'POLISH_SITE_MAX'],
    [/^BibleRequest\.prompt$/, 'BIBLE_PROMPT_MAX'],
    [/^BibleRequest\.name$/, 'BIBLE_NAME_MAX'],
    [/^BibleRequest\.references$/, 'BIBLE_REFERENCES_MAX'],
    [/^BibleRequest\.references\[\]$/, 'BIBLE_REFERENCE_MAX'],
    [/^GroupRequest\.name$/, 'GROUP_NAME_MAX'],
    [/^GroupRequest\.items$/, 'GROUP_ITEMS_MAX'],
    [/\.itemKey$/, 'ITEM_KEY_MAX'],
    [/\.style$/, 'STYLE_MAX'],
    [/\.materials$/, 'MATERIALS_MAX'],
    [/\.features$/, 'FEATURES_MAX'],
    [/\.name$/, 'NAME_MAX'],
    [/\.notes$/, 'NOTES_MAX'],
    [/\.remix$/, 'REMIX_MAX'],
    [/\.profile$/, 'PROFILE_MAX'],
    [/\.owner$/, 'OWNER_MAX'],
    [/\.ext\{key\}$/, 'EXT_KEY_MAX'],
    [/\.model$/, 'MODEL_ID_MAX'],
    [/^DesignRequest\.group$/, 'GROUP_ID_MAX'],
    [/\.context\|0$/, 'CONTEXT_MAX'],
    [/\.plot\.dimension$/, 'PLOT_DIMENSION_MAX'],
    [/\.views$/, 'CRITIQUE_VIEWS_MAX'],
    [/\.extraCriteria$/, 'EXTRA_CRITERIA_MAX'],
    [/\.extraCriteria\[\]$/, 'EXTRA_CRITERION_MAX'],
  ];
  for (const [re, c] of rules) if (re.test(p)) return c;
  return 'UNMAPPED';
}

const SCHEMAS = { DesignRequest: P.DesignRequest, GroupRequest: P.GroupRequest, BibleRequest: P.BibleRequest, CritiqueSpec: P.CritiqueSpec, PolishSpec: P.PolishSpec, MassingRedirectMsg: P.MassingRedirectMsg } as const;

describe('Limits.java against the zod bounds (6c 0c §5)', () => {
  const { ints, patterns } = javaLimits();
  const all: Bound[] = [];
  const regexes = new Map<string, string>();
  for (const [name, s] of Object.entries(SCHEMAS)) bounds(s, name, all, regexes);

  it('finds the bounds and the constants', () => {
    expect(all.length).toBeGreaterThan(40);
    expect(ints.get('STYLE_MAX')).toBe(40);
  });

  it('every bounded field maps to a Limits constant with the same value', () => {
    const bad: string[] = [];
    for (const b of all) {
      const c = constantOf(b.path);
      if (c === null) continue;
      if (c === 'UNMAPPED') bad.push(`${b.path} (max ${b.max}) has no Limits constant`);
      else if (ints.get(c) !== b.max) bad.push(`${b.path}: zod ${b.max}, Limits.${c} ${ints.get(c)}`);
    }
    expect(bad).toEqual([]);
  });

  it('every Limits constant is used by a bound (no stale constant), but for the custom-refined ones', () => {
    const used = new Set(all.map((b) => constantOf(b.path)));
    const custom = new Set(['EXT_MAX_BYTES', 'CRITIQUE_VIEWS_MAX']);
    const stale = [...ints.keys()].filter((k) => !used.has(k) && !custom.has(k));
    expect(stale).toEqual([]);
  });

  it('the patterns are zod\'s', () => {
    expect(patterns.get('FEATURE_RE')).toBe(P.FEATURE_RE.source);
    // Java escapes the '[' inside the class (an unescaped one opens a nested class there); JS takes it literally
    expect(patterns.get('MODEL_ID_RE')!.replace('\\[', '[')).toBe(regexes.get('DesignRequest.model'));
    expect(patterns.get('ITEM_KEY_RE')).toBe(regexes.get('GroupRequest.items[].itemKey'));
  });

  it('ext: 64 KB as JSON (a refine) and context 4000 as JSON', () => {
    const max = ints.get('EXT_MAX_BYTES')!;
    const ext = (n: number) => { const o: Record<string, string> = { k: '' }; o.k = 'x'.repeat(n - JSON.stringify(o).length); return o; };
    expect(P.Ext.safeParse(ext(max)).success).toBe(true);
    expect(P.Ext.safeParse(ext(max + 1)).success).toBe(false);
    expect(ints.get('CONTEXT_MAX')).toBe(P.MAX_CONTEXT);
  });
});
