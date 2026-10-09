package dev.larattalabs.architect.region;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonObject;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.function.Function;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

/** The blob_unknown re-send (CONTRACT phase 6b §2.2): IR first, then blobs, at most 3 per reason, then the tile waits. */
class TileStreamBlobTest {
	static final String SHA_A = Packed.sha256("blob a".getBytes(StandardCharsets.UTF_8));
	static final String SHA_B = Packed.sha256("blob b".getBytes(StandardCharsets.UTF_8));

	/** A link that answers each request from a script of errors (null = ok). */
	static final class Script implements TileStream.Link {
		final List<String> answers;
		final List<JsonObject> sent = new ArrayList<>();

		Script(String... answers) {
			this.answers = new ArrayList<>(java.util.Arrays.asList(answers));
		}

		public boolean connected() {
			return true;
		}

		public int generation() {
			return 1;
		}

		public CompletableFuture<JsonObject> send(JsonObject m) {
			sent.add(m.deepCopy());
			JsonObject ack = new JsonObject();
			String a = answers.isEmpty() ? null : answers.remove(0);
			ack.addProperty("ok", a == null);
			if (a != null) {
				ack.addProperty("error", a);
			}
			return CompletableFuture.completedFuture(ack);
		}
	}

	final List<String> puts = new ArrayList<>();

	TileStream.Tile run(Script link) {
		TileStream.setLink(link);
		TileStream.PUT = (bytes, kind) -> {
			puts.add(kind + ":" + new String(bytes, StandardCharsets.UTF_8));
			return CompletableFuture.completedFuture("blob-" + puts.size());
		};
		Map<String, byte[]> world = Map.of(SHA_A, "blob a".getBytes(StandardCharsets.UTF_8), SHA_B, "blob b".getBytes(StandardCharsets.UTF_8));
		JsonObject ir = new JsonObject();
		ir.addProperty("format", 2);
		Function<Void, JsonObject> irf = x -> ir;
		TileStream.request("rg1", "p1", "irsha", irf, world::get, "ground", "terrain", "0,0", new byte[] {1, 2});
		return TileStream.get("rg1", "ground", "terrain", "0,0");
	}

	@AfterEach
	void clean() {
		TileStream.forgetRegion(null);
		TileStream.setLink(null);
	}

	@Test
	void irThenBlobs() {
		Script link = new Script("ir_unknown", "blob_unknown " + SHA_A + "," + SHA_B, null);
		TileStream.Tile t = run(link);
		assertEquals(TileStream.Phase.REQUESTED, t.phase);
		assertEquals(3, link.sent.size());
		assertTrue(link.sent.get(1).has("ir"), "the IR goes first");
		JsonObject third = link.sent.get(2);
		assertTrue(third.has("ir"), "the IR stays along with the blobs");
		assertEquals("blob-1", third.getAsJsonObject("blobs").get(SHA_A).getAsString());
		assertEquals("blob-2", third.getAsJsonObject("blobs").get(SHA_B).getAsString());
		assertEquals(List.of("region.blob:blob a", "region.blob:blob b"), puts);
	}

	@Test
	void atMostThreePerReasonThenWaits() {
		String bu = "blob_unknown " + SHA_A;
		Script link = new Script(bu, bu, bu, bu);
		TileStream.Tile t = run(link);
		assertEquals(4, link.sent.size(), "the request and 3 re-requests");
		assertEquals(TileStream.Phase.WAITING, t.phase);
		assertTrue(t.error.contains("after 3 re-sends"), t.error);
		// WAITING keeps the tile (no re-request loop) until the START_SIDECAR nudge or a reconnect asks again
		assertEquals(1, TileStream.retryWaiting("rg1"));
		assertEquals(null, TileStream.get("rg1", "ground", "terrain", "0,0"));
	}

	@Test
	void aMissingWorldCopyWaits() {
		Script link = new Script("blob_unknown " + "d".repeat(64));
		TileStream.Tile t = run(link);
		assertEquals(TileStream.Phase.WAITING, t.phase);
		assertTrue(t.error.contains("missing in the world copy"), t.error);
	}

	@Test
	void otherErrorsFail() {
		TileStream.Tile t = run(new Script("IR: format must be 1"));
		assertEquals(TileStream.Phase.FAILED, t.phase);
	}

	@Test
	void shasOfTheError() {
		assertEquals(List.of(SHA_A, SHA_B), TileStream.blobUnknown("blob_unknown " + SHA_A + "," + SHA_B + "," + SHA_A));
		assertEquals(List.of(SHA_A), TileStream.blobUnknown("blob_unknown {\"shas\":[\"" + SHA_A + "\"]}"));
	}
}
