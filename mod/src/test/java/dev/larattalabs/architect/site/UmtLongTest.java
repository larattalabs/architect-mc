package dev.larattalabs.architect.site;

import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;

/** UMT's long fuzz (nightly, release): {@code ./gradlew umtLong -Dumt.seeds=5000 [-Dumt.from=<seed>]}: fresh seeds per property. */
@Tag("umt-long")
class UmtLongTest {
	@Test
	void longFuzz() {
		long from = Long.getLong("umt.from", System.currentTimeMillis() % 1_000_000_000L);
		int n = Integer.parseInt(System.getProperty("umt.seeds", "5000"));
		System.out.println("UMT long fuzz from seed " + from + ", " + n + " per property");
		UmtFuzzTest.fuzz(UmtOps.Gen.PLAIN, from, n);
		UmtFuzzTest.fuzz(UmtOps.Gen.CRASH, from, n);
		UmtFuzzTest.fuzz(UmtOps.Gen.DRIFT, from, n);
		UmtFuzzTest.fuzz(UmtOps.Gen.ALL, from, n);
		UmtFuzzTest.report();
	}
}
