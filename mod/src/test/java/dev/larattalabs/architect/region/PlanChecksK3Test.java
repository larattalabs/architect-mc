package dev.larattalabs.architect.region;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.larattalabs.architect.batch.LotFitting;
import dev.larattalabs.architect.placement.Anchors;
import dev.larattalabs.architect.placement.BlueprintTransform;
import dev.larattalabs.architect.placement.GhostModel;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.DoorBlock;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.block.state.properties.DoubleBlockHalf;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

/**
 * (7a K3, docs/CONTRACT.md "Phase 7a slice K3" §5) The bind check of a lot on a wall's line ({@link WallLotCheck}): a gatehouse stub
 * closed on its outer faces with its passage open passes; a door in an outer face, a design narrower than the box, an unstandable
 * passage floor are refused naming the lot and the cell count; a design filling its passage has its blocks there dropped (counted); a
 * lot without (or with a malformed) {@code onWall} is untouched; the rotated template's positions and states line up for every front.
 */
class PlanChecksK3Test {
	@BeforeAll
	static void boot() {
		net.minecraft.SharedConstants.tryDetectVersion();
		net.minecraft.server.Bootstrap.bootStrap();
		STONE = Blocks.STONE.defaultBlockState();
		AIR = Blocks.AIR.defaultBlockState();
	}

	static BlockState STONE;
	static BlockState AIR;
	/** The lot's box: x 10..14, y 64..67 (floorY 64), z 20..24. */
	static final Anchors.Bounds BOX = new Anchors.Bounds(10, 64, 20, 14, 67, 24);
	static final int FLOOR_Y = 64;

	/** A 5x5x5 template, groundY 1 (row 0 the floor), front south: stone floor and roof, a stone shell, air inside. */
	static final class Stub {
		final int sx;
		final int sy = 5;
		final int sz = 5;
		final BlockState[][][] at;

		Stub(int sx) {
			this.sx = sx;
			at = new BlockState[sx][sy][sz];
			for (int x = 0; x < sx; x++) {
				for (int y = 0; y < sy; y++) {
					for (int z = 0; z < sz; z++) {
						boolean shell = y == 0 || y == sy - 1 || x == 0 || x == sx - 1 || z == 0 || z == sz - 1;
						at[x][y][z] = shell ? STONE : AIR;
					}
				}
			}
		}

		/** A passage front to back through the middle column (template x = sx / 2), 3 high over the floor. */
		Stub passage() {
			for (int z = 0; z < sz; z++) {
				for (int y = 1; y <= 3; y++) {
					at[sx / 2][y][z] = AIR;
				}
			}
			return this;
		}

		Stub set(int x, int y, int z, BlockState s) {
			at[x][y][z] = s;
			return this;
		}

		int[] xyz() {
			int[] o = new int[sx * sy * sz * 3];
			int k = 0;
			for (int x = 0; x < sx; x++) {
				for (int y = 0; y < sy; y++) {
					for (int z = 0; z < sz; z++) {
						o[k++] = x;
						o[k++] = y;
						o[k++] = z;
					}
				}
			}
			return o;
		}

		BlockState[] states() {
			List<BlockState> o = new ArrayList<>();
			for (int x = 0; x < sx; x++) {
				for (int y = 0; y < sy; y++) {
					for (int z = 0; z < sz; z++) {
						o.add(at[x][y][z]);
					}
				}
			}
			return o.toArray(new BlockState[0]);
		}

		GhostModel ghost(int turns) {
			BlockState[] st = states();
			int[] argb = new int[st.length];
			for (int i = 0; i < st.length; i++) {
				argb[i] = st[i].isAir() ? 0 : 0xFFFFFFFF;
			}
			return GhostModel.of(new GhostModel.Cells(sx, sy, sz, 1, xyz(), argb), turns);
		}

		/** The check with the lot's front {@code front}, fitted as the realise fits it. */
		WallLotCheck.Result check(String front, JsonObject lot) {
			LotFitting.Fit f = fit(front);
			WallLotCheck.OnWall w = WallLotCheck.OnWall.of(lot);
			assertNotNull(w, lot.toString());
			return WallLotCheck.check("gh", w, f.turns(), f.ox(), f.oy(), f.oz(), ghost(f.turns()), states());
		}

		LotFitting.Fit fit(String front) {
			return LotFitting.fit(sx, sy, sz, "south", 0, 0, false, 1, 0, BOX, front, true, 0, true);
		}
	}

	/**
	 * The artifact lot of a gatehouse with its front {@code front}: outer faces the box's {@code front} face (floorY..+2), the passage
	 * the box's centre line front to back (3 high), its floor row under it ({@code x, z, y} triples).
	 */
	static JsonObject lot(String front, boolean passage) {
		JsonArray outer = new JsonArray();
		JsonArray cells = new JsonArray();
		JsonArray floor = new JsonArray();
		boolean alongX = front.equals("north") || front.equals("south");
		int face = switch (front) {
			case "north" -> BOX.minZ();
			case "south" -> BOX.maxZ();
			case "west" -> BOX.minX();
			default -> BOX.maxX();
		};
		for (int i = 0; i < 5; i++) {
			int x = alongX ? BOX.minX() + i : face, z = alongX ? face : BOX.minZ() + i;
			for (int v : new int[] {x, z, FLOOR_Y, FLOOR_Y + 2}) {
				outer.add(v);
			}
			int px = alongX ? 12 : BOX.minX() + i, pz = alongX ? BOX.minZ() + i : 22;
			for (int v : new int[] {px, pz, FLOOR_Y, FLOOR_Y + 2}) {
				cells.add(v);
			}
			for (int v : new int[] {px, pz, FLOOR_Y - 1}) {
				floor.add(v);
			}
		}
		JsonObject ow = new JsonObject();
		ow.addProperty("wall", "w1");
		ow.addProperty("at", "gate");
		ow.addProperty("floorY", FLOOR_Y);
		JsonObject of = new JsonObject();
		of.add("cells", outer);
		ow.add("outerFaces", of);
		if (passage) {
			JsonObject p = new JsonObject();
			p.addProperty("width", 1);
			p.addProperty("height", 3);
			p.add("cells", cells);
			p.add("floor", floor);
			ow.add("passage", p);
		}
		JsonObject l = new JsonObject();
		l.addProperty("id", "gh");
		l.addProperty("front", front);
		l.add("box", JsonParser.parseString("[10,64,20,14,67,24]"));
		l.add("onWall", ow);
		return l;
	}

	static BlockState door(Direction facing, DoubleBlockHalf half) {
		return Blocks.OAK_DOOR.defaultBlockState().setValue(DoorBlock.FACING, facing).setValue(DoorBlock.HALF, half);
	}

	@Test
	void aClosedGatehouseWithItsPassageOpenPasses() {
		WallLotCheck.Result r = new Stub(5).passage().check("south", lot("south", true));
		assertNull(r.why());
		assertEquals(0, r.open());
		assertEquals(0, r.passageDropped(), "the passage is air in the design: nothing dropped");
	}

	@Test
	void aDoorInAnOuterFaceIsRefused() {
		Stub s = new Stub(5).passage().set(1, 1, 4, door(Direction.SOUTH, DoubleBlockHalf.LOWER)).set(1, 2, 4, door(Direction.SOUTH, DoubleBlockHalf.UPPER));
		WallLotCheck.Result r = s.check("south", lot("south", true));
		assertEquals(2, r.open());
		assertEquals("lot gh on wall w1: the design leaves the wall open at 11,64,24 11,65,24 (2 cells)", r.why());
		// a fence gate and a trapdoor are passable too; a pane, a fence and a wall block close
		assertEquals(1, new Stub(5).passage().set(3, 1, 4, Blocks.OAK_FENCE_GATE.defaultBlockState()).check("south", lot("south", true)).open());
		assertEquals(1, new Stub(5).passage().set(3, 1, 4, Blocks.OAK_TRAPDOOR.defaultBlockState()).check("south", lot("south", true)).open());
		assertNull(new Stub(5).passage().set(3, 1, 4, Blocks.GLASS_PANE.defaultBlockState()).set(1, 1, 4, Blocks.OAK_FENCE.defaultBlockState()).set(3, 2, 4,
			Blocks.COBBLESTONE_WALL.defaultBlockState()).set(1, 2, 4, Blocks.OAK_STAIRS.defaultBlockState()).check("south", lot("south", true)).why());
		// a bottom slab is jumpable: open
		assertEquals(1, new Stub(5).passage().set(3, 1, 4, Blocks.STONE_SLAB.defaultBlockState()).check("south", lot("south", true)).open());
	}

	@Test
	void aDesignFillingItsPassageHasItsBlocksDropped() {
		WallLotCheck.Result r = new Stub(5).check("south", lot("south", true)); // no passage carved: stone shell at both faces
		assertNull(r.why(), "the passage cells are masked (open), the floor is stone");
		assertEquals(6, r.passageDropped(), "the shell's stone on the passage at the front and back faces, 3 high each");
		Stub filled = new Stub(5);
		for (int z = 0; z < 5; z++) {
			for (int y = 1; y <= 3; y++) {
				filled.set(2, y, z, STONE);
			}
		}
		assertEquals(15, filled.check("south", lot("south", true)).passageDropped());
	}

	@Test
	void anUnstandablePassageFloorIsRefused() {
		WallLotCheck.Result r = new Stub(5).passage().set(2, 0, 1, Blocks.OAK_FENCE.defaultBlockState()).set(2, 0, 2, AIR).check("south", lot("south", true));
		assertEquals(2, r.floorBad());
		assertEquals("lot gh on wall w1: the passage floor is not standable at 12,63,21 12,63,22 (2 cells)", r.why());
		assertNull(new Stub(5).passage().set(2, 0, 1, Blocks.STONE_SLAB.defaultBlockState()).set(2, 0, 2, Blocks.DIRT_PATH.defaultBlockState()).check("south",
			lot("south", true)).why(), "a slab and a path are standable");
	}

	@Test
	void aDesignNarrowerThanTheBoxIsRefused() {
		WallLotCheck.Result r = new Stub(3).passage().check("south", lot("south", true));
		assertEquals(6, r.open(), "the box's x 10 and 14 columns of the face have no entry block: 2 x 3");
		assertTrue(r.why().startsWith("lot gh on wall w1: the design leaves the wall open at 10,64,24 10,65,24 10,66,24 14,64,24"), r.why());
		assertTrue(r.why().endsWith("(6 cells)"), r.why());
	}

	@Test
	void manyOpenCellsListEight() {
		WallLotCheck.Result r = new Stub(1).check("south", lot("south", false));
		assertEquals(12, r.open());
		assertTrue(r.why().endsWith(" ... (12 cells)"), r.why());
		assertEquals(8, r.why().split(" at ")[1].split(" \\.\\.\\.")[0].split(" ").length);
	}

	@Test
	void aLotNotOnAWallIsUntouched() {
		JsonObject body = new JsonObject();
		JsonArray lots = new JsonArray();
		JsonObject plain = lot("south", true);
		plain.remove("onWall");
		lots.add(plain);
		body.add("lots", lots);
		assertNull(WallLotCheck.problem(body, Map.of("gh", "anything")));
		assertNull(WallLotCheck.OnWall.of(plain));
		// on a wall but unbound, or bound to an entry the library doesn't have: skipped (the realise answers an unknown entry itself)
		lots.set(0, lot("south", true));
		assertNull(WallLotCheck.problem(body, Map.of()));
		assertNull(WallLotCheck.problem(body, Map.of("gh", "no_such_entry@2")));
		assertNull(WallLotCheck.problem(new JsonObject(), Map.of("gh", "x")), "no lots");
	}

	@Test
	void aMalformedOnWallIsIgnored() {
		for (String bad : new String[] {"5", "{}", "{\"wall\":3,\"outerFaces\":{\"cells\":[]}}", "{\"wall\":\"w\"}", "{\"wall\":\"w\",\"outerFaces\":[1,2]}",
			"{\"wall\":\"w\",\"outerFaces\":{\"cells\":\"x\"}}"}) {
			JsonObject l = lot("south", true);
			l.add("onWall", JsonParser.parseString(bad));
			assertNull(WallLotCheck.OnWall.of(l), bad);
		}
		// a malformed passage is no passage; malformed runs are skipped
		JsonObject l = lot("south", true);
		l.getAsJsonObject("onWall").add("passage", JsonParser.parseString("{\"cells\":[\"a\",1,2,3]}"));
		assertNull(WallLotCheck.OnWall.of(l).passage());
		l.getAsJsonObject("onWall").add("passage", JsonParser.parseString("{\"width\":3}"));
		assertNull(WallLotCheck.OnWall.of(l).passage());
		l.getAsJsonObject("onWall").getAsJsonObject("outerFaces").add("cells", JsonParser.parseString("[[10,24,64],[11,24,64,66],\"x\"]"));
		assertEquals(4, WallLotCheck.OnWall.of(l).outer().length, "nested runs accepted, the malformed ones skipped");
		assertNull(WallLotCheck.box(JsonParser.parseString("{\"box\":[1,2,\"x\",4,5,6]}").getAsJsonObject()));
		assertNotNull(WallLotCheck.box(JsonParser.parseString("{\"box\":{\"minX\":1,\"minY\":2,\"minZ\":3,\"maxX\":4,\"maxY\":5,\"maxZ\":6}}").getAsJsonObject()));
		assertEquals("south", WallLotCheck.front(JsonParser.parseString("{\"front\":null}").getAsJsonObject()));
	}

	@Test
	void everyFrontLinesUp() {
		for (String front : new String[] {"north", "east", "south", "west"}) {
			Direction dir = Direction.byName(front);
			assertNull(new Stub(5).passage().check(front, lot(front, true)).why(), front);
			// the door on the design's front face (template z 4, x 1), facing out: on the lot's front face, facing the lot's front
			Stub s = new Stub(5).passage().set(1, 1, 4, door(Direction.SOUTH, DoubleBlockHalf.LOWER)).set(1, 2, 4, door(Direction.SOUTH, DoubleBlockHalf.UPPER));
			WallLotCheck.Result r = s.check(front, lot(front, true));
			assertEquals(2, r.open(), front);
			LotFitting.Fit f = s.fit(front);
			var at = WallLotCheck.placed(f.turns(), f.ox(), f.oy(), f.oz(), s.ghost(f.turns()), s.states());
			int[] rp = BlueprintTransform.rotateBlock(1, 4, 5, 5, f.turns());
			BlockState d = at.get(BlockPos.asLong(f.ox() + rp[0], FLOOR_Y, f.oz() + rp[1]));
			assertTrue(d.getBlock() instanceof DoorBlock, front + ": " + d);
			assertEquals(dir, d.getValue(DoorBlock.FACING), front + ": the state rotated with its position");
			assertEquals(DoubleBlockHalf.UPPER, at.get(BlockPos.asLong(f.ox() + rp[0], FLOOR_Y + 1, f.oz() + rp[1])).getValue(DoorBlock.HALF));
			int faceCoord = switch (front) {
				case "north" -> f.oz() + rp[1] - BOX.minZ();
				case "south" -> BOX.maxZ() - (f.oz() + rp[1]);
				case "west" -> f.ox() + rp[0] - BOX.minX();
				default -> BOX.maxX() - (f.ox() + rp[0]);
			};
			assertEquals(0, faceCoord, front + ": the door stands on the lot's front face");
		}
	}

	@Test
	void theGhostKeepsTheStatesOrder() {
		// TemplateGrid.ghost(turns) is GhostModel.of over the grid's cells: index i of the model is index i of states[]
		Stub s = new Stub(5).set(1, 2, 3, Blocks.GOLD_BLOCK.defaultBlockState());
		BlockState[] st = s.states();
		int[] xyz = s.xyz();
		for (int t = 0; t < 4; t++) {
			GhostModel m = s.ghost(t);
			assertEquals(st.length, m.count());
			for (int i = 0; i < m.count(); i++) {
				int[] r = BlueprintTransform.rotateBlock(xyz[i * 3], xyz[i * 3 + 2], 5, 5, t);
				assertEquals(r[0], m.x(i));
				assertEquals(xyz[i * 3 + 1], m.y(i));
				assertEquals(r[1], m.z(i));
			}
		}
	}

	@Test
	void theRealiseReadsThePassage() {
		// RegionsImpl.passageExt: what lotItem puts on the lot site's ext (LotMask.EXT_PASSAGE)
		java.util.function.Function<String, JsonObject> lotWith = pass -> JsonParser.parseString("{\"id\":\"gh\",\"onWall\":{\"wall\":\"w1\",\"outerFaces\":{\"cells\":[]}"
			+ (pass == null ? "" : ",\"passage\":" + pass) + "}}").getAsJsonObject();
		assertEquals("{\"cells\":[12,20,64,66,12,21,64,66]}", RegionsImpl.passageExt(lotWith.apply("{\"cells\":[12,20,64,66,12,21,64,66]}")).toString());
		assertEquals("{\"cells\":[12,20,64,66,12,21,64,66]}", RegionsImpl.passageExt(lotWith.apply("{\"cells\":[[12,20,64,66],[12,21,64,66]]}")).toString());
		assertEquals("{\"cells\":[12,20,64,66]}", RegionsImpl.passageExt(lotWith.apply("{\"cells\":[[12,20,64,66],[1,2],\"x\"]}")).toString());
		assertNull(RegionsImpl.passageExt(lotWith.apply(null)));
		assertNull(RegionsImpl.passageExt(lotWith.apply("{\"cells\":[]}")));
		assertNull(RegionsImpl.passageExt(lotWith.apply("{\"width\":3}")));
		assertNull(RegionsImpl.passageExt(JsonParser.parseString("{\"id\":\"gh\"}").getAsJsonObject()));
	}
}
