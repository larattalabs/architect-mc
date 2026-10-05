package dev.larattalabs.architect.placement;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonParser;
import dev.larattalabs.architect.site.Site;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import net.minecraft.core.BlockPos;
import org.junit.jupiter.api.Test;

/** LeafGuard's selection rule, BedSafety's pure parts, held leaves in the site record, and leaves in the floor row. */
class LeafAndBedTest {
	static final Anchors.Bounds BOX = new Anchors.Bounds(0, 10, 0, 4, 14, 4);

	@Test
	void manhattanDistanceToTheBox() {
		assertEquals(0, LeafGuard.distanceTo(BOX, 2, 12, 2));
		assertEquals(1, LeafGuard.distanceTo(BOX, 5, 12, 2));
		assertEquals(3, LeafGuard.distanceTo(BOX, 6, 15, 2)); // 2 east + 1 above
		assertEquals(6, LeafGuard.distanceTo(BOX, -2, 8, -2));
	}

	@Test
	void onlyLeavesThatCanReachALogInsideTheBoxAreHeld() {
		// a leaf's distance is its shortest path to a log; a log inside the box is at least `fromBox` steps away
		assertTrue(LeafGuard.mayDependOnBox(1, 1));
		assertTrue(LeafGuard.mayDependOnBox(4, 3));
		assertFalse(LeafGuard.mayDependOnBox(2, 3), "its nearest log is closer than the box: not the box's");
		assertFalse(LeafGuard.mayDependOnBox(7, 1), "distance 7 decays anyway");
		assertFalse(LeafGuard.mayDependOnBox(3, 0), "inside the box: the snapshot restores it");
	}

	@Test
	void heldLeavesSurviveTheSiteFileAndOldFilesReadWithout() {
		Site.Pin pin = new Site.Pin("abc", List.of(1, 2, 3)).withHeldLeaves(List.of(5, 11, 2, 3, -1, 12, 0, 4));
		Site.Pin back = Site.Pin.fromJson(JsonParser.parseString(pin.toJson().toString()).getAsJsonObject());
		assertEquals(pin, back);
		Site.Pin old = Site.Pin.fromJson(JsonParser.parseString("{\"template\":\"abc\",\"blockEntities\":[1,2,3]}").getAsJsonObject());
		assertEquals(List.of(), old.heldLeaves());
		assertFalse(new Site.Pin("abc", List.of()).toJson().has("heldLeaves"), "no key when nothing is held");
		assertThrows(IllegalArgumentException.class, () -> new Site.Pin("abc", List.of(), List.of(1, 2, 3)));
	}

	@Test
	void unsafeBedRules() {
		assertFalse(BedSafety.unsafe(false, false, false), "the overworld");
		assertTrue(BedSafety.unsafe(true, false, false));
		assertTrue(BedSafety.unsafe(false, true, false), "the nether and the end: explodes on use");
		assertTrue(BedSafety.unsafe(false, false, true));
	}

	@Test
	void theHeadOfABedHalf() {
		assertEquals(new BlockPos(3, 64, 5), BedSafety.head(3, 64, 5, true, 0, 1));
		assertEquals(new BlockPos(3, 64, 6), BedSafety.head(3, 64, 5, false, 0, 1), "the foot steps towards facing");
	}

	@Test
	void removedBedsLeaveThePinsBlockEntities() {
		List<Integer> offsets = List.of(1, 0, 1, 2, 0, 1, 3, 1, 3);
		Set<Long> removed = Set.of(BlockPos.asLong(10 + 2, 64, 20 + 1));
		assertEquals(List.of(1, 0, 1, 3, 1, 3), BedSafety.withoutCells(offsets, removed, 10, 64, 20));
		assertEquals(offsets, BedSafety.withoutCells(offsets, Set.of(), 10, 64, 20));
	}

	@Test
	void bedNote() {
		assertNull(BedSafety.note(0, "minecraft:the_nether"));
		assertEquals("2 beds left out (beds explode in minecraft:the_nether)", BedSafety.note(2, "minecraft:the_nether"));
	}

	@Test
	void leavesInTheFloorRowsUnwrittenCellsAreCleared() {
		// 3x3x3, floor row 0 written except (2,0,2); rows above written air (groundY 1)
		List<int[]> cells = new ArrayList<>();
		for (int y = 0; y < 3; y++) {
			for (int z = 0; z < 3; z++) {
				for (int x = 0; x < 3; x++) {
					if (!(y == 0 && x == 2 && z == 2)) {
						cells.add(new int[] {x, y, z});
					}
				}
			}
		}
		int[] xyz = new int[cells.size() * 3];
		int[] argb = new int[cells.size()];
		for (int i = 0; i < cells.size(); i++) {
			xyz[i * 3] = cells.get(i)[0];
			xyz[i * 3 + 1] = cells.get(i)[1];
			xyz[i * 3 + 2] = cells.get(i)[2];
			argb[i] = cells.get(i)[1] == 0 ? GhostModelTest.SOLID : GhostModelTest.AIR;
		}
		GhostModel m = GhostModel.of(new GhostModel.Cells(3, 3, 3, 1, xyz, argb), 0);
		// leaves at the unwritten floor cell (2, 10, 2); a log at a second world: logs below the ground row stay
		TerrainFit.World leaves = (x, y, z) -> x == 2 && y == 10 && z == 2 ? TerrainFit.TREE | TerrainFit.LEAVES : y <= 9 ? TerrainFit.NATURAL : TerrainFit.FILLABLE;
		TerrainFit.Plan p = TerrainFit.plan(m, 0, 10, 0, leaves);
		assertEquals(1, p.clearCount());
		assertEquals(List.of(2, 10, 2), List.of(p.clear()[0], p.clear()[1], p.clear()[2]));
		TerrainFit.World log = (x, y, z) -> x == 2 && y == 10 && z == 2 ? TerrainFit.TREE : y <= 9 ? TerrainFit.NATURAL : TerrainFit.FILLABLE;
		assertEquals(0, TerrainFit.plan(m, 0, 10, 0, log).clearCount());
	}
}
