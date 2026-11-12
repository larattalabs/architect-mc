package dev.larattalabs.architect.apiimpl;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.larattalabs.architect.api.ArchitectRefused;
import dev.larattalabs.architect.api.BlockSize;
import dev.larattalabs.architect.api.DesignRequest;
import dev.larattalabs.architect.api.Estimate;
import dev.larattalabs.architect.api.FitMode;
import dev.larattalabs.architect.api.Limits;
import dev.larattalabs.architect.api.Reason;
import dev.larattalabs.architect.api.SiteFrame;
import dev.larattalabs.architect.api.SitePort;
import dev.larattalabs.architect.api.SiteSpec;
import java.util.List;
import java.util.Map;
import java.util.Set;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.world.level.block.Rotation;
import net.minecraft.world.level.levelgen.structure.BoundingBox;
import org.junit.jupiter.api.Test;

/**
 * (7b DS) Site-aware design on the mod side: {@code DesignRequest.site} on the wire (only when set), the sites a message carries
 * (a design, a group's items, a site variant), the {@code site.variant} message's checks, its outcome as the API answers it (the new
 * entry id, or {@code SITE_UNFIT}/{@code SITE_UNSUPPORTED} with the helper's detail), the feature name, {@code Estimate.Kind.SITE}
 * appended, and the Limits constants equal to the spec's caps.
 */
class ApiDSTest {
	static SiteSpec site() {
		return new SiteSpec("a".repeat(64), "local:" + "a".repeat(64), new BoundingBox(-951, 112, -2497, -920, 149, -2470), FitMode.ATTACH_TO_CLIFF,
			new SiteFrame(new BlockPos(-943, 120, -2489), Rotation.NONE), List.of(), List.of(new SitePort("walk_top", SitePort.WALK, new BlockPos(7, 19, 1),
				Direction.NORTH, 2, 2, null)), "lot_cliff_face");
	}

	static DesignRequest plain() {
		return new DesignRequest("cabin", "rustic", null, List.of(), new BlockSize(20, 24, 20), null, null, null, null, null, null, null, null, null,
			List.of(), null, false, null, null, null, null, null, null, null, null, null);
	}

	@Test
	void siteGoesOnTheWireOnlyWhenSet() {
		assertFalse(DesignsImpl.wire(plain(), 2).has("site"), "a plain request is sent as before");
		JsonObject w = DesignsImpl.wire(plain().withSite(site()), 2);
		assertEquals(site().wire(), w.getAsJsonObject("site"));
		assertEquals(site(), SiteSpec.fromWire(w.getAsJsonObject("site")));
	}

	@Test
	void sitesInEveryMessageShape() {
		JsonObject d = DesignsImpl.msg("design.request");
		d.add("request", DesignsImpl.wire(plain().withSite(site()), 2));
		assertEquals(1, SiteDesigns.sitesIn(d).size());
		JsonObject p = DesignsImpl.msg("design.request");
		p.add("request", DesignsImpl.wire(plain(), 2));
		assertFalse(SiteDesigns.hasSite(p));
		JsonObject g = DesignsImpl.msg("design.group");
		JsonObject group = new JsonObject();
		JsonArray items = new JsonArray();
		items.add(DesignsImpl.wire(plain(), 2));
		items.add(DesignsImpl.wire(plain().withSite(site()), 2));
		items.add(DesignsImpl.wire(plain().withSite(site()), 2));
		group.add("items", items);
		g.add("group", group);
		assertEquals(2, SiteDesigns.sitesIn(g).size());
		JsonObject v = SiteDesigns.message("gen_cliff_house", site(), "lot-7", "steward:test");
		assertEquals(1, SiteDesigns.sitesIn(v).size());
		// the blob is resolved in place: the message's site object is the one sitesIn returns
		SiteDesigns.sitesIn(v).get(0).addProperty("volumeBlobId", "b123");
		assertEquals("b123", v.getAsJsonObject("site").get("volumeBlobId").getAsString());
	}

	@Test
	void theSiteVariantMessage() {
		JsonObject m = SiteDesigns.message("gen_cliff_house", site(), "lot-7", null);
		assertEquals("site.variant", m.get("type").getAsString());
		assertEquals("gen_cliff_house", m.get("entryId").getAsString());
		assertEquals("lot-7", m.get("opKey").getAsString());
		assertFalse(m.has("owner"));
		assertEquals("steward:x", SiteDesigns.message("gen_cliff_house", site(), "k", "steward:x").get("owner").getAsString());
		assertThrows(IllegalArgumentException.class, () -> SiteDesigns.message("Bad Id", site(), "k", null));
		assertThrows(IllegalArgumentException.class, () -> SiteDesigns.message("gen_a", null, "k", null));
		assertThrows(IllegalArgumentException.class, () -> SiteDesigns.message("gen_a", site(), null, null));
		assertThrows(IllegalArgumentException.class, () -> SiteDesigns.message("gen_a", site(), "bad key!", null));
		// a spec whose frame is off its lot box is refused before anything is sent
		SiteSpec off = new SiteSpec(site().volumeSha(), site().volumeBlobId(), site().volume(), site().fit(), new SiteFrame(new BlockPos(0, 0, 0),
			Rotation.NONE), List.of(), site().ports(), null);
		if (!off.problems().isEmpty()) {
			assertThrows(IllegalArgumentException.class, () -> SiteDesigns.message("gen_a", off, "k", null));
		}
	}

	@Test
	void theOutcomeAsTheApiAnswersIt() {
		assertEquals("gen_cliff_house_site_lot_east", SiteDesigns.outcome(JsonParser.parseString(
			"{\"id\":\"sv1\",\"kind\":\"siteVariant\",\"status\":\"done\",\"entryId\":\"gen_cliff_house\",\"newEntryId\":\"gen_cliff_house_site_lot_east\"}")
			.getAsJsonObject()));
		ArchitectRefused unfit = assertThrows(ArchitectRefused.class, () -> SiteDesigns.outcome(JsonParser.parseString(
			"{\"id\":\"sv2\",\"status\":\"done\",\"refused\":{\"code\":\"SITE_UNFIT\",\"detail\":\"site_keep\",\"message\":\"the template writes a player's block\"}}")
			.getAsJsonObject()));
		assertEquals(Reason.SITE_UNFIT, unfit.reason());
		assertEquals("site_keep", unfit.detail());
		ArchitectRefused unsupported = assertThrows(ArchitectRefused.class, () -> SiteDesigns.outcome(JsonParser.parseString(
			"{\"id\":\"sv3\",\"status\":\"done\",\"refused\":{\"code\":\"SITE_UNSUPPORTED\",\"detail\":\"not_site_aware\",\"message\":\"no fit\"}}")
			.getAsJsonObject()));
		assertEquals(Reason.SITE_UNSUPPORTED, unsupported.reason());
		assertEquals("not_site_aware", unsupported.detail());
		ArchitectRefused odd = assertThrows(ArchitectRefused.class, () -> SiteDesigns.outcome(JsonParser.parseString(
			"{\"id\":\"sv4\",\"status\":\"done\",\"refused\":{\"code\":\"NOT_A_REASON\",\"detail\":\"x\",\"message\":\"m\"}}").getAsJsonObject()));
		assertEquals(Reason.OTHER, odd.reason());
		assertThrows(IllegalStateException.class, () -> SiteDesigns.outcome(JsonParser.parseString("{\"id\":\"sv5\",\"status\":\"done\"}")
			.getAsJsonObject()));
		// a synchronous refusal (the ack's code and detail) maps through Wire0b as every typed refusal does
		ArchitectRefused sync = Wire0b.refusal(JsonParser.parseString("{\"ok\":false,\"code\":\"SITE_UNSUPPORTED\",\"detail\":\"no_program\",\"error\":"
			+ "\"no_program: imported\"}").getAsJsonObject());
		assertEquals(Reason.SITE_UNSUPPORTED, sync.reason());
		assertEquals("no_program", sync.detail());
	}

	@Test
	void theFeatureTheEnumAndTheLimits() {
		Set<String> f = ApiRules.features(2, List.of("site.design"));
		assertTrue(f.contains("siteDesign"), f.toString());
		assertFalse(ApiRules.features(2, List.of("site.analyse")).contains("siteDesign"));
		Estimate.Kind[] k = Estimate.Kind.values();
		assertEquals(Estimate.Kind.SITE, k[k.length - 1], "appended last");
		assertEquals(Estimate.Kind.CHANGE, k[5]);
		JsonObject r = JsonParser.parseString("{\"byKind\":{\"site\":{\"usdLow\":3.25,\"usdHigh\":9.2,\"minutesLow\":10.4,\"minutesHigh\":30,\"count\":1,"
			+ "\"basis\":\"b\"}}}").getAsJsonObject();
		Map<Estimate.Kind, Estimate.Item> byKind = Wire0a.byKind(r);
		assertEquals(Set.of(Estimate.Kind.SITE), byKind.keySet());
		assertEquals(SiteSpec.MAX_KEEP_CRITICAL, Limits.SITE_KEEP_CRITICAL_MAX);
		assertEquals(SiteSpec.MAX_PORTS, Limits.SITE_PORTS_MAX);
		assertNull(Wire4b.str(new JsonObject(), "newEntryId"));
	}
}
