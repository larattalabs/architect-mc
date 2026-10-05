// The pieces under the job runner: the JSON Schema subset validator, the sim's sample builder,
// cost from a result message (modelUsage with cache tokens) and the cost meter across resumes,
// and the protocol-1 downgrade.
import { describe, expect, it } from 'vitest';
import { costFromResult, CostMeter, zeroCost } from '../src/jobs/cost.js';
import { sampleFromSchema, validateJson } from '../src/jobs/schema.js';
import { chooseProtocol, toProtocol1 } from '../src/protocol.js';

describe('validateJson', () => {
  const schema = {
    type: 'object',
    properties: {
      name: { type: 'string', minLength: 2, maxLength: 5, pattern: '^[A-Z]' },
      n: { type: 'integer', minimum: 1, maximum: 3 },
      tags: { type: 'array', items: { enum: ['a', 'b'] }, minItems: 1, uniqueItems: true },
      kind: { anyOf: [{ const: 'x' }, { type: 'number' }] },
      ref: { $ref: '#/$defs/pt' },
      opt: { type: ['string', 'null'] },
    },
    required: ['name', 'n'],
    additionalProperties: false,
    $defs: { pt: { type: 'object', properties: { x: { type: 'number' } }, required: ['x'] } },
  };
  it('accepts a valid value', () => {
    expect(validateJson({ name: 'Ab', n: 2, tags: ['a'], kind: 4.5, ref: { x: 1 }, opt: null }, schema)).toEqual([]);
  });
  it('names each problem', () => {
    const errs = validateJson({ name: 'a', n: 1.5, tags: ['a', 'a', 'c'], kind: 'y', ref: {}, extra: 1 }, schema);
    expect(errs).toEqual(expect.arrayContaining([
      'name: shorter than 2',
      'name: does not match ^[A-Z]',
      'n: expected integer, got number',
      'tags: items are not unique',
      'tags[2]: not one of ["a","b"]',
      'kind: matches none of anyOf',
      'ref.x: required',
      'extra: not allowed (additionalProperties: false)',
    ]));
    expect(validateJson({}, schema)).toEqual(['name: required', 'n: required']);
    expect(validateJson('x', { type: 'object' })).toEqual(['(root): expected object, got string']);
  });
  it('the sim sample validates against its schema (patterns aside: the sample does not try to match them)', () => {
    const s = { ...schema, properties: { ...schema.properties, name: { type: 'string', minLength: 2, maxLength: 5 } } };
    expect(validateJson(sampleFromSchema(s), s)).toEqual([]);
  });
});

describe('cost', () => {
  const res = (usd: number, k: number) => ({ total_cost_usd: usd, num_turns: k, modelUsage: { a: { inputTokens: 10 * k, outputTokens: k, cacheReadInputTokens: 5 * k, cacheCreationInputTokens: 2 * k }, b: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 1, cacheCreationInputTokens: 1 } } });
  it('reads total_cost_usd, num_turns and the modelUsage token totals (cache read and write)', () => {
    expect(costFromResult(res(0.12, 3))).toEqual({ usd: 0.12, inputTokens: 31, outputTokens: 4, cacheReadTokens: 16, cacheWriteTokens: 7, turns: 3 });
    expect(costFromResult({ total_cost_usd: 0.1, num_turns: 1, modelUsage: {}, usage: { input_tokens: 5, output_tokens: 6, cache_read_input_tokens: 7, cache_creation_input_tokens: 8 } })).toEqual({ usd: 0.1, inputTokens: 5, outputTokens: 6, cacheReadTokens: 7, cacheWriteTokens: 8, turns: 1 });
  });
  it('a fresh query adds to what was committed; a resumed one that reports at least that much already includes it', () => {
    const m = new CostMeter(zeroCost());
    m.begin(false);
    m.observe(costFromResult(res(0.1, 1)));
    expect(m.commit().usd).toBe(0.1);
    m.begin(true); // the SDK continued from the transcript's total
    expect(m.observe(costFromResult(res(0.25, 2))).usd).toBe(0.25);
    expect(m.commit().usd).toBe(0.25);
    m.begin(true); // a resume that started counting from zero
    expect(m.observe(costFromResult(res(0.05, 1))).usd).toBe(0.3);
    m.commit();
    m.begin(false); // a new session
    expect(m.observe(costFromResult(res(0.02, 1))).usd).toBe(0.32);
    expect(m.remaining(0.5)).toBe(0.18);
  });
});

describe('protocol negotiation and the protocol-1 view', () => {
  it('picks the highest common protocol', () => {
    expect(chooseProtocol(undefined)).toBe(1);
    expect(chooseProtocol([1])).toBe(1);
    expect(chooseProtocol([1, 2])).toBe(2);
    expect(chooseProtocol([2, 3])).toBe(2);
    expect(chooseProtocol([3])).toBeUndefined();
  });
  it('drops job messages and strips v2 fields', () => {
    expect(toProtocol1({ v: 1, type: 'job.upsert', job: {} })).toBeUndefined();
    const design = { id: 'd1', status: 'queued', step: 's', createdAt: 1, updatedAt: 1, cost: zeroCost(), request: { type: 'cabin', style: 'x', features: [], maxSize: { x: 9, y: 9, z: 9 }, owner: 'm:x', ext: { a: 1 }, budgetUsd: 1 } };
    const out = toProtocol1({ v: 1, type: 'design.upsert', design }) as { design: Record<string, unknown> & { request: Record<string, unknown> } };
    expect(out.design.cost).toBeUndefined();
    expect(Object.keys(out.design.request).sort()).toEqual(['features', 'maxSize', 'style', 'type']);
  });
});
