package dev.larattalabs.architect.site;

import java.security.SecureRandom;
import java.util.HashMap;
import java.util.HexFormat;
import java.util.Map;
import java.util.function.LongSupplier;
import java.util.function.Supplier;

/**
 * Slice SAFETY: the one-time tokens behind {@code /architect remove <site>}'s [Confirm] link (pure, unit-tested in {@code
 * RemoveTokensTest}). A token names one site, the force flag and who asked (a player's UUID, else the source's name); it is
 * good for {@value #TTL_MS} ms and for one use, so a [Confirm] scrolled back to in chat later, or clicked twice, never removes
 * anything.
 */
public final class RemoveTokens {
	/** How long a [Confirm] link stays good. */
	public static final long TTL_MS = 30_000;

	/** The server's tokens (a world's session; cleared with {@link LastPlaced}'s lifecycle). */
	public static final RemoveTokens INSTANCE = new RemoveTokens(System::currentTimeMillis, RemoveTokens::randomId);

	public enum Check {
		/** Good: remove it. */
		OK,
		/** It was good, but more than {@link #TTL_MS} ago. */
		EXPIRED,
		/** Never issued, used already, or for another site, force flag or person. */
		INVALID
	}

	private record Entry(String site, boolean force, String who, long expires) {
	}

	private final Map<String, Entry> tokens = new HashMap<>();
	private final LongSupplier clock;
	private final Supplier<String> ids;

	public RemoveTokens(LongSupplier clock, Supplier<String> ids) {
		this.clock = clock;
		this.ids = ids;
	}

	/** A new token for removing {@code site} (with {@code force}) by {@code who}. */
	public synchronized String issue(String site, boolean force, String who) {
		long now = clock.getAsLong();
		tokens.values().removeIf(e -> e.expires() < now);
		String t;
		do {
			t = ids.get();
		} while (tokens.containsKey(t));
		tokens.put(t, new Entry(site, force, who, now + TTL_MS));
		return t;
	}

	/** Uses {@code token} (whatever the answer, it is gone afterwards when it named this site). */
	public synchronized Check use(String token, String site, boolean force, String who) {
		Entry e = tokens.get(token);
		if (e == null || !e.site().equals(site) || e.force() != force || !e.who().equals(who)) {
			return Check.INVALID;
		}
		tokens.remove(token);
		return clock.getAsLong() > e.expires() ? Check.EXPIRED : Check.OK;
	}

	public synchronized void clear() {
		tokens.clear();
	}

	public synchronized int size() {
		return tokens.size();
	}

	private static final SecureRandom RANDOM = new SecureRandom();

	private static String randomId() {
		byte[] b = new byte[4];
		RANDOM.nextBytes(b);
		return HexFormat.of().formatHex(b);
	}
}
