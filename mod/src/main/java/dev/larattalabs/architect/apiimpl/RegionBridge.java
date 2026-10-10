package dev.larattalabs.architect.apiimpl;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import dev.larattalabs.architect.region.TileStream;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.atomic.AtomicInteger;

/** Phase 6a: the sidecar link as the regions see it (a {@link TileStream.Link}), and blob put/read for plan surveys and IRs. */
public final class RegionBridge implements TileStream.Link {
	static final RegionBridge INSTANCE = new RegionBridge();
	private static final AtomicInteger GEN = new AtomicInteger();

	private RegionBridge() {
	}

	/** Every reconnect is a new generation (requests of an older link are asked again). */
	static void linkChanged(boolean synced) {
		GEN.incrementAndGet();
	}

	@Override
	public boolean connected() {
		ClientBridge b = ApiImpl.bridge();
		return b != null && b.connected() && b.protocol() >= 2;
	}

	@Override
	public int generation() {
		return GEN.get();
	}

	@Override
	public CompletableFuture<JsonObject> send(JsonObject message) {
		ClientBridge b = ApiImpl.bridge();
		if (b == null) {
			return CompletableFuture.failedFuture(new IllegalStateException("no helper link"));
		}
		return b.send(message);
	}

	/** {@code blob.put} of {@code data} (several frames when large); completes with the blob id. */
	public static CompletableFuture<String> put(byte[] data, String kind) {
		ClientBridge b = ApiImpl.bridge();
		if (b == null || !b.connected()) {
			return CompletableFuture.failedFuture(new IllegalStateException("the helper (sidecar) is not connected"));
		}
		List<List<String>> frames = BlobFrames.frames(data);
		CompletableFuture<String> chain = frame(b, frames.get(0), null, kind, frames.size() > 1);
		for (int i = 1; i < frames.size(); i++) {
			List<String> f = frames.get(i);
			boolean more = i < frames.size() - 1;
			chain = chain.thenCompose(id -> frame(b, f, id, kind, more));
		}
		return chain;
	}

	private static CompletableFuture<String> frame(ClientBridge b, List<String> chunks, String blobId, String kind, boolean more) {
		JsonObject m = new JsonObject();
		m.addProperty("type", "blob.put");
		if (blobId != null) {
			m.addProperty("blobId", blobId);
		} else {
			m.addProperty("kind", kind);
			m.addProperty("ext", "bin");
		}
		JsonArray arr = new JsonArray();
		chunks.forEach(arr::add);
		m.add("chunks", arr);
		if (more) {
			m.addProperty("more", true);
		}
		return b.send(m).thenApply(ack -> JobsImpl.ackString(ack, "blobId"));
	}

	public static CompletableFuture<byte[]> read(String blobId) {
		ClientBridge b = ApiImpl.bridge();
		if (b == null) {
			return CompletableFuture.failedFuture(new IllegalStateException("no helper link"));
		}
		return b.readBlob(blobId);
	}

	/** (6b) The helper's {@code kitVersion}, {@code irFormats}, {@code irKinds} (its snapshot), or null when unknown or not connected. */
	public static @org.jspecify.annotations.Nullable JsonObject versions() {
		ClientBridge b = ApiImpl.bridge();
		return b == null || !b.connected() ? null : b.sidecarVersions();
	}

	/** (6b) Asks the launcher to (re)start the helper (the START_SIDECAR nudge); what happened. */
	public static String restartSidecar() {
		ClientBridge b = ApiImpl.bridge();
		return b == null ? "no helper link on this side (a dedicated server)" : b.restartSidecar();
	}
}
