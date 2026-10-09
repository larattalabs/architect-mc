package dev.larattalabs.architect.region;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.function.Function;
import org.jspecify.annotations.Nullable;

/**
 * A region's side blobs (docs/CONTRACT.md phase 6b §2.2, kit/REGIONS.md "Side blobs"): when the region record is created, before
 * any tile is requested, every blob its IR names is copied into {@code <world>/architect-regions/<id>/blobs/<sha>.bin}, read
 * through the helper's blob store (the {@code blobs: [{sha, blobId}]} list of {@code region.planned}). Each copy is written,
 * fsynced, renamed, read back and its SHA-256 checked. A blob missing or bad refuses the realise with {@code OTHER} ("blob <sha>
 * missing") before any write. The copies are what the {@code blob_unknown} re-send uploads (so a realise and its resume never
 * need the helper's plan dir), and they go with the region record after the region is removed. Off the server thread.
 */
public final class RegionBlobs {
	private RegionBlobs() {
	}

	public static Path dir(Path world, String regionId) {
		return RegionStore.region(world, regionId).resolve("blobs");
	}

	public static Path file(Path world, String regionId, String sha) {
		if (!sha.matches("[0-9a-f]{64}")) {
			throw new IllegalArgumentException("bad blob sha " + sha);
		}
		return dir(world, regionId).resolve(sha + ".bin");
	}

	/** Whether {@code f} holds bytes hashing to {@code sha}. */
	public static boolean verify(Path f, String sha) {
		try {
			return Files.isRegularFile(f) && Packed.sha256(Files.readAllBytes(f)).equals(sha);
		} catch (IOException e) {
			return false;
		}
	}

	/** The blob ids of a plan's side blobs ({@code region.planned.blobs: [{sha, blobId}]}): sha -> blob id. */
	public static Map<String, String> blobIds(com.google.gson.JsonObject planned) {
		Map<String, String> out = new java.util.LinkedHashMap<>();
		if (planned != null && planned.get("blobs") instanceof com.google.gson.JsonArray a) {
			for (var e : a) {
				if (e instanceof com.google.gson.JsonObject o && o.has("sha") && o.has("blobId") && !o.get("blobId").isJsonNull()) {
					out.put(o.get("sha").getAsString(), o.get("blobId").getAsString());
				}
			}
		}
		return out;
	}

	/**
	 * Copies every sha into {@code dir}: a copy already there that checks out is kept; otherwise its bytes are read
	 * ({@code read}: blob id -> bytes), their sha checked, written (fsync, rename) and read back. Completes with null when all are
	 * there, else the refusal message ({@code blob <sha> missing (why)}), naming the first that failed.
	 */
	public static CompletableFuture<@Nullable String> install(Path dir, List<String> shas, Map<String, String> blobIds,
		Function<String, CompletableFuture<byte[]>> read) {
		CompletableFuture<@Nullable String> chain = CompletableFuture.completedFuture(null);
		for (String sha : shas) {
			chain = chain.thenCompose(err -> {
				if (err != null) {
					return CompletableFuture.completedFuture(err);
				}
				Path f = dir.resolve(sha + ".bin");
				if (verify(f, sha)) {
					return CompletableFuture.completedFuture(null);
				}
				String id = blobIds.get(sha);
				if (id == null) {
					return CompletableFuture.completedFuture(missing(sha, "the plan names no blob id for it"));
				}
				CompletableFuture<byte[]> got;
				try {
					got = read.apply(id);
				} catch (RuntimeException e) {
					got = CompletableFuture.failedFuture(e);
				}
				return got.handle((bytes, e) -> {
					if (e != null || bytes == null) {
						Throwable c = e != null && e.getCause() != null ? e.getCause() : e;
						return missing(sha, "could not be read from the helper: " + (c == null ? "no data" : c.getMessage()));
					}
					return write(f, sha, bytes);
				});
			});
		}
		return chain;
	}

	/** Write, fsync, rename, read back, sha check; null or the refusal message. */
	static @Nullable String write(Path f, String sha, byte[] bytes) {
		if (!Packed.sha256(bytes).equals(sha)) {
			return missing(sha, "the helper's copy hashes to " + Packed.sha256(bytes));
		}
		try {
			RegionStore.writeChecked(f, bytes);
		} catch (IOException e) {
			return missing(sha, "could not be written: " + e.getMessage());
		}
		return verify(f, sha) ? null : missing(sha, "the copy did not read back");
	}

	static String missing(String sha, String why) {
		return "blob " + sha + " missing (" + why + ")";
	}

	/** The shas of {@code shas} whose world copy is missing or bad (realise refuses on any). */
	public static List<String> bad(Path dir, List<String> shas) {
		List<String> out = new ArrayList<>();
		for (String sha : shas) {
			if (!verify(dir.resolve(sha + ".bin"), sha)) {
				out.add(sha);
			}
		}
		return out;
	}

	/** Deletes a region's blob copies (after the region was removed). */
	public static void delete(Path dir) {
		if (!Files.isDirectory(dir)) {
			return;
		}
		try (var st = Files.list(dir)) {
			for (Path p : st.toList()) {
				if (p.getFileName().toString().endsWith(".bin") || p.getFileName().toString().endsWith(".tmp")) {
					Files.deleteIfExists(p);
				}
			}
			Files.deleteIfExists(dir);
		} catch (IOException e) {
			dev.larattalabs.architect.Architect.LOGGER.warn("Region blobs {} not deleted: {}", dir, e.toString());
		}
	}
}
