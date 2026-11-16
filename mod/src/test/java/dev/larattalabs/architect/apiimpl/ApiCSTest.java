package dev.larattalabs.architect.apiimpl;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.larattalabs.architect.api.Batch;
import dev.larattalabs.architect.api.CompositeInfo;
import dev.larattalabs.architect.api.DesignRequest;
import dev.larattalabs.architect.api.FitMode;
import dev.larattalabs.architect.api.PlaceRequest;
import dev.larattalabs.architect.api.SiteBinding;
import dev.larattalabs.architect.api.SiteSpec;
import dev.larattalabs.architect.site.Composites;
import dev.larattalabs.architect.site.SiteFit;
import java.util.List;
import java.util.Map;
import java.util.Set;
import net.minecraft.core.BlockPos;
import net.minecraft.world.level.block.Rotation;
import org.junit.jupiter.api.Test;

/**
 * (7c CS) Composite and site edges on the mod side: {@code DesignRequest.inverted} (the 28th component, the 27-argument constructor kept,
 * every wither keeping it, on the wire only when true, the refusals before a send, the feature name), and a composite's library delete
 * (a hidden module alone refused, the composite's modules listed for the trash, a module another composite claims left alone).
 */
class ApiCSTest {
	static SiteSpec suspend() {
		SiteSpec s = ApiDSTest.site();
		return new SiteSpec(s.volumeSha(), s.volumeBlobId(), s.volume(), FitMode.SUSPEND, s.frame(), s.keepCritical(), s.ports(), "lot_hang_1");
	}

	@Test
	void theOldConstructorIsNotInvertedAndEveryWitherKeepsTheFlag() {
		DesignRequest p = ApiDSTest.plain();
		assertFalse(p.inverted());
		DesignRequest r = p.withSite(suspend()).withInverted(true);
		assertTrue(r.inverted());
		for (DesignRequest c : List.of(r.withOpKey("k1"), r.withPalette(null), r.withReserved(null), r.versionOf("e", null), r.withProfile(List.of()),
			r.withBible(null, null), r.massing(false), r.fromMassing(null, null), r.withContext("ctx"), r.critique(null), r.withSite(suspend()))) {
			assertTrue(c.inverted(), "a wither keeps inverted");
		}
		assertFalse(r.withInverted(false).inverted());
	}

	@Test
	void invertedGoesOnTheWireOnlyWhenTrue() {
		DesignRequest r = ApiDSTest.plain().withSite(suspend());
		assertFalse(DesignsImpl.wire(r, 2).has("inverted"), "a request without the flag is sent as before");
		assertEquals(DesignsImpl.wire(r, 2), DesignsImpl.wire(r.withInverted(false), 2));
		JsonObject w = DesignsImpl.wire(r.withInverted(true), 2);
		assertTrue(w.get("inverted").getAsBoolean());
	}

	@Test
	void refusalInvertedNeedsASuspendSiteAndTheHelperFeature() {
		Set<String> f = Set.of(DesignsImpl.INVERTED_FEATURE);
		assertNull(DesignsImpl.refusalInverted(ApiDSTest.plain(), 2, Set.of()), "not inverted: nothing to refuse");
		assertNull(DesignsImpl.refusalInverted(ApiDSTest.plain().withSite(suspend()).withInverted(true), 2, f));
		String noSite = DesignsImpl.refusalInverted(ApiDSTest.plain().withInverted(true), 2, f);
		assertNotNull(noSite);
		assertTrue(noSite.contains("suspend site") && noSite.contains("no site"), noSite);
		String cliff = DesignsImpl.refusalInverted(ApiDSTest.plain().withSite(ApiDSTest.site()).withInverted(true), 2, f);
		assertNotNull(cliff);
		assertTrue(cliff.contains("attach_to_cliff"), cliff);
		String old = DesignsImpl.refusalInverted(ApiDSTest.plain().withSite(suspend()).withInverted(true), 2, Set.of());
		assertNotNull(old);
		assertTrue(old.contains("design.inverted"), old);
		assertNotNull(DesignsImpl.refusalInverted(ApiDSTest.plain().withSite(suspend()).withInverted(true), 1, f));
	}

	@Test
	void theFeatureName() {
		assertTrue(ApiRules.features(2, List.of("job.run", "design.inverted")).contains("invertedDesigns"));
		assertFalse(ApiRules.features(2, List.of("job.run")).contains("invertedDesigns"));
	}

	static JsonObject composite(String id, String... modules) {
		JsonObject ci = new JsonObject();
		JsonArray m = new JsonArray();
		for (String x : modules) {
			m.add(x);
		}
		ci.add("modules", m);
		ci.add("joints", new JsonArray());
		ci.add("union", JsonParser.parseString("{\"minX\":0,\"minY\":0,\"minZ\":0,\"maxX\":120,\"maxY\":14,\"maxZ\":26}"));
		JsonObject ext = new JsonObject();
		ext.add(CompositeInfo.EXT_KEY, ci);
		JsonObject j = new JsonObject();
		j.addProperty("id", id);
		j.add("ext", ext);
		return j;
	}

	static JsonObject module(String id, String of) {
		JsonObject j = new JsonObject();
		j.addProperty("id", id);
		j.addProperty(Composites.COMPOSITE_OF, of);
		return j;
	}

	@Test
	void aCompositeDeletesWithItsModulesAndAModuleNeverAlone() {
		JsonObject c = composite("keep", "keep__west", "keep__centre", "keep__east");
		assertTrue(CompositeInfo.ofExt(c.getAsJsonObject("ext")).isPresent(), "the test's wire is a well-formed CompositeInfo");
		Map<String, JsonObject> lib = Map.of("keep__west", module("keep__west", "keep"), "keep__centre", module("keep__centre", "keep"),
			"keep__east", module("keep__east", "other")); // east claims another composite, which lists it: left alone
		Map<String, JsonObject> all = Map.of("keep", c, "keep__west", lib.get("keep__west"), "keep__centre", lib.get("keep__centre"),
			"keep__east", lib.get("keep__east"), "other", composite("other", "keep__east")); // (CS2) a live lister: without it east is an orphan and goes
		assertEquals(List.of("keep__west", "keep__centre"), Composites.modulesToDelete("keep", c, lib::get, all).modules());
		assertEquals(Map.of(), Composites.modulesToDelete("keep", c, lib::get, all).shared());
		assertEquals(List.of(), Composites.modulesToDelete("cabin", new JsonObject(), lib::get, all).modules(), "a plain entry takes nothing with it");
		assertNull(Composites.deleteRefusal("keep", c));
		assertNull(Composites.deleteRefusal("cabin", new JsonObject()));
		String why = Composites.deleteRefusal("keep__west", module("keep__west", "keep"));
		assertNotNull(why);
		assertTrue(why.contains("hidden module of composite keep"), why);
	}

	/**
	 * (7c CS, v0.74.0 review P1 #5) Composites A and B both list module M, M.compositeOf = A: deleting A must not trash M (B would be
	 * left installed but unusable). M stays and is reported as shared with B; A's own unshared module still goes.
	 */
	@Test
	void aModuleAnotherCompositeAlsoListsStaysWhenItsOwnerIsDeleted() {
		JsonObject a = composite("a", "a__m", "a__own");
		JsonObject b = composite("b", "a__m", "b__own");
		Map<String, JsonObject> lib = Map.of("a", a, "b", b, "a__m", module("a__m", "a"), "a__own", module("a__own", "a"),
			"b__own", module("b__own", "b"));
		Composites.ModuleDeletion d = Composites.modulesToDelete("a", a, lib::get, lib);
		assertEquals(List.of("a__own"), d.modules(), "the shared module is not trashed");
		assertEquals(Map.of("a__m", List.of("b")), d.shared(), "the shared module is reported with the composite that still uses it");
		// deleting B (M is A's, not B's) takes only B's own module, and nothing is shared
		Composites.ModuleDeletion db = Composites.modulesToDelete("b", b, lib::get, lib);
		assertEquals(List.of("b__own"), db.modules());
		assertEquals(Map.of(), db.shared());
	}

	/** (CS2) A composite that lists a module id twice ([M, M, N]) takes each once: a second move of the same folder would leave a partial delete. */
	@Test
	void aDuplicatedModuleIdIsDeletedOnce() {
		JsonObject a = composite("a", "a__m", "a__m", "a__n");
		JsonObject b = composite("b", "a__m", "a__m", "b__own"); // a survivor listing the shared id twice is reported once
		Map<String, JsonObject> lib = Map.of("a", a, "a__m", module("a__m", "a"), "a__n", module("a__n", "a"));
		assertEquals(List.of("a__m", "a__n"), Composites.modulesToDelete("a", a, lib::get, lib).modules());
		Map<String, JsonObject> both = Map.of("a", a, "b", b, "a__m", module("a__m", "a"), "a__n", module("a__n", "a"), "b__own", module("b__own", "b"));
		Composites.ModuleDeletion d = Composites.modulesToDelete("a", a, both::get, both);
		assertEquals(List.of("a__n"), d.modules());
		assertEquals(Map.of("a__m", List.of("b")), d.shared(), "one entry per surviving lister");
	}

	/**
	 * (CS2) A module kept as shared when its owner went (compositeOf still the deleted owner) is deleted with its last lister, not left
	 * hidden and undeletable; while another live composite lists it, it stays.
	 */
	@Test
	void aSharedModuleGoesWithItsLastLister() {
		JsonObject a = composite("a", "a__m", "a__own");
		JsonObject b = composite("b", "a__m", "b__own");
		JsonObject c = composite("c", "a__m");
		Map<String, JsonObject> lib = new java.util.HashMap<>(Map.of("a", a, "b", b, "c", c, "a__m", module("a__m", "a"), "a__own", module("a__own", "a"),
			"b__own", module("b__own", "b")));
		assertEquals(Map.of("a__m", List.of("b", "c")), Composites.modulesToDelete("a", a, lib::get, lib).shared());
		lib.remove("a");
		lib.remove("a__own"); // A deleted: M stays, its compositeOf still "a"
		Composites.ModuleDeletion db = Composites.modulesToDelete("b", b, lib::get, lib);
		assertEquals(List.of("b__own"), db.modules(), "C still lists M: it stays");
		assertEquals(Map.of(), db.shared(), "M is not B's: not reported as B's shared module");
		lib.remove("b");
		lib.remove("b__own");
		assertEquals(List.of("a__m"), Composites.modulesToDelete("c", c, lib::get, lib).modules(), "the last lister takes it, whatever its compositeOf");
		assertEquals(List.of(), Composites.modulesToDelete("c", c, x -> null, lib).modules(), "a module not in the library is left alone");
		assertEquals(List.of(), Composites.modulesToDelete("c", c, x -> new JsonObject(), lib).modules(), "a plain (non-module) entry is never taken");
	}

	/**
	 * (7c CS: PL's leftovers, intended) A batch item with a site stays refused (the queue persists no site), and a site-bound placement's
	 * move, update and revert are refused (each would re-plan CLEAR terrain over a KEEP site): the guard and the record mark pinned.
	 */
	@Test
	void siteBoundRefusalsStayAsDecided() {
		PlaceRequest p = PlaceRequest.of("bp", null, BlockPos.ZERO, Rotation.NONE);
		SiteGuards.batch(Batch.of(null, List.of(Batch.Item.of("a", p))));
		assertThrows(UnsupportedOperationException.class, () -> SiteGuards.batch(Batch.of(null, List.of(Batch.Item.of("a", p), Batch.Item.of("b", p.withSite(suspend()))))));
		JsonObject ext = SiteFit.withBinding(new JsonObject(), suspend());
		assertTrue(SiteFit.bound(ext) && ext.has(SiteBinding.EXT_KEY));
		assertFalse(SiteFit.bound(new JsonObject()));
		assertTrue(SiteFit.fixedMessage("s1", "a move").contains("site-bound") && SiteFit.fixedMessage("s1", "a move").contains("remove it and place it again"));
	}
}
