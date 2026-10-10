package dev.larattalabs.architect.region;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import dev.larattalabs.architect.api.Reason;
import dev.larattalabs.architect.api.WaitAction;
import java.util.List;
import net.minecraft.core.BlockPos;
import org.junit.jupiter.api.Test;

/** WaitAction per wait reason (CONTRACT phase 6b §6.2, gate item 1). */
class WaitActionsTest {
	static List<WaitAction> of(Reason r) {
		return WaitActions.of(new WaitActions.Context(r, new int[] {128, -64, 191, -1}, new int[] {0, 70, 0}, "lots-1", 412, 4.0));
	}

	static List<WaitAction.Kind> kinds(Reason r) {
		return of(r).stream().map(WaitAction::kind).toList();
	}

	@Test
	void perReason() {
		assertEquals(List.of(WaitAction.Kind.MOVE_CLOSER), kinds(Reason.NOT_LOADED));
		assertEquals(List.of(WaitAction.Kind.PREPARE), kinds(Reason.NOT_GENERATED));
		assertEquals(List.of(WaitAction.Kind.START_SIDECAR), kinds(Reason.SIDECAR_UNAVAILABLE));
		assertEquals(List.of(WaitAction.Kind.APPROVE_STAGE, WaitAction.Kind.REPLAN), kinds(Reason.DRIFTED));
		for (Reason r : Reason.values()) {
			if (r != Reason.NOT_LOADED && r != Reason.NOT_GENERATED && r != Reason.SIDECAR_UNAVAILABLE && r != Reason.DRIFTED) {
				assertEquals(List.of(), kinds(r), r.name());
			}
		}
		assertEquals(List.of(), WaitActions.of(new WaitActions.Context(null, null, null, null, 0, 4)));
	}

	@Test
	void moveCloserTargetsTheNearestChunkCentre() {
		WaitAction a = of(Reason.NOT_LOADED).get(0);
		// the tile 128..191 x -64..-1: its chunk nearest the player at (0, 0) is chunk (8, -1): centre (136, -8)
		assertEquals(new BlockPos(136, 70, -8), a.target());
		assertEquals("Walk to 136, -8", a.label());
		WaitAction none = WaitActions.of(new WaitActions.Context(Reason.NOT_LOADED, new int[] {0, 0, 31, 31}, null, null, 0, 4)).get(0);
		assertEquals(new BlockPos(8, 64, 8), none.target());
	}

	@Test
	void prepareShowsTheEstimate() {
		WaitAction a = of(Reason.NOT_GENERATED).get(0);
		assertEquals("412 chunks (~2 min)", a.detail());
		assertTrue(a.label().startsWith("Prepare 412 chunks"));
		assertEquals("1 chunk (~1 s)", WaitActions.estimate(1, 4));
		assertEquals("40000 chunks (~2.8 h)", WaitActions.estimate(40000, 4));
	}

	@Test
	void approveNamesTheStage() {
		assertEquals("lots-1", of(Reason.DRIFTED).get(0).detail());
	}
}
