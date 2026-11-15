package dev.larattalabs.architect.region;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.ArrayList;
import java.util.Base64;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.state.BlockState;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

/**
 * (QL) Quote.terrain: the part of the bill that comes from the plan's kept paid terrain cells, read in the same pass as A11's cut. The
 * split (terrain + the rest = bom; a standing cell in neither), every kept item a key (0 included), the clamp to bom, x03's shape, one cell
 * changed between two quotes, and Steward's maxBill rule over it (a one-cell terrain drift passes; two units over on a lot item refuse).
 */
class QuotesTerrainQLTest {
	private static final String DIRT = "minecraft:dirt", GRAVEL = "minecraft:gravel", PLANKS = "minecraft:oak_planks";

	@BeforeAll
	static void boot() {
		Boot.boot();
	}

	private static JsonObject row(String state, String item, List<int[]> xyz) {
		ByteBuffer b = ByteBuffer.allocate(xyz.size() * 12).order(ByteOrder.LITTLE_ENDIAN);
		xyz.forEach(c -> b.putInt(c[0]).putInt(c[1]).putInt(c[2]));
		JsonObject r = new JsonObject();
		r.addProperty("state", state);
		JsonObject its = new JsonObject();
		its.addProperty(item, 1);
		r.add("items", its);
		r.addProperty("cells", Base64.getEncoder().encodeToString(b.array()));
		return r;
	}

	private static List<int[]> line(int n, int y) {
		List<int[]> out = new ArrayList<>();
		for (int i = 0; i < n; i++) {
			out.add(new int[] {i, y, 0});
		}
		return out;
	}

	/** Quotes.of's tile step and its terrain: tiles (group -> items) less what stands, plus a lot's bill; the clamped terrain part. */
	private record Q(JsonObject bom, JsonObject tiles, Map<String, Integer> terrain) {
	}

	private static Q quote(JsonObject plannedTiles, JsonObject kept, Map<String, Integer> lot, Quotes.World w) {
		Quotes.Standing st = Quotes.standing(kept, w);
		Quotes.Bill bill = new Quotes.Bill();
		for (var g : plannedTiles.entrySet()) {
			Map<String, Integer> its = new TreeMap<>();
			g.getValue().getAsJsonObject().entrySet().forEach(e -> its.put(e.getKey(), e.getValue().getAsInt()));
			st.off().getOrDefault(g.getKey(), Map.of()).forEach((k, v) -> its.merge(k, -v, Integer::sum));
			bill.add("tiles:" + g.getKey(), its);
		}
		bill.add("lot:a", lot);
		JsonObject bom = bill.bom();
		return new Q(bom, bill.parts, Quotes.clamp(st.terrain(), bom));
	}

	private static JsonObject tiles(String group, Map<String, Integer> its) {
		JsonObject o = new JsonObject(), g = new JsonObject();
		its.forEach(g::addProperty);
		o.add(group, g);
		return o;
	}

	private static JsonObject kept(String group, JsonObject... rows) {
		JsonArray a = new JsonArray();
		for (JsonObject r : rows) {
			a.add(r);
		}
		JsonObject t = new JsonObject();
		t.add(group, a);
		return t;
	}

	private static int n(JsonObject o, String k) {
		return o.has(k) ? o.get(k).getAsInt() : 0;
	}

	@Test
	void theSplit() {
		// 6 kept dirt cells (2 standing), 3 kept gravel (none standing); the group also bills 4 lanterns (not terrain); the lot 20 planks and 5 dirt
		JsonObject t = kept("g", row(DIRT, DIRT, line(6, 64)), row(GRAVEL, GRAVEL, line(3, 70)));
		Q q = quote(tiles("g", Map.of(DIRT, 6, GRAVEL, 3, "minecraft:lantern", 4)), t, Map.of(PLANKS, 20, DIRT, 5),
			(x, y, z) -> y == 64 && x < 2 ? Blocks.DIRT.defaultBlockState() : Blocks.AIR.defaultBlockState());
		assertEquals(Map.of(DIRT, 4, GRAVEL, 3), q.terrain(), "the kept cells not standing");
		assertEquals(9, n(q.bom(), DIRT), "4 terrain + 5 lot (the 2 standing in neither)");
		for (String k : q.bom().keySet()) {
			int rest = n(q.bom(), k) - q.terrain().getOrDefault(k, 0);
			assertTrue(rest >= 0, k);
		}
		assertEquals(5, n(q.bom(), DIRT) - q.terrain().get(DIRT), "the rest of the dirt is the lot's");
		assertEquals(20, n(q.bom(), PLANKS));
		assertTrue(!q.terrain().containsKey(PLANKS) && !q.terrain().containsKey("minecraft:lantern"), "lots and non-terrain tiles are not terrain");
	}

	@Test
	void x03AllStandingKeepsAZeroKey() {
		// A11's x03: 49 grading dirt cells, every one already dirt: bom has no dirt, terrain names it with 0
		Q q = quote(tiles("hamlet", Map.of(DIRT, 49)), kept("hamlet", row(DIRT, DIRT, line(49, 64))), Map.of(PLANKS, 156),
			(x, y, z) -> Blocks.DIRT.defaultBlockState());
		assertEquals(Map.of(DIRT, 0), q.terrain());
		assertTrue(!q.bom().has(DIRT));
		assertEquals(156, n(q.bom(), PLANKS));
	}

	@Test
	void anUnloadedCellIsTerrainAndBilled() {
		Q q = quote(tiles("g", Map.of(DIRT, 3)), kept("g", row(DIRT, DIRT, line(3, 64))), Map.of(), (x, y, z) -> x == 2 ? null
			: Blocks.DIRT.defaultBlockState());
		assertEquals(Map.of(DIRT, 1), q.terrain());
		assertEquals(1, n(q.bom(), DIRT));
	}

	@Test
	void clampedToTheBom() {
		JsonObject bom = new JsonObject();
		bom.addProperty(DIRT, 2);
		assertEquals(Map.of(DIRT, 2, GRAVEL, 0), Quotes.clamp(Map.of(DIRT, 5, GRAVEL, 3), bom), "at most its bom count; an item bom lacks: 0");
	}

	@Test
	void oneCellChangedBetweenTwoQuotes() {
		JsonObject plannedTiles = tiles("hamlet", Map.of(DIRT, 49, "minecraft:lantern", 4));
		JsonObject t = kept("hamlet", row(DIRT, DIRT, line(49, 64)));
		Set<Integer> changed = new HashSet<>();
		Quotes.World w = (x, y, z) -> changed.contains(x) ? Blocks.COARSE_DIRT.defaultBlockState() : Blocks.DIRT.defaultBlockState();
		Q a = quote(plannedTiles, t, Map.of(PLANKS, 156, DIRT, 7), w);
		changed.add(17); // one standing dirt cell turned to coarse dirt (another state: a realise writes it)
		Q b = quote(plannedTiles, t, Map.of(PLANKS, 156, DIRT, 7), w);
		assertEquals(0, a.terrain().get(DIRT));
		assertEquals(1, b.terrain().get(DIRT), "terrain moves by the one cell");
		assertEquals(n(a.bom(), DIRT) + 1, n(b.bom(), DIRT), "bom moves by the one unit");
		assertEquals(n(a.tiles().getAsJsonObject("tiles:hamlet"), DIRT) + 1, n(b.tiles().getAsJsonObject("tiles:hamlet"), DIRT));
		assertEquals(a.tiles().get("lot:a"), b.tiles().get("lot:a"), "the lot's piece is unchanged");
		JsonObject ra = a.bom().deepCopy(), rb = b.bom().deepCopy();
		ra.remove(DIRT);
		rb.remove(DIRT);
		assertEquals(ra, rb, "every other item unchanged");
	}

	/** Steward's maxBill rule (QL's contract): bom[item] + max(2, ceil(2% of terrain[item])) for a terrain item, over bom ∪ terrain; else exact. */
	private static Map<String, Integer> stewardCap(JsonObject bom, Map<String, Integer> terrain) {
		Map<String, Integer> cap = new TreeMap<>();
		bom.entrySet().forEach(e -> cap.put(e.getKey(), e.getValue().getAsInt()));
		terrain.forEach((k, v) -> cap.merge(k, Math.max(2, (int) Math.ceil(v * 0.02)), Integer::sum));
		return cap;
	}

	@Test
	void stewardsCapPassesATerrainDriftAndRefusesALotDrift() {
		JsonObject plannedTiles = tiles("hamlet", Map.of(DIRT, 49));
		JsonObject t = kept("hamlet", row(DIRT, DIRT, line(49, 64)));
		Set<Integer> changed = new HashSet<>();
		Quotes.World w = (x, y, z) -> changed.contains(x) ? Blocks.COARSE_DIRT.defaultBlockState() : Blocks.DIRT.defaultBlockState();
		Q approved = quote(plannedTiles, t, Map.of(PLANKS, 156), w);
		Map<String, Integer> cap = stewardCap(approved.bom(), approved.terrain());
		assertEquals(2, cap.get(DIRT), "x03: a 0-count terrain item still gets its allowance of 2");
		changed.add(3);
		Q putDown = quote(plannedTiles, t, Map.of(PLANKS, 156), w);
		assertTrue(Quotes.overCap(putDown.bom(), cap).isEmpty(), "a one-cell terrain drift is under the cap: " + Quotes.overCap(putDown.bom(), cap));
		Q lotDrift = quote(plannedTiles, t, Map.of(PLANKS, 158), w);
		assertEquals(List.of("oak_planks 158 > 156"), Quotes.overCap(lotDrift.bom(), cap), "a lot item stays exact: two over refuses");
		// 300 terrain dirt: ceil(2% of 300) = 6
		JsonObject big = new JsonObject();
		big.addProperty(DIRT, 300);
		assertEquals(306, stewardCap(big, Map.of(DIRT, 300)).get(DIRT));
	}

	@Test
	void noKeptCellsNoTerrain() {
		Q q = quote(tiles("g", Map.of(DIRT, 5)), new JsonObject(), Map.of(), (x, y, z) -> (BlockState) null);
		assertTrue(q.terrain().isEmpty(), "a plan with no survivalTerrain: empty");
		assertEquals(5, n(q.bom(), DIRT));
	}
}
