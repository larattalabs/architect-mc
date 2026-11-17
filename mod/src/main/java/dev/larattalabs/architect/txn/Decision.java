package dev.larattalabs.architect.txn;

import com.google.gson.JsonObject;
import java.util.List;
import java.util.Set;
import java.util.TreeSet;
import org.jspecify.annotations.Nullable;

/**
 * (slice T1, docs/TXN-DESIGN.md §3.3, §3.6) A txn's immutable decision, separate from its {@link Phase}: {@code commit}, {@code abort}, or
 * {@code abandon} with its recorded member split (the written members settle forward, the rest compensate; the split is never recomputed).
 * Once written OK it never changes; only {@code abandon} may follow {@code commit} (T5).
 */
public record Decision(String v, @Nullable Set<String> written) {
	public static final String COMMIT = "commit";
	public static final String ABORT = "abort";
	public static final String ABANDON = "abandon";

	public Decision {
		if (!COMMIT.equals(v) && !ABORT.equals(v) && !ABANDON.equals(v)) {
			throw new IllegalArgumentException("unknown decision " + v);
		}
		if (ABANDON.equals(v) == (written == null)) {
			throw new IllegalArgumentException("an abandon (and only an abandon) carries its split");
		}
		written = written == null ? null : Set.copyOf(written);
	}

	public static Decision commit() {
		return new Decision(COMMIT, null);
	}

	public static Decision abort() {
		return new Decision(ABORT, null);
	}

	public static Decision abandon(Set<String> writtenMembers) {
		return new Decision(ABANDON, writtenMembers);
	}

	public boolean isCommit() {
		return COMMIT.equals(v);
	}

	public boolean isAbort() {
		return ABORT.equals(v);
	}

	public boolean isAbandon() {
		return ABANDON.equals(v);
	}

	public JsonObject toJson() {
		JsonObject o = new JsonObject();
		o.addProperty("v", v);
		if (written != null) {
			JsonObject s = new JsonObject();
			com.google.gson.JsonArray w = new com.google.gson.JsonArray();
			new TreeSet<>(written).forEach(w::add);
			s.add("written", w);
			o.add("split", s);
		}
		return o;
	}

	public static @Nullable Decision fromJson(com.google.gson.@Nullable JsonElement e) {
		if (e == null || e.isJsonNull()) {
			return null;
		}
		JsonObject o = e.getAsJsonObject();
		String v = o.get("v").getAsString();
		if (!ABANDON.equals(v)) {
			return new Decision(v, null);
		}
		JsonObject s = o.getAsJsonObject("split");
		List<String> w = new java.util.ArrayList<>();
		s.getAsJsonArray("written").forEach(x -> w.add(x.getAsString()));
		return new Decision(v, new TreeSet<>(w));
	}
}
