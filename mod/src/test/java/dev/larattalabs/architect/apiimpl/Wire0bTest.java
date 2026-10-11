package dev.larattalabs.architect.apiimpl;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.larattalabs.architect.api.ArchitectRefused;
import dev.larattalabs.architect.api.BlockSize;
import dev.larattalabs.architect.api.DesignRequest;
import dev.larattalabs.architect.api.Estimate;
import dev.larattalabs.architect.api.EstimateRequest;
import dev.larattalabs.architect.api.Group;
import dev.larattalabs.architect.api.GroupRequest;
import dev.larattalabs.architect.api.Library;
import dev.larattalabs.architect.api.Reason;
import java.util.List;
import org.junit.jupiter.api.Test;

/** Slice 6c 0b (API 1.11.0): the wire of copies, effort, versionOf, derivations and the typed refusals; binary compatibility. */
class Wire0bTest {
	static DesignRequest req() {
		return new DesignRequest("house", "rustic", null, List.of(), new BlockSize(20, 20, 20), null, "x", null, null, new JsonObject(), null, null, null, null);
	}

	@Test
	void enumsAppended() {
		Reason[] r = Reason.values();
		assertEquals(Reason.COPY_REFUSED, r[r.length - 2]);
		assertEquals(Reason.VERSION_REFUSED, r[r.length - 1]);
		assertEquals(Reason.TILE_SLOW, r[r.length - 3]);
		assertEquals(Estimate.Kind.SMALL, Estimate.Kind.values()[4]);
		assertEquals(Estimate.Kind.CHANGE, Estimate.Kind.values()[5]);
		assertEquals(Group.Stage.COPY, Group.Stage.values()[3]);
		assertEquals(Group.Breakdown.Stage.COPY, Group.Breakdown.Stage.values()[7]);
	}

	@Test
	void oldConstructorsKeepTheirMeaning() {
		GroupRequest.Item it = new GroupRequest.Item("a", req(), GroupRequest.Role.ORDINARY, null, false, null);
		assertEquals(1, it.count());
		assertNull(it.copyOf());
		assertEquals(GroupRequest.Item.Effort.AUTO, it.effort());
		GroupRequest g = new GroupRequest("G", "oak", null, null, new JsonObject(), null, null, List.of(it), false, null, null, null, null, null);
		assertEquals(3, g.copyCap());
		assertFalse(g.smallBySize());
		assertNull(req().versionOf());
		assertEquals(0, new EstimateRequest(null, 1, 0, 0, false, false, false, null).smallOriginals());
		assertEquals("", new ArchitectRefused(Reason.OTHER, "x").detail());
		// an older group's wire is unchanged: no copyCap, smallBySize, count, copyOf or effort
		JsonObject w = Wire4b.group(g);
		assertFalse(w.has("copyCap") || w.has("smallBySize"));
		JsonObject i0 = w.getAsJsonArray("items").get(0).getAsJsonObject();
		assertFalse(i0.has("count") || i0.has("copyOf") || i0.has("effort"));
	}

	@Test
	void copiesAndEffortOnTheWire() {
		GroupRequest.Item a = GroupRequest.Item.of("house", req()).count(6).effort(GroupRequest.Item.Effort.SMALL);
		GroupRequest.Item b = GroupRequest.Item.of("b", req()).copyOf("house");
		GroupRequest g = new GroupRequest("G", "oak", null, null, new JsonObject(), null, null, List.of(a, b), false, null, null, null, null, null)
			.withCopyCap(2).withSmallBySize(true);
		JsonObject w = Wire4b.group(g);
		assertEquals(2, w.get("copyCap").getAsInt());
		assertTrue(w.get("smallBySize").getAsBoolean());
		JsonObject wa = w.getAsJsonArray("items").get(0).getAsJsonObject();
		assertEquals(6, wa.get("count").getAsInt());
		assertEquals("small", wa.get("effort").getAsString());
		assertEquals("house", w.getAsJsonArray("items").get(1).getAsJsonObject().get("copyOf").getAsString());
		assertEquals("copies", Wire0b.feature(g));
		assertThrows(IllegalArgumentException.class, () -> Wire4b.group(new GroupRequest("G", "oak", null, null, new JsonObject(), null, null, List.of(a.count(
			25)), false, null, null, null, null, null)));
	}

	@Test
	void groupItemsParse() {
		JsonObject g = JsonParser.parseString("""
			{"id":"g1","name":"G","bible":{"id":"oak","version":1},"concurrency":3,"softBudgetFraction":0.8,"status":"running","done":0,"failed":0,
			 "cost":{"usd":0},"createdAt":1,"updatedAt":2,"items":[
			 {"itemKey":"house","designId":"d1","status":"done","step":"","cost":{"usd":1},"wave":1,"role":"ordinary","model":"m","type":"house","effort":"small"},
			 {"itemKey":"house#2","designId":"","status":"checking","step":"","cost":{"usd":0},"wave":1,"role":"ordinary","model":"m","type":"house",
			  "stage":"copy","kind":"copy","copyOf":"house","variantJob":"v3"},
			 {"itemKey":"b","designId":"d9","status":"queued","step":"","cost":{"usd":0},"wave":1,"role":"ordinary","model":"m","type":"house",
			  "kind":"fallback","copyOf":"house","fallbackReason":"size: too big"}]}""").getAsJsonObject();
		Group gr = Wire4b.group(g);
		Group.Item h = gr.items().get(0);
		assertEquals(Group.Item.Kind.ORIGINAL, h.kind());
		assertEquals(GroupRequest.Item.Effort.SMALL, h.effort());
		Group.Item c = gr.items().get(1);
		assertEquals(Group.Item.Kind.COPY, c.kind());
		assertEquals("", c.designId());
		assertEquals(List.of(), c.designIds());
		assertEquals(Group.Stage.COPY, c.stage().orElseThrow());
		assertEquals("house", c.copyOf().orElseThrow());
		assertEquals("v3", c.variantJob().orElseThrow());
		assertEquals(GroupRequest.Item.Effort.STANDARD, c.effort());
		Group.Item f = gr.items().get(2);
		assertEquals(Group.Item.Kind.FALLBACK, f.kind());
		assertEquals("size: too big", f.fallbackReason().orElseThrow());
	}

	@Test
	void typedRefusals() {
		ArchitectRefused r = Wire0b.refusal(JsonParser.parseString("{\"ok\":false,\"error\":\"cap: too many\",\"code\":\"COPY_REFUSED\",\"detail\":\"cap\"}")
			.getAsJsonObject());
		assertEquals(Reason.COPY_REFUSED, r.reason());
		assertEquals("cap", r.detail());
		ArchitectRefused v = Wire0b.refusal(JsonParser.parseString("{\"ok\":false,\"error\":\"copy: x\",\"code\":\"VERSION_REFUSED\",\"detail\":\"copy\"}")
			.getAsJsonObject());
		assertEquals(Reason.VERSION_REFUSED, v.reason());
		assertEquals("copy", v.detail());
		assertEquals(Reason.UNKNOWN_BLUEPRINT, Wire0b.refusal(JsonParser.parseString("{\"ok\":false,\"code\":\"VERSION_REFUSED\",\"detail\":\"no_entry\"}")
			.getAsJsonObject()).reason());
		assertNull(Wire0b.refusal(JsonParser.parseString("{\"ok\":false,\"error\":\"x\"}").getAsJsonObject()));
	}

	@Test
	void versionOfAndDerivation() {
		JsonObject w = DesignsImpl.wire(req().versionOf("gen_inn", "s3"), 2);
		assertEquals("gen_inn", w.getAsJsonObject("versionOf").get("entryId").getAsString());
		assertEquals("s3", w.getAsJsonObject("versionOf").get("siteId").getAsString());
		assertFalse(DesignsImpl.wire(req(), 2).has("versionOf"));
		JsonObject j = JsonParser.parseString("{\"variantOf\":\"a\",\"variantOfVersion\":2,\"derivation\":{\"source\":\"a\",\"sourceVersion\":2,\"kind\":\"copy\","
			+ "\"recipe\":{\"mirror\":true}}}").getAsJsonObject();
		Library.Derivation d = Wire0b.derivation(j).orElseThrow();
		assertEquals(Library.Derivation.Kind.COPY, d.kind());
		assertEquals(2, d.sourceVersion());
		assertTrue(d.recipe().get("mirror").getAsBoolean());
		assertEquals(2, Wire0b.variantOfVersion(j).getAsInt());
		assertTrue(Wire0b.derivation(new JsonObject()).isEmpty());
	}
}
