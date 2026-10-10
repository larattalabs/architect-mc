package dev.larattalabs.architect.apiimpl;

import com.google.gson.JsonObject;
import dev.larattalabs.architect.Architect;
import dev.larattalabs.architect.api.Bible;
import dev.larattalabs.architect.api.BibleJob;
import dev.larattalabs.architect.api.BibleRequest;
import dev.larattalabs.architect.api.Bibles;
import dev.larattalabs.architect.api.Estimate;
import dev.larattalabs.architect.placement.Blueprints;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.concurrent.CompletableFuture;
import org.jspecify.annotations.Nullable;

/**
 * {@link Bibles}: the installed bibles read from {@code <gameDir>/architect/bibles/} (cached for a second, dropped when a
 * bible is installed), the built-in ones from the sidecar's {@code bible.index}, and the bible jobs ({@code bible.upsert},
 * {@code snapshot.bibles}) merged in a {@link RecordBook} ({@code api-bibles.json}) with BIBLE_UPDATED / BIBLE_DONE fired
 * once on the server thread. Internal.
 */
public final class BiblesImpl implements Bibles {
	private static final long RESCAN_MS = 1000;

	final RecordBook jobs = new RecordBook("bible job", Blueprints.gameDataDir().resolve("api-bibles.json"), 100,
		j -> BibleJob.Status.of(RecordBook.str(j, "status")).isFinal(), j -> new JobLedger.Mark(RecordBook.str(j, "status"), RecordBook.str(j, "step"),
			RecordBook.num(j, "updatedAt"), Wire4b.cost(j).usd()));
	/** The sidecar's index (installed + built-in), as last received. */
	private volatile List<Bible> index = List.of();
	private volatile List<Bible> installed = List.of();
	private volatile long scannedAt;

	/** {@code <gameDir>/architect/bibles}: the sidecar's default {@code --bibles} folder. */
	public static Path dir() {
		return Blueprints.gameDataDir().resolve("bibles");
	}

	/** {@code bible.index} / {@code snapshot.bibleIndex} (any thread). */
	void index(List<JsonObject> raws) {
		List<Bible> out = new ArrayList<>();
		for (JsonObject r : raws) {
			try {
				out.add(Wire4b.bibleInfo(r));
			} catch (RuntimeException e) {
				Architect.LOGGER.warn("API: a bible the helper listed could not be read: {}", e.toString());
			}
		}
		index = List.copyOf(out);
		scannedAt = 0;
	}

	/** The disk changed (a bible was installed): rescan on the next read. */
	void invalidate() {
		scannedAt = 0;
	}

	private List<Bible> installed() {
		long now = System.currentTimeMillis();
		if (now - scannedAt > RESCAN_MS) {
			installed = List.copyOf(Wire4b.installed(dir()));
			scannedAt = now;
		}
		return installed;
	}

	/** Installed (latest versions, by id) then the built-in ones the sidecar lists (never one shadowed by an installed id). */
	public List<Bible> all() {
		List<Bible> out = new ArrayList<>(installed());
		for (Bible b : index) {
			if (b.builtin() && out.stream().noneMatch(x -> x.id().equals(b.id()))) {
				out.add(b);
			}
		}
		return out;
	}

	@Override
	public Optional<Bible> get(String bibleId) {
		return all().stream().filter(b -> b.id().equals(bibleId)).findFirst();
	}

	@Override
	public Optional<Bible> get(String bibleId, int version) {
		Bible b = Wire4b.installed(dir(), bibleId, version);
		if (b != null) {
			return Optional.of(b);
		}
		return get(bibleId).filter(x -> x.version() == version);
	}

	@Override
	public List<Bible> list(@Nullable String owner) {
		return all().stream().filter(b -> owner == null || owner.equals(b.owner().orElse(null))).toList();
	}

	@Override
	public CompletableFuture<BibleJob> request(BibleRequest r) {
		CompletableFuture<BibleJob> limit = FieldLimits.refuse(FieldLimits.bible(r)); // 6c 0c §5
		if (limit != null) {
			return limit;
		}
		JsonObject m = DesignsImpl.msg("bible.request");
		try {
			m.add("request", Wire4b.bibleRequest(r));
		} catch (IllegalArgumentException e) {
			return ApiImpl.onServerFuture(CompletableFuture.failedFuture(e));
		}
		if (r.sheetCritique()) {
			String why = DesignsImpl.unavailable4b(ApiImpl.bridge(), "critique", "sheet critiques");
			if (why != null) {
				return ApiImpl.onServerFuture(CompletableFuture.failedFuture(new IllegalStateException(why)));
			}
		}
		return DesignsImpl.ask("bibles", "bibles", m).thenApply(this::acked);
	}

	@Override
	public CompletableFuture<BibleJob> revise(String bibleId, String notes) {
		return revise(bibleId, notes, false);
	}

	@Override
	public CompletableFuture<BibleJob> revise(String bibleId, String notes, boolean sheetCritique) {
		JsonObject m = DesignsImpl.msg("bible.revise");
		m.addProperty("id", bibleId);
		m.addProperty("notes", notes == null ? "" : notes);
		if (sheetCritique) {
			String why = DesignsImpl.unavailable4b(ApiImpl.bridge(), "critique", "sheet critiques");
			if (why != null) {
				return ApiImpl.onServerFuture(CompletableFuture.failedFuture(new IllegalStateException(why)));
			}
			m.add("critique", Wire4b.sheetCritique());
		}
		return DesignsImpl.ask("bibles", "bibles", m).thenApply(this::acked);
	}

	@Override
	public CompletableFuture<List<Integer>> delete(String bibleId, @Nullable String owner) {
		JsonObject m = DesignsImpl.msg("bible.delete");
		m.addProperty("id", bibleId);
		if (owner != null) {
			m.addProperty("owner", owner);
		}
		return DesignsImpl.ask("bible.admin", "bible deletes", m).thenApply(res -> {
			invalidate();
			List<Integer> vs = new ArrayList<>();
			if (res.has("versions") && res.get("versions").isJsonArray()) {
				res.getAsJsonArray("versions").forEach(v -> vs.add(v.getAsInt()));
			}
			Architect.LOGGER.info("API: bible {} deleted (versions {})", bibleId, vs);
			return List.copyOf(vs);
		});
	}

	@Override
	public CompletableFuture<Void> archive(String bibleId, boolean archived) {
		JsonObject m = DesignsImpl.msg("bible.archive");
		m.addProperty("id", bibleId);
		m.addProperty("archived", archived);
		return DesignsImpl.ask("bible.admin", "bible archives", m).thenApply(res -> {
			invalidate();
			return null;
		});
	}

	/** The job named in an ack ({@code {jobId, bibleId, version}}): as the helper reported it, else a queued placeholder. */
	private BibleJob acked(JsonObject res) {
		String jobId = res.has("jobId") ? res.get("jobId").getAsString() : null;
		if (jobId == null) {
			throw new IllegalStateException("the helper sent no jobId");
		}
		Architect.LOGGER.info("API: bible job {} ({} v{}) started", jobId, res.has("bibleId") ? res.get("bibleId").getAsString() : "?",
			res.has("version") ? res.get("version").getAsInt() : 0);
		JsonObject known = jobs.get(jobId);
		if (known != null) {
			return Wire4b.bibleJob(known);
		}
		JsonObject j = new JsonObject();
		j.addProperty("id", jobId);
		j.add("bibleId", res.get("bibleId"));
		j.add("version", res.get("version"));
		j.addProperty("status", "queued");
		return Wire4b.bibleJob(j);
	}

	@Override
	public void cancel(String jobId) {
		JsonObject m = DesignsImpl.msg("bible.cancel");
		m.addProperty("jobId", jobId);
		DesignsImpl.ask("bibles", "bibles", m).whenComplete((r, e) -> {
			if (e != null) {
				Architect.LOGGER.info("API: cancelling bible job {}: {}", jobId, JobsImpl.message(e));
			}
		});
	}

	@Override
	public CompletableFuture<Estimate> estimate(@Nullable BibleRequest r) {
		JsonObject m = DesignsImpl.msg("bible.estimate");
		if (r != null) {
			try {
				m.add("request", Wire4b.bibleRequest(r));
			} catch (IllegalArgumentException e) {
				return ApiImpl.onServerFuture(CompletableFuture.failedFuture(e));
			}
		}
		return DesignsImpl.ask("estimates", "estimates", m).thenApply(Wire4b::estimate);
	}

	@Override
	public Optional<BibleJob> job(String jobId) {
		JsonObject j = jobs.get(jobId);
		return j == null ? Optional.empty() : Optional.of(Wire4b.bibleJob(j));
	}

	@Override
	public List<BibleJob> jobs(@Nullable String owner) {
		List<BibleJob> out = new ArrayList<>();
		for (JsonObject j : jobs.all()) {
			BibleJob v = Wire4b.bibleJob(j);
			if (owner == null || owner.equals(v.owner().orElse(null))) {
				out.add(v);
			}
		}
		return out;
	}

	/** {@code bible.upsert} (any thread). */
	void jobChanged(JsonObject raw) {
		JsonObject j = jobs.merge(raw);
		if (j != null) {
			if (BibleJob.Status.of(RecordBook.str(j, "status")) == BibleJob.Status.DONE) {
				invalidate();
			}
			ApiImpl.runOnServer(() -> fire(j));
		}
	}

	void fire(JsonObject raw) {
		RecordBook.Firing f = jobs.fire(raw);
		if (!f.updated() && !f.done()) {
			return;
		}
		BibleJob j = Wire4b.bibleJob(raw);
		if (f.updated()) {
			ApiEvents.bibleUpdated(j);
		}
		if (f.done()) {
			invalidate();
			ApiEvents.bibleDone(j);
		}
	}

	/** A world loaded (server thread). */
	void catchUp() {
		jobs.pendingDone().forEach(this::fire);
	}
}
