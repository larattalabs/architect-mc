package dev.larattalabs.architect.site;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonObject;
import dev.larattalabs.architect.api.FitMode;
import dev.larattalabs.architect.api.Reason;
import dev.larattalabs.architect.api.Refusal;
import dev.larattalabs.architect.api.SiteBinding;
import dev.larattalabs.architect.api.SiteFrame;
import dev.larattalabs.architect.api.SitePort;
import dev.larattalabs.architect.api.SiteSpec;
import dev.larattalabs.architect.api.VoxelClass;
import dev.larattalabs.architect.placement.Anchors;
import dev.larattalabs.architect.placement.Approach;
import dev.larattalabs.architect.placement.TerrainFit;
import java.util.List;
import java.util.Set;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.world.level.block.Rotation;
import net.minecraft.world.level.levelgen.structure.BoundingBox;
import org.junit.jupiter.api.Test;

/** (7b PL) The site checks of a placement (SiteFit), pure: shape, mismatch, drift, keep lost, the live support scan, the context. */
class SiteFitTest {
	static final String SHA = "a".repeat(64);
	static final String OTHER = "b".repeat(64);

	static SiteSpec spec(FitMode fit, List<BlockPos> keep, List<SitePort> ports) {
		return new SiteSpec(SHA, "local:" + SHA, new BoundingBox(-8, 0, -8, 16, 20, 16), fit, new SiteFrame(new BlockPos(0, 5, 0), Rotation.NONE), keep,
			ports, null);
	}

	@Test
	void policyAndApproachPerFit() {
		assertEquals(TerrainFit.Policy.CLEAR, SiteFit.policy(null));
		assertEquals(Approach.Mode.GROUND, SiteFit.approach(null));
		assertEquals(TerrainFit.Policy.CLEAR, SiteFit.policy(spec(FitMode.ON_PAD, List.of(), List.of())));
		assertEquals(Approach.Mode.GROUND, SiteFit.approach(spec(FitMode.ON_PAD, List.of(), List.of())));
		SitePort door = new SitePort("door_w", SitePort.WALK, new BlockPos(0, 1, 2), Direction.WEST, 1, 2, null);
		for (FitMode f : FitMode.values()) {
			if (f == FitMode.ON_PAD) {
				continue;
			}
			assertEquals(TerrainFit.Policy.KEEP, SiteFit.policy(spec(f, List.of(), List.of())), f.wire());
			assertEquals(Approach.Mode.PORT, SiteFit.approach(spec(f, List.of(), List.of(door))), f.wire());
			assertEquals(Approach.Mode.NONE, SiteFit.approach(spec(f, List.of(), List.of())), f.wire());
			assertFalse(SiteFit.notes(spec(f, List.of(), List.of(door))).isEmpty());
		}
	}

	@Test
	void theContextNestsAndKeysTheCache() {
		SiteSpec s = spec(FitMode.SPAN, List.of(), List.of());
		assertNull(SiteFit.now());
		assertEquals("", SiteFit.key(null));
		String k = SiteFit.with(s, () -> {
			assertEquals(s, SiteFit.now());
			SiteFit.with(null, () -> {
				assertNull(SiteFit.now(), "a plain request inside sees no site");
				return null;
			});
			assertEquals(s, SiteFit.now());
			return SiteFit.key(SiteFit.now());
		});
		assertNull(SiteFit.now());
		assertFalse(k.isEmpty());
		assertTrue(!k.equals(SiteFit.key(spec(FitMode.SUSPEND, List.of(), List.of()))), "another site keys another plan");
	}

	@Test
	void shapeRefusesAnotherFrameAndABoxOutsideTheVolume() {
		SiteSpec s = spec(FitMode.ATTACH_TO_CLIFF, List.of(), List.of());
		Anchors.Bounds box = new Anchors.Bounds(0, 5, 0, 6, 10, 6);
		assertNull(SiteFit.shape(s, new BlockPos(0, 5, 0), Rotation.NONE, box));
		assertEquals(Reason.OTHER, SiteFit.shape(s, new BlockPos(1, 5, 0), Rotation.NONE, box).reason());
		assertEquals(Reason.OTHER, SiteFit.shape(s, new BlockPos(0, 5, 0), Rotation.CLOCKWISE_90, box).reason());
		assertEquals(Reason.LOT_TOO_SMALL, SiteFit.shape(s, new BlockPos(0, 5, 0), Rotation.NONE, new Anchors.Bounds(0, 5, 0, 6, 30, 6)).reason());
	}

	/** (SA, A35) A pinned entry with no site: SITE_MISMATCH, the bound sha first, naming the site variant route; an unbound one: null. */
	@Test
	void aPinnedEntryWithNoSiteIsRefused() {
		SiteSpec s = spec(FitMode.WRAP_TRUNK, List.of(), List.of());
		assertNull(SiteFit.pinnedNoSite("plain", null));
		assertNull(SiteFit.pinnedNoSite("plain", new JsonObject()));
		JsonObject entry = new JsonObject();
		JsonObject ext = new JsonObject();
		ext.add(SiteBinding.EXT_KEY, SiteBinding.of(s, null).wire());
		entry.add("ext", ext);
		Refusal r = SiteFit.pinnedNoSite("bound_by_ext", entry);
		assertNotNull(r);
		assertEquals(Reason.SITE_MISMATCH, r.reason());
		assertTrue(r.message().startsWith(SHA + ":") && r.message().contains("site variant here"), r.message());
		JsonObject kit = new JsonObject();
		kit.add("site", s.wire());
		assertNotNull(SiteFit.pinnedNoSite("bound_by_sidecar", kit), "a design built over a site is pinned too");
		// an on_pad design keeps fitToLot and its plain placement on a pad lot
		JsonObject pad = new JsonObject();
		pad.add("site", spec(FitMode.ON_PAD, List.of(), List.of()).wire());
		assertNull(SiteFit.pinnedNoSite("on_pad", pad), "on_pad: not refused");
	}

	@Test
	void mismatchOnlyForAnEntryBoundToAnotherSha() {
		SiteSpec s = spec(FitMode.WRAP_TRUNK, List.of(), List.of());
		assertNull(SiteFit.mismatch(null, s), "an unbound entry may be fitted");
		assertNull(SiteFit.mismatch(new JsonObject(), s));
		JsonObject entry = new JsonObject();
		JsonObject ext = new JsonObject();
		ext.add(SiteBinding.EXT_KEY, SiteBinding.of(s, null).wire());
		entry.add("ext", ext);
		assertNull(SiteFit.mismatch(entry, s), "bound to this sha");
		SiteSpec other = new SiteSpec(OTHER, "local:" + OTHER, s.volume(), s.fit(), s.frame(), List.of(), List.of(), null);
		Refusal r = SiteFit.mismatch(entry, other);
		assertNotNull(r);
		assertEquals(Reason.SITE_MISMATCH, r.reason());
		assertTrue(r.message().startsWith(SHA + ":"), "the message starts with the bound sha (the detail)");
		// (slice SV) a design built over a site records the spec in its sidecar's `site`: bound by it, and to its frame
		JsonObject kit = new JsonObject();
		kit.add("site", s.wire());
		assertNull(SiteFit.mismatch(kit, s));
		assertNull(SiteFit.frameOfEntry(kit, s));
		assertEquals(Reason.SITE_MISMATCH, SiteFit.mismatch(kit, other).reason());
		assertNull(SiteFit.frameOfEntry(kit, other), "another sha is mismatch's");
		SiteSpec moved = new SiteSpec(SHA, "local:" + SHA, s.volume(), s.fit(), new SiteFrame(new BlockPos(1, 5, 0), Rotation.NONE), List.of(), List.of(), null);
		assertEquals(Reason.OTHER, SiteFit.frameOfEntry(kit, moved).reason());
		assertTrue(SiteFit.bound(SiteFit.withBinding(null, s)));
		assertFalse(SiteFit.bound(new JsonObject()));
		JsonObject mine = new JsonObject();
		mine.addProperty("steward_mc:lot", "l1");
		JsonObject with = SiteFit.withBinding(mine, s);
		assertFalse(mine.has(SiteBinding.EXT_KEY), "the caller's ext is not changed");
		assertTrue(with.has("steward_mc:lot") && SiteBinding.ofExt(with).orElseThrow().volumeSha().equals(SHA));
	}

	static final int AIR = VoxelClass.AIR.ordinal();
	static final int ROCK = VoxelClass.ROCK.ordinal();
	static final int LOG = VoxelClass.LOG.ordinal();
	static final int PLANT = VoxelClass.PLANT.ordinal();
	static final int OWNED = VoxelClass.OWNED.ordinal();
	static final int MISSING = VoxelClass.MISSING.ordinal();

	@Test
	void driftComparesClassesButNotPlantsTheJournalOrKeepCells() {
		BoundingBox v = new BoundingBox(0, 0, 0, 3, 3, 3);
		SiteFit.Classes frozen = (x, y, z) -> y == 0 ? ROCK : x == 1 && z == 1 ? LOG : x == 3 && y == 3 ? OWNED : AIR;
		assertEquals(0, SiteFit.drift(v, frozen, frozen, Set.of()).drifted());
		assertEquals(64 - 4, SiteFit.drift(v, frozen, frozen, Set.of()).compared(), "OWNED cells are not compared");
		// grass grew (air -> plant), the journal's cell changed: no drift
		SiteFit.Classes grown = (x, y, z) -> y == 1 && x == 0 ? PLANT : x == 3 && y == 3 ? ROCK : frozen.classAt(x, y, z);
		assertEquals(0, SiteFit.drift(v, frozen, grown, Set.of()).drifted());
		// a block set in the margin, the trunk cut at y 2
		SiteFit.Classes changed = (x, y, z) -> x == 2 && y == 2 && z == 0 ? ROCK : x == 1 && z == 1 && y == 2 ? AIR : frozen.classAt(x, y, z);
		SiteFit.Drift d = SiteFit.drift(v, frozen, changed, Set.of());
		assertEquals(2, d.drifted());
		assertEquals(2, d.first().size());
		// the trunk is keep-critical: it is KEEP_LOST's, not drift
		assertEquals(1, SiteFit.drift(v, frozen, changed, Set.of(BlockPos.asLong(1, 2, 1))).drifted());
		// a cell not loaded now is not compared
		SiteFit.Classes unloaded = (x, y, z) -> x == 2 ? MISSING : changed.classAt(x, y, z);
		assertEquals(1, SiteFit.drift(v, frozen, unloaded, Set.of()).drifted());
	}

	@Test
	void keepLostWhenAKeepCellIsEmptiedOrChanged() {
		SiteFit.Classes frozen = (x, y, z) -> x == 0 ? LOG : x == 1 ? OWNED : AIR;
		List<BlockPos> keep = List.of(new BlockPos(0, 1, 0), new BlockPos(0, 2, 0), new BlockPos(1, 1, 0));
		long[] n = {0};
		assertTrue(SiteFit.keepLost(keep, frozen, frozen, n).isEmpty());
		SiteFit.Classes cut = (x, y, z) -> x == 0 && y == 2 ? AIR : x == 1 ? AIR : frozen.classAt(x, y, z);
		long[] m = {0};
		List<String> lost = SiteFit.keepLost(keep, frozen, cut, m);
		assertEquals(2, m[0], "the log cut and the region's cell emptied");
		assertTrue(lost.get(0).startsWith("0,2,0 LOG->AIR"));
		SiteFit.Classes stone = (x, y, z) -> x == 0 && y == 1 ? ROCK : frozen.classAt(x, y, z);
		long[] k = {0};
		assertEquals(1, SiteFit.keepLost(keep, frozen, stone, k).size(), "a log turned to stone is gone as a log");
	}

	/** A 3 x 3 x 3 template's writes from a set of written block cells (template coordinates). */
	static byte[] writes(int[][] blocks) {
		byte[] w = new byte[27];
		for (int[] b : blocks) {
			w[(b[1] * 3 + b[2]) * 3 + b[0]] = 2;
		}
		return w;
	}

	@Test
	void supportScanFollowsWrittenBlocksToSiteSolid() {
		// rock at x <= -1 (a cliff face west of the box), air elsewhere
		TerrainFit.World cliff = (x, y, z) -> x <= -1 ? TerrainFit.NATURAL : TerrainFit.FILLABLE;
		// a bracket row against the face at y 1, and one block hanging off it
		byte[] w = writes(new int[][] {{0, 1, 1}, {1, 1, 1}, {2, 1, 1}, {2, 2, 1}});
		SiteFit.Support s = SiteFit.support(3, 3, 3, w, 0, 0, 0, cliff, Set.of());
		assertTrue(s.ok());
		assertEquals(4, s.blocks());
		// a floating block: not connected
		byte[] f = writes(new int[][] {{0, 1, 1}, {2, 2, 2}});
		SiteFit.Support u = SiteFit.support(3, 3, 3, f, 0, 0, 0, cliff, Set.of());
		assertEquals(1, u.unsupported());
		assertEquals(new BlockPos(2, 2, 2), u.first());
		// leaves and water are not site-solid; a keep-critical anchor is
		TerrainFit.World leafy = (x, y, z) -> x <= -1 ? TerrainFit.TREE | TerrainFit.LEAVES : TerrainFit.FILLABLE;
		assertEquals(1, SiteFit.support(3, 3, 3, writes(new int[][] {{0, 1, 1}}), 0, 0, 0, leafy, Set.of()).unsupported());
		assertTrue(SiteFit.support(3, 3, 3, writes(new int[][] {{0, 1, 1}}), 0, 0, 0, leafy, Set.of(BlockPos.asLong(-1, 1, 1))).ok());
		// a cell the template writes air into is not the site's any more: a carve does not hold what it carved
		byte[] carved = writes(new int[][] {{1, 1, 1}});
		carved[(1 * 3 + 1) * 3 + 0] = 1; // air written at (0, 1, 1)
		TerrainFit.World solidAll = (x, y, z) -> x <= 0 && y == 1 && z == 1 ? TerrainFit.NATURAL : TerrainFit.FILLABLE;
		assertEquals(1, SiteFit.support(3, 3, 3, carved, 0, 0, 0, solidAll, Set.of()).unsupported());
		// a trunk (logs) holds a ring
		TerrainFit.World trunk = (x, y, z) -> x == 1 && z == 1 ? TerrainFit.TREE : TerrainFit.FILLABLE;
		assertTrue(SiteFit.support(3, 3, 3, writes(new int[][] {{0, 1, 1}, {0, 1, 0}, {1, 1, 0}, {2, 1, 0}}), 0, 0, 0, trunk, Set.of()).ok());
	}
}
