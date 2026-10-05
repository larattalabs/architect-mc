package dev.larattalabs.architect.apiimpl;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonNull;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.larattalabs.architect.Architect;
import dev.larattalabs.architect.api.Cost;
import dev.larattalabs.architect.api.Job;
import dev.larattalabs.architect.api.JobSpec;
import dev.larattalabs.architect.api.Jobs;
import dev.larattalabs.architect.api.SiteEvents;
import dev.larattalabs.architect.api.ToolHandler;
import dev.larattalabs.architect.placement.Blueprints;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import net.minecraft.server.MinecraftServer;
import org.jspecify.annotations.Nullable;

/**
 * {@link Jobs} over the client's sidecar link (protocol 2, docs/CONTRACT.md "Jobs (R2)" and "Phase 4a sidecar as built").
 *
 * <ul>
 *   <li>Jobs: {@code job.run} / {@code job.cancel}; the jobs the sidecar reports ({@code snapshot.jobs}, {@code job.upsert})
 *   are merged here (a snapshot holds only the last 20 plus the unfinished ones), and {@code JOB_UPDATED} / {@code JOB_DONE}
 *   fire on the server thread, deduplicated by {@link JobLedger}. The DONE set is kept in
 *   {@code <gameDir>/architect/api-jobs.json}, so a reconnect, a sidecar restart or a game restart never fires DONE twice; a
 *   job that finished while no world was loaded fires when one loads ({@link #catchUp}). A result over 256 KB
 *   ({@code resultBlob}) is read back from the sidecar's blob store before DONE fires.</li>
 *   <li>Tools: {@code job.tool.call} runs the handler registered for (owner, name) on the server thread, or on a worker when
 *   the tool is {@code readOnly} and the handler {@link ToolHandler#threadSafe() thread-safe}; the answer
 *   ({@code job.tool.result}, at most 256 KB, else a blob named in the result) is cached by callId ({@link ToolAnswerCache})
 *   before it is sent, so a call re-sent after a reconnect or a sidecar restart gets the same answer without running the
 *   handler again. {@code ok:false} "no pending tool call" (the job was cancelled or the call timed out) is dropped.</li>
 *   <li>Blobs: {@code blob.put} from Java, whole or in chunks of 1 MB, several frames for a big blob.</li>
 * </ul>
 * Internal.
 */
final class JobsImpl implements Jobs {
	/** The largest tool answer sent inline (the sidecar's limit is 256 KB of {@code JSON.stringify}; a little headroom). */
	static final int ANSWER_INLINE_MAX = 256 * 1024 - 2048;
	static final int ERROR_MAX = 10_000;
	private static final Gson GSON = new GsonBuilder().setPrettyPrinting().disableHtmlEscaping().create();
	/** Jobs kept in memory (beyond that, the oldest finished ones are forgotten). */
	private static final int JOBS_KEEP = 200;

	private final Map<String, ToolHandler> tools = new ConcurrentHashMap<>();
	private final Map<String, Job> jobs = new ConcurrentHashMap<>();
	private final ToolAnswerCache answers = new ToolAnswerCache(512);
	/** Server thread only. */
	private final JobLedger ledger = new JobLedger();
	private boolean ledgerLoaded;
	private final ExecutorService workers = Executors.newCachedThreadPool(r -> {
		Thread t = new Thread(r, "Architect-ToolWorker");
		t.setDaemon(true);
		return t;
	});

	// ------------------------------------------------------------------ Jobs

	@Override
	public CompletableFuture<String> run(JobSpec spec) {
		ClientBridge b = ApiImpl.bridge();
		String why = unavailable(b);
		if (why != null) {
			return ApiImpl.onServerFuture(CompletableFuture.failedFuture(new IllegalStateException(why)));
		}
		JsonObject m = new JsonObject();
		m.addProperty("type", "job.run");
		m.add("job", wire(spec));
		CompletableFuture<String> id = b.send(m).thenApply(ack -> {
			String jobId = ackString(ack, "jobId");
			Architect.LOGGER.info("API: job {} ({}{}) started", jobId, spec.kind(), spec.owner() == null ? "" : ", " + spec.owner());
			return jobId;
		});
		return ApiImpl.onServerFuture(id);
	}

	/** Why jobs can't run now, or null. */
	static @Nullable String unavailable(@Nullable ClientBridge b) {
		if (b == null) {
			return "jobs need the Architect client (no sidecar link on a dedicated server)";
		}
		if (!b.connected()) {
			return "the Architect helper is not running";
		}
		if (b.protocol() < 2) {
			return "jobs need protocol 2; this helper speaks protocol " + b.protocol();
		}
		if (!b.sidecarFeatures().contains("job.run") && !b.sidecarFeatures().contains("jobs")) {
			return "this helper does not run jobs";
		}
		return null;
	}

	@Override
	public void cancel(String jobId) {
		ClientBridge b = ApiImpl.bridge();
		if (b == null || !b.connected()) {
			return;
		}
		JsonObject m = new JsonObject();
		m.addProperty("type", "job.cancel");
		m.addProperty("jobId", jobId);
		b.send(m).whenComplete((ack, e) -> {
			if (e != null || !ack.get("ok").getAsBoolean()) {
				Architect.LOGGER.info("API: cancelling job {}: {}", jobId, e != null ? e.getMessage() : str(ack, "error"));
			}
		});
	}

	@Override
	public Optional<Job> get(String jobId) {
		return Optional.ofNullable(jobs.get(jobId));
	}

	@Override
	public List<Job> list(@Nullable String owner) {
		return jobs.values().stream().filter(j -> owner == null || owner.equals(j.owner().orElse(null)))
			.sorted(Comparator.comparingLong(Job::createdAt).reversed().thenComparing(Job::id, Comparator.reverseOrder())).toList();
	}

	@Override
	public void registerTool(String owner, String name, ToolHandler h) {
		if (owner == null || name == null || h == null) {
			throw new IllegalArgumentException("registerTool needs an owner, a name and a handler");
		}
		ToolHandler prev = tools.put(key(owner, name), h);
		if (prev != null && prev != h) {
			Architect.LOGGER.warn("API: tool {} of {} registered again; the new handler replaces the old one", name, owner);
		}
	}

	private static String key(String owner, String name) {
		return owner + "/" + name;
	}

	/** The handler registered for {@code (owner, name)}, or null. */
	@Nullable ToolHandler tool(@Nullable String owner, String name) {
		return owner == null ? null : tools.get(key(owner, name));
	}

	@Override
	public boolean available() {
		return unavailable(ApiImpl.bridge()) == null;
	}

	// ------------------------------------------------------------------ blobs

	@Override
	public CompletableFuture<String> putBlob(String kind, @Nullable String owner, JsonElement data) {
		return ApiImpl.onServerFuture(putBlobRaw(kind, owner, data));
	}

	@Override
	public CompletableFuture<String> putBlob(String kind, @Nullable String owner, byte[] data) {
		return ApiImpl.onServerFuture(putBytes(kind, owner, data, null));
	}

	/** {@link #putBlob(String, String, JsonElement)} without the hop to the server thread. */
	CompletableFuture<String> putBlobRaw(String kind, @Nullable String owner, JsonElement data) {
		String text = (data == null ? JsonNull.INSTANCE : data).toString();
		byte[] utf8 = text.getBytes(StandardCharsets.UTF_8);
		if (utf8.length > BlobFrames.JSON_WHOLE_MAX) {
			// too big for one frame: the JSON text as chunks, still a .json file in the job's scratch dir
			return putBytes(kind, owner, utf8, "json");
		}
		ClientBridge b = ApiImpl.bridge();
		String why = blobsUnavailable(b);
		if (why != null) {
			return CompletableFuture.failedFuture(new IllegalStateException(why));
		}
		JsonObject m = new JsonObject();
		m.addProperty("type", "blob.put");
		m.addProperty("kind", kind);
		if (owner != null) {
			m.addProperty("owner", owner);
		}
		m.add("data", data == null ? JsonNull.INSTANCE : data);
		return b.send(m).thenApply(ack -> ackString(ack, "blobId"));
	}

	private static @Nullable String blobsUnavailable(@Nullable ClientBridge b) {
		String why = unavailable(b);
		if (why != null) {
			return why;
		}
		return b.sidecarFeatures().contains("blobs") || b.sidecarFeatures().contains("blob.put") ? null : "this helper does not take blobs";
	}

	private CompletableFuture<String> putBytes(String kind, @Nullable String owner, byte[] data, @Nullable String ext) {
		ClientBridge b = ApiImpl.bridge();
		String why = blobsUnavailable(b);
		if (why != null) {
			return CompletableFuture.failedFuture(new IllegalStateException(why));
		}
		if (data.length > BlobFrames.MAX_BLOB_BYTES) {
			return CompletableFuture.failedFuture(new IllegalArgumentException("a blob is at most " + BlobFrames.MAX_BLOB_BYTES + " bytes (got "
				+ data.length + ")"));
		}
		List<List<String>> frames = BlobFrames.frames(data);
		CompletableFuture<String> chain = sendFrame(b, frames.get(0), null, kind, owner, ext, frames.size() > 1);
		for (int i = 1; i < frames.size(); i++) {
			List<String> f = frames.get(i);
			boolean more = i < frames.size() - 1;
			chain = chain.thenCompose(id -> sendFrame(b, f, id, kind, owner, ext, more));
		}
		return chain;
	}

	private static CompletableFuture<String> sendFrame(ClientBridge b, List<String> chunks, @Nullable String blobId, String kind, @Nullable String owner,
		@Nullable String ext, boolean more) {
		JsonObject m = new JsonObject();
		m.addProperty("type", "blob.put");
		if (blobId != null) {
			m.addProperty("blobId", blobId);
		} else {
			m.addProperty("kind", kind);
			if (owner != null) {
				m.addProperty("owner", owner);
			}
			if (ext != null) {
				m.addProperty("ext", ext);
			}
		}
		JsonArray arr = new JsonArray();
		chunks.forEach(arr::add);
		m.add("chunks", arr);
		if (more) {
			m.addProperty("more", true);
		}
		return b.send(m).thenApply(ack -> ackString(ack, "blobId"));
	}

	// ------------------------------------------------------------------ the sidecar's jobs (any thread)

	/** {@code snapshot.jobs}: merged (the snapshot holds only the last 20 and the unfinished ones). */
	void snapshot(List<JsonObject> raws) {
		List<Job> changed = new ArrayList<>();
		for (JsonObject raw : raws) {
			Job j = merge(raw);
			if (j != null) {
				changed.add(j);
			}
		}
		trim();
		ApiImpl.runOnServer(() -> changed.forEach(this::fire));
	}

	/** {@code job.upsert}. */
	void upsert(JsonObject raw) {
		Job j = merge(raw);
		if (j != null) {
			ApiImpl.runOnServer(() -> fire(j));
		}
	}

	private @Nullable Job merge(JsonObject raw) {
		Job j;
		try {
			j = view(raw);
		} catch (RuntimeException e) {
			Architect.LOGGER.warn("API: a job the helper sent could not be read: {}", e.toString());
			return null;
		}
		Job prev = jobs.get(j.id());
		if (prev != null && prev.createdAt() == j.createdAt() && prev.result().isPresent() && j.result().isEmpty() && j.resultBlob().isPresent()) {
			// keep a result already read back from its blob
			j = withResult(j, prev.result().get());
		}
		jobs.put(j.id(), j);
		return j;
	}

	private void trim() {
		if (jobs.size() <= JOBS_KEEP) {
			return;
		}
		List<Job> old = jobs.values().stream().filter(Job::finished).sorted(Comparator.comparingLong(Job::updatedAt)).toList();
		for (int i = 0; i < old.size() && jobs.size() > JOBS_KEEP; i++) {
			jobs.remove(old.get(i).id());
		}
	}

	static Job view(JsonObject o) {
		JsonObject spec = o.has("spec") && o.get("spec").isJsonObject() ? o.getAsJsonObject("spec").deepCopy() : new JsonObject();
		JsonElement result = o.get("result");
		return new Job(str(o, "id"), spec, def(str(o, "status"), "queued"), def(str(o, "step"), ""),
			result == null || result.isJsonNull() ? Optional.empty() : Optional.of(result.deepCopy()), Optional.ofNullable(str(o, "error")),
			o.has("cost") && o.get("cost").isJsonObject() ? Cost.fromJson(o.getAsJsonObject("cost")) : Cost.NONE, num(o, "createdAt"),
			num(o, "updatedAt"), Optional.ofNullable(str(o, "resultBlob")));
	}

	private static Job withResult(Job j, JsonElement result) {
		return new Job(j.id(), j.spec(), j.status(), j.step(), Optional.of(result), j.error(), j.cost(), j.createdAt(), j.updatedAt(), j.resultBlob());
	}

	private void loadLedger() {
		if (ledgerLoaded) {
			return;
		}
		ledgerLoaded = true;
		Path f = file();
		if (!Files.exists(f)) {
			return;
		}
		try {
			JsonObject o = JsonParser.parseString(Files.readString(f, StandardCharsets.UTF_8)).getAsJsonObject();
			List<String> keys = new ArrayList<>();
			if (o.has("done") && o.get("done").isJsonArray()) {
				o.getAsJsonArray("done").forEach(x -> keys.add(x.getAsString()));
			}
			ledger.restoreDone(keys);
		} catch (IOException | RuntimeException e) {
			Architect.LOGGER.warn("Could not read {}; finished jobs may be reported again", f, e);
		}
	}

	private static Path file() {
		return Blueprints.gameDataDir().resolve("api-jobs.json");
	}

	private void saveLedger() {
		JsonObject o = new JsonObject();
		JsonArray done = new JsonArray();
		ledger.doneKeys().forEach(done::add);
		o.add("done", done);
		Path f = file();
		try {
			Files.createDirectories(f.getParent());
			Path tmp = f.resolveSibling(f.getFileName() + ".tmp");
			Files.writeString(tmp, GSON.toJson(o), StandardCharsets.UTF_8);
			Files.move(tmp, f, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
		} catch (IOException e) {
			Architect.LOGGER.warn("Could not save {}", f, e);
		}
	}

	/** Server thread: JOB_UPDATED when the job changed since the last one, JOB_DONE once when it is finished. */
	private void fire(Job j) {
		loadLedger();
		String key = JobLedger.key(j.id(), j.createdAt());
		if (ledger.isDone(key)) {
			return; // reported before (a reconnect's snapshot, a restart): nothing new
		}
		if (ledger.updated(key, new JobLedger.Mark(j.status(), j.step(), j.updatedAt(), j.cost().usd()))) {
			guard("JOB_UPDATED", () -> SiteEvents.JOB_UPDATED.invoker().onUpdated(j));
		}
		if (!ledger.done(key, j.finished())) {
			return;
		}
		saveLedger();
		if (j.resultBlob().isPresent() && j.result().isEmpty()) {
			ClientBridge b = ApiImpl.bridge();
			CompletableFuture<byte[]> read = b == null ? CompletableFuture.failedFuture(new IllegalStateException("no client"))
				: b.readBlob(j.resultBlob().get());
			read.thenApply(bytes -> JsonParser.parseString(new String(bytes, StandardCharsets.UTF_8))).whenComplete((res, e) -> ApiImpl.runOnServer(() -> {
				Job done = j;
				if (e != null) {
					Architect.LOGGER.warn("API: job {}: its result blob {} could not be read ({}); JOB_DONE carries only the blob id", j.id(),
						j.resultBlob().get(), e.getMessage());
				} else {
					done = withResult(j, res);
					Job now = jobs.get(j.id());
					if (now != null && now.createdAt() == j.createdAt()) {
						jobs.put(j.id(), done);
					}
				}
				Job fin = done;
				guard("JOB_DONE", () -> SiteEvents.JOB_DONE.invoker().onDone(fin));
			}));
			return;
		}
		guard("JOB_DONE", () -> SiteEvents.JOB_DONE.invoker().onDone(j));
	}

	/** A world loaded (server thread): DONE for the jobs that finished while none was. */
	void catchUp(MinecraftServer server) {
		loadLedger();
		jobs.values().stream().filter(Job::finished).filter(j -> !ledger.isDone(JobLedger.key(j.id(), j.createdAt())))
			.sorted(Comparator.comparingLong(Job::updatedAt)).forEach(this::fire);
	}

	private static void guard(String what, Runnable r) {
		try {
			r.run();
		} catch (Throwable t) {
			Architect.LOGGER.warn("Firing {} failed", what, t);
		}
	}

	// ------------------------------------------------------------------ tool calls (any thread)

	/** {@code job.tool.call {jobId, callId, name, input, owner?, timeoutMs?}} from the sidecar. */
	void toolCall(JsonObject call) {
		String jobId = str(call, "jobId");
		String callId = str(call, "callId");
		String name = str(call, "name");
		if (jobId == null || callId == null || name == null) {
			Architect.LOGGER.warn("API: a tool call without jobId, callId or name: {}", call);
			return;
		}
		String owner = str(call, "owner");
		if (owner == null) {
			owner = jobs.containsKey(jobId) ? jobs.get(jobId).owner().orElse(null) : null;
		}
		switch (answers.begin(callId)) {
			case RESEND -> {
				JsonObject a = answers.get(callId);
				Architect.LOGGER.info("API: job {} re-sent tool call {} ({}): sending the cached answer", jobId, callId, name);
				if (a != null) {
					send(a, owner);
				}
				return;
			}
			case RUNNING -> {
				Architect.LOGGER.info("API: job {} re-sent tool call {} ({}): its handler is still running", jobId, callId, name);
				return;
			}
			case RUN -> {
			}
		}
		JsonObject input = call.has("input") && call.get("input").isJsonObject() ? call.getAsJsonObject("input") : new JsonObject();
		ToolHandler h = tool(owner, name);
		if (h == null) {
			finish(jobId, callId, owner, null, new IllegalStateException("no handler for " + name + " in this game"));
			return;
		}
		MinecraftServer server = ApiImpl.workingServer();
		if (server == null) {
			finish(jobId, callId, owner, null, new IllegalStateException("no world is running in this game, so " + name + " can't answer; try again once "
				+ "a world is loaded"));
			return;
		}
		boolean offThread = readOnly(jobId, name) && h.threadSafe();
		String o = owner;
		Runnable invoke = () -> {
			CompletableFuture<JsonElement> f;
			try {
				f = h.call(jobId, input.deepCopy());
				if (f == null) {
					f = CompletableFuture.failedFuture(new IllegalStateException("the handler of " + name + " returned no future"));
				}
			} catch (Throwable t) {
				f = CompletableFuture.failedFuture(t);
			}
			f.whenComplete((v, e) -> finish(jobId, callId, o, v, e));
		};
		try {
			if (offThread) {
				workers.execute(invoke);
			} else {
				server.execute(invoke);
			}
		} catch (RuntimeException e) {
			finish(jobId, callId, owner, null, new IllegalStateException("the game could not run " + name + ": " + e.getMessage()));
		}
	}

	/** Whether the job's spec declares tool {@code name} readOnly. */
	private boolean readOnly(String jobId, String name) {
		Job j = jobs.get(jobId);
		if (j == null || !j.spec().has("tools") || !j.spec().get("tools").isJsonArray()) {
			return false;
		}
		for (JsonElement t : j.spec().getAsJsonArray("tools")) {
			if (t.isJsonObject() && name.equals(str(t.getAsJsonObject(), "name"))) {
				JsonElement ro = t.getAsJsonObject().get("readOnly");
				return ro != null && ro.isJsonPrimitive() && ro.getAsBoolean();
			}
		}
		return false;
	}

	/** The handler finished: the answer (inline, or a blob for a big one), cached, then sent. */
	private void finish(String jobId, String callId, @Nullable String owner, @Nullable JsonElement value, @Nullable Throwable error) {
		if (error != null) {
			answer(jobId, callId, owner, null, message(error));
			return;
		}
		JsonElement v = value == null ? JsonNull.INSTANCE : value;
		int bytes = v.toString().getBytes(StandardCharsets.UTF_8).length;
		if (bytes <= ANSWER_INLINE_MAX) {
			answer(jobId, callId, owner, v, null);
			return;
		}
		viaBlob(jobId, callId, owner, v, bytes);
	}

	private void viaBlob(String jobId, String callId, @Nullable String owner, JsonElement v, int bytes) {
		putBlobRaw("tool.result", owner, v).whenComplete((blobId, e) -> {
			if (e != null) {
				answer(jobId, callId, owner, null, "the answer is " + bytes + " bytes, over 256 KB, and putting it in a blob failed: " + message(e));
				return;
			}
			JsonObject r = new JsonObject();
			r.addProperty("blob", blobId);
			r.addProperty("kind", "tool.result");
			r.addProperty("bytes", bytes);
			r.addProperty("note", "the answer is over 256 KB: it is in blob " + blobId);
			answer(jobId, callId, owner, r, null);
		});
	}

	private void answer(String jobId, String callId, @Nullable String owner, @Nullable JsonElement result, @Nullable String error) {
		JsonObject p = new JsonObject();
		p.addProperty("jobId", jobId);
		p.addProperty("callId", callId);
		if (error != null) {
			p.addProperty("error", error.length() > ERROR_MAX ? error.substring(0, ERROR_MAX - 1) + "…" : error);
		} else {
			p.add("result", result);
		}
		// cached BEFORE sending: a send that fails (the link is down) goes out again when the sidecar re-sends the call
		answers.answer(callId, p);
		send(p, owner);
	}

	private void send(JsonObject payload, @Nullable String owner) {
		ClientBridge b = ApiImpl.bridge();
		String callId = str(payload, "callId");
		String jobId = str(payload, "jobId");
		if (b == null || !b.connected()) {
			Architect.LOGGER.info("API: the answer to tool call {} of job {} waits for the helper (not connected)", callId, jobId);
			return;
		}
		JsonObject m = payload.deepCopy();
		m.addProperty("type", "job.tool.result");
		b.send(m).whenComplete((ack, e) -> {
			if (e != null) {
				Architect.LOGGER.info("API: the answer to tool call {} of job {} is kept for a re-send ({})", callId, jobId, e.getMessage());
				return;
			}
			if (ack.get("ok").getAsBoolean()) {
				return;
			}
			String err = def(str(ack, "error"), "");
			if (err.contains("no pending tool call")) {
				// the job was cancelled or the call timed out: nobody waits for it any more
				Architect.LOGGER.info("API: tool call {} of job {} is no longer pending; answer dropped", callId, jobId);
			} else if (err.contains("put it in a blob") && payload.has("result")) {
				Architect.LOGGER.info("API: the helper measured the answer to {} over 256 KB; sending it as a blob", callId);
				JsonElement r = payload.get("result");
				viaBlob(jobId, callId, owner, r, r.toString().getBytes(StandardCharsets.UTF_8).length);
			} else {
				Architect.LOGGER.warn("API: the helper refused the answer to tool call {} of job {}: {}", callId, jobId, err);
			}
		});
	}

	// ------------------------------------------------------------------ wire

	static JsonObject wire(JobSpec s) {
		JsonObject o = new JsonObject();
		o.addProperty("kind", s.kind());
		o.addProperty("prompt", s.prompt());
		if (s.system() != null) {
			o.addProperty("system", s.system());
		}
		if (s.model() != null) {
			o.addProperty("model", s.model());
		}
		if (s.effort() != null) {
			o.addProperty("effort", s.effort());
		}
		if (s.schema() != null) {
			o.add("schema", s.schema().deepCopy());
		}
		if (!s.tools().isEmpty()) {
			JsonArray ts = new JsonArray();
			for (JobSpec.Tool t : s.tools()) {
				JsonObject j = new JsonObject();
				j.addProperty("name", t.name());
				j.addProperty("description", t.description() == null ? "" : t.description());
				j.add("inputSchema", t.inputSchema() == null ? schemaObject() : t.inputSchema().deepCopy());
				if (t.timeoutMs() != null) {
					j.addProperty("timeoutMs", t.timeoutMs());
				}
				if (t.readOnly()) {
					j.addProperty("readOnly", true);
				}
				ts.add(j);
			}
			o.add("tools", ts);
		}
		if (s.budgetUsd() != null) {
			o.addProperty("budgetUsd", s.budgetUsd());
		}
		if (s.maxTurns() != null) {
			o.addProperty("maxTurns", s.maxTurns());
		}
		if (s.owner() != null) {
			o.addProperty("owner", s.owner());
		}
		if (s.tag() != null) {
			o.addProperty("tag", s.tag());
		}
		if (s.group() != null) {
			o.addProperty("group", s.group());
		}
		if (s.ext().size() > 0) {
			o.add("ext", s.ext().deepCopy());
		}
		if (!s.blobs().isEmpty()) {
			JsonArray bs = new JsonArray();
			s.blobs().forEach(bs::add);
			o.add("blobs", bs);
		}
		return o;
	}

	private static JsonObject schemaObject() {
		JsonObject o = new JsonObject();
		o.addProperty("type", "object");
		return o;
	}

	/** {@code result.<key>} of an ok ack; else the ack's error as an exception. */
	static String ackString(JsonObject ack, String key) {
		if (!ack.has("ok") || !ack.get("ok").getAsBoolean()) {
			throw new CompletionException(new IllegalStateException(def(str(ack, "error"), "refused by the helper")));
		}
		JsonObject r = ack.has("result") && ack.get("result").isJsonObject() ? ack.getAsJsonObject("result") : new JsonObject();
		String v = str(r, key);
		if (v == null) {
			throw new CompletionException(new IllegalStateException("the helper sent no " + key));
		}
		return v;
	}

	static String message(Throwable e) {
		Throwable c = e;
		while ((c instanceof CompletionException || c instanceof java.util.concurrent.ExecutionException) && c.getCause() != null) {
			c = c.getCause();
		}
		String m = c.getMessage();
		return m == null || m.isBlank() ? c.getClass().getSimpleName() : m;
	}

	private static @Nullable String str(JsonObject o, String k) {
		JsonElement e = o.get(k);
		return e != null && e.isJsonPrimitive() ? e.getAsString() : null;
	}

	private static String def(@Nullable String s, String d) {
		return s == null ? d : s;
	}

	private static long num(JsonObject o, String k) {
		JsonElement e = o.get(k);
		return e != null && e.isJsonPrimitive() && e.getAsJsonPrimitive().isNumber() ? e.getAsLong() : 0L;
	}

	/** For tests and the DevBridge: how many answers are cached. */
	int cachedAnswers() {
		return answers.size();
	}
}
