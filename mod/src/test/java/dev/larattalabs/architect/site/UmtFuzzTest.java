package dev.larattalabs.architect.site;

import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.Test;

/**
 * UMT's fuzz (docs/UMT.md). The CI set is fixed seeds (they never change between runs, so a red build is reproducible with the seed it
 * prints); {@code ./gradlew umtLong -Dumt.seeds=N} runs N fresh seeds per property from a seed given by {@code -Dumt.from} (default:
 * the clock, printed). A failing scenario is shrunk to a minimal list of operations before it is reported.
 *
 * <ul>
 * <li>P1 any order of removal is exact: sites, lots, roads and region tiles over overlapping footprints, stacked, removed one by one
 * and as groups, in random orders, with restarts;</li>
 * <li>P2 a crash at any durable step (each commit's I/O steps, K2, mid-writes, K6, K7, before the job's end) then the start's recovery
 * gives the same final result;</li>
 * <li>P3 with the world changing cells (copper weathering and wax, farmland and dirt, grass, water flowing in, freezing) and players
 * mining and placing (with records), the undo restores the right befores and player cells win;</li>
 * <li>all of it together.</li>
 * </ul>
 * A violation tagged with a finding ([F1]..[F7], [LP], [UC], docs/UMT.md "Findings") is counted and printed, not failed, unless
 * {@code -Dumt.strict=true}: the coordinator decides which findings are bugs.
 */
class UmtFuzzTest {
	static final Map<String, Integer> FOUND = new TreeMap<>();
	static long started = System.nanoTime();
	static int scenarios;

	static void fuzz(UmtOps.Gen g, long from, int count) {
		boolean strict = Boolean.getBoolean("umt.strict");
		List<String> bad = new ArrayList<>();
		for (long s = from; s < from + count && bad.size() < 3; s++) {
			UmtRunner.Result r = UmtRunner.run(UmtOps.generate(s, g));
			scenarios++;
			for (String v : r.violations()) {
				if (UmtRunner.known(v)) {
					FOUND.merge(v.substring(0, v.indexOf(']') + 1), 1, Integer::sum);
				}
			}
			if (!r.violations().isEmpty()) {
				BASELINE.add(g.toString().replace(" ", "_") + " " + s + " " + digest(r.violations()));
			}
			List<String> unknown = r.violations().stream().filter(v -> strict || !UmtRunner.known(v)).toList();
			if (!unknown.isEmpty()) {
				UmtRunner.Result m = UmtRunner.shrink(r, UmtRunner.kind(unknown.get(0)));
				bad.add("seed " + s + " (" + g + "):\n" + m.report());
			}
		}
		assertTrue(bad.isEmpty(), String.join("\n\n", bad));
	}

	/** Per failing seed of the CI set: its generator, seed, tags and a digest of its violations (sorted). */
	static final List<String> BASELINE = new ArrayList<>();
	static final java.nio.file.Path BASELINE_FILE = java.nio.file.Path.of("src/test/resources/umt/ci-baseline.txt");

	static String digest(List<String> violations) {
		java.util.TreeSet<String> tags = new java.util.TreeSet<>();
		for (String v : violations) {
			tags.add(UmtRunner.known(v) ? v.substring(0, v.indexOf(']') + 1) : "[?]");
		}
		try {
			java.security.MessageDigest md = java.security.MessageDigest.getInstance("SHA-256");
			for (String v : new java.util.TreeSet<>(violations)) {
				md.update(v.getBytes(java.nio.charset.StandardCharsets.UTF_8));
				md.update((byte) 10);
			}
			return String.join("", tags) + " " + java.util.HexFormat.of().formatHex(md.digest()).substring(0, 16);
		} catch (java.security.NoSuchAlgorithmException e) {
			throw new IllegalStateException(e);
		}
	}

	static int seeds(int ci) {
		String n = System.getProperty("umt.seeds", "");
		return n.isEmpty() ? ci : Integer.parseInt(n);
	}

	@Test
	void p1_anyRemovalOrderIsExact() {
		fuzz(UmtOps.Gen.PLAIN, 1, seeds(500));
	}

	@Test
	void p2_aCrashAtAnyStepRecovers() {
		fuzz(UmtOps.Gen.CRASH, 1, seeds(500));
	}

	@Test
	void p3_driftAndPlayersUndoRight() {
		fuzz(UmtOps.Gen.DRIFT, 1, seeds(500));
	}

	@Test
	void all_together() {
		fuzz(UmtOps.Gen.ALL, 1, seeds(500));
	}

	/**
	 * The CI set's findings are pinned (provisional, until the coordinator decides on them): every failing seed's tags and the digest
	 * of its violations must equal src/test/resources/umt/ci-baseline.txt, so a change inside a known finding's bucket (more, fewer or
	 * other cells) fails too. {@code -Dumt.rebaseline=true} rewrites the file (a deliberate act, reviewed in the diff).
	 */
	@AfterAll
	static void pinned() throws java.io.IOException {
		report();
		if (!System.getProperty("umt.seeds", "").isEmpty() || BASELINE.isEmpty() || scenarios != 2000) {
			return; // a long or partial run: nothing pinned
		}
		List<String> now = BASELINE.stream().sorted().toList();
		if (Boolean.getBoolean("umt.rebaseline")) {
			java.nio.file.Files.createDirectories(BASELINE_FILE.getParent());
			java.nio.file.Files.write(BASELINE_FILE, now);
			return;
		}
		List<String> was = java.nio.file.Files.exists(BASELINE_FILE) ? java.nio.file.Files.readAllLines(BASELINE_FILE) : List.of();
		List<String> gone = was.stream().filter(x -> !now.contains(x)).toList();
		List<String> added = now.stream().filter(x -> !was.contains(x)).toList();
		assertTrue(gone.isEmpty() && added.isEmpty(), "UMT CI findings differ from " + BASELINE_FILE + " (a fix, a regression or a model change: "
			+ "rebaseline with -Dumt.rebaseline=true once understood)\nno longer:\n" + String.join("\n", gone.subList(0, Math.min(20, gone.size())))
			+ "\nnew:\n" + String.join("\n", added.subList(0, Math.min(20, added.size()))));
	}

	static void report() {
		System.out.println("UMT fuzz: " + scenarios + " scenarios in " + (System.nanoTime() - started) / 1_000_000 + " ms; findings seen " + FOUND
			+ "; vanilla rules fired " + UmtVanilla.FIRED + "; noise (rule names it / rule misses it / real diff the rule would hide) "
			+ java.util.Arrays.toString(UmtSim.NOISE_STATS));
	}
}
