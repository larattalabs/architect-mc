package dev.larattalabs.architect.client.sidecar;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.larattalabs.architect.Architect;
import dev.larattalabs.architect.client.sidecar.LinkStatus.Phase;
import java.net.ConnectException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpTimeoutException;
import java.net.http.WebSocket;
import java.net.http.WebSocketHandshakeException;
import java.nio.ByteBuffer;
import java.time.Duration;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executor;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import java.util.function.Supplier;
import org.jspecify.annotations.Nullable;

/**
 * WebSocket client to the sidecar ({@code ws://127.0.0.1:7890}, docs/CONTRACT.md "Protocol"; slim port of AgentCraft's
 * ForemanLink). Uses {@code java.net.http} (no Origin header, as the sidecar requires). Sends {@code hello} with the client
 * token on every connect (read again each time: a restarted sidecar has a new one), hands each message to
 * {@link SidecarState} on the client thread, matches acks to requests, and reconnects with backoff (0.25 s doubling up to
 * 5 s) while started. Never blocks the render or server thread.
 *
 * <p>A watchdog closes a connection that sends nothing (not even a pong to our 15 s pings) for 45 s, or that does not
 * deliver a snapshot within 15 s of opening.
 */
public final class SidecarLink {
	/** The envelope version {@code v} (unchanged by the protocol negotiation). */
	public static final int PROTOCOL = 1;
	/** The sidecar protocols this mod speaks (docs/CONTRACT.md phase 4a "Versioning"), sent in {@code hello.protocols}. */
	public static final int[] PROTOCOLS = {1, 2};
	public static final long ACK_TIMEOUT_MS = 20_000;
	private static final long[] BACKOFF_MS = {250, 500, 1000, 2000, 3000, 5000};
	private static final long SILENCE_MS = 45_000;
	private static final long HANDSHAKE_MS = 15_000;
	private static final long PING_MS = 15_000;

	/**
	 * An {@code ack}: {@code re} the request id, {@code ok}, an {@code error} or a {@code result}; (6c 0b) a typed refusal's
	 * {@code code} and {@code detail}.
	 */
	public record Ack(String re, boolean ok, @Nullable String error, @Nullable JsonObject result, @Nullable String code, @Nullable String detail) {
		public Ack(String re, boolean ok, @Nullable String error, @Nullable JsonObject result) {
			this(re, ok, error, result, null, null);
		}
	}

	private final URI uri;
	private final String modVersion;
	private final SidecarState state;
	private final Executor clientThread;
	private final ScheduledExecutorService sched;
	private final ExecutorService io;
	private final HttpClient http;
	private final AtomicInteger generation = new AtomicInteger();
	private final AtomicLong ids = new AtomicLong();
	private final Map<String, CompletableFuture<Ack>> pendingAcks = new ConcurrentHashMap<>();
	private final Supplier<@Nullable String> token;

	private volatile @Nullable WebSocket ws;
	private volatile boolean running;
	private volatile LinkStatus status;
	private volatile long lastInbound;
	private volatile long lastPing;
	private volatile long messages;
	private volatile int attempt;
	private volatile @Nullable String tokenProblem;
	private CompletableFuture<?> sendChain = CompletableFuture.completedFuture(null);
	private final Object sendLock = new Object();

	public SidecarLink(URI uri, String modVersion, SidecarState state, Executor clientThread, Supplier<@Nullable String> token) {
		this.uri = uri;
		this.modVersion = modVersion;
		this.state = state;
		this.clientThread = clientThread;
		this.token = token;
		this.status = new LinkStatus(Phase.DISABLED, uri.toString(), 0, null, System.currentTimeMillis(), System.currentTimeMillis(), false);
		this.sched = Executors.newSingleThreadScheduledExecutor(r -> daemon(r, "Architect-SidecarLink"));
		this.io = Executors.newCachedThreadPool(r -> daemon(r, "Architect-SidecarLink-io"));
		this.http = HttpClient.newBuilder().executor(io).connectTimeout(Duration.ofSeconds(3)).build();
		sched.scheduleAtFixedRate(this::watchdog, 5, 5, TimeUnit.SECONDS);
	}

	private static Thread daemon(Runnable r, String name) {
		Thread t = new Thread(r, name);
		t.setDaemon(true);
		return t;
	}

	// ------------------------------------------------------------------ lifecycle

	/** Starts connecting (and reconnecting) to the sidecar. Idempotent. */
	public synchronized void start() {
		if (running) {
			return;
		}
		running = true;
		attempt = 0;
		sched.execute(this::connect);
		Architect.LOGGER.info("Sidecar link started ({})", uri);
	}

	/** Stops reconnecting and closes the connection (the launcher disabled, the game closing). */
	public synchronized void pause() {
		running = false;
		generation.incrementAndGet();
		WebSocket s = ws;
		ws = null;
		if (s != null) {
			s.abort();
		}
		failPending("sidecar link stopped");
		publish(status.with(Phase.DISABLED, status.lastError(), 0));
	}

	public synchronized void stop() {
		running = false;
		WebSocket s = ws;
		ws = null;
		if (s != null) {
			try {
				s.sendClose(WebSocket.NORMAL_CLOSURE, "game closing").orTimeout(500, TimeUnit.MILLISECONDS).exceptionally(t -> null).join();
			} catch (Throwable ignored) {
				// closing anyway
			}
			s.abort();
		}
		failPending("game closing");
		sched.shutdownNow();
		io.shutdownNow();
	}

	/** Drop the current connection (if any) and connect again right away. */
	public void reconnectNow() {
		sched.execute(() -> {
			WebSocket s = ws;
			if (s != null) {
				s.abort();
			}
			attempt = 0;
			fail(generation.get(), "reconnect requested", 0);
		});
	}

	public boolean running() {
		return running;
	}

	public LinkStatus status() {
		return status;
	}

	public URI uri() {
		return uri;
	}

	public long messageCount() {
		return messages;
	}

	/** Why the last hello had no token (null when it had one). Never the token itself. */
	public @Nullable String tokenProblem() {
		return tokenProblem;
	}

	// ------------------------------------------------------------------ connect / fail

	private void connect() {
		if (!running) {
			return;
		}
		int gen = generation.incrementAndGet();
		attempt++;
		publish(status.with(Phase.CONNECTING, status.lastError(), 0).attempt(attempt));
		try {
			http.newWebSocketBuilder()
				.connectTimeout(Duration.ofSeconds(3))
				.buildAsync(uri, new Listener(gen))
				.whenComplete((socket, err) -> {
					if (err != null) {
						fail(gen, describe(err), -1);
						return;
					}
					if (gen != generation.get() || !running) {
						socket.abort();
						return;
					}
					ws = socket;
					lastInbound = System.currentTimeMillis();
					lastPing = lastInbound;
					publish(status.with(Phase.HANDSHAKE, null, 0));
					String tok;
					try {
						tok = token.get();
					} catch (RuntimeException e) {
						tok = null;
					}
					tokenProblem = tok == null ? "no client.token in the sidecar's data folder yet" : null;
					JsonObject hello = new JsonObject();
					hello.addProperty("v", PROTOCOL);
					hello.addProperty("type", "hello");
					hello.addProperty("client", "mod");
					hello.addProperty("version", modVersion);
					com.google.gson.JsonArray protocols = new com.google.gson.JsonArray();
					for (int p : PROTOCOLS) {
						protocols.add(p);
					}
					hello.add("protocols", protocols);
					if (tok != null) {
						hello.addProperty("token", tok);
					}
					sendRaw(socket, hello.toString());
				});
		} catch (Throwable t) {
			fail(gen, describe(t), -1);
		}
	}

	private void fail(int gen, String reason, long delayOverride) {
		if (gen != generation.get()) {
			return;
		}
		generation.incrementAndGet();
		WebSocket s = ws;
		ws = null;
		if (s != null) {
			s.abort();
		}
		failPending("sidecar connection lost: " + reason);
		if (!running) {
			return;
		}
		if (status.phase() == Phase.SYNCED) {
			attempt = 0;
			Architect.LOGGER.warn("Sidecar link lost: {}", reason);
		}
		long delay = delayOverride >= 0 ? delayOverride : BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)];
		publish(status.with(Phase.WAITING_RETRY, reason, System.currentTimeMillis() + delay));
		try {
			sched.schedule(this::connect, delay, TimeUnit.MILLISECONDS);
		} catch (Throwable ignored) {
			// shutting down
		}
	}

	private void watchdog() {
		WebSocket s = ws;
		if (s == null) {
			return;
		}
		long now = System.currentTimeMillis();
		Phase p = status.phase();
		if (p == Phase.HANDSHAKE && now - status.sinceMs() > HANDSHAKE_MS) {
			fail(generation.get(), "no snapshot within " + HANDSHAKE_MS / 1000 + " s", -1);
		} else if (now - lastInbound > SILENCE_MS) {
			fail(generation.get(), "no data for " + SILENCE_MS / 1000 + " s", -1);
		} else if (now - lastPing >= PING_MS) {
			lastPing = now;
			synchronized (sendLock) {
				sendChain = sendChain.handle((v, e) -> null).thenCompose(v -> s.sendPing(ByteBuffer.allocate(0))).exceptionally(t -> null);
			}
		}
	}

	private void publish(LinkStatus s) {
		status = s;
		clientThread.execute(() -> state.setLink(s));
	}

	private static String describe(Throwable t) {
		Throwable c = t;
		while ((c instanceof CompletionException || c.getClass() == RuntimeException.class) && c.getCause() != null) {
			c = c.getCause();
		}
		if (c instanceof ConnectException) {
			return "connection refused (sidecar not running?)";
		}
		if (c instanceof HttpTimeoutException) {
			return "connect timed out";
		}
		if (c instanceof WebSocketHandshakeException h) {
			return "handshake refused (HTTP " + h.getResponse().statusCode() + ")";
		}
		String m = c.getMessage();
		return c.getClass().getSimpleName() + (m != null ? ": " + m : "");
	}

	// ------------------------------------------------------------------ receive

	private final class Listener implements WebSocket.Listener {
		private final int gen;
		private final StringBuilder buf = new StringBuilder();

		Listener(int gen) {
			this.gen = gen;
		}

		@Override
		public void onOpen(WebSocket webSocket) {
			webSocket.request(1);
		}

		@Override
		public CompletionStage<?> onText(WebSocket webSocket, CharSequence data, boolean last) {
			buf.append(data);
			if (last) {
				String text = buf.toString();
				buf.setLength(0);
				if (gen == generation.get()) {
					handle(gen, text);
				}
			}
			webSocket.request(1);
			return null;
		}

		@Override
		public CompletionStage<?> onBinary(WebSocket webSocket, ByteBuffer data, boolean last) {
			webSocket.request(1);
			return null;
		}

		@Override
		public CompletionStage<?> onPing(WebSocket webSocket, ByteBuffer message) {
			lastInbound = System.currentTimeMillis();
			webSocket.request(1);
			return null;
		}

		@Override
		public CompletionStage<?> onPong(WebSocket webSocket, ByteBuffer message) {
			lastInbound = System.currentTimeMillis();
			webSocket.request(1);
			return null;
		}

		@Override
		public CompletionStage<?> onClose(WebSocket webSocket, int statusCode, String reason) {
			fail(gen, "closed by the sidecar (" + statusCode + (reason == null || reason.isEmpty() ? "" : ": " + reason) + ")", -1);
			return null;
		}

		@Override
		public void onError(WebSocket webSocket, Throwable error) {
			fail(gen, describe(error), -1);
		}
	}

	private void handle(int gen, String text) {
		lastInbound = System.currentTimeMillis();
		messages++;
		JsonObject json;
		try {
			JsonElement el = JsonParser.parseString(text);
			if (!el.isJsonObject()) {
				return;
			}
			json = el.getAsJsonObject();
		} catch (Exception e) {
			Architect.LOGGER.warn("Sidecar sent invalid JSON ({} chars)", text.length());
			return;
		}
		String type = SidecarState.str(json, "type", "");
		try {
			switch (type) {
				case "ack" -> {
					Ack ack = new Ack(SidecarState.str(json, "re", ""), json.has("ok") && json.get("ok").getAsBoolean(), SidecarState.str(json, "error", null),
						json.has("result") && json.get("result").isJsonObject() ? json.getAsJsonObject("result") : null, SidecarState.str(json, "code", null),
						SidecarState.str(json, "detail", null));
					CompletableFuture<Ack> f = pendingAcks.remove(ack.re());
					if (f != null) {
						f.complete(ack);
					}
				}
				case "error" -> {
					String re = SidecarState.str(json, "re", null);
					String msg = SidecarState.str(json, "message", json.toString());
					CompletableFuture<Ack> f = re == null ? null : pendingAcks.remove(re);
					if (f != null) {
						f.complete(new Ack(re, false, msg, null));
					}
					Architect.LOGGER.info("Sidecar error: {}", msg);
					if (status.phase() == Phase.HANDSHAKE) {
						// a refused hello (bad token): fail now and retry with a fresh token read
						fail(gen, "hello refused: " + msg, -1);
					}
				}
				case "region.planned", "region.failed", "region.tile", "region.tile.error", "region.progress" ->
					dev.larattalabs.architect.apiimpl.ApiImpl.regionMessage(json); // phase 6a: handled off the client thread
				case "snapshot" -> {
					clientThread.execute(() -> {
						try {
							state.receive(type, json);
						} catch (Exception e) {
							Architect.LOGGER.warn("Bad snapshot from the sidecar", e);
						}
					});
					if (status.phase() != Phase.SYNCED) {
						attempt = 0;
						Architect.LOGGER.info("Sidecar link synced ({})", uri);
						publish(status.with(Phase.SYNCED, null, 0));
					}
				}
				default -> clientThread.execute(() -> {
					try {
						state.receive(type, json);
					} catch (Exception e) {
						Architect.LOGGER.warn("Bad '{}' message from the sidecar", type, e);
					}
				});
			}
		} catch (Exception e) {
			Architect.LOGGER.warn("Could not handle sidecar message '{}'", type, e);
		}
	}

	// ------------------------------------------------------------------ send

	/**
	 * Send a client message. {@code v} and an {@code id} are added if missing; the future completes (on the client thread)
	 * with the ack, or fails if not connected, on timeout or when the connection drops. {@code ack.ok == false} is a normal
	 * completion: check it. Never logs the message (it may carry an API key).
	 */
	public CompletableFuture<Ack> send(JsonObject message) {
		CompletableFuture<Ack> raw = new CompletableFuture<>();
		WebSocket s = ws;
		if (s == null || status.phase() != Phase.SYNCED) {
			raw.completeExceptionally(new IllegalStateException("sidecar not connected (" + status.phaseName() + ")"));
			return onClientThread(raw);
		}
		String id;
		if (message.has("id") && message.get("id").isJsonPrimitive()) {
			id = message.get("id").getAsString();
		} else {
			id = "mc-" + ids.incrementAndGet();
			message.addProperty("id", id);
		}
		if (!message.has("v")) {
			message.addProperty("v", PROTOCOL);
		}
		pendingAcks.put(id, raw);
		raw.orTimeout(ACK_TIMEOUT_MS, TimeUnit.MILLISECONDS).whenComplete((a, e) -> pendingAcks.remove(id));
		sendRaw(s, message.toString()).exceptionally(t -> {
			raw.completeExceptionally(t);
			return null;
		});
		return onClientThread(raw);
	}

	private <T> CompletableFuture<T> onClientThread(CompletableFuture<T> raw) {
		CompletableFuture<T> out = new CompletableFuture<>();
		raw.whenComplete((v, e) -> clientThread.execute(() -> {
			if (e != null) {
				out.completeExceptionally(e instanceof CompletionException && e.getCause() != null ? e.getCause() : e);
			} else {
				out.complete(v);
			}
		}));
		return out;
	}

	/** java.net.http allows one outstanding send per socket: chain them. */
	private CompletableFuture<?> sendRaw(WebSocket s, String text) {
		synchronized (sendLock) {
			CompletableFuture<?> next = sendChain.handle((v, e) -> null).thenCompose(v -> s.sendText(text, true));
			sendChain = next.exceptionally(t -> null);
			return next;
		}
	}

	private void failPending(String reason) {
		IllegalStateException ex = new IllegalStateException(reason);
		pendingAcks.values().forEach(f -> f.completeExceptionally(ex));
		pendingAcks.clear();
	}
}
