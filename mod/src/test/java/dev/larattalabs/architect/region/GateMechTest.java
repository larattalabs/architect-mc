package dev.larattalabs.architect.region;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import it.unimi.dsi.fastutil.longs.Long2IntOpenHashMap;
import it.unimi.dsi.fastutil.longs.LongOpenHashSet;
import net.minecraft.core.BlockPos;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

/**
 * (7a GM-a, docs/CONTRACT.md "Slice GM" §15 item 2) The bind rule over synthetic designs: the lowest rung whose sensor has the design's
 * roof beside it and nothing above it; a roof above the last rung, a block over the sensor, or no roof beside it (a crenel gap) is no
 * rung (levers-only: the base alone, no sensor, deviation mechanism.sensor); a picked rung's cells follow the base, the last state wins.
 */
class GateMechTest {
	@BeforeAll
	static void boot() {
		net.minecraft.SharedConstants.tryDetectVersion();
		net.minecraft.server.Bootstrap.bootStrap();
	}

	// three rungs at roofs 10, 11, 12 (world y = row): sensors (0, 10, 1), (0, 11, 2), (0, 12, 3); the roof beside them at x = -1 and 1
	static final String WRITE = "{\"palette\":[\"minecraft:stone_bricks\",\"minecraft:daylight_detector[inverted=true,power=0]\",\"minecraft:redstone_wire\"],"
		+ "\"base\":[5,4,5,0, 5,5,5,2],"
		+ "\"rungs\":[{\"roof\":10,\"sensor\":[0,10,1],\"beside\":[-1,10,1,1,10,1],\"cells\":[0,10,1,1]},"
		+ "{\"roof\":11,\"sensor\":[0,11,2],\"beside\":[-1,11,2,1,11,2],\"cells\":[0,10,2,2, 0,11,2,1, 5,5,5,0]},"
		+ "{\"roof\":12,\"sensor\":[0,12,3],\"beside\":[-1,12,3,1,12,3],\"cells\":[0,12,3,1]}]}";

	static GateMech.Design flatRoof(int y, int... gaps) {
		LongOpenHashSet solid = new LongOpenHashSet();
		Long2IntOpenHashMap top = new Long2IntOpenHashMap();
		top.defaultReturnValue(Integer.MIN_VALUE);
		for (int x = -3; x <= 3; x++) {
			for (int z = 0; z <= 6; z++) {
				boolean gap = false;
				for (int g : gaps) {
					gap |= g == x;
				}
				if (gap || x == 0) {
					continue; // the sensor column (reserved: the design leaves it empty) and the gaps
				}
				solid.add(BlockPos.asLong(x, y, z));
				top.put(BlockPos.asLong(x, 0, z), y);
			}
		}
		return new GateMech.Design(solid, top);
	}

	static JsonObject write() {
		return JsonParser.parseString(WRITE).getAsJsonObject();
	}

	@Test
	void pickRung() {
		assertEquals(0, GateMech.pickRung(write(), flatRoof(10)), "a roof at row 10: the first rung");
		assertEquals(2, GateMech.pickRung(write(), flatRoof(12)), "a roof at the last rung's row");
		assertEquals(-1, GateMech.pickRung(write(), flatRoof(13)), "a roof above depth + 7: levers-only");
		assertEquals(1, GateMech.pickRung(write(), flatRoof(11, -1)), "a crenel gap on one side: the other side's roof holds it");
		assertEquals(-1, GateMech.pickRung(write(), flatRoof(11, -1, 1)), "no roof either side: no rung");
		GateMech.Design d = flatRoof(10);
		d.solid().add(BlockPos.asLong(0, 14, 1));
		d.top().put(BlockPos.asLong(0, 0, 1), 14);
		assertEquals(-1, GateMech.pickRung(write(), d), "a block (a lamp, a turret) over the sensor: no sky");
	}

	@Test
	void plan() {
		GateMech.Plan p = GateMech.plan(write(), null, null, 0, 0, 0);
		assertTrue(p.leversOnly(), "no design: levers-only");
		assertEquals(2, p.positions().length);
		assertNull(p.roof());
		assertEquals(GateMech.DEVIATION_SENSOR, p.report("portcullis").get("deviation").getAsString());
		// a rung's cells after the base; a cell in both keeps the rung's state, written once
		GateMech.Design d = flatRoof(11);
		JsonObject w = write();
		int rung = GateMech.pickRung(w, d);
		assertEquals(1, rung);
		var only = new java.util.LinkedHashMap<Long, String>();
		GateMech.Plan q = GateMech.planOver(w, d);
		for (int i = 0; i < q.positions().length; i++) {
			only.put(q.positions()[i], q.states()[i].toString());
		}
		assertEquals(4, q.positions().length);
		assertTrue(only.get(BlockPos.asLong(5, 5, 5)).contains("stone_bricks"), "the rung's state wins");
		assertArrayEquals(new int[] {0, 11, 2}, q.sensor());
		assertEquals(11, q.roof());
	}

	/**
	 * (7a GM-a2, §16 item 3) The roof fill: a roof at row 10 binds rung 10; of the other rungs' cells at or above row 10, the one in the
	 * roof course (the design's roof beside it across the passage) gets the structure block, the ones above the flat roof (nothing beside
	 * them) stay empty; the bill counts the fill. A levers-only gate fills nothing.
	 */
	@Test
	void roofFill() {
		JsonObject w = write();
		w.addProperty("fill", 0);
		GateMech.Plan q = GateMech.planOver(w, flatRoof(10));
		var at = new java.util.HashMap<Long, String>();
		for (int i = 0; i < q.positions().length; i++) {
			at.put(q.positions()[i], q.states()[i].toString());
		}
		assertEquals(10, q.roof());
		assertEquals(1, q.filled(), "one hole in the roof course");
		assertTrue(at.get(BlockPos.asLong(0, 10, 2)).contains("stone_bricks"), "rung 11's dust cell, in the roof at row 10, is filled");
		assertNull(at.get(BlockPos.asLong(0, 11, 2)), "rung 11's sensor cell above the flat roof: no bump");
		assertNull(at.get(BlockPos.asLong(0, 12, 3)), "rung 12's sensor cell above the flat roof: no bump");
		assertEquals(1, q.report("portcullis").get("fill").getAsInt());
		// the bill: the base's stone bricks and dust, the sensor, the fill
		assertEquals(2, q.bill().get("minecraft:stone_bricks"), "a base block and the fill");
		assertEquals(1, q.bill().get("minecraft:daylight_detector"));
		assertEquals(1, q.bill().get("minecraft:redstone"));
		assertEquals(q.bill().get("minecraft:stone_bricks"), q.report("portcullis").getAsJsonObject("bom").get("minecraft:stone_bricks").getAsInt());
		GateMech.Plan lv = GateMech.planOver(w, flatRoof(13));
		assertTrue(lv.leversOnly());
		assertEquals(0, lv.filled(), "levers-only: no roof row bound, nothing filled");
		assertNull(lv.bill().get("minecraft:daylight_detector"), "levers-only: no sensor billed");
	}

	/**
	 * (GM-b, CONTRACT GM §17 item 4) A K1 swing gate's write (the IR's gateMechanisms[]): read from the IR, its base written whole (no rung,
	 * no design read), the bill exact (an iron door per pair of halves), the report with no sensor deviation.
	 */
	@Test
	void k1SwingGate() {
		String gw = "{\"gate\":\"east_gate\",\"wall\":\"curtain\",\"kind\":\"swing\",\"stage\":\"links\",\"palette\":[\"minecraft:stone_bricks\","
			+ "\"minecraft:iron_door[facing=west,half=lower,hinge=left,open=false,powered=false]\",\"minecraft:iron_door[facing=west,half=upper,hinge=left,open=false,powered=false]\","
			+ "\"minecraft:lever[face=wall,facing=west,powered=false]\"],\"base\":[1,65,1,0, 1,66,1,0, 1,65,0,1, 1,66,0,2, 0,66,1,3]}";
		JsonObject ir = JsonParser.parseString("{\"gateMechanisms\":[" + gw + "],\"lots\":[]}").getAsJsonObject();
		java.util.List<JsonObject> ws = GateMech.gateWrites(new Ir(ir, "x", "0", "s", new int[] {0, 0, 0, 0}, java.util.List.of(), java.util.Map.of(), java.util.Map.of(),
			java.util.List.of(), java.util.List.of(), java.util.Map.of(), new long[] {0, 0, 0}, 1, java.util.List.of(), java.util.List.of()));
		assertEquals(1, ws.size());
		GateMech.Plan p = GateMech.plan(ws.get(0), null, null, 0, 0, 0);
		assertEquals(5, p.positions().length);
		assertEquals(java.util.Map.of("minecraft:stone_bricks", 2, "minecraft:iron_door", 1, "minecraft:lever", 1), p.bill());
		JsonObject r = GateMech.gateReport(ws.get(0), p);
		assertEquals("swing", r.get("kind").getAsString());
		assertEquals("curtain", r.get("wall").getAsString());
		assertEquals(5, r.get("cells").getAsInt());
		assertTrue(!r.has("deviation") && !r.has("sensor"));
	}

	/**
	 * (WS, CONTRACT GM §19) A wall that opts every gate in has N swings in one IR: each entry is its own write (its own gate id, so its
	 * own mech:<gate> item and bill), none read through the others.
	 */
	@Test
	void manySwingsOnOneWall() {
		String pal = "\"palette\":[\"minecraft:stone_bricks\",\"minecraft:lever[face=wall,facing=west,powered=false]\"]";
		String g1 = "{\"gate\":\"curtain_g1\",\"wall\":\"curtain\",\"kind\":\"swing\",\"stage\":\"links\"," + pal + ",\"base\":[1,65,1,0, 1,66,1,1]}";
		String g2 = "{\"gate\":\"curtain_g2\",\"wall\":\"curtain\",\"kind\":\"swing\",\"stage\":\"links\"," + pal + ",\"base\":[9,65,9,0, 9,66,9,1, 9,67,9,0]}";
		JsonObject ir = JsonParser.parseString("{\"gateMechanisms\":[" + g1 + "," + g2 + "],\"lots\":[]}").getAsJsonObject();
		java.util.List<JsonObject> ws = GateMech.gateWrites(new Ir(ir, "x", "0", "s", new int[] {0, 0, 0, 0}, java.util.List.of(), java.util.Map.of(), java.util.Map.of(),
			java.util.List.of(), java.util.List.of(), java.util.Map.of(), new long[] {0, 0, 0}, 1, java.util.List.of(), java.util.List.of()));
		assertEquals(2, ws.size());
		assertEquals(java.util.Map.of("minecraft:stone_bricks", 1, "minecraft:lever", 1), GateMech.plan(ws.get(0), null, null, 0, 0, 0).bill());
		assertEquals(java.util.Map.of("minecraft:stone_bricks", 2, "minecraft:lever", 1), GateMech.plan(ws.get(1), null, null, 0, 0, 0).bill());
		assertEquals("curtain_g2", ws.get(1).get("gate").getAsString());
	}
}
