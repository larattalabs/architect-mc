package dev.larattalabs.architect.client.launcher;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.larattalabs.architect.Architect;
import dev.larattalabs.architect.client.ClientEnv;
import dev.larattalabs.architect.client.hud.Keys;
import dev.larattalabs.architect.client.hud.Toasts;
import dev.larattalabs.architect.client.sidecar.LinkStatus;
import dev.larattalabs.architect.client.sidecar.Sidecar;
import dev.larattalabs.architect.client.sidecar.SidecarState;
import dev.larattalabs.architect.launcher.LauncherPlan;
import dev.larattalabs.architect.launcher.LauncherPlan.Reuse;
import dev.larattalabs.architect.launcher.LauncherPlan.SourceKind;
import dev.larattalabs.architect.launcher.LauncherPlan.State;
import dev.larattalabs.architect.placement.Blueprints;
import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.WebSocket;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.stream.Stream;
import net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientLifecycleEvents;
import net.fabricmc.loader.api.FabricLoader;
import net.fabricmc.loader.api.ModContainer;
import net.minecraft.client.Minecraft;
import org.jspecify.annotations.Nullable;

/**
 * Starts the sidecar so players never run it by hand (docs/CONTRACT.md "Launcher", "Sidecar process"): finds node 22+,
 * resolves the sidecar (a dev checkout via {@code ARCHITECT_SIDECAR_DIR} / {@code -Darchitect.sidecarDir}, else the jar's
 * bundle extracted to {@code <gameDir>/architect/sidecar/<modVersion>/} and installed with {@code npm ci --omit=dev}),
 * reuses one already running with our version, else spawns {@code node dist/main.mjs ...} with its output in
 * {@code <data>/sidecar.log}, and stops on exit only what it started. The decisions are {@link LauncherPlan}'s (pure,
 * unit-tested); this class does the processes and files, on its own worker thread (never the render thread).
 *
 * <p>The state ({@link State}) feeds the Status tab and a toast. Config: {@code <gameDir>/config/architect_mc.json}
 * ({@link LauncherConfig}).
 */
public final class Launcher {
	private static final Gson GSON = new GsonBuilder().setPrettyPrinting().disableHtmlEscaping().create();
	private static final ExecutorService WORKER = Executors.newSingleThreadExecutor(r -> {
		Thread t = new Thread(r, "Architect-Launcher");
		t.setDaemon(true);
		return t;
	});

	private static volatile State state = State.IDLE;
	private static volatile String detail = "";
	private static volatile @Nullable String installLine;
	private static volatile List<String> logTail = List.of();
	private static volatile LauncherPlan.@Nullable Source source;
	private static volatile @Nullable Path node;
	private static volatile @Nullable String nodeVersion;
	private static volatile @Nullable String expectedVersion;
	private static volatile @Nullable Process process;
	private static volatile long sidecarPid;
	private static volatile boolean reused;
	private static volatile boolean stopping;
	private static volatile @Nullable Reuse lastReuse;
	private static volatile long generation;
	private static LauncherConfig config = LauncherConfig.DEFAULT;

	private Launcher() {
	}

	public static void init() {
		config = LauncherConfig.load();
		Sidecar.init();
		Sidecar.state().addListener(new SidecarState.Listener() {
			@Override
			public void onLink(LinkStatus link) {
				onLinkChange(link);
			}
		});
		ClientLifecycleEvents.CLIENT_STARTED.register(mc -> {
			if (config.autoStart()) {
				start();
			} else {
				set(State.DISABLED, "autoStart is off in config/architect_mc.json (the Status tab can start the helper)");
			}
		});
		ClientLifecycleEvents.CLIENT_STOPPING.register(mc -> stopOnExit());
	}

	// ------------------------------------------------------------------ reads (any thread)

	public static State state() {
		return state;
	}

	public static String detail() {
		return detail;
	}

	public static @Nullable String installLine() {
		return installLine;
	}

	public static List<String> logTail() {
		return logTail;
	}

	public static LauncherPlan.@Nullable Source source() {
		return source;
	}

	public static @Nullable Path node() {
		return node;
	}

	public static @Nullable String nodeVersion() {
		return nodeVersion;
	}

	public static boolean startedByUs() {
		Process p = process;
		return p != null && p.isAlive();
	}

	public static boolean reusedRunning() {
		return reused;
	}

	public static Path logFile() {
		return Sidecar.dataDir().resolve("sidecar.log");
	}

	public static LauncherConfig config() {
		return config;
	}

	// ------------------------------------------------------------------ control

	/** (Re)starts the launch sequence on the worker thread (client start, the Status tab's Restart). */
	public static void start() {
		long gen = ++generation;
		stopping = false;
		WORKER.execute(() -> {
			try {
				launch(gen);
			} catch (Throwable t) {
				Architect.LOGGER.error("Launcher failed", t);
				set(State.CRASHED, "launcher error: " + t.getMessage());
			}
		});
	}

	/** Restart: stops a sidecar we started (never one we reused), then launches again. */
	public static void restart() {
		long gen = ++generation;
		WORKER.execute(() -> {
			stopOurs("restart");
			start();
		});
		Architect.LOGGER.info("Launcher restart requested (gen {})", gen);
	}

	// ------------------------------------------------------------------ the sequence

	private static void launch(long gen) throws Exception {
		Path gameDir = FabricLoader.getInstance().getGameDir();
		String modVersion = modVersion();
		Optional<ModContainer> mod = FabricLoader.getInstance().getModContainer(Architect.MOD_ID);
		boolean bundled = mod.flatMap(c -> c.findPath("architect-sidecar/dist/main.mjs")).map(Files::exists).orElse(false);
		LauncherPlan.Source src = LauncherPlan.source(System.getProperty("architect.sidecarDir"), System.getenv("ARCHITECT_SIDECAR_DIR"),
			ClientEnv.raw("ARCHITECT_KIT_DIR"), bundled, gameDir, modVersion, Files::isDirectory);
		source = src;
		Architect.LOGGER.info("Launcher: sidecar source {} ({}), kit {}", src.kind(), src.origin(), src.kit());
		if (src.kind() == SourceKind.NONE) {
			set(State.DISABLED, "this build has no sidecar bundled (dev: set ARCHITECT_SIDECAR_DIR to a sidecar/ checkout)");
			return;
		}
		// node
		Path found = findNode();
		if (found == null) {
			set(State.NODE_MISSING, "Node.js " + LauncherPlan.MIN_NODE + " or newer was not found. Install it from " + LauncherPlan.NODE_INSTALL_URL
				+ ", or set nodePath in config/architect_mc.json");
			return;
		}
		node = found;
		if (gen != generation) {
			return;
		}
		Path dir = src.dir();
		if (src.kind() == SourceKind.BUNDLED) {
			if (!install(mod.orElseThrow(), dir, found)) {
				return;
			}
		}
		if (!Files.isRegularFile(dir.resolve("dist").resolve("main.mjs"))) {
			set(State.DISABLED, "no dist/main.mjs in " + dir + (src.kind() == SourceKind.DEV ? " (run npm run build in sidecar/)" : ""));
			return;
		}
		expectedVersion = packageVersion(dir);
		// reuse or start
		Path data = Sidecar.dataDir();
		Files.createDirectories(data);
		String answered = probe(Sidecar.port());
		JsonObject sidecarJson = readJson(data.resolve("sidecar.json"));
		JsonObject launcherJson = readJson(data.resolve("launcher.json"));
		long recordedPid = sidecarJson != null && sidecarJson.has("pid") ? sidecarJson.get("pid").getAsLong() : 0;
		long ownedPid = launcherJson != null && launcherJson.has("pid") ? launcherJson.get("pid").getAsLong() : 0;
		boolean alive = recordedPid > 0 && ProcessHandle.of(recordedPid).map(ProcessHandle::isAlive).orElse(false);
		// a pid counts as ours only when that process started right when our launcher spawned one (pids get reused)
		long spawnedAt = launcherJson != null && launcherJson.has("startedAt") ? launcherJson.get("startedAt").getAsLong() : 0;
		long procStart = alive ? ProcessHandle.of(recordedPid).flatMap(h -> h.info().startInstant()).map(java.time.Instant::toEpochMilli).orElse(-1L)
			: -1L;
		if (ownedPid > 0 && !LauncherPlan.sameProcess(procStart, spawnedAt)) {
			ownedPid = 0;
		}
		Reuse r = LauncherPlan.reuse(answered, expectedVersion, recordedPid, ownedPid, alive);
		lastReuse = r;
		Architect.LOGGER.info("Launcher: port {} answered {}, expected {}, sidecar.json pid {} (alive {}), ours {}: {}", Sidecar.port(),
			answered == null ? "nothing" : "version '" + answered + "'", expectedVersion, recordedPid, alive, ownedPid, r);
		switch (r) {
			case REUSE -> {
				reused = true;
				sidecarPid = recordedPid;
				set(State.STARTING, "reusing the helper already running on port " + Sidecar.port());
				Sidecar.link().start();
				return;
			}
			case PORT_TAKEN -> {
				set(State.DISABLED, "port " + Sidecar.port() + " is used by another helper (version " + (answered.isEmpty() ? "?" : answered)
					+ ", ours " + expectedVersion + ") that this game did not start; stop it or set ARCHITECT_PORT");
				return;
			}
			case STOP_THEN_START -> {
				set(State.STARTING, "stopping the old helper (pid " + recordedPid + ")");
				ProcessHandle.of(recordedPid).ifPresent(h -> kill(h, 3000));
			}
			case START -> {
			}
		}
		if (gen != generation) {
			return;
		}
		spawn(src, found, data);
	}

	private static void spawn(LauncherPlan.Source src, Path nodePath, Path data) throws IOException {
		Path library = Blueprints.userDir();
		Files.createDirectories(library);
		List<String> cmd = LauncherPlan.command(nodePath, src.dir(), Sidecar.port(), data, library, src.kit(), ProcessHandle.current().pid(), false);
		Path log = logFile();
		Files.writeString(log, "", StandardCharsets.UTF_8, java.nio.file.StandardOpenOption.CREATE, java.nio.file.StandardOpenOption.APPEND);
		ProcessBuilder pb = new ProcessBuilder(cmd).directory(src.dir().toFile()).redirectErrorStream(true)
			.redirectOutput(ProcessBuilder.Redirect.appendTo(log.toFile()));
		pb.environment().clear();
		pb.environment().putAll(LauncherPlan.environment(System.getenv(), nodePath, isWindows()));
		long spawnedAt = System.currentTimeMillis();
		set(State.STARTING, "starting the helper");
		Process p = pb.start();
		process = p;
		reused = false;
		sidecarPid = p.pid();
		JsonObject lj = new JsonObject();
		lj.addProperty("pid", p.pid());
		lj.addProperty("startedAt", spawnedAt);
		lj.addProperty("gamePid", ProcessHandle.current().pid());
		Files.writeString(data.resolve("launcher.json"), GSON.toJson(lj), StandardCharsets.UTF_8);
		Architect.LOGGER.info("Launcher: started the sidecar (pid {}) from {}; log {}", p.pid(), src.dir(), log);
		p.onExit().thenAccept(Launcher::exited);
		// the sidecar writes a fresh client.token on start: connect once it is there (the link retries anyway)
		Path token = data.resolve("client.token");
		long deadline = spawnedAt + 20_000;
		while (System.currentTimeMillis() < deadline && p.isAlive()) {
			try {
				if (Files.exists(token) && Files.getLastModifiedTime(token).toMillis() >= spawnedAt - 1000) {
					break;
				}
				Thread.sleep(100);
			} catch (InterruptedException e) {
				Thread.currentThread().interrupt();
				return;
			}
		}
		if (p.isAlive()) {
			Sidecar.link().start();
		}
	}

	private static void exited(Process p) {
		if (p != process) {
			return;
		}
		int code = p.exitValue();
		process = null;
		Sidecar.link().pause();
		if (stopping) {
			set(State.DISABLED, "the helper was stopped");
			return;
		}
		logTail = readTail(20);
		set(State.CRASHED, "the helper exited (code " + code + "); last lines of " + logFile().getFileName());
	}

	private static void onLinkChange(LinkStatus link) {
		if (link.synced()) {
			if (state != State.RUNNING) {
				set(State.RUNNING, (reused ? "reused the helper" : "helper running") + " on port " + Sidecar.port());
			}
		} else if (state == State.RUNNING && link.phase() == LinkStatus.Phase.WAITING_RETRY) {
			Process p = process;
			if (reused || p == null || p.isAlive()) {
				set(State.STARTING, "reconnecting: " + (link.lastError() == null ? "" : link.lastError()));
			}
		}
	}

	/** On client exit: stop the sidecar only if this game started it (shutdown message, then the process). */
	private static void stopOnExit() {
		stopping = true;
		stopOurs("game closing");
		Sidecar.link().stop();
	}

	private static void stopOurs(String why) {
		Process p = process;
		if (p == null || !p.isAlive()) {
			return;
		}
		stopping = true;
		Architect.LOGGER.info("Launcher: stopping the sidecar we started (pid {}): {}", p.pid(), why);
		try {
			if (Sidecar.connected()) {
				Sidecar.shutdown().get(1500, TimeUnit.MILLISECONDS);
			}
		} catch (Exception ignored) {
			// it may close the socket before acking
		}
		kill(p.toHandle(), 2500);
		process = null;
	}

	private static void kill(ProcessHandle h, long graceMs) {
		try {
			if (!h.onExit().isDone()) {
				h.destroy();
			}
			h.onExit().get(graceMs, TimeUnit.MILLISECONDS);
		} catch (Exception e) {
			h.destroyForcibly();
		}
	}

	// ------------------------------------------------------------------ node

	private static @Nullable Path findNode() {
		LauncherPlan.Host host = new LauncherPlan.Host(System.getenv(), System.getProperty("os.name", ""), System.getProperty("user.home", ""),
			p -> Files.isRegularFile(p) && Files.isExecutable(p), Launcher::list);
		for (Path p : LauncherPlan.nodeCandidates(config.nodePath(), host)) {
			if (host.executable().test(p) && checkNode(p)) {
				return p;
			}
		}
		String out = run(LauncherPlan.shellProbe(host), 6000);
		Path probed = out == null ? null : LauncherPlan.parseProbe(out);
		if (probed != null && Files.isExecutable(probed) && checkNode(probed)) {
			return probed;
		}
		return null;
	}

	private static List<Path> list(Path dir) {
		if (!Files.isDirectory(dir)) {
			return List.of();
		}
		try (Stream<Path> s = Files.list(dir)) {
			return s.toList();
		} catch (IOException e) {
			return List.of();
		}
	}

	private static boolean checkNode(Path p) {
		String v = run(List.of(p.toString(), "--version"), 5000);
		if (LauncherPlan.nodeOk(v)) {
			nodeVersion = v == null ? null : v.strip();
			return true;
		}
		Architect.LOGGER.info("Launcher: {} is not node {}+ ({})", p, LauncherPlan.MIN_NODE, v == null ? "did not run" : v.strip());
		return false;
	}

	/** Runs a short command, returning its output (stdout and stderr), or null when it failed or timed out. */
	private static @Nullable String run(List<String> cmd, long timeoutMs) {
		try {
			Process p = new ProcessBuilder(cmd).redirectErrorStream(true).start();
			CompletableFuture<String> out = CompletableFuture.supplyAsync(() -> {
				try (InputStream in = p.getInputStream()) {
					return new String(in.readAllBytes(), StandardCharsets.UTF_8);
				} catch (IOException e) {
					return "";
				}
			});
			if (!p.waitFor(timeoutMs, TimeUnit.MILLISECONDS)) {
				p.destroyForcibly();
				return null;
			}
			return p.exitValue() == 0 ? out.get(1, TimeUnit.SECONDS) : null;
		} catch (Exception e) {
			return null;
		}
	}

	// ------------------------------------------------------------------ the bundle

	/** Extracts the jar's {@code architect-sidecar/} (once per mod version) and runs {@code npm ci --omit=dev} (once). */
	private static boolean install(ModContainer mod, Path target, Path nodePath) throws IOException, InterruptedException {
		if (!Files.exists(target.resolve(".extracted"))) {
			set(State.INSTALLING, "unpacking the helper");
			Path root = mod.findPath("architect-sidecar").orElseThrow();
			Path tmp = target.resolveSibling(target.getFileName() + ".tmp-" + System.currentTimeMillis());
			try (Stream<Path> walk = Files.walk(root)) {
				for (Path p : (Iterable<Path>) walk::iterator) {
					Path rel = Path.of(root.relativize(p).toString());
					Path dest = tmp.resolve(rel.toString());
					if (Files.isDirectory(p)) {
						Files.createDirectories(dest);
					} else {
						Files.createDirectories(dest.getParent());
						Files.copy(p, dest, StandardCopyOption.REPLACE_EXISTING);
					}
				}
			}
			Files.writeString(tmp.resolve(".extracted"), modVersion(), StandardCharsets.UTF_8);
			if (Files.exists(target)) {
				deleteTree(target);
			}
			Files.move(tmp, target, StandardCopyOption.ATOMIC_MOVE);
		}
		if (Files.exists(target.resolve(".installed")) || !Files.exists(target.resolve("package.json"))) {
			return true;
		}
		Path npm = LauncherPlan.npmFor(nodePath, isWindows());
		List<String> cmd = LauncherPlan.installCommand(npm, Files.exists(target.resolve("package-lock.json")));
		set(State.INSTALLING, "installing the Claude Agent SDK (about 200 MB, first run only)");
		ProcessBuilder pb = new ProcessBuilder(cmd).directory(target.toFile()).redirectErrorStream(true);
		pb.environment().putAll(LauncherPlan.environment(System.getenv(), nodePath, isWindows()));
		Process p = pb.start();
		List<String> lines = new ArrayList<>();
		try (BufferedReader r = new BufferedReader(new InputStreamReader(p.getInputStream(), StandardCharsets.UTF_8))) {
			for (String line; (line = r.readLine()) != null;) {
				lines.add(line);
				if (!line.isBlank()) {
					installLine = line.strip();
				}
			}
		}
		int code = p.waitFor();
		// first run: the sidecar has not created its data dir yet
		Files.createDirectories(Sidecar.dataDir());
		Files.write(Sidecar.dataDir().resolve("npm-install.log"), lines, StandardCharsets.UTF_8);
		if (code != 0) {
			logTail = LauncherPlan.tail(lines, 20);
			set(State.CRASHED, "npm " + cmd.get(1) + " failed (code " + code + ")");
			return false;
		}
		installLine = null;
		Files.writeString(target.resolve(".installed"), Long.toString(System.currentTimeMillis()), StandardCharsets.UTF_8);
		return true;
	}

	private static void deleteTree(Path dir) throws IOException {
		try (Stream<Path> walk = Files.walk(dir)) {
			for (Path p : walk.sorted(java.util.Comparator.reverseOrder()).toList()) {
				Files.deleteIfExists(p);
			}
		}
	}

	// ------------------------------------------------------------------ helpers

	/**
	 * Asks the port's sidecar for its version: {@code hello} with our token, the {@code snapshot}'s {@code version} ("" when
	 * it answered without one, or refused the hello), null when nothing answers within 3 s.
	 */
	static @Nullable String probe(int port) {
		HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(2)).build();
		CompletableFuture<String> answer = new CompletableFuture<>();
		WebSocket ws = null;
		try {
			ws = http.newWebSocketBuilder().connectTimeout(Duration.ofSeconds(2)).buildAsync(URI.create("ws://127.0.0.1:" + port), new WebSocket.Listener() {
				private final StringBuilder buf = new StringBuilder();

				@Override
				public CompletionStage<?> onText(WebSocket w, CharSequence data, boolean last) {
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
			hello.addProperty("version", modVersion());
			String tok = Sidecar.readToken();
			if (tok != null) {
				hello.addProperty("token", tok);
			}
			ws.sendText(hello.toString(), true);
			return answer.get(3, TimeUnit.SECONDS);
		} catch (Exception e) {
			return ws == null ? null : answer.getNow(""); // connected but no answer: something is there
		} finally {
			if (ws != null) {
				ws.abort();
			}
		}
	}

	private static @Nullable String packageVersion(Path dir) {
		JsonObject o = readJson(dir.resolve("package.json"));
		return o != null && o.has("version") ? o.get("version").getAsString() : null;
	}

	private static @Nullable JsonObject readJson(Path f) {
		try {
			return JsonParser.parseString(Files.readString(f, StandardCharsets.UTF_8)).getAsJsonObject();
		} catch (Exception e) {
			return null;
		}
	}

	static List<String> readTail(int n) {
		try {
			return LauncherPlan.tail(Files.readAllLines(logFile(), StandardCharsets.UTF_8), n);
		} catch (IOException e) {
			return List.of();
		}
	}

	private static String modVersion() {
		return FabricLoader.getInstance().getModContainer(Architect.MOD_ID).map(c -> c.getMetadata().getVersion().getFriendlyString()).orElse("dev");
	}

	private static boolean isWindows() {
		return System.getProperty("os.name", "").toLowerCase(java.util.Locale.ROOT).startsWith("windows");
	}

	private static void set(State s, String why) {
		State before = state;
		state = s;
		detail = why;
		if (s == State.CRASHED && logTail.isEmpty()) {
			logTail = readTail(20);
		}
		if (s != State.CRASHED) {
			logTail = s == State.RUNNING ? List.of() : logTail;
		}
		Architect.LOGGER.info("Launcher: {} ({})", s.wire(), why);
		if (before == s) {
			return;
		}
		Minecraft mc = Minecraft.getInstance();
		mc.execute(() -> {
			String key = Keys.screen == null ? "B" : Keys.label(Keys.screen);
			switch (s) {
				case RUNNING -> Toasts.push(Toasts.Level.INFO, "Architect is ready", "The design helper is running.");
				case NODE_MISSING -> Toasts.push(Toasts.Level.NEED, "Architect needs Node.js", "Install Node.js " + LauncherPlan.MIN_NODE
					+ "+ to design buildings; placing works without it.", key, "status");
				case CRASHED -> Toasts.push(Toasts.Level.WARN, "The design helper stopped", why, key, "status");
				default -> {
				}
			}
		});
	}

	/** For the DevBridge and the Status tab. */
	public static JsonObject json() {
		JsonObject o = new JsonObject();
		o.addProperty("state", state.wire());
		o.addProperty("detail", detail);
		o.addProperty("installLine", installLine);
		LauncherPlan.Source s = source;
		o.addProperty("source", s == null ? null : s.kind().name().toLowerCase(java.util.Locale.ROOT));
		o.addProperty("sourceOrigin", s == null ? null : s.origin());
		o.addProperty("sidecarDir", s == null || s.dir() == null ? null : s.dir().toString());
		o.addProperty("kit", s == null || s.kit() == null ? null : s.kit().toString());
		o.addProperty("node", node == null ? null : node.toString());
		o.addProperty("nodeVersion", nodeVersion);
		o.addProperty("expectedVersion", expectedVersion);
		o.addProperty("reuse", lastReuse == null ? null : lastReuse.name().toLowerCase(java.util.Locale.ROOT));
		o.addProperty("startedByUs", startedByUs());
		o.addProperty("reused", reused);
		o.addProperty("pid", sidecarPid);
		o.addProperty("port", Sidecar.port());
		o.addProperty("log", logFile().toString());
		o.addProperty("autoStart", config.autoStart());
		JsonArray tail = new JsonArray();
		logTail.forEach(tail::add);
		o.add("logTail", tail);
		return o;
	}
}
