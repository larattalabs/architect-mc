package dev.larattalabs.architect.apiimpl;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.larattalabs.architect.Architect;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Function;
import java.util.function.Predicate;
import org.jspecify.annotations.Nullable;

/**
 * The sidecar's records of one 4b kind (groups, bible jobs, re-skins) as the API keeps them: merged from snapshots (which hold
 * only the last 20 plus the unfinished ones) and upserts, and which UPDATED / DONE events to fire, deduplicated by a
 * {@link JobLedger} (a record is keyed {@code id@createdAt}). The DONE set and the newest {@code keep} records are persisted in
 * {@code file}, so a reconnect, a sidecar restart or a game restart never fires DONE twice, and {@code list(owner)} still has
 * what finished while the caller was away. Thread-safe (synchronized); the caller fires the events on the server thread.
 * Internal.
 */
final class RecordBook {
	private static final Gson GSON = new GsonBuilder().disableHtmlEscaping().create();

	/** What to do with one record: fire UPDATED, fire DONE (both may be true). */
	record Firing(JsonObject raw, boolean updated, boolean done) {
	}

	private final String kind;
	private final Path file;
	private final int keep;
	private final Predicate<JsonObject> finished;
	private final Function<JsonObject, JobLedger.Mark> mark;
	private final Map<String, JsonObject> records = new LinkedHashMap<>();
	private final JobLedger ledger = new JobLedger();
	private boolean loaded;

	RecordBook(String kind, Path file, int keep, Predicate<JsonObject> finished, Function<JsonObject, JobLedger.Mark> mark) {
		this.kind = kind;
		this.file = file;
		this.keep = keep;
		this.finished = finished;
		this.mark = mark;
	}

	static String str(JsonObject o, String k) {
		JsonElement e = o.get(k);
		return e != null && e.isJsonPrimitive() ? e.getAsString() : "";
	}

	static long num(JsonObject o, String k) {
		JsonElement e = o.get(k);
		return e != null && e.isJsonPrimitive() && e.getAsJsonPrimitive().isNumber() ? e.getAsLong() : 0L;
	}

	static String key(JsonObject o) {
		return JobLedger.key(str(o, "id"), num(o, "createdAt"));
	}

	synchronized void load() {
		if (loaded) {
			return;
		}
		loaded = true;
		if (!Files.exists(file)) {
			return;
		}
		try {
			JsonObject o = JsonParser.parseString(Files.readString(file, StandardCharsets.UTF_8)).getAsJsonObject();
			List<String> keys = new ArrayList<>();
			if (o.has("done") && o.get("done").isJsonArray()) {
				o.getAsJsonArray("done").forEach(x -> keys.add(x.getAsString()));
			}
			ledger.restoreDone(keys);
			if (o.has("records") && o.get("records").isJsonArray()) {
				for (JsonElement e : o.getAsJsonArray("records")) {
					if (e.isJsonObject() && !str(e.getAsJsonObject(), "id").isEmpty()) {
						records.putIfAbsent(str(e.getAsJsonObject(), "id"), e.getAsJsonObject());
					}
				}
			}
		} catch (IOException | RuntimeException e) {
			Architect.LOGGER.warn("Could not read {}; finished {}s may be reported again", file, kind, e);
		}
	}

	private synchronized void save() {
		JsonObject o = new JsonObject();
		JsonArray done = new JsonArray();
		ledger.doneKeys().forEach(done::add);
		o.add("done", done);
		JsonArray rs = new JsonArray();
		records.values().stream().sorted(Comparator.comparingLong(r -> num(r, "createdAt"))).skip(Math.max(0, records.size() - keep)).forEach(rs::add);
		o.add("records", rs);
		try {
			Files.createDirectories(file.getParent());
			Path tmp = file.resolveSibling(file.getFileName() + ".tmp");
			Files.writeString(tmp, GSON.toJson(o), StandardCharsets.UTF_8);
			Files.move(tmp, file, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
		} catch (IOException e) {
			Architect.LOGGER.warn("Could not save {}", file, e);
		}
	}

	/** Merges a record as received (a copy is kept); returns it. A record with no id is dropped (null). */
	synchronized @Nullable JsonObject merge(JsonObject raw) {
		load();
		String id = str(raw, "id");
		if (id.isEmpty()) {
			return null;
		}
		JsonObject copy = raw.deepCopy();
		records.put(id, copy);
		// trim: the oldest finished ones beyond twice what is persisted
		if (records.size() > 2 * keep) {
			List<String> old = records.values().stream().filter(finished).sorted(Comparator.comparingLong(r -> num(r, "updatedAt")))
				.map(r -> str(r, "id")).toList();
			for (int i = 0; i < old.size() && records.size() > 2 * keep; i++) {
				records.remove(old.get(i));
			}
		}
		return copy;
	}

	/**
	 * What to fire for a record now (call on the server thread, after {@link #merge}): UPDATED when its mark changed since the
	 * last one, DONE once ever when it is finished. Nothing for a record reported done before. Persists when DONE fires (and
	 * keeps the record either way).
	 */
	synchronized Firing fire(JsonObject raw) {
		load();
		String key = key(raw);
		if (ledger.isDone(key)) {
			return new Firing(raw, false, false);
		}
		boolean upd = ledger.updated(key, mark.apply(raw));
		boolean done = ledger.done(key, finished.test(raw));
		if (done || upd && finished.test(raw)) {
			save();
		}
		return new Firing(raw, upd, done);
	}

	/** Finished records not reported DONE yet (a world loaded), oldest first. */
	synchronized List<JsonObject> pendingDone() {
		load();
		return records.values().stream().filter(finished).filter(r -> !ledger.isDone(key(r))).sorted(Comparator.comparingLong(r -> num(r, "updatedAt")))
			.toList();
	}

	synchronized @Nullable JsonObject get(String id) {
		load();
		return records.get(id);
	}

	/** Every record, newest first. */
	synchronized List<JsonObject> all() {
		load();
		List<JsonObject> out = new ArrayList<>(records.values());
		out.sort(Comparator.comparingLong((JsonObject r) -> num(r, "createdAt")).reversed().thenComparing(r -> str(r, "id"), Comparator.reverseOrder()));
		return out;
	}

	synchronized boolean isDone(JsonObject raw) {
		load();
		return ledger.isDone(key(raw));
	}
}
