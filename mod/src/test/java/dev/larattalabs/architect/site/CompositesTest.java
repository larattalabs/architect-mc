package dev.larattalabs.architect.site;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.larattalabs.architect.api.CompositeInfo;
import dev.larattalabs.architect.api.Reason;
import dev.larattalabs.architect.placement.BlueprintTransform;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.junit.jupiter.api.Test;

/** (7c CM-b) The composite layout, the joint check at place time, support order and the module origins at every rotation. */
class CompositesTest {
	/** The castle's shape (CM-a's kit/designs/composite/castle.mjs): three 41x15x27 modules side by side on x, arches 3x4 at z 11. */
	private static final int W = 41;
	private static final int H = 15;
	private static final int D = 27;

	private static JsonObject port(String name, String kind, int x, int y, int z, String facing, int w, int h) {
		JsonObject p = new JsonObject();
		p.addProperty("name", name);
		p.addProperty("kind", kind);
		p.addProperty("x", x);
		p.addProperty("y", y);
		p.addProperty("z", z);
		p.addProperty("facing", facing);
		p.addProperty("width", w);
		p.addProperty("height", h);
		return p;
	}

	private static JsonObject sidecar(int sx, int sy, int sz, JsonObject... ports) {
		JsonObject o = new JsonObject();
		JsonObject s = new JsonObject();
		s.addProperty("x", sx);
		s.addProperty("y", sy);
		s.addProperty("z", sz);
		o.add("size", s);
		JsonArray ps = new JsonArray();
		for (JsonObject p : ports) {
			ps.add(p);
		}
		o.add("ports", ps);
		return o;
	}

	/** The castle: its sidecars by entry id, its CompositeInfo and its manifest. */
	private static final class Castle {
		final Map<String, JsonObject> sidecars = new HashMap<>();
		CompositeInfo info;
		JsonObject manifest;

		Castle() {
			sidecars.put("castle__west", sidecar(W, H, D, port("arch_e", "architect:joint", 40, 1, 11, "east", 3, 4)));
			sidecars.put("castle__centre", sidecar(W, H, D, port("arch_w", "architect:joint", 0, 1, 11, "west", 3, 4),
				port("arch_e", "architect:joint", 40, 1, 11, "east", 3, 4)));
			sidecars.put("castle__east", sidecar(W, H, D, port("arch_w", "architect:joint", 0, 1, 11, "west", 3, 4)));
			info = new CompositeInfo(List.of("castle__west", "castle__centre", "castle__east"), List.of(new CompositeInfo.Joint("castle__west", "arch_e",
				"castle__centre", "arch_w"), new CompositeInfo.Joint("castle__centre", "arch_e", "castle__east", "arch_w")),
				new net.minecraft.world.level.levelgen.structure.BoundingBox(0, 0, 0, 120, 14, 26));
			manifest = JsonParser.parseString("""
				{"id": "castle", "entryId": "castle", "size": {"x": 121, "y": 15, "z": 27}, "modules": [
				 {"id": "west", "entryId": "castle__west", "at": [0, 0, 0], "size": {"x": 41, "y": 15, "z": 27}},
				 {"id": "centre", "entryId": "castle__centre", "at": [40, 0, 0], "size": {"x": 41, "y": 15, "z": 27}},
				 {"id": "east", "entryId": "castle__east", "at": [80, 0, 0], "size": {"x": 41, "y": 15, "z": 27}}]}
				""").getAsJsonObject();
		}

		Composites.Layout layout() throws Composites.Refused {
			return Composites.layout("castle", info, manifest, sidecars::get);
		}
	}

	@Test
	void castleLayoutChecksClean() throws Exception {
		Castle c = new Castle();
		Composites.Layout l = c.layout();
		assertEquals(121, l.sx());
		assertEquals(List.of("west", "centre", "east"), l.modules().stream().map(Composites.Module::id).toList());
		Composites.checkJoints(l, c.sidecars::get);
	}

	@Test
	void aMissingModuleEntryIsUnknown() {
		Castle c = new Castle();
		c.sidecars.remove("castle__east");
		Composites.Refused r = assertThrows(Composites.Refused.class, c::layout);
		assertEquals(Reason.UNKNOWN_BLUEPRINT, r.reason());
		assertTrue(r.getMessage().contains("module east"), r.getMessage());
	}

	@Test
	void aModuleOfAnotherSizeIsRefused() {
		Castle c = new Castle();
		c.sidecars.put("castle__east", sidecar(40, H, D, port("arch_w", "architect:joint", 0, 1, 11, "west", 3, 4)));
		Composites.Refused r = assertThrows(Composites.Refused.class, c::layout);
		assertEquals(Reason.OTHER, r.reason());
		assertTrue(r.getMessage().contains("module east"), r.getMessage());
	}

	/** JOINT_MISMATCH at place time: each kind names the module and the port. */
	@Test
	void everyJointMismatchNamesTheModuleAndPort() throws Exception {
		record Case(String what, JsonObject eastPort, String expect) {
		}
		List<Case> cases = List.of(
			new Case("missing", port("door", "architect:joint", 0, 1, 11, "west", 3, 4), "module east port arch_w does not exist"),
			new Case("kind", port("arch_w", "architect:door", 0, 1, 11, "west", 3, 4), "module east port arch_w is not an architect:joint port"),
			new Case("off its face", port("arch_w", "architect:joint", 1, 1, 11, "west", 3, 4), "module east port arch_w is not on its module's west face"),
			new Case("cell", port("arch_w", "architect:joint", 0, 2, 11, "west", 3, 4), "module east port arch_w is at union cell 80,2,11"),
			new Case("width", port("arch_w", "architect:joint", 0, 1, 11, "west", 2, 4), "module east port arch_w is 2 wide"),
			new Case("height", port("arch_w", "architect:joint", 0, 1, 11, "west", 3, 5), "module east port arch_w is 5 tall"));
		for (Case k : cases) {
			Castle c = new Castle();
			c.sidecars.put("castle__east", sidecar(W, H, D, k.eastPort()));
			Composites.Layout l = c.layout();
			Composites.Refused r = assertThrows(Composites.Refused.class, () -> Composites.checkJoints(l, c.sidecars::get), k.what());
			assertEquals(Reason.JOINT_MISMATCH, r.reason(), k.what());
			assertTrue(r.getMessage().contains(k.expect()), k.what() + ": " + r.getMessage());
		}
		// a facing mismatch alone (the cell and face right, the far end turned): the centre's east port facing west on x = 40 is off its
		// west face, so the facing is tested on a module whose port sits on both faces' lines (a 1-wide module)
		Castle c = new Castle();
		c.sidecars.put("castle__west", sidecar(W, H, D, port("arch_e", "architect:joint", 40, 1, 11, "east", 3, 4)));
		c.sidecars.put("castle__centre", sidecar(W, H, D, port("arch_w", "architect:joint", 0, 1, 11, "west", 3, 4), port("arch_e", "architect:joint", 40, 1,
			11, "east", 3, 4)));
		JsonObject turned = port("arch_w", "architect:joint", 0, 1, 11, "west", 3, 4);
		turned.addProperty("facing", "east");
		c.sidecars.put("castle__east", sidecar(1, H, D, turned));
		c.manifest.getAsJsonArray("modules").get(2).getAsJsonObject().getAsJsonObject("size").addProperty("x", 1);
		Composites.Layout l = c.layout();
		Composites.Refused r = assertThrows(Composites.Refused.class, () -> Composites.checkJoints(l, c.sidecars::get));
		assertEquals(Reason.JOINT_MISMATCH, r.reason());
		assertTrue(r.getMessage().contains("module east port arch_w faces east, not opposite module centre port arch_e"), r.getMessage());
	}

	@Test
	void supportOrderPutsAModuleAfterWhatItRestsOn() {
		Composites.Module tower = new Composites.Module("tower", "c__tower", 10, 14, 0, 20, 30, 20);
		Composites.Module hall = new Composites.Module("hall", "c__hall", 0, 0, 0, 41, 15, 27);
		Composites.Module side = new Composites.Module("side", "c__side", 40, 0, 0, 41, 15, 27);
		List<Composites.Module> o = Composites.supportOrder(List.of(tower, hall, side));
		assertEquals(List.of("hall", "tower", "side"), o.stream().map(Composites.Module::id).toList());
		assertNull(null);
	}

	/**
	 * The module origins at all four rotations: every module cell, placed through its own template at its origin, lands where the
	 * union's template puts it (the cell-by-cell identity of the rotated module grids and the rotated union grid).
	 */
	@Test
	void moduleOriginsMatchTheRotatedUnionAtEveryRotation() throws Exception {
		Composites.Layout l = new Castle().layout();
		// a tall module on top too, off the x line, so z and y offsets are exercised
		Composites.Layout l2 = new Composites.Layout("c", 121, 40, 60, List.of(l.modules().get(0), l.modules().get(1), new Composites.Module("top", "c__top", 7, 14,
			30, 13, 26, 30)), List.of());
		for (Composites.Layout lay : List.of(l, l2)) {
			for (int turns = 0; turns < 4; turns++) {
				int ox = 1000;
				int oy = 64;
				int oz = -300;
				Set<String> seen = new HashSet<>();
				for (Composites.Module m : lay.modules()) {
					int[] mo = Composites.moduleOrigin(lay, m, turns, ox, oy, oz);
					for (int x = 0; x < m.sx(); x += 3) {
						for (int z = 0; z < m.sz(); z += 2) {
							int[] viaModule = BlueprintTransform.rotateBlock(x, z, m.sx(), m.sz(), turns);
							int[] viaUnion = BlueprintTransform.rotateBlock(x + m.ax(), z + m.az(), lay.sx(), lay.sz(), turns);
							assertEquals(ox + viaUnion[0], mo[0] + viaModule[0], "x at turns " + turns + " module " + m.id());
							assertEquals(oz + viaUnion[1], mo[2] + viaModule[1], "z at turns " + turns + " module " + m.id());
							seen.add(m.id());
						}
					}
					assertEquals(oy + m.ay(), mo[1]);
				}
				assertEquals(lay.modules().size(), seen.size());
			}
		}
	}

	@Test
	void moduleEntriesAreHiddenByTheirMark() {
		JsonObject j = new JsonObject();
		assertTrue(!Composites.isModule(j));
		j.addProperty(Composites.COMPOSITE_OF, "castle");
		assertTrue(Composites.isModule(j));
		assertNotNull(Composites.EXT_SITE);
	}
}
