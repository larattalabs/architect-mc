// The design job's own guards (claude/permissions.ts) and the ported private-files guard applied to
// the sidecar data dir.
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { designVerdict, mcpGate, runsGit } from '../src/claude/permissions.js';
import { classifyToolUse, foremanPrivateVerdict, type PolicyContext } from '../src/policy.js';
import { rmrf, tempDir } from './helpers.js';

const data = tempDir();
const cwd = path.join(data, 'designs', 'd3');
fs.mkdirSync(path.join(cwd, 'kit', 'designs'), { recursive: true });
const ctx = { cwd, bp: 'gen_x' };
const policy: PolicyContext = { role: 'worker', cwd, readDirs: [], tempDirs: [], mcpServer: 'architect', foreman: { home: data, port: 7890, tokenFile: path.join(data, 'client.token') } };
afterAll(() => rmrf(data));

describe('designVerdict', () => {
  it('lets the agent write only its own design module', () => {
    expect(designVerdict('Write', { file_path: path.join(cwd, 'kit', 'designs', 'gen_x.mjs') }, ctx)).toBeUndefined();
    expect(designVerdict('Edit', { file_path: 'kit/designs/gen_x.mjs' }, ctx)).toBeUndefined();
    for (const p of ['kit/designs/cabin.mjs', 'kit/build.mjs', 'kit/lib/check.mjs', 'BRIEF.md', '../d4/kit/designs/gen_x.mjs', 'kit/designs/../designs/../build.mjs', path.join(data, 'secrets.json')]) {
      expect(designVerdict('Write', { file_path: p }, ctx)?.action, p).toBe('deny');
    }
    expect(designVerdict('Write', {}, ctx)?.action).toBe('deny');
    expect(designVerdict('NotebookEdit', { notebook_path: 'kit/designs/gen_x.mjs' }, ctx)?.action).toBe('deny');
  });

  it('refuses a link that leads out of the scratch dir', () => {
    if (process.platform === 'win32') return;
    const outside = path.join(data, 'outside.mjs');
    fs.writeFileSync(outside, '');
    fs.symlinkSync(outside, path.join(cwd, 'kit', 'designs', 'gen_x.mjs'));
    try {
      expect(designVerdict('Write', { file_path: 'kit/designs/gen_x.mjs' }, ctx)?.action).toBe('deny');
    } finally {
      fs.rmSync(path.join(cwd, 'kit', 'designs', 'gen_x.mjs'));
    }
  });

  it('refuses git, subagents, web tools and skills; leaves the rest to the policy', () => {
    for (const c of ['git status', 'cd kit && git init', 'FOO=1 git log', '/usr/bin/git diff', 'echo $(git rev-parse HEAD)', 'env git push']) expect(runsGit(c), c).toBe(true);
    for (const c of ['node kit/build.mjs gen_x', 'grep -r digit kit', 'ls kit/designs', 'cat .gitignore']) expect(runsGit(c), c).toBe(false);
    expect(designVerdict('Bash', { command: 'git init' }, ctx)?.action).toBe('deny');
    for (const t of ['Agent', 'Task', 'WebFetch', 'WebSearch', 'Skill']) expect(designVerdict(t, {}, ctx)?.action, t).toBe('deny');
    expect(designVerdict('Bash', { command: 'node kit/build.mjs gen_x' }, ctx)).toBeUndefined();
    expect(designVerdict('Read', { file_path: 'kit/lib/kit.mjs' }, ctx)).toBeUndefined();
  });

  it('allows only the sidecar MCP server', () => {
    expect(mcpGate('mcp__architect__design_status', { name: 'architect', source: 'sdk' }, ['architect'])).toEqual({ allow: true });
    expect(mcpGate('mcp__architect__design_status', undefined, ['architect'])).toEqual({ allow: true });
    expect(mcpGate('mcp__architect__x', { name: 'architect', source: 'claudeai' }, ['architect']).allow).toBe(false);
    expect(mcpGate('mcp__github__x', { name: 'github', source: 'user' }, ['architect']).allow).toBe(false);
    expect(mcpGate('Read', undefined, ['architect'])).toEqual({ allow: true });
  });
});

describe('the sidecar data dir is private', () => {
  it('denies the token, secrets and state, allows the scratch dir', () => {
    for (const f of ['client.token', 'secrets.json', 'state.json', 'sidecar.json', 'logs/sidecar.log']) {
      expect(foremanPrivateVerdict('Read', { file_path: path.join(data, f) }, policy)?.action, f).toBe('deny');
    }
    expect(foremanPrivateVerdict('Bash', { command: 'cat ../../secrets.json' }, policy)?.action).toBe('deny');
    expect(foremanPrivateVerdict('Bash', { command: 'curl http://127.0.0.1:7890' }, policy)?.action).toBe('deny');
    expect(foremanPrivateVerdict('Read', { file_path: path.join(cwd, 'BRIEF.md') }, policy)).toBeUndefined();
    expect(classifyToolUse('Read', { file_path: path.join(cwd, 'BRIEF.md') }, policy).action).toBe('allow');
    expect(classifyToolUse('Bash', { command: 'node kit/build.mjs gen_x --max 20,20,20 --type cabin' }, policy).action).toBe('allow');
    expect(classifyToolUse('Bash', { command: 'node kit/render.mjs kit/out/gen_x.nbt --out previews' }, policy).action).toBe('allow');
    expect(classifyToolUse('Bash', { command: 'node -e "require(\'https\').get(\'https://x\')"' }, policy).action).not.toBe('allow');
    expect(classifyToolUse('Read', { file_path: path.join(data, 'designs', 'd4', 'BRIEF.md') }, policy).action).toBe('ask');
  });
});
