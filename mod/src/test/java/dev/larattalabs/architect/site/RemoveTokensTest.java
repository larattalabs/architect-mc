package dev.larattalabs.architect.site;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;

import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import org.junit.jupiter.api.Test;

/** SAFETY: /architect remove's [Confirm] tokens: one use, 30 s, for one site, force flag and person. */
class RemoveTokensTest {
	private final AtomicLong now = new AtomicLong(1_000_000);
	private final AtomicInteger n = new AtomicInteger();
	private final RemoveTokens tokens = new RemoveTokens(now::get, () -> "t" + n.incrementAndGet());
	private static final String ME = "00000000-0000-0000-0000-000000000001";

	@Test
	void goodOnceWithinThirtySeconds() {
		String t = tokens.issue("cabin_1", false, ME);
		now.addAndGet(RemoveTokens.TTL_MS); // exactly 30 s later: still good
		assertEquals(RemoveTokens.Check.OK, tokens.use(t, "cabin_1", false, ME));
		assertEquals(RemoveTokens.Check.INVALID, tokens.use(t, "cabin_1", false, ME), "a second click never removes again");
	}

	@Test
	void expiresAfterThirtySeconds() {
		String t = tokens.issue("cabin_1", false, ME);
		now.addAndGet(RemoveTokens.TTL_MS + 1);
		assertEquals(RemoveTokens.Check.EXPIRED, tokens.use(t, "cabin_1", false, ME));
		assertEquals(RemoveTokens.Check.INVALID, tokens.use(t, "cabin_1", false, ME), "and it is gone");
	}

	@Test
	void boundToSiteForceAndPerson() {
		String t = tokens.issue("cabin_1", false, ME);
		assertEquals(RemoveTokens.Check.INVALID, tokens.use(t, "cabin_2", false, ME), "another site");
		assertEquals(RemoveTokens.Check.INVALID, tokens.use(t, "cabin_1", true, ME), "with force: a token without it");
		assertEquals(RemoveTokens.Check.INVALID, tokens.use(t, "cabin_1", false, "source:Server"), "another person");
		assertEquals(RemoveTokens.Check.OK, tokens.use(t, "cabin_1", false, ME), "a mismatch does not use it up");
		assertEquals(RemoveTokens.Check.INVALID, tokens.use("nope", "cabin_1", false, ME));
	}

	@Test
	void tokensAreDistinctAndExpiredOnesArePruned() {
		String a = tokens.issue("cabin_1", false, ME);
		String b = tokens.issue("cabin_1", false, ME);
		assertNotEquals(a, b);
		now.addAndGet(RemoveTokens.TTL_MS + 1);
		tokens.issue("cabin_3", false, ME);
		assertEquals(1, tokens.size(), "the two old ones went when the new one was issued");
	}
}
