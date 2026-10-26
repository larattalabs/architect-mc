package dev.larattalabs.architect.jobs;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.larattalabs.labui.ui.JobCost;
import dev.larattalabs.labui.ui.JobRow;
import dev.larattalabs.labui.ui.JobState;
import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.Test;

/** (J3) The Jobs panel's row mapping and ledger (pure). */
class JobRowsTest {
	static final long NOW = 1_800_000_000_000L;
	final List<JobRows.Action> ran = new ArrayList<>();
	final JobRows.Actions act = a -> () -> ran.add(a);

	static JsonObject j(String s) {
		return JsonParser.parseString(s).getAsJsonObject();
	}

	JobRows.Feed feed(List<JsonObject> groups, List<JsonObject> bibles, List<JsonObject> designs, List<JsonObject> variants, List<JsonObject> massings,
		List<JsonObject> jobs, long limit) {
		return JobRows.of(new JobRows.Input(groups, bibles, designs, variants, massings, jobs, limit, NOW), act);
	}

	static JobRow row(JobRows.Feed f, String id) {
		return f.rows().stream().filter(r -> r.id().equals(id)).findFirst().orElseThrow(() -> new AssertionError("no row " + id + " in " + f.rows()));
	}

	static JsonObject group(String id, String status, String owner, String approvalUi, String awaiting, double usd) {
		return j("{id:'" + id + "', name:'Ford hamlet', bible:{id:'oak', version:1}, " + (owner == null ? "" : "owner:'" + owner + "', ") + "status:'" + status
			+ "', concurrency:2, massingFirst:true, approvalUi:'" + approvalUi + "', budgetUsd:10, softBudgetFraction:0.8, done:1, failed:0, wave:0, "
			+ "awaiting:" + awaiting + ", items:[{itemKey:'a', designId:'d1', status:'done', step:'', cost:{usd:" + usd / 2 + "}}, {itemKey:'b', designId:"
			+ "'d2', status:'done', step:'', cost:{usd:" + usd / 2 + "}}], cost:{usd:" + usd + "}, createdAt:" + (NOW - 5000) + ", updatedAt:" + (NOW - 1000)
			+ "}");
	}

	@Test
	void setWaitingForThePlayerIsNeedsYouAndApprovesItsItems() {
		JobRows.Feed f = feed(List.of(group("g3", "awaiting_approval", null, "architect", "['b']", 1.2)), List.of(), List.of(), List.of(), List.of(),
			List.of(), 0);
		JobRow r = row(f, "architect_mc:set/g3");
		assertEquals(JobState.NEEDS_YOU, r.state());
		assertTrue(r.waiting());
		assertEquals("set", r.kind());
		assertEquals(1.2, r.spentUsd(), 1e-9);
		assertEquals(10, r.budgetUsd(), 1e-9);
		assertEquals("set", r.budgetKind());
		assertTrue(r.step().contains("1 massing waits for you"), r.step());
		assertNull(r.parentId());
		assertNotNull(r.approve());
		assertNotNull(r.cancel());
		assertNotNull(r.raise());
		r.approve().run().run();
		assertEquals(new JobRows.Action("approve_set", "g3", List.of("b"), 0), ran.get(0));
		r.raise().run().run();
		assertEquals(new JobRows.Action("raise_set", "g3", List.of(), 15), ran.get(ran.size() - 1));
		r.link().run();
		assertEquals(JobRows.Action.of("open_designs", "g3"), ran.get(ran.size() - 1));
	}

	@Test
	void stewardOwnedSetFoldsUnderTheSettlementAndOffersNoActions() {
		JobRows.Feed f = feed(List.of(group("g4", "awaiting_approval", "steward_mc:settlement/7", "owner", "['a']", 2)), List.of(), List.of(), List.of(),
			List.of(), List.of(), 0);
		JobRow r = row(f, "architect_mc:set/g4");
		assertEquals("steward_mc:settlement/7", r.parentId());
		assertFalse(r.waiting(), "the owner's row says it waits, not Architect's");
		assertEquals(JobState.RUNNING, r.state());
		assertNull(r.approve());
		assertNull(r.cancel());
		assertNull(r.raise());
		assertNotNull(r.link());
		assertTrue(r.step().contains("for steward_mc"), r.step());
		JobCost c = f.ledger().get(0);
		assertEquals("g4", c.jobId());
		assertEquals("steward_mc", c.ownerMod());
		assertEquals(2, c.usd(), 1e-9);
	}

	@Test
	void heldSetAndPausedSet() {
		JsonObject h = group("g5", "held_usage", null, "architect", "[]", 0.5);
		h.addProperty("usageLimitUntil", NOW + 3_600_000);
		JobRows.Feed f = feed(List.of(h, group("g6", "paused_budget", null, "architect", "[]", 8.5)), List.of(), List.of(), List.of(), List.of(), List.of(),
			0);
		JobRow held = row(f, "architect_mc:set/g5");
		assertEquals(JobState.HELD, held.state());
		assertEquals(NOW + 3_600_000, held.resetAt());
		JobRow paused = row(f, "architect_mc:set/g6");
		assertEquals(JobState.PAUSED_BUDGET, paused.state());
		assertNotNull(paused.raise());
		assertEquals("Budget → $15", paused.raise().label());
	}

	static JsonObject massingDesign(String id, String status) {
		return j("{id:'" + id + "', status:'" + status + "', step:'massing done', request:{type:'cabin', style:'rustic', name:'Ford cabin', massing:true}, "
			+ "massing:{id:'m1', version:1}, cost:{usd:0.25}, createdAt:" + (NOW - 9000) + ", updatedAt:" + (NOW - 2000) + "}");
	}

	static JsonObject massing(String detail) {
		return j("{id:'m1', version:1, versions:[1], designId:'d7', type:'cabin', parts:{body:{}, roof:{}}, size:{x:9, y:7, z:9}, request:{}, "
			+ (detail == null ? "" : "detail:" + detail + ", ") + "createdAt:" + (NOW - 2000) + "}");
	}

	@Test
	void aMassingReadyWaitsForThePlayerUntilApproved() {
		JobRows.Feed f = feed(List.of(), List.of(), List.of(massingDesign("d7", "done")), List.of(), List.of(massing(null)), List.of(), 0);
		JobRow r = row(f, "architect_mc:design/d7");
		assertEquals("massing", r.kind());
		assertEquals("Ford cabin", r.title());
		assertEquals(JobState.NEEDS_YOU, r.state());
		assertTrue(r.waiting());
		assertNotNull(r.approve());
		assertNull(r.cancel(), "a massing that waits is approved or left, not cancelled");
		r.approve().run().run();
		assertEquals(JobRows.Action.of("approve_massing", "m1"), ran.get(0));
		// approved: the massing records its detail pass
		JobRows.Feed after = feed(List.of(), List.of(), List.of(massingDesign("d7", "done")), List.of(), List.of(massing("{designId:'d8', status:"
			+ "'designing'}")), List.of(), 0);
		JobRow a = row(after, "architect_mc:design/d7");
		assertEquals(JobState.DONE, a.state());
		assertFalse(a.waiting());
		assertNull(a.approve());
		assertTrue(a.step().contains("d8"), a.step());
		// or (before the massing record comes back) a detail design made from it
		JsonObject detail = j("{id:'d9', status:'designing', step:'detail', request:{type:'cabin', fromMassing:'m1', massingVersion:1}, cost:{usd:0.1}, "
			+ "createdAt:" + NOW + "}");
		JobRows.Feed after2 = feed(List.of(), List.of(), List.of(massingDesign("d7", "done"), detail), List.of(), List.of(massing(null)), List.of(), 0);
		assertFalse(row(after2, "architect_mc:design/d7").waiting());
		assertEquals("detail", row(after2, "architect_mc:design/d9").kind());
	}

	@Test
	void designsLinksHeldAndLedger() {
		JsonObject done = j("{id:'d1', status:'done', step:'done', blueprintId:'gen_cabin', request:{type:'cabin', style:'rustic'}, cost:{usd:0.4}, "
			+ "createdAt:" + (NOW - 9000) + ", updatedAt:" + (NOW - 100) + "}");
		JsonObject running = j("{id:'d2', status:'designing', step:'round 1', request:{type:'tower', owner:'steward_mc:settlement/7', budgetUsd:2}, "
			+ "cost:{usd:0.2}, createdAt:" + (NOW - 500) + ", updatedAt:" + (NOW - 50) + "}");
		JsonObject inSet = j("{id:'d3', status:'designing', step:'x', request:{type:'cabin', group:'g1'}, cost:{usd:9}, createdAt:" + NOW + "}");
		JsonObject job = j("{id:'j4', spec:{kind:'structured', owner:'steward_mc:settlement/7'}, status:'done', step:'', cost:{usd:0.05}, createdAt:" + NOW
			+ ", updatedAt:" + NOW + "}");
		JobRows.Feed f = feed(List.of(), List.of(), List.of(done, running, inSet), List.of(), List.of(), List.of(job), NOW + 60_000);
		JobRow d1 = row(f, "architect_mc:design/d1");
		assertEquals(JobState.DONE, d1.state());
		assertEquals("Cabin, rustic", d1.title());
		assertTrue(d1.linkLabel().contains("gen_cabin"));
		d1.link().run();
		assertEquals(JobRows.Action.of("open_entry", "gen_cabin"), ran.get(0));
		assertTrue(d1.endedAt() > 0);
		JobRow d2 = row(f, "architect_mc:design/d2");
		assertEquals(JobState.HELD, d2.state(), "the usage limit holds running work");
		assertEquals(NOW + 60_000, d2.resetAt());
		assertEquals("steward_mc:settlement/7", d2.parentId());
		assertEquals(2, d2.budgetUsd(), 1e-9);
		assertNull(d2.cancel(), "the owner's job is the owner's to cancel");
		assertTrue(f.rows().stream().noneMatch(r -> r.id().endsWith("/d3")), "a set's design shows in its set");
		// ledger: d1, d2 and j4; never the set's design d3
		assertEquals(List.of("d1", "d2", "j4"), f.ledger().stream().map(JobCost::jobId).toList());
		assertEquals(0.65, f.ledger().stream().mapToDouble(JobCost::usd).sum(), 1e-9);
		assertEquals("architect_mc", f.ledger().get(0).withMod("architect_mc").ownerMod());
		assertEquals("steward_mc", f.ledger().get(2).ownerMod());
	}

	@Test
	void bibleAndPartsJobsAndVariants() {
		JsonObject bible = j("{id:'b1', kind:'request', bibleId:'harbour', version:1, status:'components', step:'drafting parts', cost:{usd:0.8}, rounds:0, "
			+ "usageLimitUntil:0, request:{name:'Harbour'}, createdAt:" + NOW + ", updatedAt:" + NOW + "}");
		JsonObject parts = j("{id:'b2', kind:'revise', bibleId:'u3_birch', version:2, status:'done', step:'done', cost:{usd:0.3}, rounds:1, "
			+ "usageLimitUntil:0, request:{parts:true, name:'Birch'}, createdAt:" + NOW + ", updatedAt:" + NOW + "}");
		JsonObject variant = j("{id:'v1', from:'gen_cabin', status:'done', step:'done', blueprintId:'gen_cabin_2', createdAt:" + NOW + ", updatedAt:"
			+ NOW + "}");
		JsonObject imp = j("{id:'v2', path:'/tmp/x/tower.schem', status:'building', step:'reading', createdAt:" + NOW + "}");
		JobRows.Feed f = feed(List.of(), List.of(bible, parts), List.of(), List.of(variant, imp), List.of(), List.of(), 0);
		JobRow b1 = row(f, "architect_mc:bible/b1");
		assertEquals("bible", b1.kind());
		assertEquals(JobState.RUNNING, b1.state());
		assertEquals("Bible Harbour v1", b1.title());
		assertNotNull(b1.cancel());
		JobRow b2 = row(f, "architect_mc:bible/b2");
		assertEquals("parts", b2.kind());
		assertEquals(JobState.DONE, b2.state());
		JobRow v1 = row(f, "architect_mc:variant/v1");
		assertEquals("variant", v1.kind());
		assertEquals(0, v1.spentUsd(), 1e-9);
		v1.link().run();
		assertEquals(JobRows.Action.of("open_entry", "gen_cabin_2"), ran.get(ran.size() - 1));
		JobRow v2 = row(f, "architect_mc:variant/v2");
		assertEquals("import", v2.kind());
		assertEquals("Import of tower.schem", v2.title());
		assertEquals(JobState.RUNNING, v2.state());
		assertEquals(List.of("b1", "b2"), f.ledger().stream().map(JobCost::jobId).toList(), "variants cost nothing");
	}

	@Test
	void ownerRule() {
		assertEquals("steward_mc:settlement/7", JobRows.foreignOwner("steward_mc:settlement/7"));
		assertNull(JobRows.foreignOwner("architect_mc:player"));
		assertNull(JobRows.foreignOwner(null));
		assertNull(JobRows.foreignOwner("plain"));
		assertEquals(15, JobRows.raiseTo(10, 9.5), 1e-9);
		assertEquals(12, JobRows.raiseTo(5, 11), 1e-9);
	}
}
