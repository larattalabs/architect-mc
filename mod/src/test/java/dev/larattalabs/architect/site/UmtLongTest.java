package dev.larattalabs.architect.site;

import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;

/**
 * UMT's long fuzz (nightly, release): {@code ./gradlew umtLong -Dumt.seeds=5000 [-Dumt.from=<seed>]}: fresh seeds per property. (6c
 * close-out B) Every generator runs whatever an earlier one found (each stops at its own first 3 unexplained seeds), and the run fails
 * once at the end with all of them: before, the first property's failure hid the other three.
 */
@Tag("umt-long")
class UmtLongTest {
	@Test
	void longFuzz() {
		long from = Long.getLong("umt.from", System.currentTimeMillis() % 1_000_000_000L);
		int n = Integer.parseInt(System.getProperty("umt.seeds", "5000"));
		System.out.println("UMT long fuzz from seed " + from + ", " + n + " per property");
		List<String> bad = new ArrayList<>();
		for (UmtOps.Gen g : List.of(UmtOps.Gen.PLAIN, UmtOps.Gen.CRASH, UmtOps.Gen.DRIFT, UmtOps.Gen.ALL)) {
			try {
				UmtFuzzTest.fuzz(g, from, n);
			} catch (AssertionError e) {
				bad.add(g + ": " + e.getMessage());
			}
		}
		UmtFuzzTest.report();
		assertTrue(bad.isEmpty(), String.join("\n\n", bad));
	}
}
