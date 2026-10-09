package dev.larattalabs.architect.region;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/** The side blob copy (CONTRACT phase 6b §2.2, gate item 1 "the blob copy with read-back, and a bad sha refusing"). */
class RegionBlobsTest {
	@TempDir
	Path tmp;

	static byte[] b(String s) {
		return s.getBytes(StandardCharsets.UTF_8);
	}

	@Test
	void copiesAndReadsBack() throws Exception {
		byte[] one = b("heightfield one");
		byte[] two = b("mask two");
		String s1 = Packed.sha256(one);
		String s2 = Packed.sha256(two);
		AtomicInteger reads = new AtomicInteger();
		Map<String, byte[]> store = Map.of("blob-1", one, "blob-2", two);
		Path dir = tmp.resolve("rg1/blobs");
		String err = RegionBlobs.install(dir, List.of(s1, s2), Map.of(s1, "blob-1", s2, "blob-2"), id -> {
			reads.incrementAndGet();
			return CompletableFuture.completedFuture(store.get(id));
		}).join();
		assertNull(err);
		assertArrayEquals(one, Files.readAllBytes(dir.resolve(s1 + ".bin")));
		assertArrayEquals(two, Files.readAllBytes(dir.resolve(s2 + ".bin")));
		assertEquals(2, reads.get());
		assertFalse(Files.exists(dir.resolve(s1 + ".bin.tmp")), "renamed, no temp file left");
		// a copy that checks out is kept (not read again)
		assertNull(RegionBlobs.install(dir, List.of(s1, s2), Map.of(), id -> CompletableFuture.failedFuture(new IllegalStateException("no"))).join());
		assertEquals(List.of(), RegionBlobs.bad(dir, List.of(s1, s2)));
		RegionBlobs.delete(dir);
		assertFalse(Files.exists(dir));
	}

	@Test
	void aBadShaRefuses() {
		byte[] good = b("the real blob");
		String sha = Packed.sha256(good);
		String err = RegionBlobs.install(tmp.resolve("b"), List.of(sha), Map.of(sha, "x"), id -> CompletableFuture.completedFuture(b("tampered"))).join();
		assertTrue(err.startsWith("blob " + sha + " missing ("), err);
		assertFalse(Files.exists(tmp.resolve("b").resolve(sha + ".bin")), "nothing written for a bad copy");
	}

	@Test
	void missingRefuses() {
		String sha = "c".repeat(64);
		assertTrue(RegionBlobs.install(tmp, List.of(sha), Map.of(), id -> null).join().contains("names no blob id"));
		assertTrue(RegionBlobs.install(tmp, List.of(sha), Map.of(sha, "gone"), id -> CompletableFuture.failedFuture(new IllegalStateException(
			"no blob gone"))).join().contains("no blob gone"));
	}

	@Test
	void aCorruptWorldCopyIsBad() throws Exception {
		byte[] good = b("x");
		String sha = Packed.sha256(good);
		Files.createDirectories(tmp);
		Files.write(tmp.resolve(sha + ".bin"), b("y"));
		assertEquals(List.of(sha), RegionBlobs.bad(tmp, List.of(sha)));
		// install replaces it from the helper's copy
		assertNull(RegionBlobs.install(tmp, List.of(sha), Map.of(sha, "id"), id -> CompletableFuture.completedFuture(good)).join());
		assertEquals(List.of(), RegionBlobs.bad(tmp, List.of(sha)));
	}
}
