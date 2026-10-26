package dev.larattalabs.architect.region;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertNull;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import org.junit.jupiter.api.Test;

/**
 * (6d RV-b, docs/CONTRACT.md "Phase 6d slice RV" §2.1, §2.3, §4.1) The revision's names, its record and the effective IR: the mod's merge
 * equals the kit's mergeEffective on the parity fixture (kit/test/fixtures/rv/merge.json, written by make-merge.mjs: a base IR, two revision
 * IRs, the kit's effective IR after each).
 */
class RevisionsTest {
	static final Path FIXTURE = Path.of("../kit/test/fixtures/rv/merge.json");

	@Test
	void stageNames() {
		assertEquals(0, Revisions.layerOf("ground"));
		assertEquals(0, Revisions.layerOf(null));
		assertEquals(3, Revisions.layerOf("rv3:ground"));
		assertEquals(9999, Revisions.layerOf("rv9999:fluids"));
		assertEquals("ground", Revisions.plainStage("rv12:ground"));
		assertEquals("ground", Revisions.plainStage("ground"));
		assertEquals("rv7:props", Revisions.stageName(7, "props"));
		assertEquals(0, Revisions.layerOf("rvx:ground"));
	}

	@Test
	void recordRoundTrip() {
		Revisions.Rev r = new Revisions.Rev();
		r.rid = 4;
		r.position = 2;
		r.parentRid = 1;
		r.planId = "p1";
		r.irSha = "ab";
		r.state = "PARTIAL";
		r.stages = List.of("rv4:ground");
		r.lotsAdded = List.of("rv4_shed");
		r.sites = List.of("c7", "s3");
		r.waiting = "why";
		r.batchId = "b9";
		r.regionStateBefore = "PARTIAL";
		Revisions.Rev b = Revisions.Rev.fromJson(r.toJson());
		assertEquals(r.toJson(), b.toJson());
		assertEquals(List.of("c7", "s3"), b.view().sites());
		assertEquals(4, b.view().rid());
		assertNull(Revisions.Rev.fromJson(new Revisions.Rev().toJson()).artifact);
	}

	@Test
	void regionRecordKeepsRevisionsOnlyOnceRevised() {
		RegionRec rec = new RegionRec("rg1", "p", "s", null, new JsonObject(), "minecraft:overworld", new int[] {0, -64, 0, 10, 319, 10}, 1L);
		assertEquals(false, rec.toJson().has("revisions"), "an unrevised region's record is unchanged");
		rec.nextRid = 2;
		rec.headRid = 2;
		rec.position = 1;
		rec.busy = "revising 2";
		Revisions.Rev r = new Revisions.Rev();
		r.rid = 2;
		rec.revisions.add(r);
		RegionRec back = RegionRec.fromJson(rec.toJson());
		assertEquals(rec.toJson(), back.toJson());
		assertEquals("revising 2", back.busy);
	}

	@Test
	void mergeEqualsTheKits() throws Exception {
		JsonObject f = JsonParser.parseString(Files.readString(FIXTURE)).getAsJsonObject();
		JsonObject e = f.getAsJsonObject("base");
		for (JsonElement x : f.getAsJsonArray("revisions")) {
			JsonObject r = x.getAsJsonObject();
			e = Revisions.merge(e, r.getAsJsonObject("ir"), r.get("rid").getAsInt(), r.get("position").getAsInt(), r.get("irSha").getAsString());
			assertEquals(r.getAsJsonObject("effective"), e, "the effective IR after revision " + r.get("rid"));
		}
		assertNotEquals(f.getAsJsonObject("base"), e);
	}

	@Test
	void historyHashIsTheKits() {
		// the kit's historySha([]) and of one row (kit/lib/region/revise.mjs): sha256 of the canonical JSON of the rows
		assertEquals(Revisions.sha256("[]"), Revisions.sha256(new com.google.gson.JsonArray().toString()));
		com.google.gson.JsonArray rows = new com.google.gson.JsonArray();
		com.google.gson.JsonArray row = new com.google.gson.JsonArray();
		row.add(0);
		row.add("ground");
		row.add("terrain");
		row.add("aa");
		row.add("committed");
		rows.add(row);
		assertEquals("[[0,\"ground\",\"terrain\",\"aa\",\"committed\"]]", rows.toString());
	}
}
