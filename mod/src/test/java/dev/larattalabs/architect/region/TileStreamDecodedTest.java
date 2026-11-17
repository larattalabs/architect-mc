package dev.larattalabs.architect.region;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.io.IOException;
import java.io.InputStream;
import java.util.Base64;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

/**
 * (fix b5, bcd-grow in the v0.73.0 batch) A tile whose phase reads DECODED has its cells. The phase was published inside the decode
 * future's whenComplete action while {@code cells()} read the future that whenComplete returns (done only after the action), so the
 * server thread could see DECODED with null cells: RegionItems built a TileCheck over null, its prepare threw an NPE and the item
 * failed OTHER ("the tile's cells could not be read"), leaving the revision PARTIAL. The hook runs right after the phase is set: on
 * the old code its read is null every time.
 */
class TileStreamDecodedTest {
	@BeforeAll
	static void boot() {
		Boot.boot();
	}

	@AfterEach
	void clean() {
		TileStream.ON_DECODED = null;
		TileStream.forgetRegion(null);
		TileStream.setLink(null);
	}

	private static byte[] res(String name) throws IOException {
		try (InputStream in = TileStreamDecodedTest.class.getResourceAsStream("/region/" + name)) {
			return in.readAllBytes();
		}
	}

	@Test
	void decodedAlwaysCarriesItsCells() throws Exception {
		JsonObject exp = JsonParser.parseString(new String(res("tile.expected.json"))).getAsJsonObject();
		byte[] gz = res("tile.artl.gz");
		TileStream.setLink(new TileStreamBlobTest.Script());
		JsonObject ir = new JsonObject();
		TileStream.request("rg1", "p1", "irsha", x -> ir, "ground", "terrain", "0,0", new byte[] {1});
		TileStream.Tile t = TileStream.get("rg1", "ground", "terrain", "0,0");
		assertNotNull(t);
		AtomicReference<String> seen = new AtomicReference<>();
		CompletableFuture<Void> hooked = new CompletableFuture<>();
		TileStream.ON_DECODED = () -> {
			seen.set(t.phase + " cells " + (t.cells() == null ? "null" : String.valueOf(t.cells().size())));
			hooked.complete(null);
		};
		JsonObject m = new JsonObject();
		m.addProperty("type", "region.tile");
		m.addProperty("planId", "p1");
		m.addProperty("key", "0,0");
		m.addProperty("stage", "ground");
		m.addProperty("set", "terrain");
		m.addProperty("seq", 0);
		m.addProperty("data", Base64.getEncoder().encodeToString(gz));
		m.addProperty("sha", exp.get("sha").getAsString());
		m.addProperty("count", exp.get("count").getAsInt());
		TileStream.onMessage(m);
		hooked.get(10, TimeUnit.SECONDS);
		assertEquals("DECODED cells " + exp.get("count").getAsInt(), seen.get(), "the moment the phase reads DECODED, the cells are there");
		assertTrue(t.cells() != null && t.cells().size() == exp.get("count").getAsInt());
	}
}
