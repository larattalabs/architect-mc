// Logging. Lines go to stdout/stderr (the mod's launcher shows the last ones when the sidecar
// crashes) and, when a file is given, to <data>/logs/sidecar.log. Nothing secret is ever logged:
// the API key and the client token never reach a log call.
import fs from 'node:fs';
import path from 'node:path';

export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
  debug(msg: string): void;
}

/** the log file rotates at this size (one previous file kept) */
const LOG_MAX_BYTES = 4 * 1024 * 1024;

export function consoleLogger(prefix = 'sidecar', opts: { debug?: boolean; quiet?: boolean; file?: string } = {}): Logger {
  const stamp = () => new Date().toTimeString().slice(0, 8);
  let size = 0;
  if (opts.file) {
    fs.mkdirSync(path.dirname(opts.file), { recursive: true });
    try {
      size = fs.statSync(opts.file).size;
    } catch {
      size = 0;
    }
  }
  const toFile = (line: string) => {
    if (!opts.file) return;
    try {
      if (size > LOG_MAX_BYTES) {
        fs.rmSync(`${opts.file}.1`, { force: true });
        fs.renameSync(opts.file, `${opts.file}.1`);
        size = 0;
      }
      const data = `${new Date().toISOString()} ${line}\n`;
      fs.appendFileSync(opts.file, data);
      size += Buffer.byteLength(data);
    } catch {
      /* logging must never take the sidecar down */
    }
  };
  return {
    info: (m) => {
      toFile(`INFO ${m}`);
      if (!opts.quiet) console.log(`${stamp()} [${prefix}] ${m}`);
    },
    warn: (m) => {
      toFile(`WARN ${m}`);
      if (!opts.quiet) console.warn(`${stamp()} [${prefix}] WARN ${m}`);
    },
    error: (m) => {
      toFile(`ERROR ${m}`);
      console.error(`${stamp()} [${prefix}] ERROR ${m}`);
    },
    debug: (m) => {
      if (!opts.debug) return;
      toFile(`DEBUG ${m}`);
      console.log(`${stamp()} [${prefix}] debug ${m}`);
    },
  };
}

export const silentLogger: Logger = { info() {}, warn() {}, error() {}, debug() {} };

/** A logger that keeps every line (tests). */
export function memoryLogger(): Logger & { lines: string[] } {
  const lines: string[] = [];
  return { lines, info: (m) => lines.push(`INFO ${m}`), warn: (m) => lines.push(`WARN ${m}`), error: (m) => lines.push(`ERROR ${m}`), debug: (m) => lines.push(`DEBUG ${m}`) };
}
