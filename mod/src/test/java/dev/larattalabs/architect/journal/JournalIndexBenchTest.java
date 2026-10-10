package dev.larattalabs.architect.journal;

import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import java.io.IOException;
import java.nio.channels.FileChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * Phase 6a step 1 (docs/CONTRACT.md "Entry count and the index"): the 4e index with region-sized entry counts. mega_bench
 * gives about 1-2k entries (tile entries per stage and change-set, plus about 200 lots and their leaves entries). Bar: the
 * index at most 8 MB and its commit (JSON, write, atomic rename, as {@code JournalStore.writeIndex}) p99 at most 100 ms.
 * Prints the measured numbers (the gate records them in artifacts/gate6a/).
 */
class JournalIndexBenchTest {
	private static final Gson GSON = new GsonBuilder().disableHtmlEscaping().create();

	@TempDir
	Path dir;

	/** A tile entry: 4x4 section columns of a 64x64 tile, {@code rows} section rows deep. */
	private static long[] tileSections(int tx, int tz, int y0, int rows) {
		long[] out = new long[16 * rows];
		int n = 0;
		for (int sx = tx * 4; sx < tx * 4 + 4; sx++) {
			for (int sz = tz * 4; sz < tz * 4 + 4; sz++) {
				for (int sy = y0; sy < y0 + rows; sy++) {
					out[n++] = Sections.key(sx, sy, sz);
				}
			}
		}
		Arrays.sort(out);
		return out;
	}

	private static JournalStore.Index index(int entries, int rows) {
		Map<String, JournalStore.Meta> metas = new LinkedHashMap<>();
		for (int i = 0; i < entries; i++) {
			int tx = i % 16 - 8;
			int tz = i / 16 % 16 - 8;
			long[] sections = i % 10 == 9 ? tileSections(tx, tz, 4, 1) : tileSections(tx, tz, 3, rows); // a lot now and then: one row
			Map<String, Integer> files = new LinkedHashMap<>();
			files.put((tx * 64 >> 9) + "," + (tz * 64 >> 9), 1 + i % 3);
			String id = "e" + (i + 1);
			metas.put(id, new JournalStore.Meta(id, i % 10 == 9 ? "site" : "architect:terrain", "c" + (i + 1), "g1", "minecraft:overworld",
				Journal.Policy.CELL, i + 1, Journal.Status.ACTIVE, 1_760_000_000_000L + i, 40_000 + i, new int[] {tx * 64, 48, tz * 64, tx * 64 + 63, 48 + rows
					* 16, tz * 64 + 63}, files, sections, null, 0L));
		}
		return new JournalStore.Index(metas, entries + 1, entries + 1, 1, entries + 1, Map.of());
	}

	private void commit(JournalStore.Index idx) throws IOException {
		Path f = dir.resolve(JournalStore.INDEX);
		Path tmp = dir.resolve(JournalStore.INDEX + ".tmp");
		String json = GSON.toJson(JournalStore.indexToJson(idx));
		Files.writeString(tmp, json, StandardCharsets.UTF_8);
		try (FileChannel ch = FileChannel.open(tmp, StandardOpenOption.WRITE)) {
			ch.force(true); // stricter than writeIndex (no fsync there): an upper bound
		}
		Files.move(tmp, f, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
	}

	@Test
	void theIndexAt2kEntriesStaysUnderTheBars() throws IOException {
		for (int[] c : new int[][] {{1000, 4}, {2000, 4}, {2000, 8}}) {
			JournalStore.Index idx = index(c[0], c[1]);
			commit(idx); // warm-up
			int n = 40;
			double[] ms = new double[n];
			for (int i = 0; i < n; i++) {
				long t0 = System.nanoTime();
				commit(idx);
				ms[i] = (System.nanoTime() - t0) / 1e6;
			}
			Arrays.sort(ms);
			long bytes = Files.size(dir.resolve(JournalStore.INDEX));
			double p50 = ms[n / 2];
			double p99 = ms[(int) Math.ceil(n * 0.99) - 1];
			// round trip
			JournalStore.Index back = JournalStore.indexFromJson(com.google.gson.JsonParser.parseString(Files.readString(dir.resolve(JournalStore.INDEX)))
				.getAsJsonObject());
			System.out.printf("INDEXBENCH entries=%d rows=%d bytes=%d (%.2f MB) commit p50=%.1f ms p99=%.1f ms max=%.1f ms%n", c[0], c[1], bytes,
				bytes / 1048576.0, p50, p99, ms[n - 1]);
			assertTrue(back.entries().size() == c[0]);
			assertTrue(bytes <= 8L << 20, "index " + bytes + " bytes");
			// The p99 is a timing bar: judged only where the box is dedicated (ARCHITECT_TIMING_BARS=1, the gate runner);
			// shared CI runners and a loaded dev box made it flaky (113 ms on CI, 2026-10-10). Size and round trip stay judged.
			if ("1".equals(System.getenv("ARCHITECT_TIMING_BARS"))) assertTrue(p99 <= 100, "commit p99 " + p99 + " ms");
		}
	}
}
