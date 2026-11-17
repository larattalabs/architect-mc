// Child-process helpers. Everything is spawned with explicit argv (no shell) unless stated.
import { scrubEnv } from './env.js';
import { spawn, spawnSync, execFile, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** (WR2) which limit stopped it: 'cpu' (cpuLimitMs of CPU time) or 'wall' (timeoutMs of wall clock); absent when none did */
  limit?: 'cpu' | 'wall';
  /** (WR2) the child's last sampled CPU time in ms (user + system), when cpuLimitMs was asked and the platform can read it */
  cpuMs?: number;
}

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: string;
  timeoutMs?: number;
  /** Run through the platform shell (needed for npm/.cmd on Windows). `cmd` is then a full command line. */
  shell?: boolean;
  maxBuffer?: number;
  /**
   * (WR2) a CPU-time limit in ms (user + system of the child): sampled every `cpuPollMs`; the child is stopped once it has used more.
   * `timeoutMs` stays the wall-clock backstop. Where the platform can't read a child's CPU time (no sample has succeeded), the CPU
   * limit is enforced as wall clock instead (the old behaviour), never dropped; a failed sample keeps the last reading.
   */
  cpuLimitMs?: number;
  /** (WR2) how often the CPU time is sampled (default 1000 ms) */
  cpuPollMs?: number;
  /** (WR2, tests) the CPU-time sampler: ms used by `pid`, or undefined when it can't be read */
  cpuOf?: (pid: number) => Promise<number | undefined>;
}

/**
 * (WR2) Which limit a run is past, or null: CPU time over `cpuLimitMs` (when it can be read), else the wall clock over `wallLimitMs`
 * (the backstop); with no CPU reading, the CPU limit is enforced as wall clock. Pure: the tests drive it.
 */
export function limitHit(o: { wallMs: number; cpuMs: number | undefined; cpuLimitMs?: number | undefined; wallLimitMs?: number | undefined }): 'cpu' | 'wall' | null {
  if (o.cpuLimitMs !== undefined && o.cpuLimitMs > 0) {
    if (o.cpuMs !== undefined ? o.cpuMs > o.cpuLimitMs : o.wallMs > o.cpuLimitMs) return o.cpuMs !== undefined ? 'cpu' : 'wall';
  }
  if (o.wallLimitMs !== undefined && o.wallLimitMs > 0 && o.wallMs > o.wallLimitMs) return 'wall';
  return null;
}

/** (WR2) `ps -o time=` (POSIX: [[dd-]hh:]mm:ss[.cc]) as ms, or undefined. */
export function parseCpuTime(text: string): number | undefined {
  const m = /^\s*(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:[.,]\d+)?)\s*$/.exec(text);
  if (!m) return undefined;
  const [d, h, mi, se] = [Number(m[1] ?? 0), Number(m[2] ?? 0), Number(m[3]), Number(m[4]!.replace(',', '.'))];
  return Math.round((((d * 24 + h) * 60 + mi) * 60 + se) * 1000);
}

/**
 * (WR2) A child's CPU time (user + system, ms): Linux reads /proc/<pid>/stat (clock ticks of 100 Hz, the kernel's USER_HZ), macOS and
 * the BSDs `ps -o time=`; Windows (or any failure) undefined.
 */
export async function childCpuMs(pid: number): Promise<number | undefined> {
  if (process.platform === 'win32') return undefined;
  if (process.platform === 'linux') {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      const f = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      const ticks = Number(f[11]) + Number(f[12]); // utime, stime (fields 14 and 15)
      return Number.isFinite(ticks) ? ticks * 10 : undefined;
    } catch {
      return undefined;
    }
  }
  return new Promise((resolve) => {
    execFile('ps', ['-o', 'time=', '-p', String(pid)], { timeout: 10_000, env: scrubEnv(process.env) }, (err, out) => resolve(err ? undefined : parseCpuTime(String(out))));
  });
}

/**
 * Kill a child we started together with everything it started (a shell's `npm test` and its
 * node grandchildren). Only ever targets our own child's PID and its descendants.
 */
export function killTree(child: ChildProcess): void {
  const pid = child.pid;
  if (!pid || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    // taskkill /T walks the tree of *this* PID only
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', env: scrubEnv(process.env) });
  } else {
    try {
      process.kill(-pid, 'SIGKILL'); // the child leads its own process group (detached)
    } catch {
      child.kill('SIGKILL');
    }
  }
}

export interface ProcEntry {
  pid: number;
  ppid: number;
  /** creation time as reported by the OS (identifies the process, not just its reusable pid) */
  created: string;
  /** the same as epoch ms (0 if unknown) */
  createdMs: number;
}

/**
 * The OS process table (pid, parent, creation time), or undefined if it could not be read (the
 * query is retried once: on a busy machine PowerShell/CIM can be slow).
 */
export async function processTable(): Promise<ProcEntry[] | undefined> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res =
        process.platform === 'win32'
          ? await run(
              'powershell',
              ['-NoProfile', '-NonInteractive', '-Command', "Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate | ForEach-Object { '{0} {1} {2}' -f $_.ProcessId, $_.ParentProcessId, $(if ($_.CreationDate) { $_.CreationDate.ToFileTimeUtc() } else { 0 }) }"],
              { timeoutMs: 30_000 },
            )
          : await run('ps', ['-A', '-o', 'pid=,ppid=,lstart='], { timeoutMs: 30_000 });
      const table = parseTable(res.stdout);
      if (res.code === 0 && !res.timedOut && table.length) return table;
    } catch {
      /* retry */
    }
  }
  return undefined;
}

function parseTable(text: string): ProcEntry[] {
  const out: ProcEntry[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*?)\s*$/.exec(line);
    if (!m) continue;
    const created = m[3]!;
    // Windows: FILETIME (100 ns since 1601); POSIX: a date string
    const createdMs = /^\d{15,}$/.test(created) ? Number(created) / 10_000 - 11_644_473_600_000 : Date.parse(created) || 0;
    out.push({ pid: Number(m[1]), ppid: Number(m[2]), created, createdMs });
  }
  return out;
}

/**
 * Orphans of our own (now exited) child: processes whose parent chain leads to `rootPid` and that
 * were started after we spawned it. Windows keeps the parent pid of orphans, so they can still be
 * found after the child exited. If `rootPid` is alive again as a NEWER process (the pid was
 * reused), nothing is returned.
 */
export function orphansOf(table: ProcEntry[], rootPid: number, spawnedAtMs: number): ProcEntry[] {
  const root = table.find((e) => e.pid === rootPid);
  if (root && root.createdMs > spawnedAtMs + 2000) return []; // pid reused by someone else
  return descendantsOf(table, rootPid).filter((e) => e.createdMs >= spawnedAtMs - 2000);
}

/** Every process below `rootPid` in a process table (not the root itself). */
export function descendantsOf(table: ProcEntry[], rootPid: number): ProcEntry[] {
  const kids = new Map<number, ProcEntry[]>();
  for (const e of table) {
    if (e.pid === e.ppid) continue;
    const list = kids.get(e.ppid) ?? [];
    list.push(e);
    kids.set(e.ppid, list);
  }
  const out: ProcEntry[] = [];
  const seen = new Set<number>([rootPid]);
  const queue = [rootPid];
  while (queue.length) {
    for (const k of kids.get(queue.shift()!) ?? []) {
      if (seen.has(k.pid)) continue;
      seen.add(k.pid);
      out.push(k);
      queue.push(k.pid);
    }
  }
  return out;
}

/**
 * Kill processes from an earlier snapshot of OUR OWN child's tree that are still running. A pid
 * is only killed if the same process is still there (same creation time), so a pid the OS has
 * reused for something else is never touched. Returns the pids killed.
 */
export async function killSnapshot(snapshot: ProcEntry[], table?: ProcEntry[]): Promise<number[] | undefined> {
  if (!snapshot.length) return [];
  const now = table ?? (await processTable());
  if (!now) return undefined; // cannot verify which of them are still the same processes
  const alive = new Map(now.map((e) => [e.pid, e]));
  const killed: number[] = [];
  for (const e of snapshot) {
    const cur = alive.get(e.pid);
    if (!cur || cur.created !== e.created) continue;
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(e.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', env: scrubEnv(process.env) });
    else {
      try {
        process.kill(e.pid, 'SIGKILL');
      } catch {
        continue;
      }
    }
    killed.push(e.pid);
  }
  return killed;
}

export function run(cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, opts.shell ? [] : args, {
      cwd: opts.cwd,
      env: scrubEnv(opts.env ?? process.env),
      shell: opts.shell ?? false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      // POSIX: own process group, so a timeout can kill the whole tree
      ...(process.platform !== 'win32' && opts.shell ? { detached: true } : {}),
    });
    const max = opts.maxBuffer ?? 8 * 1024 * 1024;
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout!.setEncoding('utf8');
    child.stderr!.setEncoding('utf8');
    child.stdout!.on('data', (d: string) => {
      if (stdout.length < max) stdout += d;
    });
    child.stderr!.on('data', (d: string) => {
      if (stderr.length < max) stderr += d;
    });
    let timer: NodeJS.Timeout | undefined;
    let poll: NodeJS.Timeout | undefined;
    let limit: 'cpu' | 'wall' | undefined;
    let cpuMs: number | undefined;
    const stop = (why: 'cpu' | 'wall') => {
      if (timedOut) return;
      timedOut = true;
      limit = why;
      killTree(child);
    };
    if (opts.timeoutMs) timer = setTimeout(() => stop('wall'), opts.timeoutMs);
    if (opts.cpuLimitMs && opts.cpuLimitMs > 0 && child.pid) {
      // (WR2) the CPU limit: sampled while the child runs (one sample at a time; a busy machine slows the wall clock, not this)
      const t0 = Date.now(), pid = child.pid, cpuOf = opts.cpuOf ?? childCpuMs, every = Math.max(10, opts.cpuPollMs ?? 1000);
      let busy = false;
      poll = setInterval(() => {
        if (busy || timedOut) return;
        busy = true;
        void cpuOf(pid).then((c) => {
          busy = false;
          if (c !== undefined) cpuMs = c;
          if (child.exitCode !== null || child.signalCode !== null) return;
          // (a failed sample keeps the last reading; only a child never read at all falls back to the wall clock)
          const hit = limitHit({ wallMs: Date.now() - t0, cpuMs, cpuLimitMs: opts.cpuLimitMs });
          if (hit) stop(hit === 'cpu' ? 'cpu' : 'wall');
        }, () => { busy = false; });
      }, every);
    }
    const done = () => {
      if (timer) clearTimeout(timer);
      if (poll) clearInterval(poll);
    };
    child.on('error', (e) => {
      done();
      reject(e);
    });
    child.on('close', (code) => {
      done();
      resolve({ code: code ?? (timedOut ? 124 : 1), stdout, stderr, timedOut, ...(limit ? { limit } : {}), ...(cpuMs !== undefined ? { cpuMs } : {}) });
    });
    if (opts.input !== undefined) child.stdin!.end(opts.input);
    else child.stdin!.end();
  });
}

/** Run a shell command line (used for repo test commands like `npm test`). */
export function runShell(commandLine: string, opts: Omit<RunOptions, 'shell'> = {}): Promise<RunResult> {
  return run(commandLine, [], { ...opts, shell: true });
}
