package dev.larattalabs.architect.txn;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.Map;
import org.jspecify.annotations.Nullable;

/**
 * (slice T1, docs/TXN-DESIGN.md §3.7) The bounded result cache ({@code done}): the last {@value #MAX} finished txns as {@code {id, key,
 * decision, result, payloads}}, oldest evicted first. Attempts and dedupe are separate (round 4): {@link #committed} answers a dedupe key
 * only from a <b>committed</b> result; an aborted attempt is kept under its id for tracing and never answers its key, so a retry after an
 * abort is a fresh attempt.
 */
public final class ResultCache {
	public static final int MAX = 4096;

	/** One finished txn. */
	public record Done(String id, @Nullable String key, String decision, JsonObject result, JsonObject payloads) {
		JsonObject toJson() {
			JsonObject o = new JsonObject();
			o.addProperty("id", id);
			if (key != null) {
				o.addProperty("key", key);
			}
			o.addProperty("decision", decision);
			o.add("result", result.deepCopy());
			o.add("payloads", payloads.deepCopy());
			return o;
		}

		static Done fromJson(JsonObject o) {
			return new Done(o.get("id").getAsString(), o.has("key") ? o.get("key").getAsString() : null, o.get("decision").getAsString(),
				o.get("result") instanceof JsonObject r ? r : new JsonObject(), o.get("payloads") instanceof JsonObject p ? p : new JsonObject());
		}
	}

	private final int max;
	/** TEST seam (TxnCrashModel's naive variant, review 4 P2-4): an aborted result answers its key as a committed one would. */
	final boolean answerAborted;
	private final LinkedHashMap<String, Done> byId = new LinkedHashMap<>();
	private final Map<String, String> committedByKey = new LinkedHashMap<>();

	public ResultCache() {
		this(MAX, false);
	}

	ResultCache(int max, boolean answerAborted) {
		this.max = max;
		this.answerAborted = answerAborted;
	}

	void add(Done d) {
		byId.put(d.id(), d);
		if (d.key() != null && (Decision.COMMIT.equals(d.decision()) || Decision.ABANDON.equals(d.decision()) || answerAborted)) {
			committedByKey.put(d.key(), d.id());
		}
		for (Iterator<Map.Entry<String, Done>> it = byId.entrySet().iterator(); byId.size() > max && it.hasNext();) {
			Done old = it.next().getValue();
			it.remove();
			if (old.key() != null && old.id().equals(committedByKey.get(old.key()))) {
				committedByKey.remove(old.key());
			}
		}
	}

	/** The committed result for a dedupe key (to replay, never to re-run), or null (none, only aborted attempts, or evicted). */
	public @Nullable Done committed(String key) {
		String id = committedByKey.get(key);
		return id == null ? null : byId.get(id);
	}

	public @Nullable Done byId(String id) {
		return byId.get(id);
	}

	public int size() {
		return byId.size();
	}

	JsonArray toJson() {
		JsonArray a = new JsonArray();
		byId.values().forEach(d -> a.add(d.toJson()));
		return a;
	}

	void load(@Nullable JsonArray a) {
		byId.clear();
		committedByKey.clear();
		if (a != null) {
			a.forEach(x -> {
				if (x.isJsonObject()) {
					add(Done.fromJson(x.getAsJsonObject()));
				}
			});
		}
	}
}
