package dev.larattalabs.architect.region;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.io.IOException;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import net.minecraft.commands.arguments.blocks.BlockStateParser;
import net.minecraft.core.BlockPos;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

/**
 * The mod reads what the kit writes (kit/REGIONS.md): an ARTL tile and an ARSV window made by kit/lib/region/pack.mjs
 * (test resources region/, regenerated from the kit), decoded in Java: every cell, state, cond and walk bit; the sha over the
 * uncompressed payload; frames; a wrong sha refused.
 */
class RegionCodecTest {
	@BeforeAll
	static void boot() {
		Boot.boot();
	}

	private static byte[] res(String name) throws IOException {
		try (InputStream in = RegionCodecTest.class.getResourceAsStream("/region/" + name)) {
			return in.readAllBytes();
		}
	}

	@Test
	void aKitTileDecodesCellForCell() throws IOException {
		JsonObject exp = JsonParser.parseString(new String(res("tile.expected.json"))).getAsJsonObject();
		byte[] gz = res("tile.artl.gz");
		// three frames, as the sidecar splits big tiles
		int a = gz.length / 3;
		List<byte[]> frames = List.of(java.util.Arrays.copyOfRange(gz, 0, a), java.util.Arrays.copyOfRange(gz, a, 2 * a), java.util.Arrays.copyOfRange(gz,
			2 * a, gz.length));
		byte[] payload = Packed.payload(frames, exp.get("sha").getAsString());
		Packed.Tile t = Packed.decode(payload);
		assertEquals(exp.get("count").getAsInt(), t.size());
		assertEquals(exp.get("sha").getAsString(), t.sha());
		List<String> got = new ArrayList<>();
		for (int i = 0; i < t.size(); i++) {
			long p = t.pos()[i];
			got.add(BlockPos.getX(p) + "," + BlockPos.getY(p) + "," + BlockPos.getZ(p) + "|" + t.stateIds().get(t.state()[i]) + "|" + t.cond()[i] + "|" + (t
				.walk()[i] ? 1 : 0) + "|" + BlockStateParser.serialize(t.states().get(t.state()[i])).equals(BlockStateParser.serialize(Packed.parse(t.stateIds()
					.get(t.state()[i])))));
		}
		got.sort(Comparator.naturalOrder());
		List<String> want = new ArrayList<>();
		for (var e : exp.getAsJsonArray("cells")) {
			JsonArray c = e.getAsJsonArray();
			want.add(c.get(0).getAsInt() + "," + c.get(1).getAsInt() + "," + c.get(2).getAsInt() + "|" + c.get(3).getAsString() + "|" + c.get(4).getAsInt() + "|"
				+ c.get(5).getAsInt() + "|true");
		}
		want.sort(Comparator.naturalOrder());
		assertEquals(want, got);
	}

	@Test
	void aWrongShaIsRefused() throws IOException {
		byte[] gz = res("tile.artl.gz");
		assertThrows(IOException.class, () -> Packed.payload(List.of(gz), "00"));
	}

	@Test
	void aKitWindowRoundTrips() throws IOException {
		byte[] a = res("window.arsv");
		Columns c = Columns.decode(a);
		assertEquals(-8, c.minX);
		assertEquals(80, c.width);
		assertEquals(60 + 13 % 7, c.ground[13]);
		assertEquals(1, c.flags[5] & Columns.WATER);
		assertArrayEquals(a, c.encode());
		assertEquals(c.index(3, 4), c.at(-5, 60));
	}
}
