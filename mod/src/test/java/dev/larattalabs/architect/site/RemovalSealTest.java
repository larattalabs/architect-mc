package dev.larattalabs.architect.site;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import dev.larattalabs.architect.placement.Anchors;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import net.minecraft.SharedConstants;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.server.Bootstrap;
import net.minecraft.world.level.EmptyBlockGetter;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.entity.BrushableBlockEntity;
import net.minecraft.world.level.block.entity.CampfireBlockEntity;
import net.minecraft.world.level.block.entity.ChestBlockEntity;
import net.minecraft.world.level.block.entity.ChiseledBookShelfBlockEntity;
import net.minecraft.world.level.block.entity.DecoratedPotBlockEntity;
import net.minecraft.world.level.block.entity.HopperBlockEntity;
import net.minecraft.world.level.block.entity.JukeboxBlockEntity;
import net.minecraft.world.level.block.entity.LecternBlockEntity;
import net.minecraft.world.level.block.entity.ShelfBlockEntity;
import net.minecraft.world.level.block.entity.SignBlockEntity;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

/**
 * (Slice LC3) The removal seal: its index (boxes per dimension, filed by chunk), its holders, the persisted
 * sources it is derived from (a group removal's members and its current member, a restore job's site: what the queue file reloads after a
 * crash), and that every insertion path calls it. In game: lc3-seal (tools/lib/gatem5lc3.mjs).
 */
class RemovalSealTest {
	@BeforeAll
	static void boot() {
		SharedConstants.tryDetectVersion();
		Bootstrap.bootStrap();
	}

	static final String OW = "minecraft:overworld";

	@Test
	void indexHoldsEachBoxAcrossChunksAndDimensions() {
		Anchors.Bounds a = new Anchors.Bounds(10, 60, 10, 40, 70, 20); // crosses the chunk line at x 16 and 32
		Anchors.Bounds b = new Anchors.Bounds(-20, 0, -20, -17, 5, -17); // negative chunk coordinates
		RemovalSeal.Index ix = RemovalSeal.index(List.of(new RemovalSeal.Sealed(OW, a), new RemovalSeal.Sealed(OW, b),
			new RemovalSeal.Sealed("minecraft:the_nether", a)));
		assertEquals(3, ix.boxes());
		for (int[] p : new int[][] {{10, 60, 10}, {16, 65, 15}, {33, 70, 20}, {40, 60, 10}, {-20, 0, -20}, {-17, 5, -17}}) {
			assertTrue(ix.contains(OW, p[0], p[1], p[2]), "sealed: " + java.util.Arrays.toString(p));
		}
		for (int[] p : new int[][] {{9, 60, 10}, {41, 60, 10}, {20, 71, 15}, {20, 59, 15}, {20, 65, 21}, {-16, 0, -20}, {-21, 0, -20}}) {
			assertFalse(ix.contains(OW, p[0], p[1], p[2]), "outside: " + java.util.Arrays.toString(p));
		}
		assertTrue(ix.contains("minecraft:the_nether", 20, 65, 15));
		assertFalse(ix.contains("minecraft:the_nether", -20, 0, -20), "the nether has only its own box");
		assertFalse(ix.contains("minecraft:the_end", 20, 65, 15));
		assertEquals(0, RemovalSeal.index(List.of()).boxes(), "nothing removed: nothing sealed");
	}

	@Test
	void holdersAreEveryItemHolderARestoreReplaces() {
		BlockPos o = BlockPos.ZERO;
		assertTrue(RemovalSeal.holder(new ChestBlockEntity(o, Blocks.CHEST.defaultBlockState())));
		assertTrue(RemovalSeal.holder(new HopperBlockEntity(o, Blocks.HOPPER.defaultBlockState())));
		assertTrue(RemovalSeal.holder(new LecternBlockEntity(o, Blocks.LECTERN.defaultBlockState())));
		assertTrue(RemovalSeal.holder(new CampfireBlockEntity(o, Blocks.CAMPFIRE.defaultBlockState())));
		assertTrue(RemovalSeal.holder(new DecoratedPotBlockEntity(o, Blocks.DECORATED_POT.defaultBlockState())));
		assertTrue(RemovalSeal.holder(new ChiseledBookShelfBlockEntity(o, Blocks.CHISELED_BOOKSHELF.defaultBlockState())));
		assertTrue(RemovalSeal.holder(new JukeboxBlockEntity(o, Blocks.JUKEBOX.defaultBlockState())));
		assertTrue(RemovalSeal.holder(new ShelfBlockEntity(o, Blocks.OAK_SHELF.defaultBlockState())));
		assertTrue(RemovalSeal.holder(new BrushableBlockEntity(o, Blocks.SUSPICIOUS_SAND.defaultBlockState())));
		assertFalse(RemovalSeal.holder(new SignBlockEntity(o, Blocks.OAK_SIGN.defaultBlockState())));
		assertFalse(RemovalSeal.holder(null));
	}

	@Test
	void theSourcesSurviveTheQueueFile() {
		// a group removal: its members not yet written and the one being written come back from the queue file (re-sealed after a crash)
		Groups.Removal r = new Groups.Removal("g1", "s2", null, false);
		r.sites.addAll(List.of("lot_a", "lot_b"));
		r.current = "lot_c";
		r.started = true;
		Groups.Removal back = Groups.Removal.fromJson(r.toJson());
		assertEquals(List.of("lot_a", "lot_b"), back.sites);
		assertEquals("lot_c", back.current);
		// a removal's restore job: its site comes back with the job (Placement.resume adds it while the record stands or is pending)
		RestoreJob j = RestoreJob.writing("big_1", "u:remove-big_1", Map.of());
		RestoreJob jb = RestoreJob.fromJson(j.toJson());
		assertEquals("big_1", jb.siteId);
		assertEquals(RestoreJob.REMOVE, jb.purpose);
		assertFalse(jb.done);
	}

	@Test
	void aReloadedQueueSealsRunningAndStalledRemovals() {
		// the queue file's removals after a restart: a running one and a stalled one (a retry resumes it with no new blocker scan)
		Groups.Removal run = new Groups.Removal("g1", "lots", null, false);
		run.sites.addAll(List.of("lot_a", "lot_b"));
		run.current = "lot_c";
		run.started = true;
		Groups.Removal stalled = new Groups.Removal("g2", null, null, false);
		stalled.sites.add("lot_d");
		stalled.started = true;
		com.google.gson.JsonArray a = new com.google.gson.JsonArray();
		a.add(run.toJson());
		com.google.gson.JsonObject s = stalled.toJson();
		s.addProperty("stalled", true);
		a.add(s);
		try {
			Groups.load(a);
			List<String> ids = new java.util.ArrayList<>();
			Groups.sealedIds(ids);
			assertEquals(List.of("lot_a", "lot_b", "lot_c", "lot_d"), ids);
			int m0 = Groups.sealMods();
			Groups.load(new com.google.gson.JsonArray());
			List<String> none = new java.util.ArrayList<>();
			Groups.sealedIds(none);
			assertTrue(none.isEmpty(), "nothing in the queue: nothing sealed");
			assertTrue(Groups.sealMods() != m0, "the index follows the change");
		} finally {
			Groups.reset(null);
		}
	}

	@Test
	void aRoadOrCellSiteSealsOnlyItsWriteFootprint() {
		// (LC3 fix, should-fix) a road's bounding box spans holders it never writes: only the cells of its journal entries are sealed
		Anchors.Bounds box = new Anchors.Bounds(0, 60, 0, 40, 62, 40);
		it.unimi.dsi.fastutil.longs.LongOpenHashSet cells = new it.unimi.dsi.fastutil.longs.LongOpenHashSet();
		for (int x = 0; x <= 40; x++) {
			cells.add(BlockPos.asLong(x, 61, x)); // a diagonal road
		}
		RemovalSeal.Index ix = RemovalSeal.index(List.of(new RemovalSeal.Sealed(OW, box, cells), new RemovalSeal.Sealed(OW, new Anchors.Bounds(100, 0, 100,
			101, 1, 101))));
		assertTrue(ix.contains(OW, 20, 61, 20), "a cell the road writes");
		assertTrue(ix.contains(OW, 33, 61, 33), "across chunks");
		assertFalse(ix.contains(OW, 20, 61, 30), "in its bounding box, off its cells: a player's chest there is not sealed");
		assertFalse(ix.contains(OW, 20, 60, 20), "below a cell it writes");
		assertTrue(ix.contains(OW, 100, 1, 101), "a site's box (no footprint): the whole box");
	}

	@Test
	void aGroupRemovalKeepsItsWrittenMembersSealedUntilItEnds() {
		// (LC3 fix, review 2) member A written (out of sites), B being written: A stays sealed, since a crash before the removal ends writes A
		// again (Sites.reconcile -> Groups.writeAgain -> writeAgainIn); so does a planned (not yet committed) removal's whole set
		Groups.Removal r = new Groups.Removal("g1", null, null, false);
		r.undo = "u:g1";
		r.undoSites.addAll(List.of("lot_b", "lot_a"));
		r.current = "lot_b";
		r.started = true;
		Groups.Removal planned = new Groups.Removal("g2", null, null, false);
		planned.planned = "u:g2";
		planned.plannedSites.add("lot_p");
		planned.started = true;
		com.google.gson.JsonArray a = new com.google.gson.JsonArray();
		a.add(r.toJson());
		a.add(planned.toJson());
		try {
			Groups.load(a);
			List<String> ids = new java.util.ArrayList<>();
			Groups.sealedIds(ids);
			assertTrue(ids.contains("lot_a"), "the written member stays sealed: " + ids);
			assertTrue(ids.contains("lot_b") && ids.contains("lot_p"), "the member being written and a planned removal's members: " + ids);
		} finally {
			Groups.reset(null);
		}
	}

	@Test
	void aLingeringBoxUnsealsOnlyOnceAQueueGenerationThatExcludesItIsWritten(@org.junit.jupiter.api.io.TempDir Path dir) throws Exception {
		// (LC3 fix 2, GPT P1 #1) a box that left the seal waits for a generation requested after it left; the saver's barrier completing is
		// not enough: a failed write (logged, no exception out of the saver) leaves it sealed, and the retry's write releases it
		Path f = dir.resolve("architect-queue.json");
		com.google.gson.JsonObject root = new com.google.gson.JsonObject();
		root.addProperty("version", 1);
		long base = Math.max(Placement.writtenGen(), Placement.requestedGen());
		RemovalSeal.Linger l = new RemovalSeal.Linger(new RemovalSeal.Sealed(OW, new Anchors.Bounds(0, 0, 0, 3, 3, 3)), base + 1);
		assertFalse(RemovalSeal.released(l, Placement.writtenGen()), "nothing written since it left: sealed");
		Placement.FAIL_WRITES.set(1);
		try {
			assertFalse(Placement.writeSave(root, f, base + 1), "the injected write fails");
			Placement.saved().get(10, java.util.concurrent.TimeUnit.SECONDS); // the saver's barrier completes all the same
			assertFalse(Files.exists(f), "nothing on disk");
			assertTrue(Placement.writtenGen() < base + 1 && Placement.writeFailing(), "the failed generation is not written; a retry is due");
			assertFalse(RemovalSeal.released(l, Placement.writtenGen()), "a failed queue write keeps the box sealed (611ee4ee unsealed it here)");
			assertTrue(Placement.writeSave(root, f, base + 2), "the retry's write (a later generation: the state as it is then)");
		} finally {
			Placement.FAIL_WRITES.set(0);
		}
		assertTrue(Files.exists(f) && !Files.exists(dir.resolve("architect-queue.json.tmp")), "written, forced and renamed");
		assertFalse(Placement.writeFailing(), "no retry due once a later generation is written");
		assertTrue(RemovalSeal.released(l, Placement.writtenGen()), "the written generation excludes it: unsealed");
		assertFalse(RemovalSeal.released(new RemovalSeal.Linger(l.box(), base + 3), Placement.writtenGen()), "a box that left later still waits");
	}

	@Test
	void abandonSettlesOnlyAStalledRemovalItsWrittenAndUnwrittenMembers() {
		// (LC3 fix 2, GPT P1 #2) /architect removal abandon: members A written, B broke mid-write, C never started; written A settles as a
		// finished removal, B and C stay standing (their records and entries dropped); refused for anything not STALLED
		Groups.Removal r = new Groups.Removal("g7", null, null, false);
		r.undo = "u:g7";
		r.undoSites.addAll(List.of("lot_a", "lot_b", "lot_c"));
		r.sites.addAll(List.of("lot_b", "lot_c"));
		r.started = true;
		Groups.Settle st = Groups.settle(r);
		assertEquals(List.of("lot_a"), st.written());
		assertEquals(List.of("lot_b", "lot_c"), st.unwritten());
		r.current = "lot_a"; // (a member being written counts as unwritten)
		assertEquals(List.of("lot_a", "lot_b", "lot_c"), Groups.settle(r).unwritten());
		r.current = null;
		assertTrue(Groups.abandonRefusal(null, false, "g7", null).startsWith("No stalled removal of g7"), "unknown, finished or already abandoned");
		assertTrue(Groups.abandonRefusal(null, true, "g7 s1", null).contains("is running, not stalled"), "a running removal");
		assertTrue(Groups.abandonRefusal(r, false, "g7", "closed").contains("journal is unavailable"));
		assertEquals(null, Groups.abandonRefusal(r, false, "g7", null));
		com.google.gson.JsonArray a = new com.google.gson.JsonArray();
		com.google.gson.JsonObject o = r.toJson();
		o.addProperty("stalled", true);
		a.add(o);
		try {
			Groups.load(a);
			List<String[]> names = Groups.stalledNames();
			assertEquals(1, names.size());
			assertEquals("g7", names.get(0)[0]);
			List<String> ids = new java.util.ArrayList<>();
			Groups.sealedIds(ids);
			assertTrue(ids.containsAll(List.of("lot_a", "lot_b", "lot_c")), "stalled: its whole set sealed " + ids);
			int m0 = Groups.sealMods();
			// the step that ends it (after the records are settled): out of the stalled list, out of the queue file, nothing sealed by it
			Groups.Removal loaded = null;
			for (com.google.gson.JsonElement e : Groups.toJson()) {
				assertTrue(e.getAsJsonObject().has("stalled"));
			}
			for (Groups.Removal x : stalledList()) {
				loaded = x;
			}
			assertTrue(Groups.dropStalled(loaded));
			assertFalse(Groups.dropStalled(loaded), "a second drop finds nothing (the command refuses: no stalled removal)");
			assertTrue(Groups.toJson().isEmpty(), "the next queue file holds no removal: nothing resumes or replays");
			List<String> none = new java.util.ArrayList<>();
			Groups.sealedIds(none);
			assertTrue(none.isEmpty(), "nothing sealed by it (its boxes linger until that queue file is written)");
			assertTrue(Groups.sealMods() != m0, "the index follows the change");
		} finally {
			Groups.reset(null);
		}
	}

	private static List<Groups.Removal> stalledList() {
		List<Groups.Removal> out = new java.util.ArrayList<>();
		for (String[] n : Groups.stalledNames()) {
			out.add(Groups.stalledFor(n[0], n[1]));
		}
		return out;
	}

	@Test
	void everyExtractionAndConsumerPathAsksTheSeal() throws Exception {
		// (LC3 fix, review 1, 3, 4, 5) out of a sealed holder, a crafter, a vault, a chained shelf
		String mx = "java/dev/larattalabs/architect/mixin/";
		String hg = read(mx + "HopperGuardMixin.java");
		assertTrue(hg.contains("RemovalSeal.refusesExtract(container, slot)") && hg.contains("method = \"ejectItems\", at = @At(\"HEAD\")")
			&& hg.contains("RemovalSeal.refusesPush(level, pos)"), "a hopper's or hopper minecart's pull, a sealed hopper's push");
		assertTrue(read(mx + "CopperGolemSealMixin.java").contains("RemovalSeal.refusesGolemTake(container)"), "a copper golem's pick-up");
		assertTrue(read(mx + "CrafterSealMixin.java").contains("method = \"dispenseFrom\", at = @At(\"HEAD\")")
			&& read(mx + "CrafterSealMixin.java").contains("RemovalSeal.refusesCraft("), "a crafter, before it consumes anything");
		assertTrue(read(mx + "DispenseSealMixin.java").contains("{DispenserBlock.class, DropperBlock.class}"), "a sealed dispenser or dropper");
		assertTrue(read(mx + "VaultSealMixin.java").contains("method = \"tryInsertKey\", at = @At(\"HEAD\")"), "a vault's key");
		String cw = read("java/dev/larattalabs/architect/compatmixin/ContainerSlotWrapperMixin.java");
		assertTrue(cw.contains("RemovalSeal.refusesTransferExtract(this)"), "Transfer API extract");
		String mixins = read("resources/architect_mc.mixins.json");
		for (String m : List.of("CrafterSealMixin", "DispenseSealMixin", "VaultSealMixin", "HopperGuardMixin")) {
			assertTrue(mixins.contains("\"" + m + "\""), m + " registered");
		}
		String seal = read("java/dev/larattalabs/architect/site/RemovalSeal.java");
		assertTrue(seal.contains("chain.getAllBlocksConnectedTo(level, at)"), "a powered shelf's whole chain");
		assertTrue(seal.contains("PlayerBlockBreakEvents.BEFORE.register"), "a player breaking a sealed holder");
		assertTrue(seal.contains("need = Placement.requestedGen() + 1") && seal.contains("Placement.writtenGen()"), "an ended removal's boxes stay "
			+ "sealed until a queue file generation without it is written (LC3 fix 2: confirmed, not the saver's barrier)");
		String pl = read("java/dev/larattalabs/architect/site/Placement.java");
		assertTrue(pl.contains("RemovalSeal.observe();") && pl.contains("saveIfDue(srv);"), "the tick sees every ended removal and retries a failed write");
	}

	static String read(String rel) throws Exception {
		return Files.readString(Path.of("src/main/" + rel));
	}

	@Test
	void everyInsertionPathAsksTheSeal() throws Exception {
		String mx = "java/dev/larattalabs/architect/mixin/";
		assertTrue(read(mx + "HopperHoldMixin.java").contains("RemovalSeal.refusesInsert(container, slot)"), "hopper, dropper, crafter, item pickup");
		assertTrue(read(mx + "HopperHoldMixin.java").contains("FillHold.refusesInsert(container, slot)"), "FL's fill rule kept");
		assertTrue(read(mx + "CopperGolemSealMixin.java").contains("RemovalSeal.refusesGolem(container)"), "copper golem");
		assertTrue(read(mx + "ContainerStillValidMixin.java").contains("RemovalSeal.refusesMenu(")
			&& read(mx + "ContainerStillValidMixin.java").contains("CrafterBlockEntity.class"), "an open menu (the crafter overrides stillValid)");
		assertTrue(read(mx + "BlockItemSealMixin.java").contains("RemovalSeal.refusesPlace("), "a filled block item placed (a player, a dispenser)");
		assertTrue(read(mx + "ItemFrameSealMixin.java").contains("RemovalSeal.refusesFrame("), "item frame");
		String cw = read("java/dev/larattalabs/architect/compatmixin/ContainerSlotWrapperMixin.java");
		assertTrue(cw.contains("method = \"insert(") && cw.contains("RemovalSeal.refusesTransferInsert(this)"), "Transfer API insert");
		String mixins = read("resources/architect_mc.mixins.json");
		for (String m : List.of("HopperHoldMixin", "CopperGolemSealMixin", "ContainerStillValidMixin", "ItemFrameSealMixin", "BlockItemSealMixin")) {
			assertTrue(mixins.contains("\"" + m + "\""), m + " registered");
		}
		String seal = read("java/dev/larattalabs/architect/site/RemovalSeal.java");
		assertTrue(seal.contains("UseBlockCallback.EVENT.register"), "a player's use of a holder");
		assertTrue(read("java/dev/larattalabs/architect/site/Sites.java").contains("RemovalSeal.init()"), "registered at start");
		// the sources: the queue's restore and delta-revert jobs, the group removals running or stalled
		assertTrue(seal.contains("j instanceof RestoreJob rj") && seal.contains("DeltaJob.REVERT.equals(dj.kind)"));
		String g = read("java/dev/larattalabs/architect/site/Groups.java");
		assertTrue(g.contains("for (List<Removal> l : List.of(REMOVALS, STALLED))"), "a stalled removal stays sealed (its retry has no blocker scan)");
	}

	@Test
	void aPlayersBlockDropsOnTopOfTheCellNeverInsideIt() {
		// (LC2's F10 fix, kept) the gravel spawned at y + 0.25 inside the grass block the cell got back; vanilla pushed it off the cell
		double top = Blocks.GRASS_BLOCK.defaultBlockState().getCollisionShape(EmptyBlockGetter.INSTANCE, BlockPos.ZERO).max(Direction.Axis.Y);
		assertEquals(1.0, top, 1e-9);
		assertTrue(Builder.dropY(64, top) >= 64 + top);
		assertEquals(64.25, Builder.dropY(64, Double.NaN), 1e-9);
		double slab = Blocks.STONE_SLAB.defaultBlockState().getCollisionShape(EmptyBlockGetter.INSTANCE, BlockPos.ZERO).max(Direction.Axis.Y);
		assertTrue(Builder.dropY(64, slab) >= 64.5);
	}

	@Test
	void regionTargetDropsAPlayersHolderWithItsContents() throws Exception {
		String rt = read("java/dev/larattalabs/architect/site/RegionTargets.java");
		int c = rt.indexOf("Builder.holderContents(level.getBlockEntity(p))");
		int w = rt.indexOf("Placed.set(level, p, was != null ? was");
		int d = rt.indexOf("Builder.dropStacksAtCell(level, p, contents)");
		assertTrue(c > 0 && c < w && w < d, "the contents read before the write, dropped after it on top");
	}
}
