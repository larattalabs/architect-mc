package dev.larattalabs.architect.placement;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.larattalabs.architect.placement.Reconcile.Action;
import dev.larattalabs.architect.placement.Reconcile.Overlap;
import dev.larattalabs.architect.placement.Anchor;
import dev.larattalabs.architect.placement.Anchors;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

/**
 * Review fixes of the world stream: a building pins the template it was placed from (blueprints regenerated under the
 * same id never change it), the world-start release of pending snapshots (never after N saves), arrows and tridents.
 */
class PinAndReconcileTest {
	static final Anchors.Bounds BOX = new Anchors.Bounds(0, 64, 0, 20, 72, 16);

	// ------------------------------------------------------------------ pin (high: blueprint regenerated under the same id)

	@Test
	void fingerprintIsOrderFreeAndSeesEveryChange() {
		int[] xyz = {0, 0, 0, 1, 0, 0, 0, 1, 0};
		String[] st = {"Block{minecraft:stone}", "Block{agentcraft:monitor}[facing=north]", "Block{minecraft:air}"};
		boolean[] be = {false, true, false};
		String f = TemplateGrid.fingerprint(xyz, st, be);
		assertEquals(16, f.length());
		// same cells, another order: same fingerprint
		assertEquals(f, TemplateGrid.fingerprint(new int[] {0, 1, 0, 0, 0, 0, 1, 0, 0},
			new String[] {st[2], st[0], st[1]}, new boolean[] {false, false, true}));
		// vanilla materials instead of the mod's: another template
		assertNotEquals(f, TemplateGrid.fingerprint(xyz, new String[] {st[0], "Block{minecraft:barrel}[facing=north]", st[2]}, be));
		assertNotEquals(f, TemplateGrid.fingerprint(xyz, st, new boolean[] {false, false, false}));
		assertNotEquals(f, TemplateGrid.fingerprint(new int[] {0, 0, 0, 2, 0, 0, 0, 1, 0}, st, be));
	}

	// ------------------------------------------------------------------ world-start release (high: snapshot deleted after pause saves)

	@Test
	void aSnapshotIsOnlyReleasedOnPositiveEvidence() {
		// the restore reached the disk: the site shows its snapshot again
		assertEquals(Action.RELEASE, Reconcile.decide(false, false, true, Overlap.NONE, false, null));
		// neither the building nor its snapshot stands (taken apart before removal, crash): kept
		assertEquals(Action.KEEP, Reconcile.decide(false, false, false, Overlap.NONE, false, null));
		// cannot be checked (blueprint changed, dimension missing): kept
		assertEquals(Action.KEEP, Reconcile.decide(false, null, null, Overlap.NONE, false, null));
		assertEquals(Action.KEEP, Reconcile.decide(true, null, null, Overlap.NONE, true, null));
		// a removal that never reached the disk: the record comes back
		assertEquals(Action.RECOVER, Reconcile.decide(false, true, false, Overlap.NONE, false, null));
		assertEquals(Action.REPORT_KEEP, Reconcile.decide(false, true, false, Overlap.NONE, true, null));
		// restored needs a share of the differing cells
		assertEquals(Boolean.TRUE, Reconcile.restored(90, 100));
		assertEquals(Boolean.FALSE, Reconcile.restored(89, 100));
		assertNull(Reconcile.restored(0, 0));
	}

	@Test
	void aMoveSavedOnlyAtOneSiteIsReportedNotDeleted() {
		// both sites stand (an autosave wrote the new site's chunks, not the old one's): report, keep the snapshot
		assertEquals(Action.REPORT_KEEP, Reconcile.decide(true, true, false, Overlap.NONE, true, true));
		assertEquals(Action.REPORT_KEEP, Reconcile.decide(true, true, false, Overlap.NONE, true, null));
		// only the old site stands: the move is undone
		assertEquals(Action.RECOVER, Reconcile.decide(true, true, false, Overlap.NONE, true, false));
		// only the new site stands and the old site shows its terrain: done
		assertEquals(Action.RELEASE, Reconcile.decide(true, false, true, Overlap.NONE, true, true));
	}

	@Test
	void aTakenDownBuildingUnderAnotherIsNeverReAdded() {
		// remove b1, place b2 on the same spot, crash: b1 "stands" but b2 covers it
		assertEquals(Action.RELEASE, Reconcile.decide(false, true, false, Overlap.COVERED, false, null));
		// partly under b2: report on b2, keep b1's terrain, never re-add b1
		assertEquals(Action.REPORT_KEEP, Reconcile.decide(false, true, false, Overlap.PARTIAL, false, null));
		assertEquals(Action.KEEP, Reconcile.decide(false, false, false, Overlap.PARTIAL, false, null));
	}

	@Test
	void overlapCountsTheSameIdSoUndoMoveIsNotTwoCopies() {
		String ow = "minecraft:overworld";
		Anchors.Bounds a = new Anchors.Bounds(0, 58, 0, 20, 72, 16);
		// move A -> B, undo: pending (b1 at A, moved) while b1 stands at A again: covered by itself, released
		Reconcile.Found undo = Reconcile.overlap(new Reconcile.Site("b1", ow, a, null), List.of(new Reconcile.Site("b1", ow, a, true)));
		assertEquals(Reconcile.Overlap.COVERED, undo.overlap());
		assertEquals(Action.RELEASE, Reconcile.decide(true, true, false, undo.overlap(), true, true));
		// another building that stands covers the whole site: covered
		Anchors.Bounds big = new Anchors.Bounds(-2, 50, -2, 30, 80, 30);
		assertEquals(new Reconcile.Found(Reconcile.Overlap.COVERED, "b2"),
			Reconcile.overlap(new Reconcile.Site("b1", ow, a, null), List.of(new Reconcile.Site("b2", ow, big, true))));
		// covering but not standing (or unknown), or only intersecting: partial
		assertEquals(new Reconcile.Found(Reconcile.Overlap.PARTIAL, "b2"),
			Reconcile.overlap(new Reconcile.Site("b1", ow, a, null), List.of(new Reconcile.Site("b2", ow, big, false))));
		assertEquals(Reconcile.Overlap.PARTIAL, Reconcile.overlap(new Reconcile.Site("b1", ow, a, null),
			List.of(new Reconcile.Site("b2", ow, new Anchors.Bounds(10, 60, 10, 40, 70, 40), true))).overlap());
		// another dimension, or apart: none (a move to a separate site can still be undone by RECOVER)
		assertEquals(Reconcile.Overlap.NONE, Reconcile.overlap(new Reconcile.Site("b1", ow, a, null),
			List.of(new Reconcile.Site("b2", "minecraft:the_nether", a, true), new Reconcile.Site("b1", ow, new Anchors.Bounds(100, 60, 0, 120, 70, 16), false)))
			.overlap());
	}

	// ------------------------------------------------------------------ occupancy (medium: tridents and pickable arrows)

	@Test
	void pickableProjectilesRefuseLikeItems() {
		Occupancy.Found trident = new Occupancy.Found(Occupancy.Kind.ITEM, "trident", true);
		Occupancy.Found skeletonArrow = new Occupancy.Found(Occupancy.Kind.PROJECTILE, "arrow", false);
		assertFalse(trident.removable());
		assertTrue(skeletonArrow.removable());
		assertEquals(List.of("dropped items in the box: trident (pick them up first)"), Occupancy.refusals(List.of(trident, skeletonArrow)));
	}
}
