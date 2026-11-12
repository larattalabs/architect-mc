package dev.larattalabs.architect.api;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.larattalabs.architect.apiimpl.ApiRules;
import dev.larattalabs.architect.apiimpl.SiteGuards;
import dev.larattalabs.architect.batch.BatchKeys;
import java.lang.reflect.InvocationHandler;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.util.Arrays;
import java.util.List;
import java.util.Optional;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.world.level.block.Rotation;
import net.minecraft.world.level.levelgen.structure.BoundingBox;
import org.junit.jupiter.api.Test;

/** Since NEXT (docs/CONTRACT.md "Phase 7b" §2 and slice 7bF): the 7b foundation's frozen surface, stubs and wire shapes. */
class Api7bFTest {
	static SiteSpec site() {
		return new SiteSpec("a".repeat(64), "b".repeat(64), new BoundingBox(0, 60, 0, 31, 91, 31), FitMode.ATTACH_TO_CLIFF,
			new SiteFrame(new BlockPos(8, 64, 8), Rotation.CLOCKWISE_90), List.of(new BlockPos(10, 64, 10), new BlockPos(11, 64, 10)),
			List.of(new SitePort("door_w", SitePort.DOOR, new BlockPos(0, 1, 4), Direction.WEST, 1, 2, null),
				new SitePort("hatch", SitePort.WALK, new BlockPos(3, 9, 3), Direction.UP, 2, 1, "e_ladder")), "lot_3");
	}

	@Test
	void reasonsAppendedInOrder() {
		Reason[] r = Reason.values();
		int n = Reason.NO_ROOM.ordinal();
		List<Reason> seven = Arrays.asList(r).subList(n, n + 7);
		assertEquals(List.of(Reason.NO_ROOM, Reason.SITE_DRIFTED, Reason.KEEP_LOST, Reason.SITE_UNSUPPORTED, Reason.SITE_MISMATCH,
			Reason.SITE_UNFIT, Reason.NO_LINK), seven, "the six after NO_ROOM, in the contract's order");
		assertTrue(r.length - 1 >= Reason.NO_LINK.ordinal(), "later slices append after NO_LINK");
	}

	@Test
	void fitModes() {
		assertEquals(List.of("on_pad", "carve_into", "attach_to_cliff", "span", "wrap_trunk", "suspend"), Arrays.stream(FitMode.values()).map(
			FitMode::wire).toList());
		for (FitMode f : FitMode.values()) {
			assertEquals(Optional.of(f), FitMode.of(f.wire()));
			assertEquals(Optional.of(f), FitMode.of(f.name()));
		}
		assertEquals(Optional.empty(), FitMode.of("hover"));
		assertEquals(Optional.empty(), FitMode.of(null));
		assertEquals(List.of("cliff_face", "ledge", "overhang", "cave", "trunk", "canopy", "spike", "water", "gap", "pad"), Arrays.stream(
			Affordance.Kind.values()).map(Affordance.Kind::wire).toList());
	}

	@Test
	void siteSpecWireRoundTrip() {
		SiteSpec s = site();
		JsonObject w = s.wire();
		assertEquals("attach_to_cliff", w.get("fit").getAsString());
		assertEquals("clockwise_90", w.getAsJsonObject("frame").get("rotation").getAsString());
		assertEquals("up", w.getAsJsonArray("ports").get(1).getAsJsonObject().get("facing").getAsString());
		assertFalse(w.getAsJsonArray("ports").get(0).getAsJsonObject().has("edge"), "a null edge leaves no key");
		assertEquals(s, SiteSpec.fromWire(w));
		assertEquals(s, SiteSpec.fromWire(JsonParser.parseString(w.toString()).getAsJsonObject()));
		assertEquals(List.of(), s.problems());
		for (Rotation r : Rotation.values()) {
			assertSame(r, SiteFrame.rotationOf(SiteFrame.rotationWire(r)));
		}
		assertEquals(Rotation.NONE, new SiteFrame(BlockPos.ZERO, null).rotation());
	}

	@Test
	void siteSpecRefusals() {
		JsonObject bad = site().wire();
		bad.addProperty("fit", "hover");
		assertThrows(IllegalArgumentException.class, () -> SiteSpec.fromWire(bad));
		JsonObject dup = site().wire();
		dup.getAsJsonArray("ports").add(dup.getAsJsonArray("ports").get(0).deepCopy());
		assertThrows(IllegalArgumentException.class, () -> SiteSpec.fromWire(dup));
		JsonObject kind = site().wire();
		kind.getAsJsonArray("ports").get(0).getAsJsonObject().addProperty("kind", "minecraft:ladder");
		assertThrows(IllegalArgumentException.class, () -> SiteSpec.fromWire(kind));
		JsonObject outside = site().wire();
		JsonArray far = new JsonArray();
		far.add(500);
		far.add(64);
		far.add(0);
		outside.getAsJsonArray("keepCritical").add(far);
		assertThrows(IllegalArgumentException.class, () -> SiteSpec.fromWire(outside));
		JsonObject many = site().wire();
		JsonArray ports = new JsonArray();
		for (int i = 0; i <= SiteSpec.MAX_PORTS; i++) {
			JsonObject p = many.getAsJsonArray("ports").get(0).getAsJsonObject().deepCopy();
			p.addProperty("name", "p" + i);
			ports.add(p);
		}
		many.add("ports", ports);
		assertThrows(IllegalArgumentException.class, () -> SiteSpec.fromWire(many));
		JsonObject noFrame = site().wire();
		noFrame.remove("frame");
		assertThrows(IllegalArgumentException.class, () -> SiteSpec.fromWire(noFrame));
	}

	@Test
	void kitFixturesReadAndWriteTheSameWire() throws java.io.IOException {
		// the kit's six site fixtures (kit/tools/site-fixtures.mjs): Java reads each spec with the shared schema and writes it back equal
		java.nio.file.Path dir = java.nio.file.Path.of("../kit/test/fixtures/site");
		int n = 0;
		try (var ds = java.nio.file.Files.newDirectoryStream(dir)) {
			for (var d : ds) {
				JsonObject spec = JsonParser.parseString(java.nio.file.Files.readString(d.resolve("site.json"))).getAsJsonObject().getAsJsonObject("spec");
				SiteSpec s = SiteSpec.fromWire(spec);
				assertEquals(spec, s.wire(), d.getFileName().toString());
				n++;
			}
		}
		assertEquals(FitMode.values().length, n, "one fixture per fit");
		JsonObject extra = site().wire();
		extra.addProperty("extra", 1);
		IllegalArgumentException e = assertThrows(IllegalArgumentException.class, () -> SiteSpec.fromWire(extra));
		assertTrue(e.getMessage().contains("unexpected extra"), e.getMessage());
	}

	@Test
	void bindingInExt() {
		SiteBinding b = SiteBinding.of(site(), "plan-7");
		assertEquals(new SiteBinding("a".repeat(64), FitMode.ATTACH_TO_CLIFF, "lot_3", new BoundingBox(0, 60, 0, 31, 91, 31), "plan-7"), b);
		JsonObject ext = new JsonObject();
		ext.add(SiteBinding.EXT_KEY, b.wire());
		assertEquals("architect_mc:site", SiteBinding.EXT_KEY);
		assertEquals(Optional.of(b), SiteBinding.ofExt(ext));
		SiteBinding standalone = new SiteBinding("c".repeat(64), FitMode.SUSPEND, null, new BoundingBox(0, 0, 0, 3, 3, 3), null);
		JsonObject w = standalone.wire();
		assertFalse(w.has("lotId") || w.has("regionPlanId"));
		ext.add(SiteBinding.EXT_KEY, w);
		assertEquals(Optional.of(standalone), SiteBinding.ofExt(ext));
		assertEquals(Optional.empty(), SiteBinding.ofExt(new JsonObject()));
		assertEquals(Optional.empty(), SiteBinding.ofExt(null));
		JsonObject broken = new JsonObject();
		JsonObject m = b.wire();
		m.addProperty("fit", "hover");
		broken.add(SiteBinding.EXT_KEY, m);
		assertEquals(Optional.empty(), SiteBinding.ofExt(broken), "malformed: empty, never a throw");
	}

	@Test
	void oldConstructorsKept() throws ReflectiveOperationException {
		// the pre-7b canonical constructors stay (binary compatibility); the site member is the last component
		Class<?>[] lot = {String.class, String.class, BoundingBox.class, int.class, Direction.class, String.class, BlockSize.class, JsonObject.class};
		LotSpec l = LotSpec.class.getConstructor(lot).newInstance("l", "s", new BoundingBox(0, 0, 0, 1, 1, 1), 0, Direction.SOUTH, null,
			new BlockSize(1, 1, 1), null);
		assertNull(l.site());
		Class<?>[] place = Arrays.copyOf(Arrays.stream(PlaceRequest.class.getRecordComponents()).map(c -> c.getType()).toArray(Class<?>[]::new), 12);
		assertEquals(BuildConsent.class, place[11]);
		PlaceRequest.class.getConstructor(place);
		Class<?>[] design = Arrays.copyOf(Arrays.stream(DesignRequest.class.getRecordComponents()).map(c -> c.getType()).toArray(Class<?>[]::new), 26);
		assertEquals(String.class, design[25]);
		DesignRequest.class.getConstructor(design);
		for (Class<?> c : List.of(LotSpec.class, PlaceRequest.class, DesignRequest.class)) {
			var rc = c.getRecordComponents();
			assertEquals("site", rc[rc.length - 1].getName(), c.getSimpleName());
			assertEquals(SiteSpec.class, rc[rc.length - 1].getType(), c.getSimpleName());
		}
	}

	@Test
	void copiesCarryTheSite() {
		SiteSpec s = site();
		PlaceRequest p = PlaceRequest.of("bp", null, BlockPos.ZERO, Rotation.NONE);
		assertNull(p.site());
		PlaceRequest ps = p.withSite(s);
		assertEquals(s, ps.site());
		assertEquals(s, ps.withOverlap(null).withPathStyle("stone").withConsent(null).site());
		DesignRequest d = new DesignRequest("house", "rustic", null, List.of(), new BlockSize(9, 9, 9), null, null, null, null, null, null, null,
			null, null, List.of(), null, false, null, null, null, null, null, null, null, null, null);
		assertNull(d.site());
		DesignRequest ds = d.withSite(s);
		assertEquals(s, ds.withOpKey("k").withPalette(null).withReserved(null).versionOf("e", null).withProfile(List.of()).massing(false)
			.fromMassing("m", 1).withBible("b", 1).withContext((String) null).critique(null).site());
	}

	@Test
	void stubsThrow() throws Throwable {
		assertThrowsDefault(Sites.class, "fitToSite", "x", site(), FitOptions.DEFAULT);
		assertThrowsDefault(Survey.class, "site", null, new BoundingBox(0, 0, 0, 1, 1, 1), FitMode.SPAN, LoadPolicy.LOADED_ONLY);
		assertThrowsDefault(Designs.class, "siteVariant", "e", site(), "k");
		assertThrowsDefault(Regions.class, "affordances", "plan");
		assertEquals(LotFit.class, Sites.class.getMethod("fitToSite", String.class, SiteSpec.class, FitOptions.class).getReturnType());
		assertEquals(Optional.class, Regions.class.getMethod("affordances", String.class).getReturnType());
	}

	@Test
	void guardsRefuseASiteUntilItsSlice() {
		PlaceRequest p = PlaceRequest.of("bp", null, BlockPos.ZERO, Rotation.NONE);
		SiteGuards.place(p);
		assertThrows(UnsupportedOperationException.class, () -> SiteGuards.place(p.withSite(site())));
		DesignRequest d = new DesignRequest("house", "rustic", null, List.of(), new BlockSize(9, 9, 9), null, null, null, null, null, null, null,
			null, null, List.of(), null, false, null, null, null, null, null, null, null, null, null);
		SiteGuards.design(d);
		assertThrows(UnsupportedOperationException.class, () -> SiteGuards.design(d.withSite(site())));
	}

	@Test
	void nullSiteKeepsTheBodyHash() {
		PlaceRequest p = PlaceRequest.of("bp", null, BlockPos.ZERO, Rotation.NONE);
		JsonObject j = BatchKeys.json(p, true).getAsJsonObject();
		assertFalse(j.has("site"), "a null site leaves no key: a batch hashed before 7b keeps its hash");
		assertTrue(j.has("consent"), "other null members stay as they were");
		assertTrue(BatchKeys.json(p.withSite(site()), true).getAsJsonObject().has("site"));
	}

	@Test
	void featuresNotAdvertisedByTheFoundation() {
		var f = ApiRules.features(2, List.of("site.design", "site.survey", "site.lots", "link.pass", "region.siteLot", "region.links"));
		for (String n : List.of("siteDesign", "siteSurvey", "siteLots", "linkPass")) {
			assertFalse(f.contains(n), n + " is advertised by its slice, not the foundation");
		}
	}

	private static void assertThrowsDefault(Class<?> api, String name, Object... args) throws Throwable {
		Method m = Arrays.stream(api.getMethods()).filter(x -> x.getName().equals(name) && x.getParameterCount() == args.length).findFirst()
			.orElseThrow();
		assertTrue(m.isDefault(), api.getSimpleName() + "." + name + " is a default");
		InvocationHandler h = (proxy, method, a) -> method.isDefault() ? InvocationHandler.invokeDefault(proxy, method, a) : null;
		Object proxy = Proxy.newProxyInstance(api.getClassLoader(), new Class<?>[] {api}, h);
		try {
			m.invoke(proxy, args);
		} catch (InvocationTargetException e) {
			Throwable t = e.getCause() instanceof java.lang.reflect.UndeclaredThrowableException u ? u.getCause() : e.getCause();
			assertTrue(t instanceof UnsupportedOperationException, api.getSimpleName() + "." + name + ": " + t);
			assertTrue(t.getMessage().contains("since NEXT") || t.getMessage().matches(".*since \\d+\\.\\d+\\.\\d+.*"), t.getMessage());
			return;
		}
		throw new AssertionError(api.getSimpleName() + "." + name + " did not throw");
	}
}
