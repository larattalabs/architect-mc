package dev.larattalabs.architect.apiimpl;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.larattalabs.architect.api.BlockSize;
import dev.larattalabs.architect.api.CancelOutcome;
import dev.larattalabs.architect.api.Design;
import dev.larattalabs.architect.api.DesignRequest;
import dev.larattalabs.architect.api.GroupRequest;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import org.junit.jupiter.api.Test;

/**
 * Since NEXT (7a K3; docs/CONTRACT.md "Phase 7a slice K3 as built", the design.opKeys row): the wire and refusals of
 * {@link DesignRequest#opKey}, the cancel outcome mapping, and the DONE ordering of {@code Designs.get} / {@code designByKey} /
 * {@code cancelDesign} (simulated: the helper's DONE record arrives before the server has installed the entry).
 */
class DesignKeysK3Test {
	private static final Set<String> K3 = Set.of("design.opKeys");

	static DesignRequest keyed() {
		return ApiStyleU1Test.steward().withOpKey("steward:lot:7");
	}

	static JsonObject raw(String json) {
		return JsonParser.parseString(json).getAsJsonObject();
	}

	@Test
	void wireAndRefusals() {
		assertEquals("steward:lot:7", DesignsImpl.wire(keyed(), 2).get("opKey").getAsString());
		assertFalse(DesignsImpl.wire(ApiStyleU1Test.steward(), 2).has("opKey"), "an unkeyed request is sent exactly as before");
		assertFalse(DesignsImpl.wire(keyed(), 1).has("opKey"), "protocol 1 never carries it");
		assertNull(DesignsImpl.refusalOpKey(keyed(), 2, K3));
		assertNull(DesignsImpl.refusalOpKey(ApiStyleU1Test.steward(), 2, Set.of()));
		assertTrue(DesignsImpl.refusalOpKey(keyed(), 2, Set.of("opKeys")).contains("design.opKeys"), "a helper without it would drop the key");
		assertTrue(DesignsImpl.refusalOpKey(keyed(), 1, K3).contains("design.opKeys"));
		assertTrue(DesignsImpl.refusalOpKey(ApiStyleU1Test.steward().withOpKey("bad key!"), 2, K3).contains("opKey"));
		// a group item never carries a design key
		GroupRequest g = new GroupRequest("Hamlet", "medieval", null, null, new JsonObject(), null, null, List.of(GroupRequest.Item.of("a", keyed())),
			false, null, null, null, null, null);
		assertFalse(Wire4b.group(g).getAsJsonArray("items").get(0).getAsJsonObject().has("opKey"));
	}

	/** A minimal record view (status, step, entry, cost) as the mapping's settle function. */
	static Design design(JsonObject r) {
		return new Design(r.get("id").getAsString(), Design.Status.of(r.get("status").getAsString()), r.has("step") ? r.get("step").getAsString() : "",
			r.has("blueprintId") ? java.util.Optional.of(r.get("blueprintId").getAsString()) : java.util.Optional.empty(), r.has("cost")
				? dev.larattalabs.architect.api.Cost.fromJson(r.getAsJsonObject("cost")) : dev.larattalabs.architect.api.Cost.NONE, java.util.Optional.empty(),
			new JsonObject(), java.util.Optional.empty(), r.has("createdAt") ? r.get("createdAt").getAsLong() : 0, 0, java.util.Optional.empty(),
			java.util.Optional.empty());
	}

	@Test
	void outcomeMapping() {
		CancelOutcome u = DesignsImpl.outcome(raw("{\"designId\":\"d9\",\"outcome\":\"unknown\"}"), DesignKeysK3Test::design);
		assertEquals(CancelOutcome.Kind.UNKNOWN, u.kind());
		assertTrue(u.design().isEmpty());
		CancelOutcome c = DesignsImpl.outcome(raw("{\"designId\":\"d3\",\"outcome\":\"cancelled\",\"design\":{\"id\":\"d3\",\"status\":\"cancelled\","
			+ "\"step\":\"cancelled\",\"cost\":{\"usd\":0.02,\"inputTokens\":1,\"outputTokens\":2,\"cacheReadTokens\":0,\"cacheWriteTokens\":0,"
			+ "\"turns\":1},\"createdAt\":5}}"), DesignKeysK3Test::design);
		assertEquals(CancelOutcome.Kind.CANCELLED, c.kind());
		assertEquals(Design.Status.CANCELLED, c.design().orElseThrow().status());
		assertEquals(0.02, c.design().orElseThrow().cost().usd(), 1e-9);
		CancelOutcome f = DesignsImpl.outcome(raw("{\"designId\":\"d4\",\"outcome\":\"already_final\",\"design\":{\"id\":\"d4\",\"status\":"
			+ "\"failed\",\"createdAt\":1}}"), DesignKeysK3Test::design);
		assertEquals(CancelOutcome.Kind.ALREADY_FINAL, f.kind());
		assertEquals(Design.Status.FAILED, f.design().orElseThrow().status());
		assertThrows(IllegalStateException.class, () -> DesignsImpl.outcome(raw("{\"outcome\":\"cancelled\"}"), DesignKeysK3Test::design),
			"cancelled needs its design");
		assertThrows(IllegalStateException.class, () -> DesignsImpl.outcome(raw("{\"outcome\":\"maybe\"}"), DesignKeysK3Test::design));
	}

	static String status(JsonObject r) {
		return r.get("status").getAsString();
	}

	@Test
	void doneIsReportedOnlyWhenInstalledAndLoaded() {
		DoneOrder order = new DoneOrder();
		JsonObject rendering = raw("{\"id\":\"d7\",\"status\":\"rendering\",\"step\":\"rendering previews\",\"createdAt\":100}");
		JsonObject done = raw("{\"id\":\"d7\",\"status\":\"done\",\"step\":\"done: gen_lot\",\"blueprintId\":\"gen_lot\",\"createdAt\":100}");
		assertEquals("rendering", status(order.read(rendering)));
		// the helper's DONE reached the bridge; the server has not installed it: the last non-final record
		JsonObject early = order.read(done);
		assertEquals("rendering", status(early));
		assertEquals("rendering previews", early.get("step").getAsString());
		assertFalse(early.has("blueprintId"));
		assertFalse(order.installed(done));
		// the install (merge, reload), then DESIGN_DONE: readers see DONE exactly from the event on
		List<String> seen = new ArrayList<>();
		order.finish(done, () -> seen.add("install:" + status(order.read(done))), () -> seen.add("fire:" + status(order.read(done))));
		assertEquals(List.of("install:rendering", "fire:done"), seen);
		assertTrue(order.installed(done));
		assertEquals("gen_lot", order.read(done).get("blueprintId").getAsString());
		// a stale non-final record afterwards is dropped (no event) and changes nothing for readers
		assertFalse(order.pending(rendering));
		assertEquals("done", status(order.read(done)));
		// designs reported in an earlier session (the persisted done set) read as DONE at once
		DoneOrder seeded = new DoneOrder();
		seeded.seed(List.of(DoneOrder.key(done)));
		assertEquals("done", status(seeded.read(done)));
	}

	@Test
	void unseenDoneReadsAsRenderingAndFailedOrCancelledAtOnce() {
		DoneOrder order = new DoneOrder();
		JsonObject p = order.read(raw("{\"id\":\"d8\",\"status\":\"done\",\"step\":\"done\",\"blueprintId\":\"gen_x\",\"size\":{\"x\":1,\"y\":1,"
			+ "\"z\":1},\"createdAt\":1}"));
		assertEquals("rendering", status(p));
		assertEquals("installing the result", p.get("step").getAsString());
		assertFalse(p.has("blueprintId") || p.has("size"));
		assertEquals("failed", status(order.read(raw("{\"id\":\"d9\",\"status\":\"failed\",\"createdAt\":1}"))));
		assertEquals("cancelled", status(order.read(raw("{\"id\":\"d10\",\"status\":\"cancelled\",\"createdAt\":1}"))));
		// a pending record of an earlier design with the same id (another createdAt) is not used
		JsonObject old = raw("{\"id\":\"d11\",\"status\":\"checking\",\"step\":\"old\",\"createdAt\":1}");
		assertEquals("installing the result", DoneOrder.pendingOf(raw("{\"id\":\"d11\",\"status\":\"done\",\"createdAt\":2}"), old).get("step")
			.getAsString());
		assertEquals("old", DoneOrder.pendingOf(raw("{\"id\":\"d11\",\"status\":\"done\",\"createdAt\":1}"), old).get("step").getAsString());
	}
}
