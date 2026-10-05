package dev.larattalabs.apitest;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.google.gson.JsonPrimitive;
import dev.larattalabs.architect.api.ArchitectApi;
import dev.larattalabs.architect.api.Job;
import dev.larattalabs.architect.api.JobSpec;
import dev.larattalabs.architect.api.Jobs;
import dev.larattalabs.architect.api.LoadPolicy;
import dev.larattalabs.architect.api.ToolHandler;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.Random;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicReference;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerTickEvents;
import net.minecraft.commands.CommandSourceStack;
import net.minecraft.core.BlockPos;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.level.levelgen.structure.BoundingBox;

/**
 * The jobs half of apitest (docs/CONTRACT.md "Phase 4a gate": jobs without Claude, against the sidecar's sim backend). Its
 * tools are registered once at init, globally per (owner "apitest", name), as the contract asks:
 * <ul>
 *   <li>{@code survey}: a survey summary around the player (server thread);</li>
 *   <li>{@code fast}: readOnly and declared thread-safe: runs on a worker;</li>
 *   <li>{@code slowro}: readOnly but not thread-safe: runs on the server thread;</li>
 *   <li>{@code big}: answers ~300 KB, which goes as a blob;</li>
 *   <li>{@code tickwait}: answers after {@link #TICKWAIT} server ticks (which do not pass while the game is paused);</li>
 *   <li>{@code hold}: answers when {@code /apitest release} says so;</li>
 *   <li>{@code missing}: declared in specs, never registered ("no handler for missing in this game").</li>
 * </ul>
 */
final class ApiTestJobs {
	static final String OWNER = "apitest";
	static final int TICKWAIT = 60;
	static final AtomicLong TICKS = new AtomicLong();
	static final AtomicReference<MinecraftServer> SERVER = new AtomicReference<>();
	/** Per tool: invocations, the thread of the last one, when it was called and answered. */
	static final Map<String, JsonObject> STATS = new ConcurrentHashMap<>();
	private static final List<Object[]> TICK_WAITS = new ArrayList<>();
	private static final AtomicReference<CompletableFuture<JsonElement>> HOLD = new AtomicReference<>();

	private ApiTestJobs() {
	}

	static void init() {
		net.fabricmc.fabric.api.event.lifecycle.v1.ServerLifecycleEvents.SERVER_STARTED.register(SERVER::set);
		ServerTickEvents.END_SERVER_TICK.register(s -> {
			long t = TICKS.incrementAndGet();
			synchronized (TICK_WAITS) {
				TICK_WAITS.removeIf(w -> {
					if ((long) w[0] <= t) {
						@SuppressWarnings("unchecked")
						CompletableFuture<JsonElement> f = (CompletableFuture<JsonElement>) w[1];
						JsonObject o = new JsonObject();
						o.addProperty("tickwait", TICKWAIT);
						o.addProperty("answeredOn", Thread.currentThread().getName());
						f.complete(o);
						return true;
					}
					return false;
				});
			}
		});
		Jobs jobs = ArchitectApi.get().jobs();
		jobs.registerTool(OWNER, "survey", (jobId, input) -> {
			called("survey");
			MinecraftServer server = SERVER.get();
			ServerLevel level = server.overworld();
			List<ServerPlayer> ps = server.getPlayerList().getPlayers();
			BlockPos c = ps.isEmpty() ? BlockPos.ZERO : ps.get(0).blockPosition();
			int r = input.has("radius") && input.get("radius").getAsInt() >= 8 ? Math.min(64, input.get("radius").getAsInt()) : 24;
			BoundingBox box = new BoundingBox(c.getX() - r, level.getMinY(), c.getZ() - r, c.getX() + r, level.getMaxY(), c.getZ() + r);
			return ArchitectApi.get().survey().sample(level, box, 4, LoadPolicy.LOADED_ONLY).thenApply(s -> {
				JsonObject o = new JsonObject();
				String sum = s.summary();
				o.addProperty("summary", sum.length() > 4000 ? sum.substring(0, 4000) : sum);
				o.addProperty("width", s.width());
				o.addProperty("depth", s.depth());
				o.addProperty("ranOn", STATS.get("survey").get("thread").getAsString());
				answered("survey");
				return o;
			});
		});
		jobs.registerTool(OWNER, "fast", ToolHandler.threadSafe((jobId, input) -> CompletableFuture.completedFuture(threadAnswer("fast"))));
		jobs.registerTool(OWNER, "slowro", (jobId, input) -> CompletableFuture.completedFuture(threadAnswer("slowro")));
		jobs.registerTool(OWNER, "big", (jobId, input) -> {
			called("big");
			JsonArray arr = new JsonArray();
			for (int i = 0; i < 6000; i++) {
				arr.add("row " + i + " " + "x".repeat(40));
			}
			JsonObject o = new JsonObject();
			o.add("rows", arr);
			answered("big");
			return CompletableFuture.completedFuture(o);
		});
		jobs.registerTool(OWNER, "tickwait", (jobId, input) -> {
			called("tickwait");
			CompletableFuture<JsonElement> f = new CompletableFuture<>();
			synchronized (TICK_WAITS) {
				TICK_WAITS.add(new Object[] {TICKS.get() + TICKWAIT, f});
			}
			return f.whenComplete((v, e) -> answered("tickwait"));
		});
		jobs.registerTool(OWNER, "hold", (jobId, input) -> {
			called("hold");
			CompletableFuture<JsonElement> f = new CompletableFuture<>();
			HOLD.set(f);
			return f.whenComplete((v, e) -> answered("hold"));
		});
	}

	private static synchronized void called(String tool) {
		JsonObject s = STATS.computeIfAbsent(tool, k -> new JsonObject());
		s.addProperty("calls", (s.has("calls") ? s.get("calls").getAsInt() : 0) + 1);
		s.addProperty("thread", Thread.currentThread().getName());
		s.addProperty("calledAt", System.currentTimeMillis());
		s.remove("answeredAt");
	}

	private static synchronized void answered(String tool) {
		STATS.computeIfAbsent(tool, k -> new JsonObject()).addProperty("answeredAt", System.currentTimeMillis());
	}

	private static JsonObject threadAnswer(String tool) {
		called(tool);
		JsonObject o = new JsonObject();
		o.addProperty("tool", tool);
		o.addProperty("ranOn", Thread.currentThread().getName());
		answered(tool);
		return o;
	}

	private static JobSpec.Tool tool(String name, String description, String schema, Long timeoutMs, boolean readOnly) {
		return new JobSpec.Tool(name, description, JsonParser.parseString(schema).getAsJsonObject(), timeoutMs, readOnly);
	}

	private static final String EMPTY = "{\"type\":\"object\",\"properties\":{}}";

	/** The specs the driver runs, by name. */
	static JobSpec spec(String name, List<String> blobs) {
		JsonObject ext = new JsonObject();
		ext.addProperty("apitest:case", name);
		String structuredSchema = "{\"type\":\"object\",\"properties\":{\"name\":{\"type\":\"string\",\"minLength\":1},\"floors\":{\"type\":\"integer\","
			+ "\"minimum\":1,\"maximum\":4},\"tags\":{\"type\":\"array\",\"items\":{\"type\":\"string\"},\"maxItems\":3}},\"required\":[\"name\",\"floors\"],"
			+ "\"additionalProperties\":false}";
		return switch (name) {
			case "structured" -> new JobSpec("structured", "Name a cabin and give its floor count.", null, null, "low",
				JsonParser.parseString(structuredSchema).getAsJsonObject(), List.of(), 0.5, null, OWNER, "apitest-structured", null, ext, blobs);
			case "agent" -> new JobSpec("agent", "Survey the site, then report.", null, null, "low", null, List.of(
				tool("survey", "A summary of the terrain around the player", "{\"type\":\"object\",\"properties\":{\"radius\":{\"type\":\"integer\","
					+ "\"minimum\":8,\"maximum\":64}}}", 30_000L, false),
				tool("fast", "Answers at once (read-only, thread-safe)", EMPTY, null, true),
				tool("slowro", "Answers at once (read-only, not thread-safe)", EMPTY, null, true),
				tool("missing", "Nobody registered this one", EMPTY, null, false),
				tool("big", "A long answer", EMPTY, null, true)), 1.0, null, OWNER, "apitest-agent", null, ext, blobs);
			case "paused" -> new JobSpec("agent", "Wait for the game.", null, null, "low", null, List.of(
				tool("tickwait", "Answers after 60 game ticks", EMPTY, 10_000L, false)), 1.0, null, OWNER, "apitest-paused", null, ext, blobs);
			case "hold" -> new JobSpec("agent", "Wait for the hold.", null, null, "low", null, List.of(
				tool("hold", "Answers when released", EMPTY, 600_000L, false)), 1.0, null, OWNER, "apitest-hold", null, ext, blobs);
			case "budget" -> new JobSpec("agent", "Spend.", null, null, "low", null, List.of(
				tool("fast", "Answers at once", EMPTY, null, true), tool("slowro", "Answers at once", EMPTY, null, true),
				tool("missing", "Nobody", EMPTY, null, false)), 0.015, null, OWNER, "apitest-budget", null, ext, blobs);
			default -> throw new IllegalArgumentException("unknown spec " + name);
		};
	}

	static JsonElement step(CommandSourceStack src, String[] a) throws Exception {
		Jobs jobs = ArchitectApi.get().jobs();
		SERVER.set(src.getServer());
		switch (a[0]) {
			case "jobrun": {
				// jobrun <spec> [blob,blob]
				List<String> blobs = a.length > 2 ? Arrays.asList(a[2].split(",")) : List.of();
				return ApiTest.later("jobrun:" + a[1], jobs.run(spec(a[1], blobs)).thenApply(JsonPrimitive::new));
			}
			case "job": {
				return jobs.get(a[1]).map(j -> (JsonElement) job(j)).orElse(com.google.gson.JsonNull.INSTANCE);
			}
			case "joblist": {
				JsonArray arr = new JsonArray();
				jobs.list(a.length > 1 ? a[1] : null).forEach(j -> arr.add(job(j)));
				return arr;
			}
			case "jobcancel": {
				jobs.cancel(a[1]);
				JsonObject o = new JsonObject();
				o.addProperty("sent", true);
				return o;
			}
			case "blobput": {
				// blobput bin <bytes> | blobput survey
				if (a[1].equals("bin")) {
					byte[] data = new byte[Integer.parseInt(a[2])];
					new Random(42).nextBytes(data);
					String sha = sha256(data);
					return ApiTest.later("blobput:bin", jobs.putBlob("apitest.bin", OWNER, data).thenApply(id -> {
						JsonObject o = new JsonObject();
						o.addProperty("blobId", id);
						o.addProperty("sha256", sha);
						o.addProperty("bytes", data.length);
						o.addProperty("thread", Thread.currentThread().getName());
						return o;
					}));
				}
				ServerPlayer p = src.getPlayer();
				ServerLevel level = src.getLevel();
				BlockPos c = p != null ? p.blockPosition() : BlockPos.ZERO;
				BoundingBox box = new BoundingBox(c.getX() - 32, level.getMinY(), c.getZ() - 32, c.getX() + 31, level.getMaxY(), c.getZ() + 31);
				return ApiTest.later("blobput:survey", ArchitectApi.get().survey().sample(level, box, 1, LoadPolicy.LOADED_ONLY).thenCompose(s -> {
					JsonObject json = s.toJson();
					return jobs.putBlob("survey", OWNER, json).thenApply(id -> {
						JsonObject o = new JsonObject();
						o.addProperty("blobId", id);
						o.addProperty("width", s.width());
						o.addProperty("depth", s.depth());
						o.addProperty("bytes", json.toString().getBytes(StandardCharsets.UTF_8).length);
						o.addProperty("thread", Thread.currentThread().getName());
						return o;
					});
				}));
			}
			case "release": {
				CompletableFuture<JsonElement> f = HOLD.getAndSet(null);
				JsonObject o = new JsonObject();
				o.addProperty("released", f != null);
				if (f != null) {
					JsonObject ans = new JsonObject();
					ans.addProperty("held", true);
					ans.addProperty("calls", STATS.get("hold").get("calls").getAsInt());
					f.complete(ans);
				}
				return o;
			}
			case "toolstats": {
				JsonObject o = new JsonObject();
				STATS.forEach((k, v) -> o.add(k, v.deepCopy()));
				o.addProperty("ticks", TICKS.get());
				return o;
			}
			case "ticks": {
				JsonObject o = new JsonObject();
				o.addProperty("ticks", TICKS.get());
				return o;
			}
			default:
				throw new IllegalArgumentException("unknown step " + a[0]);
		}
	}

	static JsonObject job(Job j) {
		JsonObject o = new JsonObject();
		o.addProperty("id", j.id());
		o.addProperty("status", j.status());
		o.addProperty("step", j.step());
		o.addProperty("owner", j.owner().orElse(null));
		o.addProperty("tag", j.spec().has("tag") ? j.spec().get("tag").getAsString() : null);
		o.addProperty("error", j.error().orElse(null));
		o.addProperty("resultBlob", j.resultBlob().orElse(null));
		j.result().ifPresent(r -> o.add("result", r.toString().length() > 20_000 ? new JsonPrimitive(r.toString().substring(0, 20_000)) : r));
		JsonObject cost = new JsonObject();
		cost.addProperty("usd", j.cost().usd());
		cost.addProperty("turns", j.cost().turns());
		cost.addProperty("inputTokens", j.cost().inputTokens());
		cost.addProperty("cacheReadTokens", j.cost().cacheReadTokens());
		cost.addProperty("cacheWriteTokens", j.cost().cacheWriteTokens());
		o.add("cost", cost);
		o.addProperty("createdAt", j.createdAt());
		return o;
	}

	static String sha256(byte[] data) throws Exception {
		return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(data));
	}
}
