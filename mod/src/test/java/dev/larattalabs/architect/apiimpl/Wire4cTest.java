package dev.larattalabs.architect.apiimpl;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.google.gson.JsonPrimitive;
import dev.larattalabs.architect.api.BlockSize;
import dev.larattalabs.architect.api.Design;
import dev.larattalabs.architect.api.DesignRequest;
import dev.larattalabs.architect.api.Group;
import dev.larattalabs.architect.api.GroupRequest;
import dev.larattalabs.architect.api.Massing;
import dev.larattalabs.architect.api.MassingRef;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.junit.jupiter.api.Test;

/** Phase 4c wire forms and views (sidecar/README.md "Phase 4c", the exact shapes), the event dedupe keys and the request rules. */
class Wire4cTest {
	private static JsonObject json(String s) {
		return JsonParser.parseString(s).getAsJsonObject();
	}

	static final String MASSING = """
		{"id":"mas_tavern","version":2,"versions":[1,2],"designId":"d12","type":"tavern","name":"Tavern","itemKey":"lot/c",
		 "ext":{"steward_mc:lot":"C"},"owner":"steward_mc:set/1","group":"g4","bible":{"id":"oak","version":1},
		 "parts":{"hall":{"box":[0,0,0,12,7,9],"cells":420},"tower":{"box":[13,0,0,17,14,4],"cells":180},"bad":{"box":[1,2]}},
		 "size":{"x":18,"y":15,"z":10},"request":{"type":"tavern","style":"rustic","features":[],"maxSize":{"x":21,"y":20,"z":21},"massing":true,
		 "model":"claude-sonnet-5-5"},"cost":{"usd":0.12,"inputTokens":1,"outputTokens":2,"cacheReadTokens":3,"cacheWriteTokens":4,"turns":6},
		 "dir":"/g/architect/massings/mas_tavern/versions/2","nbt":"/g/architect/massings/mas_tavern/versions/2/mas_tavern.nbt",
		 "previews":["/g/architect/massings/mas_tavern/versions/2/iso.png"],"redirect":{"fromVersion":1,"notes":"L-shaped with a tower"},
		 "detail":{"designId":"d15","status":"done","entryId":"gen_tavern","at":99},"createdAt":1234}""";

	@Test
	void massing() {
		Massing m = Wire4c.massing(json(MASSING));
		assertEquals(new MassingRef("mas_tavern", 2), m.ref());
		assertEquals(List.of(1, 2), m.versions());
		assertTrue(m.latest());
		assertEquals("d12", m.designId());
		assertEquals("lot/c", m.itemKey().orElseThrow());
		assertEquals("C", m.ext().get("steward_mc:lot").getAsString());
		assertEquals("steward_mc:set/1", m.owner().orElseThrow());
		assertEquals("g4", m.group().orElseThrow());
		assertEquals("oak", m.bible().orElseThrow().id());
		assertEquals(Set.of("hall", "tower"), m.parts().keySet(), "an invalid part is skipped");
		assertEquals(14, m.parts().get("tower").box().maxY());
		assertEquals(new BlockSize(18, 15, 10), m.size());
		assertTrue(m.request().get("massing").getAsBoolean());
		assertEquals(0.12, m.cost().usd());
		assertEquals(Path.of("/g/architect/massings/mas_tavern/versions/2/mas_tavern.nbt"), m.nbt());
		assertEquals(1, m.previews().size());
		assertEquals(1, m.redirect().orElseThrow().fromVersion());
		assertEquals(Design.Status.DONE, m.detail().orElseThrow().status());
		assertEquals("gen_tavern", m.detail().orElseThrow().entryId().orElseThrow());
		assertEquals(1234, m.createdAt());
	}

	@Test
	void massingKeys() {
		JsonObject m = json(MASSING);
		assertEquals("mas_tavern@2", Wire4c.versionKey(m));
		assertEquals("mas_tavern@2@1234", Wire4c.doneKey(m));
		// a minimal record (an older version without the optional fields)
		Massing v1 = Wire4c.massing(json("{\"id\":\"mas_x\",\"version\":1,\"versions\":[1,2],\"designId\":\"d1\",\"type\":\"cabin\",\"parts\":{},"
			+ "\"size\":{\"x\":9,\"y\":7,\"z\":9},\"request\":{},\"cost\":{\"usd\":0},\"dir\":\"/d\",\"nbt\":\"/d/mas_x.nbt\",\"previews\":[],\"createdAt\":5}"));
		assertFalse(v1.latest());
		assertTrue(v1.redirect().isEmpty() && v1.detail().isEmpty() && v1.group().isEmpty() && v1.itemKey().isEmpty());
	}

	@Test
	void designMassingAndConformance() {
		JsonObject d = json("""
			{"id":"d12","status":"done","step":"done","request":{"type":"tavern","style":"r","features":[],"maxSize":{"x":9,"y":9,"z":9},
			 "massing":true},"massing":{"id":"mas_tavern","version":1},"createdAt":1,"updatedAt":2}""");
		assertEquals(new MassingRef("mas_tavern", 1), Wire4c.designMassing(d).orElseThrow());
		var c = Wire4c.conformance(json("{\"ok\":false,\"errors\":[\"part hall missing\"],\"issues\":[\"size +3 on x\",\"roof form\"]}")).orElseThrow();
		assertFalse(c.ok());
		assertEquals(3, c.warnings());
		assertTrue(Wire4c.conformance(null).isEmpty());
		Design detail = new Design("d15", Design.Status.DONE, "", java.util.Optional.of("gen_tavern"), dev.larattalabs.architect.api.Cost.NONE,
			java.util.Optional.empty(), json("{\"fromMassing\":\"mas_tavern\",\"massingVersion\":2}"), java.util.Optional.empty(), 0, 0);
		assertEquals(new MassingRef("mas_tavern", 2), detail.fromMassing().orElseThrow());
		assertFalse(detail.isMassing());
	}

	static final String GROUP4C = """
		{"id":"g4","name":"Hamlet","bible":{"id":"oak","version":1},"owner":"steward_mc:set/1","concurrency":3,"softBudgetFraction":0.8,
		 "status":"awaiting_approval","massingFirst":true,"approvalUi":"owner","maxRedirects":2,"context":{"site":"river bend"},
		 "awaiting":["a","c"],
		 "items":[{"itemKey":"a","designId":"d1","status":"done","step":"massing done","cost":{"usd":0.1},"wave":0,"role":"landmark",
		           "model":"m","type":"tower","stage":"approval","massing":{"id":"mas_tower","version":1},"rounds":0,"designIds":["d1"]},
		          {"itemKey":"b","designId":"d7","status":"designing","step":"x","cost":{"usd":0.5},"wave":1,"role":"ordinary","model":"m",
		           "type":"house","stage":"detail","massing":{"id":"mas_house","version":1},"rounds":0,"designIds":["d2","d7"]},
		          {"itemKey":"c","designId":"d8","status":"done","step":"","cost":{"usd":0.2},"wave":1,"role":"ordinary","model":"m",
		           "type":"tavern","stage":"approval","massing":{"id":"mas_tavern","version":2},"rounds":1,"designIds":["d3","d8"]}],
		 "designs":[],"done":0,"failed":0,"cost":{"usd":0.8},"createdAt":10,"updatedAt":20}""";

	@Test
	void groupWith4cFields() {
		Group g = Wire4b.group(json(GROUP4C));
		assertEquals(Group.Status.AWAITING_APPROVAL, g.status());
		assertFalse(g.finished());
		assertTrue(g.massingFirst());
		assertEquals(GroupRequest.ApprovalUi.OWNER, g.approvalUi());
		assertEquals(2, g.maxRedirects());
		assertEquals("river bend", g.context().orElseThrow().getAsJsonObject().get("site").getAsString());
		assertEquals(List.of("a", "c"), g.awaiting());
		Group.Item a = g.item("a").orElseThrow();
		assertEquals(Group.Stage.APPROVAL, a.stage().orElseThrow());
		assertTrue(a.awaitingApproval());
		assertFalse(a.detailed(), "a massing waiting for approval is not a done building");
		Group.Item c = g.item("c").orElseThrow();
		assertEquals(1, c.rounds());
		assertEquals(List.of("d3", "d8"), c.designIds());
		assertEquals(new MassingRef("mas_tavern", 2), c.massing().orElseThrow());
		assertEquals(List.of("a=mas_tower@1", "c=mas_tavern@2"), Wire4c.awaitingTokens(g));
		// a 4b group: no stage, approval ui architect, its designId as the only design
		Group old = Wire4b.group(json(Wire4bTest.GROUP));
		assertFalse(old.massingFirst());
		assertEquals(GroupRequest.ApprovalUi.ARCHITECT, old.approvalUi());
		assertTrue(old.items().get(0).stage().isEmpty());
		assertTrue(old.items().get(0).detailed());
		assertEquals(List.of("d7"), old.items().get(0).designIds());
		assertEquals(List.of(), Wire4c.awaitingTokens(old));
	}

	@Test
	void approvalAndRedirect() {
		Group.Approval a = Wire4c.approval(json("{\"groupId\":\"g4\",\"approved\":{\"a\":\"d20\",\"b\":\"d21\"},\"redirected\":{\"c\":{\"designId\":\"d22\","
			+ "\"version\":3}},\"cancelled\":[\"z\"]}"));
		assertEquals(Map.of("a", "d20", "b", "d21"), a.approved());
		assertEquals(new Group.Redirected("d22", 3), a.redirected().get("c"));
		assertEquals(List.of("z"), a.cancelled());
		JsonObject m = Wire4c.approveMessage("g4", List.of("a"), Map.of("c", "taller"), List.of(), "steward_mc:set/1");
		assertEquals("group.approve", m.get("type").getAsString());
		assertEquals("taller", m.getAsJsonObject("redirect").get("c").getAsString());
		assertFalse(m.has("cancel"), "empty lists are left out");
		assertEquals("steward_mc:set/1", m.get("owner").getAsString());
		assertFalse(Wire4c.approveMessage("g4", List.of("a"), Map.of(), List.of(), null).has("owner"), "no owner: none is sent (the sidecar enforces)");
	}

	@Test
	void awaitingLedger() {
		AwaitingLedger l = new AwaitingLedger();
		String g = "g4@10";
		assertTrue(l.fire(g, List.of("a=mas_a@1", "b=mas_b@1", "c=mas_c@1")), "the change to awaiting_approval");
		assertFalse(l.fire(g, List.of("a=mas_a@1", "b=mas_b@1", "c=mas_c@1")), "a reconnect's snapshot");
		assertFalse(l.fire(g, List.of("c=mas_c@1")), "a partial approval (a and b approved)");
		assertFalse(l.fire(g, List.of()), "not awaiting");
		assertTrue(l.fire(g, List.of("c=mas_c@2")), "the redirect finished: a new version waits");
		assertTrue(l.fire("g4@11", List.of("a=mas_a@1")), "another group (a wiped sidecar reuses the id)");
		AwaitingLedger restarted = new AwaitingLedger();
		restarted.restore(l.keys());
		assertFalse(restarted.pending(g, List.of("c=mas_c@2")), "a game restart");
		assertFalse(restarted.fire(g, List.of("c=mas_c@2")));
	}

	private static DesignRequest req() {
		return new DesignRequest("tavern", "rustic", null, List.of(), new BlockSize(21, 20, 21), null, null, null, null, null, null, null, null, null);
	}

	@Test
	void designRequestWire() {
		DesignRequest m = req().massing(true).withContext("on a river bend, street to the south");
		assertTrue(m.massing());
		JsonObject w = DesignsImpl.wire(m, 2);
		assertTrue(w.get("massing").getAsBoolean());
		assertEquals("on a river bend, street to the south", w.get("context").getAsString());
		assertFalse(DesignsImpl.wire(req(), 2).has("massing"), "false is left out (a 4b helper sees the 4b shape)");
		assertFalse(DesignsImpl.wire(m, 1).has("massing"), "protocol 1 never");
		DesignRequest d = req().fromMassing("mas_tavern", 2);
		JsonObject dw = DesignsImpl.wire(d, 2);
		assertEquals("mas_tavern", dw.get("fromMassing").getAsString());
		assertEquals(2, dw.get("massingVersion").getAsInt());
		assertFalse(dw.has("massing"));
		assertFalse(req().fromMassing("mas_tavern").massing(true).fromMassing() != null, "massing(true) clears fromMassing");
		// the old constructors keep working and set no 4c field
		DesignRequest old = new DesignRequest("cabin", "r", null, List.of(), new BlockSize(9, 9, 9), null, null, null, null, null, null, null, null, null,
			List.of(), null);
		assertFalse(old.massing());
		assertNull(old.context());
		// withProfile and withBible keep the 4c fields
		assertTrue(m.withBible("oak", null).withProfile(List.of("door")).massing());
	}

	@Test
	void designRequestRefusals() {
		Set<String> f4c = Set.of("job.run", "design.groups", "massing");
		Set<String> f4b = Set.of("job.run", "design.groups");
		assertNull(DesignsImpl.refusal4c(req(), 2, f4b), "an ordinary request needs nothing new");
		assertNotNull(DesignsImpl.refusal4c(req().massing(true), 2, f4b), "a 4b helper has no massings");
		assertNotNull(DesignsImpl.refusal4c(req().massing(true), 1, f4c), "protocol 1 has no massings");
		assertNull(DesignsImpl.refusal4c(req().massing(true), 2, f4c));
		assertNull(DesignsImpl.refusal4c(req().fromMassing("mas_x"), 2, f4c));
		assertNotNull(DesignsImpl.refusal4c(req().fromMassing("Not An Id"), 2, f4c));
		DesignRequest both = new DesignRequest("tavern", "r", null, List.of(), new BlockSize(9, 9, 9), null, null, null, null, null, null, null, null, null,
			List.of(), null, true, "mas_x", null, null);
		assertNotNull(DesignsImpl.refusal4c(both, 2, f4c));
		DesignRequest versionOnly = new DesignRequest("tavern", "r", null, List.of(), new BlockSize(9, 9, 9), null, null, null, null, null, null, null,
			null, null, List.of(), null, false, null, 3, null);
		assertNotNull(DesignsImpl.refusal4c(versionOnly, 2, f4c));
		assertNotNull(DesignsImpl.refusal4c(req().withContext(new JsonPrimitive("x".repeat(4001))), 2, f4c));
		assertNull(DesignsImpl.refusal4c(req().withContext(new JsonPrimitive("x".repeat(4000))), 2, f4c));
		JsonObject big = new JsonObject();
		big.addProperty("k", "y".repeat(4000));
		assertNotNull(DesignsImpl.refusal4c(req().withContext(big), 2, f4c), "JSON over 4000 as text");
		assertNotNull(Wire4c.contextProblem(new com.google.gson.JsonArray()), "an array is neither text nor an object");
		assertNull(req().withContext("  ").context(), "blank text = none");
	}

	@Test
	void groupRequestWire() {
		GroupRequest g = new GroupRequest("Hamlet", "oak", null, "steward_mc:set/1", null, 3, 5.0, List.of(GroupRequest.Item.of("a", req().massing(true)
			.fromMassing(null, null)))).withMassingFirst(GroupRequest.ApprovalUi.OWNER, 2).withContext("river bend");
		JsonObject w = Wire4b.group(g);
		assertTrue(w.get("massingFirst").getAsBoolean());
		assertEquals("owner", w.get("approvalUi").getAsString());
		assertEquals(2, w.get("maxRedirects").getAsInt());
		assertEquals("river bend", w.get("context").getAsString());
		JsonObject item = w.getAsJsonArray("items").get(0).getAsJsonObject();
		assertFalse(item.has("massing"), "the group's massingFirst decides; an item never carries massing");
		// the 1.2.0 constructor: no 4c field on the wire
		JsonObject w2 = Wire4b.group(new GroupRequest("H", "oak", null, null, null, null, null, List.of(GroupRequest.Item.of("a", req()))));
		assertFalse(w2.has("massingFirst") || w2.has("approvalUi") || w2.has("context") || w2.has("maxRedirects"));
		// rules
		assertThrows(IllegalArgumentException.class, () -> Wire4b.group(new GroupRequest("H", "oak", null, null, null, null, null, List.of(
			GroupRequest.Item.of("a", req()))).withMassingFirst(GroupRequest.ApprovalUi.OWNER, null)), "owner approval needs an owner");
		assertThrows(IllegalArgumentException.class, () -> Wire4b.group(g.withMassingFirst(null, 11)));
		assertThrows(IllegalArgumentException.class, () -> Wire4b.group(g.withContext("z".repeat(4001))));
	}
}
