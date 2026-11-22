package dev.larattalabs.architect.site;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonObject;
import dev.larattalabs.architect.placement.Anchors;
import dev.larattalabs.architect.survival.Refunds;
import dev.larattalabs.architect.survival.SurvivalItems;
import it.unimi.dsi.fastutil.longs.LongOpenHashSet;
import java.lang.reflect.Method;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.BitSet;
import java.util.List;
import java.util.Map;
import net.minecraft.core.BlockPos;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

/**
 * (slice T4R-D fix round, P1-2 and P1-3; rows T4RDF-adopt-pile and T4RDF-adopt-write) An adopted site's removal joins the single-removal flow:
 * a stockpile-fed adopted site's owner record carries its pile stash (paid, with its refunded cells), never the crate-fed settle that is null
 * for it; and its live write is the single removal's live write (found recorded, marked written, written with its own delta-cell hold
 * exempt, unmarked when a hold refused any of it). Red before the fix: the member was unpaid with no settle, and the live write ran under
 * its own hold (refused) while marked restored, so its W skipped the repair write.
 */
class T4RDFixAdoptTest {
	static final String DIM = "minecraft:overworld";

	@AfterEach
	void reset() {
		OwnerRemovals.read(null, null);
		CrateSettle.WRITING = java.util.Set.of();
	}

	static Site adopted() {
		Anchors.Bounds bx = new Anchors.Bounds(0, 64, 0, 1, 64, 0);
		Construction con = new Construction(Construction.BUILT, new int[] {0, 1}, "journal", null, new BitSet(), false, "owner");
		return new Site("adopted", "bp", "none", bx, bx, Map.of(), 1, DIM, bx, "snapshot", null, null, con);
	}

	/** A pile-fed deconstruction of the delta cells: one paid plank standing, one of the player's sponges. */
	static Builder.Deconstruction pileFed(Site s) {
		Refunds.Tally t = new Refunds.Tally();
		t.add(Refunds.Outcome.REFUND, BlockPos.asLong(0, 64, 0), "minecraft:oak_planks", List.of(new SurvivalItems.Cost("minecraft:oak_planks", 1)), null);
		t.add(Refunds.Outcome.PLAYER_DROP, BlockPos.asLong(1, 64, 0), "minecraft:sponge", List.of(new SurvivalItems.Cost("minecraft:sponge", 1)), "placer");
		return new Builder.Deconstruction(t, Map.of(), BlockPos.ZERO, 2, 0, "owner", Builder.creditKey(s));
	}

	static Method ownerRecord() {
		try {
			Method m = Adopt.class.getDeclaredMethod("ownerRecord", Site.class, Builder.Deconstruction.class, String.class, Anchors.Bounds.class,
				LongOpenHashSet.class, String.class);
			m.setAccessible(true);
			return m;
		} catch (NoSuchMethodException e) {
			return null;
		}
	}

	@Test
	void aPileFedAdoptedSiteIsPaidFromItsPile() throws Exception {
		System.out.println("ROW T4RDF-adopt-pile (unit)");
		Method m = ownerRecord();
		assertNotNull(m, "T4RDF-adopt-pile: Adopt builds its record from dec.settle() (null for a stockpile-fed site): no pile refund");
		Site s = adopted();
		LongOpenHashSet cells = new LongOpenHashSet(new long[] {BlockPos.asLong(0, 64, 0), BlockPos.asLong(1, 64, 0)});
		JsonObject rec = (JsonObject) m.invoke(null, s, pileFed(s), "u:adopted", new Anchors.Bounds(0, 64, 0, 1, 64, 0), cells, null);
		assertNotNull(rec, "needed: paid and with a player cell");
		JsonObject mem = rec.getAsJsonObject("members").getAsJsonObject("adopted");
		System.out.println("ROW T4RDF-adopt-pile: member " + mem);
		assertTrue(mem.get("paid").getAsBoolean(), "T4RDF-adopt-pile: the adopted member is paid");
		JsonObject st = mem.getAsJsonObject("settle");
		assertNotNull(st, "T4RDF-adopt-pile: its settle is its pile stash");
		assertEquals("owner", st.get("pile").getAsString(), "T4RDF-adopt-pile: credited into the owner's pile");
		assertEquals(1, st.getAsJsonObject("refund").get("minecraft:oak_planks").getAsInt(), "T4RDF-adopt-pile: the paid plank refunded");
		assertEquals(1, st.getAsJsonArray("cells").size(), "T4RDF-adopt-pile: its refunded cell recorded (the W's min)");
		assertEquals("u:adopted", st.get("undoGroup").getAsString(), "named with its undo group");
		assertEquals(1, mem.getAsJsonArray("player").size(), "the player's sponge owed, not refunded");
		assertEquals(2, mem.getAsJsonArray("hold").size(), "held cell by cell: its delta cells");
	}

	@Test
	void theAdoptedLiveWriteIsTheSingleRemovalsLiveWrite() throws Exception {
		System.out.println("ROW T4RDF-adopt-write (unit)");
		Method m = ownerRecord();
		Site s = adopted();
		LongOpenHashSet cells = new LongOpenHashSet(new long[] {BlockPos.asLong(0, 64, 0), BlockPos.asLong(1, 64, 0)});
		if (m != null) {
			OwnerRemovals.put("removal:adopted@u:adopted", (JsonObject) m.invoke(null, s, pileFed(s), "u:adopted", new Anchors.Bounds(0, 64, 0, 1, 64, 0), cells,
				null));
			// the hold the live write must be exempt from: refused by the owner key alone (OWNER_WRITE), accepted with the member writing
			assertTrue(CrateSettle.stashBoxHeld(DIM, 0, 64, 0), "the delta cell is held while the record lives");
			CrateSettle.WRITING = java.util.Set.of("adopted");
			assertFalse(CrateSettle.stashBoxHeld(DIM, 0, 64, 0), "its own write (the member in WRITING) is exempt");
			CrateSettle.WRITING = java.util.Set.of();
		}
		boolean shared;
		try {
			Sites.class.getDeclaredMethod("liveOwnWrite", net.minecraft.server.level.ServerLevel.class, String.class, String.class, JsonObject.class);
			shared = true;
		} catch (NoSuchMethodException e) {
			shared = false;
		}
		assertTrue(shared, "T4RDF-adopt-write: no shared live write: Adopt marks its restore written while its own hold refuses the write");
		String src = Files.readString(Path.of("src/main/java/dev/larattalabs/architect/site/Adopt.java"));
		String body = src.substring(src.indexOf("private static Sites.Removed undoDeltas("), src.indexOf("static com.google.gson.@Nullable JsonObject ownerRecord("));
		assertTrue(body.contains("Sites.liveOwnWrite(level, b.id(), group, stash)"), "T4RDF-adopt-write: Adopt's live write is the single removal's");
		assertFalse(body.contains("CrateSettle.markRestored("), "T4RDF-adopt-write: never marked restored outside the shared live write");
	}
}
