package dev.larattalabs.architect.devserver;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.larattalabs.architect.Architect;
import dev.larattalabs.architect.apiimpl.ApiImpl;
import dev.larattalabs.architect.apiimpl.ClientBridge;
import dev.larattalabs.architect.client.sidecar.LinkStatus;
import dev.larattalabs.architect.client.sidecar.SidecarLink;
import dev.larattalabs.architect.client.sidecar.SidecarState;
import dev.larattalabs.architect.launcher.LauncherPlan;
import dev.larattalabs.architect.library.LibraryMeta;
import dev.larattalabs.architect.placement.Blueprints;
import java.io.IOException;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import net.fabricmc.loader.api.FabricLoader;
import net.minecraft.server.MinecraftServer;
import org.jspecify.annotations.Nullable;

/**
 * The sidecar on the headless server: what the client's {@code Launcher}, {@code Sidecar} and {@code ApiClientBridge} do in a
 * dev client, for the dev case only (ARCHITECT_SIDECAR_DIR, the stub or the sim backend; no bundle, no npm install). The link
 * and state classes are the client's own ({@link SidecarLink}, {@link SidecarState}: no Minecraft client code), run on a
 * "sidecar" thread instead of the client thread.
 *
 * <p>The helper's parent pid is the headless host (ARCHITECT_HOST_PID, tools/run-headless-server.mjs), not this JVM, so it
 * outlives the per-world server restarts as a dev client's helper outlives its world switches; the next JVM reuses it
 * ({@link LauncherPlan#reuse}, as the client's launcher does) and it exits with the host.
 */
public final class ServerSidecar implements ClientBridge {
	static final ExecutorService THREAD = Executors.newSingleThreadExecutor(r -> {
		Thread t = new Thread(r, "devserver-sidecar");
		t.setDaemon(true);
		return t;
	});
	private static final SidecarState STATE = new SidecarState();
	private static @Nullable SidecarLink link;
	private static final Map<String, JsonObject> DESIGNS = new ConcurrentHashMap<>();
	private static final Set<String> VARIANTS_SEEN = new HashSet<>();
	/** dev.api.dropAck: message types whose next ack is dropped (6c 0a). */
	public static final Set<String> DROP_ACK = ConcurrentHashMap.newKeySet();

	private static volatile String state = LauncherPlan.State.IDLE.wire();
	private static volatile String detail = "";
	private static volatile long pid;
	private static volatile boolean reused;
	private static volatile @Nullable Process process;
	private static volatile @Nullable Boolean paused;

	private ServerSidecar() {
	}

	static int port() {
		return Bot.intEnv("ARCHITECT_PORT", LauncherPlan.DEFAULT_PORT);
	}

	static Path dataDir() {
		return Blueprints.gameDataDir().resolve("sidecar-data");
	}

	public static Path dataDirPublic() {
		return dataDir();
	}

	public static SidecarLink linkPublic() {
		return link;
	}

	static Path logFile() {
		return dataDir().resolve("sidecar.log");
	}

	static @Nullable String readToken() {
		try {
			String t = Files.readString(dataDir().resolve("client.token"), StandardCharsets.UTF_8).strip();
			return t.isEmpty() ? null : t;
		} catch (IOException e) {
			return null;
		}
	}

	/** Mod init: the API's bridge and the state listener (once per JVM). */
	static void init() {
		String version = FabricLoader.getInstance().getModContainer(Architect.MOD_ID).map(c -> c.getMetadata().getVersion().getFriendlyString())
			.orElse("dev");
		link = new SidecarLink(URI.create("ws://127.0.0.1:" + port()), version, STATE, THREAD::execute, ServerSidecar::readToken);
		ApiImpl.setClientBridge(new ServerSidecar());
		STATE.addListener(new SidecarState.Listener() {
			@Override
			public void onSnapshot() {
				if (Boolean.TRUE.equals(paused)) {
					sendPaused(true);
				}
				DESIGNS.clear();
				for (JsonObject d : STATE.designsRaw()) {
					DESIGNS.put(d.has("id") ? d.get("id").getAsString() : "?", d);
				}
				if (STATE.protocol() >= 2) {
					ApiImpl.jobsSnapshot(STATE.jobsRaw());
				}
				if (STATE.protocol() >= 2 && STATE.features().contains("massing")) {
					ApiImpl.massingsSync();
				}
			}

			@Override
			public void onMassing(JsonObject massing) {
				ApiImpl.massingChanged(massing);
			}

			@Override
			public void onEntryVersioned(JsonObject message) {
				dev.larattalabs.architect.apiimpl.Versioned.onVersioned(message.deepCopy());
			}

			@Override
			public void onMassingRemoved(String massingId, String reason) {
				ApiImpl.massingRemoved(massingId);
			}

			@Override
			public void onLink(LinkStatus l) {
				ApiImpl.linkChanged(l.synced());
				if (l.synced()) {
					state = LauncherPlan.State.RUNNING.wire();
					detail = (reused ? "reused the helper" : "helper running") + " on port " + port();
				} else if (LauncherPlan.State.RUNNING.wire().equals(state) && l.phase() == LinkStatus.Phase.WAITING_RETRY) {
					state = LauncherPlan.State.STARTING.wire();
					detail = "reconnecting: " + (l.lastError() == null ? "" : l.lastError());
				}
			}

			@Override
			public void onJob(JsonObject job) {
				ApiImpl.jobChanged(job);
			}

			@Override
			public void onToolCall(JsonObject call) {
				ApiImpl.toolCall(call);
			}

			@Override
			public void onGroup(JsonObject group) {
				ApiImpl.groupChanged(group.deepCopy());
			}

			@Override
			public void onBibleJob(JsonObject job) {
				ApiImpl.bibleJobChanged(job.deepCopy());
			}

			@Override
			public void onBibleIndex(List<JsonObject> bibles) {
				ApiImpl.bibleIndex(bibles.stream().map(JsonObject::deepCopy).toList());
			}

			@Override
			public void onReskin(JsonObject reskin) {
				ApiImpl.reskinChanged(reskin.deepCopy());
			}

			@Override
			public void onDesign(SidecarState.@Nullable Design previous, SidecarState.Design d) {
				DESIGNS.put(d.id(), d.raw().deepCopy());
				ApiImpl.designChanged(d.raw());
			}

			@Override
			public void onVariant(SidecarState.@Nullable Variant previous, SidecarState.Variant v) {
				if (v.status().isRunning() || v.status() == SidecarState.VariantStatus.UNKNOWN) {
					return;
				}
				if (!VARIANTS_SEEN.add(v.id() + "@" + v.createdAt())) {
					return;
				}
				ApiImpl.variantFinished(v.id(), v.status() == SidecarState.VariantStatus.DONE, v.blueprintId(), v.error(), v.isImport());
			}
		});
	}

	public static SidecarState state() {
		return STATE;
	}

	static boolean linkSynced() {
		SidecarLink l = link;
		return l != null && l.status().synced();
	}

	// ------------------------------------------------------------------ the launcher (dev only)

	/** Starts (or reuses) the helper, off the server thread. */
	static void start() {
		THREAD.execute(() -> {
			try {
				launch();
			} catch (Exception e) {
				state = LauncherPlan.State.CRASHED.wire();
				detail = "launch failed: " + e;
				Architect.LOGGER.error("devserver: sidecar launch failed", e);
			}
		});
	}

	public static void restart() {
		THREAD.execute(() -> {
			stopOurs("restart");
			try {
				launch();
			} catch (Exception e) {
				state = LauncherPlan.State.CRASHED.wire();
				detail = "launch failed: " + e;
			}
		});
	}

	/** The world stops: the link stays up, as a dev client's does on its title screen (jobs and designs go on finishing). */
	static void worldStopped() {
	}

	private static long hostPid() {
		String h = System.getenv("ARCHITECT_HOST_PID");
		try {
			return h == null || h.isBlank() ? ProcessHandle.current().pid() : Long.parseLong(h.strip());
		} catch (NumberFormatException e) {
			return ProcessHandle.current().pid();
		}
	}

	private static void launch() throws Exception {
		String dirEnv = System.getenv("ARCHITECT_SIDECAR_DIR");
		if (dirEnv == null || dirEnv.isBlank()) {
			state = LauncherPlan.State.DISABLED.wire();
			detail = "headless: no ARCHITECT_SIDECAR_DIR";
			return;
		}
		Path dir = Path.of(dirEnv.strip()).toAbsolutePath().normalize();
		String kitEnv = System.getenv("ARCHITECT_KIT_DIR");
		Path kit = kitEnv != null && !kitEnv.isBlank() ? Path.of(kitEnv.strip()) : dir.getParent() != null && Files.isDirectory(dir.getParent().resolve("kit"))
			? dir.getParent().resolve("kit") : null;
		String nodeEnv = System.getenv("ARCHITECT_NODE");
		Path node = Path.of(nodeEnv != null && !nodeEnv.isBlank() ? nodeEnv.strip() : "node");
		Path data = dataDir();
		Files.createDirectories(data);
		String expected = packageVersion(dir);
		String answered = probe(port());
		JsonObject launcherJson = readJson(data.resolve("launcher.json"));
		JsonObject sidecarJson = readJson(data.resolve("sidecar.json"));
		long recordedPid = sidecarJson != null && sidecarJson.has("pid") ? sidecarJson.get("pid").getAsLong() : 0;
		long ownedPid = launcherJson != null && launcherJson.has("pid") ? launcherJson.get("pid").getAsLong() : 0;
		boolean alive = recordedPid > 0 && ProcessHandle.of(recordedPid).map(ProcessHandle::isAlive).orElse(false);
		long spawnedAt = launcherJson != null && launcherJson.has("startedAt") ? launcherJson.get("startedAt").getAsLong() : 0;
		long procStart = alive ? ProcessHandle.of(recordedPid).flatMap(h -> h.info().startInstant()).map(java.time.Instant::toEpochMilli).orElse(-1L) : -1L;
		if (ownedPid > 0 && !LauncherPlan.sameProcess(procStart, spawnedAt)) {
			ownedPid = 0;
		}
		LauncherPlan.Reuse r = LauncherPlan.reuse(answered, expected, recordedPid, ownedPid, alive);
		Architect.LOGGER.info("devserver: sidecar port {} answered {}, expected {}, pid {} (alive {}), ours {}: {}", port(), answered, expected, recordedPid,
			alive, ownedPid, r);
		switch (r) {
			case REUSE -> {
				reused = true;
				pid = recordedPid;
				state = LauncherPlan.State.STARTING.wire();
				detail = "reusing the helper already running on port " + port();
				link.start();
				return;
			}
			case PORT_TAKEN -> {
				state = LauncherPlan.State.DISABLED.wire();
				detail = "port " + port() + " is used by another helper (version " + answered + ", ours " + expected + ")";
				return;
			}
			case STOP_THEN_START -> ProcessHandle.of(recordedPid).ifPresent(h -> kill(h, 3000));
			case START -> {
			}
		}
		Path library = Blueprints.userDir();
		Files.createDirectories(library);
		List<String> cmd = LauncherPlan.command(node, dir, port(), data, library, kit, hostPid(), false, System.getenv("ARCHITECT_SIDECAR_BACKEND"));
		Files.writeString(logFile(), "", StandardCharsets.UTF_8, java.nio.file.StandardOpenOption.CREATE, java.nio.file.StandardOpenOption.APPEND);
		ProcessBuilder pb = new ProcessBuilder(cmd).directory(dir.toFile()).redirectErrorStream(true)
			.redirectOutput(ProcessBuilder.Redirect.appendTo(logFile().toFile()));
		pb.environment().clear();
		pb.environment().putAll(LauncherPlan.environment(System.getenv(), node, false));
		pb.environment().keySet().removeIf(k -> k.startsWith("ANTHROPIC_") || k.startsWith("CLAUDE"));
		long t0 = System.currentTimeMillis();
		state = LauncherPlan.State.STARTING.wire();
		detail = "starting the helper";
		Process p = pb.start();
		process = p;
		reused = false;
		pid = p.pid();
		JsonObject lj = new JsonObject();
		lj.addProperty("pid", p.pid());
		lj.addProperty("startedAt", t0);
		lj.addProperty("gamePid", ProcessHandle.current().pid());
		Files.writeString(data.resolve("launcher.json"), lj.toString(), StandardCharsets.UTF_8);
		Architect.LOGGER.info("devserver: started the sidecar (pid {}) from {}", p.pid(), dir);
		p.onExit().thenAccept(ServerSidecar::exited);
		Path token = data.resolve("client.token");
		while (System.currentTimeMillis() < t0 + 20_000 && p.isAlive()) {
			if (Files.exists(token) && Files.getLastModifiedTime(token).toMillis() >= t0 - 1000) {
				break;
			}
			Thread.sleep(100);
		}
		if (p.isAlive()) {
			link.start();
		}
	}

	private static void exited(Process p) {
		if (p != process) {
			return;
		}
		process = null;
		SidecarLink l = link;
		if (l != null) {
			l.pause();
		}
		state = LauncherPlan.State.CRASHED.wire();
		detail = "the helper exited (code " + p.exitValue() + ")";
	}

	/** Stops a helper this host started (a restart), by its pid only. */
	private static void stopOurs(String why) {
		long recorded = pid;
		Process p = process;
		ProcessHandle h = p != null ? p.toHandle() : null;
		if (h == null && recorded > 0) {
			// started by an earlier server JVM of this host: ours when launcher.json says so (pid and start time)
			JsonObject lj = readJson(dataDir().resolve("launcher.json"));
			long spawnedAt = lj != null && lj.has("startedAt") ? lj.get("startedAt").getAsLong() : 0;
			long owned = lj != null && lj.has("pid") ? lj.get("pid").getAsLong() : 0;
			ProcessHandle ph = ProcessHandle.of(recorded).orElse(null);
			long start = ph == null ? -1 : ph.info().startInstant().map(java.time.Instant::toEpochMilli).orElse(-1L);
			if (ph != null && owned == recorded && LauncherPlan.sameProcess(start, spawnedAt)) {
				h = ph;
			}
		}
		if (h == null || !h.isAlive()) {
			return;
		}
		Architect.LOGGER.info("devserver: stopping the sidecar (pid {}): {}", h.pid(), why);
		process = null;
		SidecarLink l = link;
		if (l != null) {
			l.pause();
		}
		kill(h, 2500);
	}

	private static void kill(ProcessHandle h, long graceMs) {
		h.destroy();
		try {
			h.onExit().get(graceMs, TimeUnit.MILLISECONDS);
		} catch (Exception e) {
			h.destroyForcibly();
		}
	}

	private static @Nullable String packageVersion(Path dir) {
		JsonObject o = readJson(dir.resolve("package.json"));
		return o != null && o.has("version") ? o.get("version").getAsString() : null;
	}

	private static @Nullable JsonObject readJson(Path p) {
		try {
			return JsonParser.parseString(Files.readString(p, StandardCharsets.UTF_8)).getAsJsonObject();
		} catch (Exception e) {
			return null;
		}
	}

	/** The client launcher's probe: {@code hello} on the port; the version it answers ("" without one), null when nothing is there. */
	private static @Nullable String probe(int port) {
		var http = java.net.http.HttpClient.newBuilder().connectTimeout(java.time.Duration.ofSeconds(2)).build();
		CompletableFuture<String> answer = new CompletableFuture<>();
		java.net.http.WebSocket ws = null;
		try {
			ws = http.newWebSocketBuilder().connectTimeout(java.time.Duration.ofSeconds(2)).buildAsync(URI.create("ws://127.0.0.1:" + port),
				new java.net.http.WebSocket.Listener() {
					private final StringBuilder buf = new StringBuilder();

					@Override
					public java.util.concurrent.CompletionStage<?> onText(java.net.http.WebSocket w, CharSequence data, boolean last) {
						buf.append(data);
						if (last) {
							try {
								JsonObject o = JsonParser.parseString(buf.toString()).getAsJsonObject();
								buf.setLength(0);
								answer.complete(o.has("version") && o.get("version").isJsonPrimitive() ? o.get("version").getAsString() : "");
							} catch (RuntimeException e) {
								answer.complete("");
							}
						}
						w.request(1);
						return null;
					}
				}).get(3, TimeUnit.SECONDS);
			JsonObject hello = new JsonObject();
			hello.addProperty("v", 1);
			hello.addProperty("type", "hello");
			hello.addProperty("client", "mod");
			hello.addProperty("version", FabricLoader.getInstance().getModContainer(Architect.MOD_ID).map(c -> c.getMetadata().getVersion()
				.getFriendlyString()).orElse("dev"));
			String tok = readToken();
			if (tok != null) {
				hello.addProperty("token", tok);
			}
			ws.sendText(hello.toString(), true);
			return answer.get(3, TimeUnit.SECONDS);
		} catch (Exception e) {
			return ws == null ? null : answer.getNow("");
		} finally {
			if (ws != null) {
				ws.abort();
			}
		}
	}

	public static JsonObject launcherJson() {
		JsonObject o = new JsonObject();
		o.addProperty("state", state);
		o.addProperty("detail", detail);
		o.addProperty("source", "dev");
		o.addProperty("sidecarDir", System.getenv("ARCHITECT_SIDECAR_DIR"));
		o.addProperty("startedByUs", process != null && process.isAlive());
		o.addProperty("reused", reused);
		o.addProperty("pid", pid);
		o.addProperty("port", port());
		o.addProperty("log", logFile().toString());
		o.addProperty("headless", true);
		o.add("logTail", new JsonArray());
		return o;
	}

	// ------------------------------------------------------------------ the pause emulation (dev.screen pause)

	/** A paused singleplayer game, headless: the server skips its ticks (PauseMixin), and a protocol-2 helper hears client.paused. */
	public static void setPaused(MinecraftServer server, boolean on) {
		boolean changed = !Boolean.valueOf(on).equals(paused);
		paused = on;
		if (changed) {
			sendPaused(on);
		}
	}

	/** A new world starts unpaused (no message: the helper hears the next change). */
	static void setPausedQuiet(boolean on) {
		paused = on;
	}

	public static boolean paused() {
		return Boolean.TRUE.equals(paused);
	}

	private static void sendPaused(boolean on) {
		if (linkSynced() && STATE.protocol() >= 2) {
			JsonObject m = new JsonObject();
			m.addProperty("type", "client.paused");
			m.addProperty("paused", on);
			link.send(m).whenComplete((ack, t) -> Architect.LOGGER.info("devserver: client.paused {} -> {}", on, t != null ? t.getMessage()
				: ack.ok() ? "ok" : ack.error()));
		}
	}

	// ------------------------------------------------------------------ ClientBridge

	private static String idOf(SidecarLink.Ack ack, String... keys) {
		if (!ack.ok()) {
			throw new IllegalStateException(ack.error() == null ? "refused by the helper" : ack.error());
		}
		JsonObject r = ack.result();
		if (r != null) {
			for (String k : keys) {
				if (r.has(k) && r.get(k).isJsonPrimitive()) {
					return r.get(k).getAsString();
				}
			}
		}
		throw new IllegalStateException("the helper sent no id");
	}

	private static JsonObject msg(String type) {
		JsonObject o = new JsonObject();
		o.addProperty("v", SidecarLink.PROTOCOL);
		o.addProperty("type", type);
		return o;
	}

	@Override
	public boolean connected() {
		return linkSynced();
	}

	@Override
	public int protocol() {
		return connected() ? STATE.protocol() : 0;
	}

	@Override
	public Set<String> sidecarFeatures() {
		return STATE.features();
	}

	@Override
	public @Nullable JsonObject sidecarVersions() {
		return STATE.versions();
	}

	@Override
	public String restartSidecar() {
		if (connected()) {
			return "connected";
		}
		if (LauncherPlan.State.STARTING.wire().equals(state)) {
			return "already starting (" + detail + ")";
		}
		restart();
		return "starting";
	}

	@Override
	public CompletableFuture<String> designRequest(JsonObject request) {
		JsonObject m = msg("design.request");
		m.add("request", request);
		return link.send(m).thenApply(ack -> idOf(ack, "designId", "id"));
	}

	@Override
	public CompletableFuture<Void> designCancel(String designId) {
		JsonObject m = msg("design.cancel");
		m.addProperty("designId", designId);
		return link.send(m).thenApply(ack -> null);
	}

	@Override
	public List<JsonObject> designs() {
		return DESIGNS.values().stream().map(JsonObject::deepCopy).toList();
	}

	@Override
	public CompletableFuture<String> variantRequest(JsonObject payload) {
		JsonObject m = msg("variant.request");
		for (var e : payload.entrySet()) {
			m.add(e.getKey(), e.getValue());
		}
		return link.send(m).thenApply(ack -> idOf(ack, "variantId", "id"));
	}

	@Override
	public CompletableFuture<JsonObject> send(JsonObject message) {
		String type = message.has("type") ? message.get("type").getAsString() : "";
		if (DROP_ACK.remove(type)) {
			link.send(message).thenAccept(ack -> Architect.LOGGER.warn("dev.api.dropAck: dropped the ack of {} (ok {})", type, ack.ok()));
			return new CompletableFuture<>();
		}
		return link.send(message).thenApply(ack -> {
			JsonObject o = new JsonObject();
			o.addProperty("ok", ack.ok());
			if (ack.error() != null) {
				o.addProperty("error", ack.error());
			}
			if (ack.result() != null) {
				o.add("result", ack.result().deepCopy());
			}
			if (ack.code() != null) {
				o.addProperty("code", ack.code());
				o.addProperty("detail", ack.detail() == null ? "" : ack.detail());
			}
			return o;
		});
	}

	@Override
	public CompletableFuture<byte[]> readBlob(String blobId) {
		if (!blobId.matches("[A-Za-z0-9_-]{1,64}")) {
			return CompletableFuture.failedFuture(new IllegalArgumentException("not a blob id: " + blobId));
		}
		return CompletableFuture.supplyAsync(() -> {
			try {
				return Files.readAllBytes(dataDir().resolve("blobs").resolve(blobId));
			} catch (IOException e) {
				throw new java.io.UncheckedIOException(e);
			}
		});
	}

	/** The Library's delete for a user entry (to architect/library-trash, then a reload); bundled entries refuse, as on a client. */
	@Override
	public CompletableFuture<Boolean> deleteEntry(String id) {
		Blueprints.Entry e = Blueprints.entry(id);
		if (e == null || e.dir() == null) {
			return CompletableFuture.completedFuture(false);
		}
		try {
			Path trash = Blueprints.gameDataDir().resolve("library-trash");
			Files.createDirectories(trash);
			Files.move(e.dir(), trash.resolve(e.blueprint().id() + "-" + System.currentTimeMillis()), StandardCopyOption.ATOMIC_MOVE);
		} catch (IOException ex) {
			return CompletableFuture.completedFuture(false);
		}
		MinecraftServer s = DevServer.server();
		if (s == null) {
			return CompletableFuture.completedFuture(true);
		}
		return CompletableFuture.supplyAsync(() -> {
			Blueprints.reload(s);
			return true;
		}, s);
	}

	/** The Library's tag edit, for user entries (in place); a bundled entry's overlay is client state: refused headless. */
	@Override
	public CompletableFuture<Void> setTags(String id, List<String> tags) {
		Blueprints.Entry e = Blueprints.entry(id);
		if (e == null) {
			return CompletableFuture.failedFuture(new IllegalStateException("no library entry " + id));
		}
		if (e.bundled() || e.dir() == null) {
			return CompletableFuture.failedFuture(new IllegalStateException("headless: a bundled entry's tag overlay is client state"));
		}
		try {
			List<String> norm = LibraryMeta.normalizeTags(tags);
			LibraryMeta.editInPlace(e.dir().resolve(id + Blueprints.SIDECAR_SUFFIX), m -> m.withTags(norm));
			return CompletableFuture.completedFuture(null);
		} catch (IOException | RuntimeException ex) {
			return CompletableFuture.failedFuture(ex);
		}
	}
}
