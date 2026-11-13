package dev.larattalabs.architect.api;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.larattalabs.architect.apiimpl.ApiRules;
import java.lang.reflect.InvocationHandler;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.util.Arrays;
import java.util.List;
import java.util.Optional;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import net.minecraft.core.BlockPos;
import net.minecraft.world.level.levelgen.structure.BoundingBox;
import org.junit.jupiter.api.Test;

/** Since NEXT (docs/CONTRACT.md "Phase 7c" §2 and slice 7cF): the 7c foundation's frozen surface, stubs and wire shapes. */
class Api7cFTest {
	private static final BoundingBox CLAIM = new BoundingBox(0, 60, 0, 127, 120, 127);

	@Test
	void reasonsAppendedAfterNoLinkInOrder() {
		Reason[] r = Reason.values();
		int n = Reason.NO_LINK.ordinal();
		// (merge with M5 GP) PROGRAM_REFUSED landed first, right after NO_LINK; 7c's two follow it, in the contract's order
		assertEquals(List.of(Reason.NO_LINK, Reason.PROGRAM_REFUSED, Reason.JOINT_MISMATCH, Reason.AUTHORED_STALE), Arrays.asList(r).subList(n, n + 4),
			"the two 7c reasons after 7b's NO_LINK and M5 GP's PROGRAM_REFUSED, in the contract's order");
		assertTrue(r.length - 1 >= Reason.AUTHORED_STALE.ordinal(), "later slices append after AUTHORED_STALE");
	}

	@Test
	void stubsThrowNamingTheirSlice() throws Throwable {
		assertThrowsDefault(Regions.class, "compose", "slice CO", new ComposeRequest("a ring town", CLAIM, null, false, null, "k", null));
		assertThrowsDefault(Regions.class, "authorProgram", "slice AU", new AuthorRequest("a sea stack", CLAIM, null, null, null, "k", null));
		assertThrowsDefault(Sites.class, "placeConnector", "slice CX", new ConnectorRequest("rope_bridge", BlockPos.ZERO, new BlockPos(9, 0, 0), null,
			null, Mode.INSTANT, "k"));
		assertThrowsDefault(Regions.class, "planCatalogue", "slice 7cF", Set.of("form.crater"));
		assertEquals(CompletableFuture.class, Regions.class.getMethod("compose", ComposeRequest.class).getReturnType());
		assertEquals(CompletableFuture.class, Regions.class.getMethod("authorProgram", AuthorRequest.class).getReturnType());
		assertEquals(CompletableFuture.class, Sites.class.getMethod("placeConnector", ConnectorRequest.class).getReturnType());
		assertEquals(JsonObject.class, Regions.class.getMethod("planCatalogue", Set.class).getReturnType());
		assertTrue(Regions.class.getMethod("planCatalogue").isDefault(), "the no-arg call is unchanged");
	}

	@Test
	void requestRecords() {
		ComposeRequest c = new ComposeRequest("b", CLAIM, "s", true, 1.5, "k", null);
		assertEquals(new JsonObject(), c.ext(), "a null ext is empty");
		assertEquals(List.of("brief", "claim", "styleId", "images", "budgetUsd", "opKey", "ext"), names(ComposeRequest.class));
		assertEquals(List.of("brief", "claim", "planId", "partId", "budgetUsd", "opKey", "ext"), names(AuthorRequest.class));
		assertEquals(List.of("kind", "from", "to", "styleId", "params", "mode", "opKey"), names(ConnectorRequest.class));
		assertEquals(new JsonObject(), new ConnectorRequest("ladder", BlockPos.ZERO, BlockPos.ZERO, null, null, Mode.INSTANT, "k").params());
		assertThrows(NullPointerException.class, () -> new ComposeRequest(null, CLAIM, null, false, null, "k", null));
		assertThrows(NullPointerException.class, () -> new AuthorRequest("b", CLAIM, null, null, null, null, null));
		assertThrows(NullPointerException.class, () -> new ConnectorRequest("ladder", BlockPos.ZERO, BlockPos.ZERO, null, null, null, "k"));
	}

	@Test
	void compositeInfoWire() {
		CompositeInfo ci = new CompositeInfo(List.of("castle_keep", "castle_wall"), List.of(new CompositeInfo.Joint("castle_keep", "east_arch",
			"castle_wall", "west_arch")), new BoundingBox(0, 0, 0, 119, 40, 63));
		JsonObject ext = new JsonObject();
		ext.add(CompositeInfo.EXT_KEY, ci.wire());
		assertEquals("architect_mc:composite", CompositeInfo.EXT_KEY);
		assertEquals(Optional.of(ci), CompositeInfo.ofExt(ext));
		assertEquals(Optional.of(ci), CompositeInfo.ofExt(JsonParser.parseString(ext.toString()).getAsJsonObject()));
		assertEquals("west_arch", ci.wire().getAsJsonArray("joints").get(0).getAsJsonObject().getAsJsonObject("to").get("port").getAsString());
		assertEquals(List.of("moduleEntryIds", "joints", "union"), names(CompositeInfo.class));
		assertEquals(List.of("fromModule", "fromPort", "toModule", "toPort"), names(CompositeInfo.Joint.class));
		// empty, never a throw: none, not an object, a member missing or of the wrong type
		assertEquals(Optional.empty(), CompositeInfo.ofExt(null));
		assertEquals(Optional.empty(), CompositeInfo.ofExt(new JsonObject()));
		for (String bad : List.of("{\"architect_mc:composite\": 3}", "{\"architect_mc:composite\": {\"modules\": [], \"joints\": []}}",
			"{\"architect_mc:composite\": {\"modules\": [\"a\"], \"joints\": [{\"from\": {\"module\": \"a\"}}], \"union\": {\"minX\": 0}}}")) {
			assertEquals(Optional.empty(), CompositeInfo.ofExt(JsonParser.parseString(bad).getAsJsonObject()), bad);
		}
		assertEquals(Optional.empty(), CompositeInfo.of(null));
	}

	@Test
	void extKeys() {
		assertEquals("architect_mc:secrets", PlanRequest.EXT_SECRETS);
		assertEquals("architect_mc:planImages", PlanRequest.EXT_PLAN_IMAGES);
		assertEquals("architect_mc:relatedTo", BibleRequest.EXT_RELATED_TO);
	}

	@Test
	void featuresNotAdvertisedByTheFoundation() {
		List<String> names = List.of("bigForms", "hiddenRooms", "suspendedBuilds", "aqueduct", "regionM15", "styleFormat3", "scenarioTemplates",
			"compose", "programAuthoring", "shapePromotion", "placeConnector"); // (7c CM-b) "composites" is advertised by CM-b
		for (Set<String> f : List.of(ApiRules.JAVA_FEATURES, ApiRules.features(1, List.of()), ApiRules.features(2, List.of("job.run", "region.plan",
			"region.planCheck", "site.design", "region.link")))) {
			for (String n : names) {
				assertFalse(f.contains(n), n + " is advertised by its slice, not the foundation");
			}
		}
	}

	private static List<String> names(Class<?> record) {
		return Arrays.stream(record.getRecordComponents()).map(java.lang.reflect.RecordComponent::getName).toList();
	}

	private static void assertThrowsDefault(Class<?> api, String name, String slice, Object... args) throws Throwable {
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
			assertTrue(t.getMessage().contains("NEXT") && t.getMessage().contains(slice), t.getMessage());
			return;
		}
		throw new AssertionError(api.getSimpleName() + "." + name + " did not throw");
	}
}
