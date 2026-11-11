package dev.larattalabs.architect.site;

import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonObject;
import java.util.List;
import org.junit.jupiter.api.Test;

/**
 * (PX, XR guard) A direct undo of one stage of a survival region's group is refused: a block a later writer took up (and gave back to the
 * stockpile) would otherwise be written back for free. A revision's own stage, a creative region and a plain group are not refused.
 */
class GroupsUndoStageGuardTest {
	private static SiteGroupRec group(String region) {
		JsonObject ext = new JsonObject();
		if (region != null) {
			ext.addProperty(RegionItems.EXT_REGION, region);
		}
		return new SiteGroupRec("g1", null, ext, List.of(), List.of(), SiteGroupRec.ACTIVE, false, null, null, 0L);
	}

	@Test
	void survivalRegionStageIsRefused() {
		String no = Groups.undoStageRefusal(group("r1"), "streets", false, id -> id.equals("r1"));
		assertNotNull(no);
		assertTrue(no.contains("survival region r1") && no.contains("for free"), no);
	}

	@Test
	void ownRevisionStageCreativeRegionAndPlainGroupAreNot() {
		assertNull(Groups.undoStageRefusal(group("r1"), "rv1:a", true, id -> true), "a revision's own stage");
		assertNull(Groups.undoStageRefusal(group("r1"), "streets", false, id -> false), "a creative region");
		assertNull(Groups.undoStageRefusal(group(null), "a", false, id -> true), "a group that is no region's");
	}
}
