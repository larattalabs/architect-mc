package dev.larattalabs.architect.site;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import dev.larattalabs.architect.api.ArchitectRefused;
import dev.larattalabs.architect.api.Busy;
import dev.larattalabs.architect.api.Reason;
import java.lang.reflect.Method;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;
import java.util.concurrent.ExecutionException;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

/**
 * (slice T4R-D fix round, P2-2; row T4RDF-busy-routes) Every public removal route answers a pending member of a live owner record, and a
 * typed refusal from a road's call or its future, with {@code ArchitectRefused(SITE_BUSY).busy()}: never "No site" and never text in a
 * {@code RemoveResult(false)}. Reflective so it compiles on the red base (where the helpers are missing).
 */
class T4RDFixBusyRoutesTest {
	@AfterEach
	void reset() {
		OwnerRemovals.read(null, null);
	}

	static Method method(Class<?> c, String name, Class<?>... args) {
		try {
			Method m = c.getDeclaredMethod(name, args);
			m.setAccessible(true);
			return m;
		} catch (NoSuchMethodException e) {
			return null;
		}
	}

	@Test
	void aPendingMemberAnswersHeldDecidedTyped() throws Exception {
		System.out.println("ROW T4RDF-busy-routes (unit): a pending member");
		OwnerRemovals.put("removal:a@u:a", com.google.gson.JsonParser.parseString("{\"v\":1,\"kind\":\"site\",\"base\":\"a\",\"undoGroup\":\"u:a\","
			+ "\"dim\":\"minecraft:overworld\",\"order\":[\"b\",\"a\"],\"members\":{\"b\":{\"paid\":false,\"box\":[0,64,0,1,64,1],\"player\":[]},"
			+ "\"a\":{\"paid\":true,\"box\":[0,63,0,1,63,1],\"player\":[]}},\"r1\":[]}").getAsJsonObject());
		Method held = method(Sites.class, "heldDecided", String.class);
		assertNotNull(held, "T4RDF-busy-routes: no route-level held(decided) check (SitesImpl answers \"No site\" for a pending member)");
		Sites.SiteException e = (Sites.SiteException) held.invoke(null, "b");
		assertNotNull(e, "T4RDF-busy-routes: a pending member of a live owner record is held(decided)");
		assertNotNull(e.busy(), "typed");
		assertEquals(Busy.Kind.HELD_DECIDED, e.busy().kind());
		assertEquals("a", e.busy().blockingId(), "its removal's base");
		assertEquals(null, held.invoke(null, "zzz"), "no record names it: no answer (the route says No site)");
	}

	@Test
	void aRoadFutureFailingTypedStaysTyped() throws Exception {
		System.out.println("ROW T4RDF-busy-routes (unit): a road's future");
		Class<?> impl = Class.forName("dev.larattalabs.architect.apiimpl.SitesImpl");
		Method failure = method(impl, "answerFailure", Throwable.class);
		assertNotNull(failure, "T4RDF-busy-routes: a road's removal future turns a typed refusal into text (no answerFailure)");
		Busy b = new Busy(Busy.Kind.REMOVAL_IN_PROGRESS, "x", "site", null);
		CompletableFuture<?> f = (CompletableFuture<?>) failure.invoke(null, new CompletionException(new Sites.SiteException(Reason.SITE_BUSY, "Not yet", b)));
		ExecutionException ex = org.junit.jupiter.api.Assertions.assertThrows(ExecutionException.class, f::get, "T4RDF-busy-routes: fails, not RemoveResult(false)");
		assertTrue(ex.getCause() instanceof ArchitectRefused ar && ar.busy() != null && ar.busy().equals(b), "T4RDF-busy-routes: its Busy kept: " + ex.getCause());
		Method answer = method(impl, "answer", Sites.SiteException.class);
		CompletableFuture<?> h = (CompletableFuture<?>) answer.invoke(null, new Sites.SiteException(Reason.SITE_BUSY, "held(decided) r: in progress"));
		assertThrows(h);
	}

	static void assertThrows(CompletableFuture<?> f) {
		ExecutionException ex = org.junit.jupiter.api.Assertions.assertThrows(ExecutionException.class, f::get);
		assertTrue(ex.getCause() instanceof ArchitectRefused, "held(decided) fails SITE_BUSY");
	}

	@Test
	void everyPublicRouteAsksFirst() throws Exception {
		System.out.println("ROW T4RDF-busy-routes (unit): the routes");
		String src = Files.readString(Path.of("src/main/java/dev/larattalabs/architect/apiimpl/SitesImpl.java"));
		int remove = src.indexOf("public CompletableFuture<RemoveResult> remove(String siteId, RemoveOptions o)");
		int held = src.indexOf("Sites.heldDecided(siteId)", remove);
		int infra = src.indexOf("removeInfra(siteId, o)", remove);
		assertTrue(remove > 0 && held > 0 && held < infra, "T4RDF-busy-routes: remove() asks heldDecided before the road and No-site branches");
		int ri = src.indexOf("private CompletableFuture<RemoveResult> removeInfra(");
		int end = src.indexOf("private static RemoveResult refused(", ri);
		String body = src.substring(ri, end);
		assertTrue(body.contains("exceptionallyCompose") && body.contains("return answer(e)"), "T4RDF-busy-routes: removeInfra maps typed refusals");
	}
}
