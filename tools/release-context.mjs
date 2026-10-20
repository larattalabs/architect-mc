// Is this checkout a release context, where the NEXT version placeholder must be gone (docs/GATES.md "Release versions")?
//   ARCHITECT_RELEASE=1 / =0      wins (the coordinator, a test)
//   GitHub Actions                a v* tag or main pushed (GITHUB_REF), or a PR from integrate/* or release/* (GITHUB_HEAD_REF)
//   git                           the branch is main, integrate/* or release/*, or HEAD carries a v* tag
// Anything else is lenient: slice branches, and the gate runner's detached run worktrees. No git (a temp tree): lenient.
import { execFileSync } from 'node:child_process';

const RELEASE_BRANCH = /^(main|integrate\/.+|release\/.+)$/;

/** {release: boolean, why: string} */
export function releaseContext(root, env = process.env) {
  if (env.ARCHITECT_RELEASE === '1' || env.ARCHITECT_RELEASE === '0') return { release: env.ARCHITECT_RELEASE === '1', why: `ARCHITECT_RELEASE=${env.ARCHITECT_RELEASE}` };
  if (env.GITHUB_ACTIONS === 'true') {
    const ref = env.GITHUB_REF ?? '', head = env.GITHUB_HEAD_REF ?? '';
    if (head) return { release: RELEASE_BRANCH.test(head) && head !== 'main', why: `pull request from ${head}` };
    if (/^refs\/tags\/v/.test(ref)) return { release: true, why: ref };
    return { release: ref === 'refs/heads/main', why: ref || 'GitHub Actions' };
  }
  const git = (...a) => execFileSync('git', ['-C', root, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  try {
    const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
    if (RELEASE_BRANCH.test(branch)) return { release: true, why: `branch ${branch}` };
    const tags = git('tag', '--points-at', 'HEAD').split('\n').filter((t) => /^v\d/.test(t));
    if (tags.length) return { release: true, why: `tag ${tags[0]}` };
    return { release: false, why: branch === 'HEAD' ? 'detached HEAD' : `branch ${branch}` };
  } catch {
    return { release: false, why: 'no git' };
  }
}
