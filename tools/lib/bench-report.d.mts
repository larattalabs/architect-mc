// Types for tools/lib/bench-report.mjs (the sidecar's vitest suites import it).
export interface BenchRow {
  at: string;
  id: string;
  value: number;
  bound: number;
  better: 'lower' | 'higher';
  unit: string;
  ok: boolean;
  load1: number;
  cpus: number;
  note?: string;
}
export const BENCH_DIR: string;
export function withinBound(value: number, bound: number, better?: 'lower' | 'higher'): boolean;
export function bench(
  b: { id: string; value: number; bound: number; better?: 'lower' | 'higher'; unit?: string; note?: string },
  opts?: { dir?: string; env?: Record<string, string | undefined>; log?: (s: string) => void },
): BenchRow;
export function benchRows(dirs: string[], since?: string): BenchRow[];
