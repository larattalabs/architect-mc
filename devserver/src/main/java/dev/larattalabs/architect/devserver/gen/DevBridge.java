package dev.larattalabs.architect.devserver.gen;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import dev.larattalabs.architect.Architect;
import java.util.Map;
import java.util.TreeMap;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.function.Supplier;
import java.util.function.ToLongFunction;

/**
 * The headless DevBridge's hook registry: the client {@code DevBridge}'s extension API ({@link #register}, {@link #onClient},
 * {@link DevException}, {@link #GSON}) for the hooks derived from the client's sources, and the dispatch the line bridge
 * ({@code dev.larattalabs.architect.devserver.LineBridge}) calls. The transport lives in tools/run-headless-server.mjs, which
 * serves the DevBridge's WebSocket protocol to the gate drivers and forwards each request here.
 */
public final class DevBridge {
	public static final int PROTOCOL = 1;
	public static final Gson GSON = new GsonBuilder().disableHtmlEscaping().serializeNulls().create();
	public static final long MAX_TIMEOUT_MS = 3_600_000L;

	/** The client thread's stand-in: one thread, so handler bodies run one at a time as they do on the client. */
	static final ExecutorService HOST = Executors.newSingleThreadExecutor(r -> {
		Thread t = new Thread(r, "devserver-host");
		t.setDaemon(true);
		return t;
	});

	@FunctionalInterface
	public interface Handler {
		CompletableFuture<JsonObject> handle(JsonObject request, Mc mc) throws Exception;
	}

	private record Registered(Handler handler, ToLongFunction<JsonObject> defaultTimeoutMs, String help) {
	}

	private static final Map<String, Registered> HANDLERS = new ConcurrentHashMap<>();

	private DevBridge() {
	}

	public static void register(String type, long timeoutMs, String help, Handler handler) {
		HANDLERS.put(type, new Registered(handler, req -> timeoutMs, help));
	}

	public static void register(String type, ToLongFunction<JsonObject> timeoutMs, String help, Handler handler) {
		HANDLERS.put(type, new Registered(handler, timeoutMs, help));
	}

	public static boolean has(String type) {
		return HANDLERS.containsKey(type);
	}

	/** Runs {@code work} on the host thread and completes with its result. */
	public static <T> CompletableFuture<T> onClient(Mc mc, Supplier<T> work) {
		CompletableFuture<T> f = new CompletableFuture<>();
		HOST.execute(() -> {
			try {
				f.complete(work.get());
			} catch (Throwable t) {
				f.completeExceptionally(t);
			}
		});
		return f;
	}

	/** A registered hook run from mod code (no timeout). */
	public static CompletableFuture<JsonObject> invoke(String type, JsonObject request) {
		Registered reg = HANDLERS.get(type);
		if (reg == null) {
			return CompletableFuture.failedFuture(new DevException("unknown type '" + type + "' (try dev.help)"));
		}
		try {
			CompletableFuture<JsonObject> f = reg.handler().handle(request, Mc.INSTANCE);
			return f != null ? f : CompletableFuture.failedFuture(new IllegalStateException("handler returned no future"));
		} catch (Throwable t) {
			return CompletableFuture.failedFuture(t);
		}
	}

	/**
	 * Dispatches one request (the client DevBridge's {@code onMessage} without the socket): completes with the full reply,
	 * {@code {id, type, ok: true, ...}} or {@code {id, type, ok: false, error}}. Never completes exceptionally.
	 */
	public static CompletableFuture<JsonObject> dispatch(JsonObject req) {
		JsonElement id = req.get("id");
		String type = req.has("type") && req.get("type").isJsonPrimitive() ? req.get("type").getAsString() : null;
		try {
			if (type == null) {
				throw new DevException("missing 'type'");
			}
			Registered reg = HANDLERS.get(type);
			if (reg == null) {
				throw new DevException("unknown type '" + type + "' (try dev.help)");
			}
			Fields meta = Fields.of(req);
			long timeout = meta.has("timeoutMs") ? meta.integer("timeoutMs", 1, MAX_TIMEOUT_MS)
				: Math.max(1, Math.min(MAX_TIMEOUT_MS, reg.defaultTimeoutMs().applyAsLong(req)));
			CompletableFuture<JsonObject> future = reg.handler().handle(req, Mc.INSTANCE);
			if (future == null) {
				throw new IllegalStateException("handler returned no future");
			}
			final String ftype = type;
			return future.orTimeout(timeout, TimeUnit.MILLISECONDS).handle((result, err) -> {
				if (err != null) {
					return error(id, ftype, err);
				}
				JsonObject out = new JsonObject();
				if (id != null && !id.isJsonNull()) {
					out.add("id", id);
				}
				out.addProperty("type", ftype);
				out.addProperty("ok", true);
				if (result != null) {
					for (Map.Entry<String, JsonElement> e : result.entrySet()) {
						out.add(e.getKey(), e.getValue());
					}
				}
				return out;
			});
		} catch (Throwable t) {
			return CompletableFuture.completedFuture(error(id, type, t));
		}
	}

	static JsonObject error(JsonElement id, String type, Throwable t) {
		Throwable cause = t;
		while ((cause instanceof CompletionException || cause instanceof ExecutionException) && cause.getCause() != null) {
			cause = cause.getCause();
		}
		JsonObject out = new JsonObject();
		if (id != null && !id.isJsonNull()) {
			out.add("id", id);
		}
		if (type != null) {
			out.addProperty("type", type);
		}
		out.addProperty("ok", false);
		String msg;
		if (cause instanceof TimeoutException) {
			msg = cause.getMessage() != null ? cause.getMessage() : "timed out";
		} else if (cause instanceof DevException || cause instanceof ServerTasks.Refused) {
			msg = cause.getMessage();
		} else {
			msg = "internal error: " + cause;
			Architect.LOGGER.warn("devserver: {} failed", type, cause);
		}
		out.addProperty("error", msg == null ? cause.getClass().getSimpleName() : msg);
		return out;
	}

	public static String describeError(Throwable t) {
		return error(null, null, t).get("error").getAsString();
	}

	public static JsonObject help() {
		JsonObject cmds = new JsonObject();
		new TreeMap<>(HANDLERS).forEach((k, v) -> cmds.addProperty(k, v.help()));
		JsonObject out = new JsonObject();
		out.add("commands", cmds);
		out.add("screens", new JsonObject());
		return out;
	}

	/** A user-facing error (sent back verbatim). */
	public static final class DevException extends RuntimeException {
		public DevException(String message) {
			super(message);
		}
	}
}
