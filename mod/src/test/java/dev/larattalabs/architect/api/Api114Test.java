package dev.larattalabs.architect.api;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.larattalabs.architect.apiimpl.ApiRules;
import dev.larattalabs.architect.apiimpl.FieldLimits;
import java.lang.reflect.Modifier;
import java.util.List;
import java.util.Map;
import java.util.Set;
import net.minecraft.world.level.levelgen.structure.BoundingBox;
import org.junit.jupiter.api.Test;

/**
 * API 1.14.0 (docs/CONTRACT.md phase 6c slice X, C19 and C20): the old constructors are kept (binary compatibility), the new record
 * components are trailing, the new interface methods are defaults that throw, no Reason is added, and a lot's ext is bounded.
 */
class Api114Test {
	@Test
	void version() {
		String[] v = ArchitectApi.VERSION.split("\\.");
		assertTrue(Integer.parseInt(v[0]) == 1 && Integer.parseInt(v[1]) >= 14, ArchitectApi.VERSION); // later slices append
	}

	@Test
	void featuresAreAlwaysThere() {
		Set<String> f = ApiRules.features(1, List.of());
		assertTrue(f.contains("regionOpKeys") && f.contains("lotExt"), f.toString());
	}

	@Test
	void oldConstructorsKept() throws Exception {
		// the 1.13.0 shapes, by descriptor: a jar compiled against them still links
		assertEquals(RegionPlanRequest.class, RegionPlanRequest.class.getConstructor(String.class, JsonObject.class, net.minecraft.server.level.ServerLevel.class,
			BoundingBox.class, Long.class, String.class, Integer.class, LoadPolicy.class, String.class, JsonObject.class).getDeclaringClass());
		assertEquals(RealiseRequest.class, RealiseRequest.class.getConstructor(String.class, Mode.class, net.minecraft.server.level.ServerPlayer.class, Map.class,
			LoadPolicy.class, boolean.class, List.class, boolean.class, JsonObject.class, int.class).getDeclaringClass());
		assertEquals(RealiseRequest.class, RealiseRequest.class.getConstructor(String.class, Mode.class, net.minecraft.server.level.ServerPlayer.class, Map.class,
			LoadPolicy.class, boolean.class, List.class, boolean.class, JsonObject.class).getDeclaringClass());
		// the new component is last, and the old constructors leave it null
		var pc = RegionPlanRequest.class.getRecordComponents();
		assertEquals("opKey", pc[pc.length - 1].getName());
		var rc = RealiseRequest.class.getRecordComponents();
		assertEquals("opKey", rc[rc.length - 1].getName());
		assertEquals("maxWaitSeconds", rc[rc.length - 2].getName());
		RealiseRequest r = new RealiseRequest("p1", null, null, null, null, false, null, false, null);
		assertNull(r.opKey());
		assertEquals(0, r.maxWaitSeconds());
		assertNull(new RealiseRequest("p1", null, null, null, null, false, null, false, null, 5).opKey());
		assertEquals("k", new RealiseRequest("p1", null, null, null, null, false, null, false, null, 5, "k").opKey());
		assertNull(new RegionPlanRequest("mega_bench", null, null, new BoundingBox(0, 0, 0, 1, 1, 1), null, null, null, null, null, null).opKey());
	}

	@Test
	void newMethodsAreDefaultsThatThrow() throws Exception {
		for (String m : List.of("planByKey", "realiseByKey")) {
			var method = Regions.class.getMethod(m, String.class, String.class);
			assertTrue(method.isDefault(), m);
			assertTrue(!Modifier.isAbstract(method.getModifiers()), m);
		}
		Regions old = new Regions() {
			@Override
			public java.util.concurrent.CompletableFuture<RegionPlan> plan(RegionPlanRequest r) {
				return null;
			}

			@Override
			public java.util.concurrent.CompletableFuture<PrepareView> prepare(PrepareRequest r) {
				return null;
			}

			@Override
			public void cancelPrepare(String regionOrPlanId) {
			}

			@Override
			public java.util.concurrent.CompletableFuture<String> realise(RealiseRequest r) {
				return null;
			}

			@Override
			public java.util.concurrent.CompletableFuture<RemoveResult> remove(String regionId, RemoveOptions o) {
				return null;
			}

			@Override
			public java.util.Optional<RegionView> get(String regionId) {
				return java.util.Optional.empty();
			}

			@Override
			public List<RegionView> list(String owner) {
				return List.of();
			}
		};
		assertEquals("Regions.planByKey needs Architect API 1.14.0", assertThrows(UnsupportedOperationException.class, () -> old.planByKey(null, "k")).getMessage());
		assertEquals("Regions.realiseByKey needs Architect API 1.14.0", assertThrows(UnsupportedOperationException.class, () -> old.realiseByKey(null, "k")).getMessage());
	}

	@Test
	void noReasonAdded() {
		// the last constants are 1.12.0's: X appends none (OP_KEY_CONFLICT and FIELD_LIMIT exist)
		Reason[] r = Reason.values();
		assertEquals(Reason.FIELD_LIMIT, r[r.length - 1]);
		assertEquals(Reason.PROTECTED, r[r.length - 2]);
	}

	private static JsonObject params(String ext) {
		return JsonParser.parseString("{\"shared\": \"well\", \"lots\": [{\"id\": \"a_1\", \"type\": \"cottage\", \"size\": [11, 14]}, {\"id\": \"b_1\", \"type\": \"hall\", \"size\": [11, 14], \"ext\": "
			+ ext + "}]}").getAsJsonObject();
	}

	private static String padded(int total) {
		String head = "{\"steward_mc:x\":\"";
		return head + "a".repeat(total - head.length() - 2) + "\"}";
	}

	@Test
	void lotExtBounds() {
		assertNull(FieldLimits.lotExt(null));
		assertNull(FieldLimits.lotExt(new JsonObject()));
		assertNull(FieldLimits.lotExt(params("{\"steward_mc:lot\": \"b_1\", \"steward_mc:build\": {\"id\": \"b7\"}}")));
		assertNull(FieldLimits.lotExt(params("null")), "a null ext is none");
		assertNull(FieldLimits.lotExt(params("{\"architect_mc:lot\": \"forged\"}")), "Architect's namespace is dropped by the kit, not refused");
		String at = padded(4096);
		assertEquals(4096, JsonParser.parseString(at).toString().length());
		assertNull(FieldLimits.lotExt(params(at)), "exactly 4096 passes");
		assertEquals("params.lots[1].ext: 4097 characters as JSON, at most 4096", FieldLimits.lotExt(params(padded(4097))));
		assertEquals("params.lots[1].ext: must be an object", FieldLimits.lotExt(params("[1]")));
		assertEquals("params.lots[1].ext: must be an object", FieldLimits.lotExt(params("\"x\"")));
		assertEquals("params.lots[1].ext: key \"nonamespace\" is not namespace:name", FieldLimits.lotExt(params("{\"nonamespace\": 1}")));
		assertTrue(FieldLimits.lotExt(params("{\"" + "k".repeat(150) + ":" + "v".repeat(60) + "\": 1}")).startsWith("params.lots[1].ext: a key of 211 characters, at most 200"));
	}

	@Test
	void c22TombstonesAreBinaryCompatible() throws Exception {
		RegionState[] rs = RegionState.values();
		assertEquals(RegionState.REMOVED, rs[rs.length - 1]);
		assertEquals(RegionState.REMOVING, rs[rs.length - 2]);
		var vc = RegionView.class.getRecordComponents();
		assertEquals("removedAt", vc[vc.length - 1].getName());
		RegionView.class.getConstructor(String.class, String.class, String.class, String.class, JsonObject.class, String.class, BoundingBox.class, RegionState.class,
			List.class, List.class, long.class, Map.class, Refusal.class, PrepareView.class, List.class); // 1.9.0
		RegionView.class.getConstructor(String.class, String.class, String.class, String.class, JsonObject.class, String.class, BoundingBox.class, RegionState.class,
			List.class, List.class, long.class, Map.class, Refusal.class, PrepareView.class); // 1.8.0
		SiteGroup.class.getConstructor(String.class, String.class, JsonObject.class, List.class, List.class, SiteGroup.State.class, java.util.Optional.class); // 1.4.0
		var g = new SiteGroup("g", null, null, List.of(), List.of(), SiteGroup.State.REMOVED, java.util.Optional.empty());
		assertTrue(g.removedAt().isEmpty());
	}

	@Test
	void groupTombstoneKeepsItsTime() {
		var rec = new dev.larattalabs.architect.site.SiteGroupRec("g1", null, new JsonObject(), List.of(), List.of(), dev.larattalabs.architect.site.SiteGroupRec.ACTIVE,
			false, null, null, 1L);
		assertEquals(0L, rec.removedAt());
		var removing = rec.withState(dev.larattalabs.architect.site.SiteGroupRec.REMOVING);
		assertEquals(0L, removing.removedAt());
		var removed = removing.withState(dev.larattalabs.architect.site.SiteGroupRec.REMOVED);
		assertTrue(removed.removedAt() > 0);
		assertEquals(removed.removedAt(), dev.larattalabs.architect.site.SiteGroupRec.fromJson(removed.toJson()).removedAt(), "survives save and reload");
		assertEquals(removed.removedAt(), removed.withState(dev.larattalabs.architect.site.SiteGroupRec.REMOVED).removedAt(), "a second finish keeps the first time");
		assertEquals(0L, removed.withState(dev.larattalabs.architect.site.SiteGroupRec.ACTIVE).removedAt());
		assertEquals(removed.removedAt(), removed.withSites(List.of("a")).removedAt(), "other updates keep it");
	}
}
