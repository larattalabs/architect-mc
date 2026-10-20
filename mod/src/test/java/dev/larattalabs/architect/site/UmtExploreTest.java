package dev.larattalabs.architect.site;

import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;

/** Exploration: -Dumt.explore=<gen>:<from>:<count> runs those seeds and prints each failure, shrunk (gradle umtExplore). */
@Tag("umt-explore")
class UmtExploreTest {
	@Test
	void explore() {
		String spec = System.getProperty("umt.explore", "PLAIN:1:20");
		String[] a = spec.split(":");
		UmtOps.Gen g = switch (a[0]) {
			case "CRASH" -> UmtOps.Gen.CRASH;
			case "DRIFT" -> UmtOps.Gen.DRIFT;
			case "ALL" -> UmtOps.Gen.ALL;
			case "FINDINGS" -> new UmtOps.Gen(14, true, true, true, true);
			default -> UmtOps.Gen.PLAIN;
		};
		if (a.length > 3 && a[3].equals("one")) {
			UmtRunner.Result r = UmtRunner.run(UmtOps.generate(Long.parseLong(a[1]), g));
			System.out.println(r.failed() ? UmtRunner.shrink(r).report() : "passes:\n" + r.report());
			return;
		}
		long from = Long.parseLong(a[1]);
		int n = Integer.parseInt(a[2]);
		int failed = 0;
		long t0 = System.nanoTime();
		java.util.Map<String, Integer> kinds = new java.util.TreeMap<>();
		for (long s = from; s < from + n; s++) {
			UmtRunner.Result r = UmtRunner.run(UmtOps.generate(s, g));
			if (r.failed() && (System.getProperty("umt.unknown") == null || r.violations().stream().anyMatch(v -> !UmtRunner.known(v)))) {
				failed++;
				String k = UmtRunner.kind(r.violations().stream().filter(v -> System.getProperty("umt.unknown") == null || !UmtRunner.known(v)).findFirst().orElseThrow());
				if (kinds.merge(k, 1, Integer::sum) == 1) {
					UmtRunner.Result m = UmtRunner.shrink(r, k);
					System.out.println("=== seed " + s + " FAILS (" + k + "), shrunk:\n" + m.report());
				}
			}
		}
		System.out.println("UMT explore " + spec + ": " + failed + " of " + n + " failed in " + (System.nanoTime() - t0) / 1_000_000 + " ms; kinds " + kinds);
	}
}
