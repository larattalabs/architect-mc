package dev.larattalabs.architect.region;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.Base64;
import java.util.Map;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.state.BlockState;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

/**
 * (BC, A11) The plan's kept paid terrain cells (survivalTerrain) read against the world: the cells the land already holds are left out of
 * the bill (a realise skips them); a cell in an unloaded chunk stays billed and makes the quote inexact; when the kept cells cover every
 * natural-terrain item, SA's upper-bound note goes and the quote is exact.
 */
class QuotesStandingBCTest {
	@BeforeAll
	static void boot() {
		Boot.boot();
	}

	private static String cells(int[]... xyz) {
		ByteBuffer b = ByteBuffer.allocate(xyz.length * 12).order(ByteOrder.LITTLE_ENDIAN);
		for (int[] c : xyz) {
			b.putInt(c[0]).putInt(c[1]).putInt(c[2]);
		}
		return Base64.getEncoder().encodeToString(b.array());
	}

	private static JsonObject terrain(String group, String state, String item, int[]... xyz) {
		JsonObject row = new JsonObject();
		row.addProperty("state", state);
		JsonObject its = new JsonObject();
		its.addProperty(item, 1);
		row.add("items", its);
		row.addProperty("cells", cells(xyz));
		JsonArray a = new JsonArray();
		a.add(row);
		JsonObject t = new JsonObject();
		t.add(group, a);
		return t;
	}

	@Test
	void theCellsAlreadyThereAreTakenOff() {
		// x03's case in small: 4 grading dirt cells, 3 over dirt (skipped in game), 1 over air
		JsonObject t = terrain("hamlet", "minecraft:dirt", "minecraft:dirt", new int[] {0, 64, 0}, new int[] {1, 64, 0}, new int[] {2, 64, 0},
			new int[] {-3, 65, -4});
		Quotes.Standing s = Quotes.standing(t, (x, y, z) -> y == 64 ? Blocks.DIRT.defaultBlockState() : Blocks.AIR.defaultBlockState());
		assertEquals(3, s.offCells());
		assertEquals(0, s.unloaded());
		assertEquals(Map.of("hamlet", Map.of("minecraft:dirt", 3)), s.off());
		assertEquals(Map.of("hamlet", Map.of("minecraft:dirt", 4)), s.covered());
		JsonObject tiles = JsonParser.parseString("{\"hamlet\":{\"minecraft:dirt\":4,\"minecraft:lantern\":4}}").getAsJsonObject();
		assertNull(Quotes.mayAlreadyHold(tiles, s.covered()), "every natural item covered: no upper-bound note (exact)");
		assertNotNull(Quotes.mayAlreadyHold(tiles), "SA's note without the kept cells");
	}

	@Test
	void anotherStateIsBilled() {
		// grass where the plan writes dirt: a realise writes it (TileCheck's same is the state, not the item)
		BlockState grass = Blocks.GRASS_BLOCK.defaultBlockState();
		Quotes.Standing s = Quotes.standing(terrain("g", "minecraft:dirt", "minecraft:dirt", new int[] {0, 64, 0}), (x, y, z) -> grass);
		assertEquals(0, s.offCells());
		assertTrue(s.off().isEmpty());
	}

	@Test
	void anUnloadedCellStaysBilledAndInexact() {
		Quotes.Standing s = Quotes.standing(terrain("g", "minecraft:dirt", "minecraft:dirt", new int[] {0, 64, 0}, new int[] {900, 64, 0}),
			(x, y, z) -> x > 100 ? null : Blocks.DIRT.defaultBlockState());
		assertEquals(1, s.offCells());
		assertEquals(1, s.unloaded());
		assertEquals(Map.of("g", Map.of("minecraft:dirt", 2)), s.covered(), "both kept: the unloaded one has its own note");
	}

	@Test
	void uncoveredItemsKeepTheNote() {
		// 10 dirt billed, 4 kept (a group past the kit's cap keeps none): 6 may still stand unread
		JsonObject tiles = JsonParser.parseString("{\"g\":{\"minecraft:dirt\":10}}").getAsJsonObject();
		String n = Quotes.mayAlreadyHold(tiles, Map.of("g", Map.of("minecraft:dirt", 4)));
		assertNotNull(n);
		assertTrue(n.contains("6 paid cell(s)") && n.contains("g (6 dirt)"), n);
	}

	@Test
	void anUnknownStateIsSkipped() {
		Quotes.Standing s = Quotes.standing(terrain("g", "minecraft:not_a_block", "minecraft:dirt", new int[] {0, 64, 0}), (x, y, z) -> Blocks.DIRT
			.defaultBlockState());
		assertEquals(0, s.offCells());
		assertTrue(s.covered().isEmpty(), "not covered: the upper-bound note names it");
	}
}
