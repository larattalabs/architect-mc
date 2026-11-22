package dev.larattalabs.architect.site;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonParser;
import dev.larattalabs.architect.batch.QItem;
import java.util.List;
import java.util.Set;
import org.junit.jupiter.api.Test;

/**
 * (slice PLR, Steward's report on 0.89.0) An unclean halt during a survival region's forms stage left terrain site c46 saved placing (P4: the
 * sites file is written at once) while the queue file, saved off the server thread, still held its job from before the record, or no job.
 * The load queued the tile again (placed as c49) and nothing ever settled c46: it stayed placing and "building" for good, and the fluids
 * stage waited on it forever (RegionTargets.building / firstBuilding). The records here are the evidence world's (Steward E2E
 * mwr1oad6_147my8c1), trimmed to what the decisions read.
 */
class StrayPlacingPLRTest {
	static Infra rec(String id, boolean placing, String itemKey) {
		return Infra.fromJson(JsonParser.parseString("{\"id\":\"" + id + "\",\"kind\":\"cells:architect:terrain\",\"owner\":\"steward_mc:settlement/set_4\","
			+ "\"ext\":{\"architect_mc:tile\":\"forms|terrain|56,1547\",\"architect_mc:region\":\"rg3\",\"architect_mc:part\":\"river\"},"
			+ "\"dimension\":\"minecraft:overworld\",\"box\":{\"minX\":3588,\"minY\":61,\"minZ\":99008,\"maxX\":3595,\"maxY\":64,\"maxZ\":99071},"
			+ "\"placedAt\":1795304402346,\"member\":{\"group\":\"g3\",\"batchId\":\"b3\",\"itemKey\":\"" + itemKey + "\"},\"placing\":" + placing + "}")
			.getAsJsonObject());
	}

	@Test
	void aRecordSavedPlacingOutransItsJobsBeforeRecordFlagAfterAnUncleanStop() {
		Infra c46 = rec("c46", true, "t:forms:terrain:56,1547");
		assertTrue(Placement.recordOutranQueue(true, false, c46), "the job says before its record, the record on disk is placing: the record wins");
		assertFalse(Placement.recordOutranQueue(true, true, c46), "a clean stop's queue file is current");
		assertFalse(Placement.recordOutranQueue(false, false, c46), "a job already past its record resumes as before");
		assertFalse(Placement.recordOutranQueue(true, false, null), "no record on disk: K2, the item queues again as before");
		assertFalse(Placement.recordOutranQueue(true, false, c46.withPlacing(false)), "a placed record is not a placement in flight");
	}

	@Test
	void aPlacingRecordNoJobCoversIsStrayAndAJobsExtrasAreCovered() {
		List<Infra> records = List.of(rec("c45", false, "t:forms:terrain:55,1546"), rec("c46", true, "t:forms:terrain:56,1547"),
			rec("c47", true, "t:forms:terrain:54,1546"), rec("c48", true, "t:forms:terrain:54,1546"), rec("c49", false, "t:forms:terrain:56,1547"));
		// c47's job resumed; c48 is that job's extra target (InfraJob.siteIds)
		assertEquals(List.of("c46"), Placement.strayPlacing(records, Set.of("c47", "c48")));
		assertEquals(List.of("c46", "c47", "c48"), Placement.strayPlacing(records, Set.of()));
	}

	@Test
	void theStrayRollbackLeavesAnItemPlacedAgainAsAnotherSiteAlone() {
		// the evidence: t:forms:terrain:56,1547 is PLACED as c49; c46's rollback must not queue it a third time
		assertFalse(Placement.rollbackOwnsItem(QItem.Status.PLACED, "c49", "c46"), "placed again as c49: left as it is");
		assertFalse(Placement.rollbackOwnsItem(QItem.Status.PLACING, "c49", "c46"), "placing again as c49: its job and chunk ticket stay");
		assertFalse(Placement.rollbackOwnsItem(QItem.Status.FAILED, null, "c46"), "a failed item is done");
		assertTrue(Placement.rollbackOwnsItem(QItem.Status.PLACING, "c46", "c46"), "its own placing item queues again (the crash rollback)");
		assertTrue(Placement.rollbackOwnsItem(QItem.Status.QUEUED, null, "c46"), "an item already queued again stays queued");
	}
}
