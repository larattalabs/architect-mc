// (TI) The kit and scenario files the mod's Java tests read are inputs of mod/build.gradle's `test` task (8a ST, chore/TF, RTE3), so
// an edit to one never leaves the task UP-TO-DATE on a stale PASS. `node tools/step-inputs.mjs check` (CI) runs this over the tree.
//
// A literal path a test names (`"../kit/x"`, `"kit/x"`, `Path.of("..", "kit", "x", ...)`, the literal head of the chain) must be
// declared in that block:
// - a file: by `inputs.files` naming it, or an `inputs.dir` holding it;
// - a directory (a test lists it, or reads computed names in it: `Path.of("../kit/examples", id)`): only by an `inputs.dir` of it or of
//   a parent. Single files declared under it are not enough: the test may read any file there (v0.89.0 review P3).
// Computed paths without a literal (KIT.resolve(id), a node child's own reads) stay the author's to declare. Pure: no file access.

/** The `test { }` block's declared inputs: -> { dirs: [repo paths], files: [repo paths] } (paths "../x" read as repo "x"), or null. */
export function declaredTestInputs(gradle) {
  const at = gradle.search(/^test \{/m);
  if (at < 0) return null;
  let depth = 0;
  let end = gradle.length;
  for (let i = gradle.indexOf('{', at); i < gradle.length; i++) {
    if (gradle[i] === '{') depth++;
    else if (gradle[i] === '}' && --depth === 0) {
      end = i;
      break;
    }
  }
  const out = { dirs: [], files: [] };
  for (const m of gradle.slice(at, end).matchAll(/inputs\.(dir|files)\(([^)]*)\)/g)) {
    for (const q of m[2].matchAll(/"\.\.\/([^"]+)"/g)) (m[1] === 'dir' ? out.dirs : out.files).push(q[1].replace(/\/$/, ''));
  }
  return out;
}

/** The literal kit/ and scenarios/ paths a Java source names (comments dropped). */
export function literalTestPaths(java) {
  const text = java.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const found = [];
  for (const m of text.matchAll(/"(?:\.\.\/)?((?:kit|scenarios)\/[\w./-]*)"/g)) found.push(m[1]);
  for (const m of text.matchAll(/Paths?\.(?:of|get)\(\s*"\.\."((?:\s*,\s*"[\w.-]+")+)/g)) found.push([...m[1].matchAll(/"([\w.-]+)"/g)].map((x) => x[1]).join('/'));
  return found.map((p) => p.replace(/\/+$/, '')).filter((p) => /^(kit|scenarios)\//.test(p));
}

/**
 * The gaps: -> ["mod/build.gradle: <path> (read by A, B) ..."]. `gradle` is mod/build.gradle's text, `sources` [[repo path, text]] of
 * the Java tests, `files` the tree's paths (a Set), `known` paths (and their subtrees) accepted as undeclared.
 */
export function gradleTestInputGaps(gradle, sources, files, known = []) {
  const decl = declaredTestInputs(gradle);
  if (!decl) return ['mod/build.gradle: no `test {` block'];
  const underDir = (p) => decl.dirs.some((d) => p === d || p.startsWith(`${d}/`));
  const named = new Map();
  for (const [f, text] of sources) {
    for (const p of literalTestPaths(text)) {
      const isFile = files.has(p);
      const isDir = !isFile && [...files].some((t) => t.startsWith(`${p}/`));
      if (!isFile && !isDir) continue; // not a repo path (a name in a message, a generated file)
      if (isFile ? decl.files.includes(p) || underDir(p) : underDir(p)) continue;
      if (known.some((k) => p === k || p.startsWith(`${k}/`))) continue;
      if (!named.has(p)) named.set(p, new Set());
      named.get(p).add(f.split('/').pop().replace(/\.java$/, ''));
    }
  }
  return [...named].sort().map(([p, by]) => `mod/build.gradle: ${p} (read by ${[...by].join(', ')}) is no input of the test task${files.has(p) ? '' : ' (a directory: declare it, or a parent, with inputs.dir)'}: declare it there (and in unit-mod's data in tools/step-inputs.json)`);
}
