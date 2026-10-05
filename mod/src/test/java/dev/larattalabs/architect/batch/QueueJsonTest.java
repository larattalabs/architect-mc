package dev.larattalabs.architect.batch;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.larattalabs.architect.api.Stage;
import dev.larattalabs.architect.placement.Anchors;
import dev.larattalabs.architect.site.Construction;
import dev.larattalabs.architect.site.Site;
import dev.larattalabs.architect.site.SiteGroupRec;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

/** Persistence of the queue and the groups (docs/CONTRACT.md phase 4d: the queue survives relogs and restarts). */
class QueueJsonTest {
	private static JsonObject reparse(JsonObject o) {
		return JsonParser.parseString(o.toString()).getAsJsonObject();
	}

	@Test
	void batchAndItemsRoundTrip() {
		JsonObject ext = new JsonObject();
		ext.addProperty("steward_mc:lot", "L3");
		QItem a = new QItem("lot3", "walls", List.of("lot1", "lot2"), "cabin", "minecraft:overworld", 10, 64, -20, 3, true, ext,
			"0b0e4ed2-1f1d-4f63-9f1a-1e7d3a8f2b11", false, false);
		a.status = QItem.Status.WAITING;
		a.reason = "PLAYER_IN_BOX";
		a.message = "Noah is in the box";
		a.waited = 140;
		a.nextCheck = 999; // not persisted
		QItem b = new QItem("lot4", "roofs", List.of(), "tower", "minecraft:the_nether", 0, 70, 0, 0, false, new JsonObject(), null, true, true);
		b.status = QItem.Status.PLACED;
		b.siteId = "s9";
		JsonObject bext = new JsonObject();
		bext.addProperty("steward_mc:settlement", "set_ab12");
		QBatch q = new QBatch("b4", "steward_mc:settlement/set_ab12", bext, "g2", List.of(a, b), List.of("walls", "roofs"), 12000, 16, false, true, true,
			true, new int[] {1, 2, 3}, 1234L);
		q.cancelling = true;
		q.note = "stopped at lot3";

		QBatch back = QBatch.fromJson(reparse(q.toJson()));
		assertEquals(q.toJson(), back.toJson());
		assertEquals("b4", back.id);
		assertEquals("steward_mc:settlement/set_ab12", back.owner);
		assertEquals(List.of("walls", "roofs"), back.stages);
		assertEquals(16, back.loadChunks);
		assertArrayEquals(new int[] {1, 2, 3}, back.crateAt);
		assertTrue(back.cancelling);
		QItem a2 = back.item("lot3");
		assertEquals(List.of("lot1", "lot2"), a2.after);
		assertEquals(3, a2.turns);
		assertTrue(a2.force);
		assertEquals("L3", a2.ext.get("steward_mc:lot").getAsString());
		assertEquals("0b0e4ed2-1f1d-4f63-9f1a-1e7d3a8f2b11", a2.actor, "the actor is a UUID string, never a player");
		assertFalse(a2.construction);
		assertEquals(QItem.Status.WAITING, a2.status);
		assertEquals("PLAYER_IN_BOX", a2.reason);
		assertEquals(140, a2.waited);
		assertEquals(0, a2.nextCheck, "a waiting item is checked at once after a load");
		QItem b2 = back.item("lot4");
		assertTrue(b2.construction);
		assertTrue(b2.survivalAtQueue);
		assertNull(b2.actor);
		assertEquals("s9", b2.siteId);
		assertEquals("minecraft:the_nether", b2.dimension);
	}

	@Test
	void groupsAndMembershipRoundTripThroughTheSitesFile() {
		Anchors.Bounds box = new Anchors.Bounds(0, 64, 0, 8, 70, 8);
		Site s = new Site("s3", "cabin", "none", box, box, Map.of(), 5L, Site.OVERWORLD, null, "s3-5.nbt", null, null)
			.withMember(new Site.Member("g2", "b4", "lot3")).withPlacing(true);
		SiteGroupRec g = new SiteGroupRec("g2", "steward_mc:s/1", new JsonObject(), List.of("s3"), List.of(
			new SiteGroupRec.StageRec("walls", List.of("lot3"), Stage.State.PLACING, List.of("s3"), "b4"),
			new SiteGroupRec.StageRec("roofs", List.of("lot4"), Stage.State.PLANNED, List.of(), "b4")), SiteGroupRec.ACTIVE, true,
			new Construction.Crate(4, 64, 12, "{Name:\"minecraft:grass_block\",Properties:{snowy:\"false\"}}", null), new int[] {4, 64, 12}, 77L);
		JsonObject file = Site.fileJson(List.of(s), 4, List.of(), List.of(g), 3);
		Site.FileData d = Site.fileFromJson(reparse(file));
		assertEquals(s, d.sites().get(0));
		assertEquals("g2", d.sites().get(0).group());
		assertTrue(d.sites().get(0).placing());
		assertEquals(1, d.groups().size());
		SiteGroupRec g2 = d.groups().get(0);
		assertEquals(g.toJson(), g2.toJson());
		assertEquals(List.of("walls", "roofs"), g2.stageNames());
		assertEquals(Stage.State.PLANNED, g2.stage("roofs").state());
		assertEquals(4, g2.crate().x());
		assertTrue(g2.sharedCrate());
		assertEquals(3, d.nextGroup());
	}

	@Test
	void oldSitesFilesLoadWithoutGroups() {
		JsonObject old = JsonParser.parseString("{\"version\":1,\"next\":3,\"sites\":[]}").getAsJsonObject();
		Site.FileData d = Site.fileFromJson(old);
		assertTrue(d.groups().isEmpty());
		assertEquals(1, d.nextGroup());
		// a file written without groups stays without them
		assertFalse(Site.fileJson(List.of(), 3, List.of()).has("groups"));
		// nextGroup never goes back below a group id in the file
		JsonObject f = Site.fileJson(List.of(), 1, List.of(), List.of(new SiteGroupRec("g7", null, new JsonObject(), List.of(), List.of(),
			SiteGroupRec.REMOVED, false, null, null, 0L)), 2);
		assertEquals(8, Site.fileFromJson(reparse(f)).nextGroup());
	}
}
