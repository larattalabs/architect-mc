package dev.larattalabs.architect.site;

import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;

/**
 * UMT's long fuzz (nightly, release): {@code ./gradlew umtLong -Dumt.seeds=5000 [-Dumt.from=<seed>]}: fresh seeds per property.
 * (speed audit A) One class per generator, so the umtLong task's four test JVMs (maxParallelForks, mod/build.gradle) run them side by
 * side: the fuzz keeps process-wide state (the mod's own statics, UmtFuzzTest's counters, the Minecraft bootstrap), so a generator
 * gets its own JVM rather than a thread. Every generator runs the same seeds as before ({@code umt.from}, fixed once by the task for
 * all four), each stops at its own first 3 unexplained seeds, and all four always run: the task fails once at the end with every
 * generator's failures (before, the first property's failure hid the other three; (6c close-out B) then one test ran them in turn).
 */
@Tag("umt-long")
abstract class UmtLongTest {
	abstract UmtOps.Gen gen();

	@Test
	void longFuzz() {
		long from = Long.getLong("umt.from", System.currentTimeMillis() % 1_000_000_000L);
		int n = Integer.parseInt(System.getProperty("umt.seeds", "5000"));
		System.out.println("UMT long fuzz from seed " + from + ", " + n + " per property: " + gen());
		String bad = null;
		try {
			UmtFuzzTest.fuzz(gen(), from, n);
		} catch (AssertionError e) {
			bad = gen() + ": " + e.getMessage();
		}
		UmtFuzzTest.report();
		assertTrue(bad == null, bad);
	}
}

class UmtLongPlainTest extends UmtLongTest {
	@Override
	UmtOps.Gen gen() {
		return UmtOps.Gen.PLAIN;
	}
}

class UmtLongCrashTest extends UmtLongTest {
	@Override
	UmtOps.Gen gen() {
		return UmtOps.Gen.CRASH;
	}
}

class UmtLongDriftTest extends UmtLongTest {
	@Override
	UmtOps.Gen gen() {
		return UmtOps.Gen.DRIFT;
	}
}

class UmtLongAllTest extends UmtLongTest {
	@Override
	UmtOps.Gen gen() {
		return UmtOps.Gen.ALL;
	}
}
