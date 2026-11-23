package dev.larattalabs.architect.apiimpl;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import dev.larattalabs.architect.api.ArchitectRefused;
import dev.larattalabs.architect.api.Reason;
import dev.larattalabs.architect.site.Sites;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;
import java.util.concurrent.ExecutionException;
import org.junit.jupiter.api.Test;

/**
 * (slice LR2-FIX, fix-check P2-3) A removal refused while its entities load is typed for API callers: the remove route's mapping
 * ({@code SitesImpl.answer}, the call the sync route makes, and {@code answerFailure}, a future's) fails with ArchitectRefused(NOT_LOADED),
 * never a text-only RemoveResult(false). Row LR2F-api.
 */
class RemoveNotLoadedLR2Test {
	static Reason reasonOf(CompletableFuture<?> f) throws InterruptedException {
		assertTrue(f.isDone());
		try {
			Object v = f.get();
			throw new AssertionError("LR2F-api: answered " + v + ", not a typed refusal");
		} catch (ExecutionException e) {
			assertTrue(e.getCause() instanceof ArchitectRefused, "LR2F-api: " + e.getCause());
			return ((ArchitectRefused) e.getCause()).reason();
		}
	}

	@Test
	void aRemovalWaitingForItsEntitiesIsATypedNotLoaded() throws Exception {
		System.out.println("ROW LR2F-api (unit)");
		Sites.SiteException se = new Sites.SiteException(Reason.NOT_LOADED, "Removing a waits for the entities around it to load");
		assertEquals(Reason.NOT_LOADED, reasonOf(SitesImpl.answer(se)), "LR2F-api: the sync route");
		assertEquals(Reason.NOT_LOADED, reasonOf(SitesImpl.answerFailure(new CompletionException(se))), "LR2F-api: a future's failure");
	}
}
