package dev.larattalabs.architect.devserver.gen;

import com.google.gson.JsonArray;
import com.google.gson.JsonNull;
import com.google.gson.JsonObject;
import dev.larattalabs.architect.devserver.Bot;
import dev.larattalabs.architect.devserver.DevServer;
import dev.larattalabs.architect.devserver.ServerSidecar;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import net.minecraft.SharedConstants;
import net.minecraft.commands.CommandSource;
import net.minecraft.commands.CommandSourceStack;
import net.minecraft.network.chat.Component;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.server.permissions.LevelBasedPermissionSet;
import net.minecraft.world.level.GameType;
import net.minecraft.world.phys.Vec3;

/**
 * The DevBridge's core hooks (the client's DevCommands) on the headless server. The world is the server's, the player is the
 * bot ({@link Bot}), and a "frame" is a server tick. What only a client has (screenshots, screens, keys, the HUD, the camera's
 * view) answers that it is client-only; {@code dev.camera} still moves the player, which is what the gates rely on (it
 * loads the chunks there), and {@code dev.screen {open: "pause"}} pauses the game the way a singleplayer pause does (ticks
 * frozen, the helper told {@code client.paused}). World open, leave and quit are the host's (tools/run-headless-server.mjs:
 * one server process per world); {@code dev.host.stop} is how it stops this one.
 */
public final class CoreHooks {
	private CoreHooks() {
	}

	static final int FULL_RADIUS = Math.max(0, Bot.viewDistance() - 1);

	public static void init() {
		DevBridge.register("dev.ping", 5_000, "{} -> {pong, frame (server ticks), msSinceLastFrame, stalled, quitting}", (req, mc) -> {
			JsonObject o = new JsonObject();
			long since = DevServer.msSinceLastTick();
			o.addProperty("pong", true);
			o.addProperty("frame", DevServer.ticks());
			o.addProperty("msSinceLastFrame", since);
			o.addProperty("stalled", DevServer.server() != null && since >= 5000 && !ServerSidecar.paused());
			o.addProperty("quitting", DevServer.stopping());
			o.addProperty("headless", true);
			return CompletableFuture.completedFuture(o);
		});
		DevBridge.register("dev.help", 5_000, "{} -> {commands, screens}", (req, mc) -> CompletableFuture.completedFuture(DevBridge.help()));
		DevBridge.register("dev.state", 10_000, "{} -> {inWorld, ready, paused, player, world, chunks, headless: true}", (req, mc) -> state());
		DevBridge.register("dev.command", 30_000, "{cmd, asPlayer?: false} - run a command as the player with full permissions -> {messages[], "
			+ "success, result}", (req, mc) -> {
				Fields f = Fields.of(req);
				return command(f.nonBlank("cmd"), f.optBool("asPlayer", false));
			});
		DevBridge.register("dev.wait", req -> {
			Fields f = Fields.of(req);
			return f.optLong("ms", 0, 0, 600_000) + f.optInt("frames", 0, 0, 36_000) * 50L + 30_000;
		}, "{frames?:0-36000 (server ticks), ms?:0-600000} - wait for server ticks and/or wall time", (req, mc) -> {
			Fields f = Fields.of(req);
			int frames = f.optInt("frames", 0, 0, 36_000);
			long ms = f.optLong("ms", 0, 0, 600_000);
			CompletableFuture<Void> fut = frames > 0 ? DevServer.afterTicks(frames) : CompletableFuture.completedFuture(null);
			if (ms > 0) {
				fut = fut.thenCompose(v -> CompletableFuture.runAsync(() -> {
				}, CompletableFuture.delayedExecutor(ms, TimeUnit.MILLISECONDS)));
			}
			return fut.thenApply(v -> {
				JsonObject o = new JsonObject();
				o.addProperty("frame", DevServer.ticks());
				return o;
			});
		});
		DevBridge.register("dev.waitChunks", req -> 35_000, "{timeoutMs?:30000, radius?:viewDistance-1} - block until the chunks around the player "
			+ "are loaded (FULL)", (req, mc) -> {
				Fields f = Fields.of(req);
				long timeout = f.optLong("timeoutMs", 30_000, 1, DevBridge.MAX_TIMEOUT_MS);
				int radius = f.optInt("radius", FULL_RADIUS, 0, FULL_RADIUS);
				long start = System.currentTimeMillis();
				return waitChunks(radius, start + Math.max(1, timeout - 500)).thenApply(v -> {
					JsonObject o = new JsonObject();
					o.addProperty("waitedMs", System.currentTimeMillis() - start);
					return o;
				});
			});
		DevBridge.register("dev.time", 10_000, "{ticks} - set the day time", (req, mc) -> {
			long t = Fields.of(req).optLong("ticks", 6000, 0, Integer.MAX_VALUE);
			return command("/time set " + t, false);
		});
		DevBridge.register("dev.weather", 10_000, "{clear?:true} or {weather: clear|rain|thunder}", (req, mc) -> {
			Fields f = Fields.of(req);
			String w = f.optStr("weather", f.optBool("clear", true) ? "clear" : "rain");
			return command("/weather " + w, false);
		});
		DevBridge.register("dev.camera", 20_000, "{x,y,z, yaw,pitch | lookAt:{x,y,z}, mode?:spectator|creative|keep, feet?:false} - headless: puts "
			+ "the player there (eye at x,y,z unless feet), which loads the chunks around it; there is no view", (req, mc) -> camera(req));
		DevBridge.register("dev.release", 10_000, "{mode?:creative|keep} - give the view back to the player: spectator -> creative (flying)",
			(req, mc) -> {
				String mode = Fields.of(req).optStr("mode", "creative");
				return ServerTasks.callAsPlayer((level, p) -> {
					if (mode.equals("creative") && p.gameMode() == GameType.SPECTATOR) {
						p.setGameMode(GameType.CREATIVE);
						p.getAbilities().flying = true;
						p.onUpdateAbilities();
					}
					JsonObject o = new JsonObject();
					o.addProperty("released", true);
					return o;
				});
			});
		DevBridge.register("dev.screen", 10_000, "{open: 'pause'|null} - headless: 'pause' pauses the game as a singleplayer pause does (ticks "
			+ "frozen, client.paused to the helper), null resumes; other screens are client-only", (req, mc) -> {
				var el = req.get("open");
				String open = el == null || el.isJsonNull() ? null : el.getAsString();
				if (open != null && !open.equals("pause")) {
					throw new DevBridge.DevException(ClientOnly.WHY + " (screen " + open + ")");
				}
				return ServerTasks.callOnServer(server -> {
					ServerSidecar.setPaused(server, open != null);
					JsonObject o = new JsonObject();
					o.addProperty("paused", open != null);
					o.add("screen", open == null ? JsonNull.INSTANCE : new com.google.gson.JsonPrimitive(open));
					return o;
				});
			});
		for (String clientOnly : new String[] {"dev.screenshot", "dev.hud", "dev.key", "dev.type", "dev.click", "dev.ui.open", "dev.ui.state",
			"dev.ui.click", "dev.ui.focus", "dev.build.start", "dev.build.state", "dev.build.confirm", "dev.build.cancel", "dev.build.rotate",
			"dev.build.nudge", "dev.build.lock", "dev.library.state", "dev.composite.state", "dev.composite.clear", "dev.region.ghost", "dev.crate.open",
			"dev.crate.state", "dev.crate.press", "dev.ghosts.state", "dev.scenario.cams"}) {
			DevBridge.register(clientOnly, 5_000, "client-only (headless: refused)", (req, mc) -> CompletableFuture.failedFuture(new DevBridge.DevException(
				ClientOnly.WHY + " (" + clientOnly + ")")));
		}
		DevBridge.register("dev.host.stop", 10_000, "{} - (the headless host) save and stop the server; the process exits", (req, mc) -> {
			DevServer.stopServer(false);
			JsonObject o = new JsonObject();
			o.addProperty("stopping", true);
			return CompletableFuture.completedFuture(o);
		});
		DevBridge.register("dev.host.leave", 300_000, "{} - (the headless host) save and stop the server; the process waits for the next world",
			(req, mc) -> DevServer.stopServer(true).thenApply(v -> {
				JsonObject o = new JsonObject();
				o.addProperty("left", true);
				return o;
			}));
		DevBridge.register("dev.host.open", 10_000, "{world} - (the headless host) start the server on that world in this process", (req, mc) -> {
			String world = Fields.of(req).nonBlank("world");
			DevServer.openWorld(world);
			JsonObject o = new JsonObject();
			o.addProperty("opening", true);
			return CompletableFuture.completedFuture(o);
		});
	}

	// ------------------------------------------------------------------ state

	static CompletableFuture<JsonObject> state() {
		MinecraftServer server = DevServer.server();
		if (server == null || DevServer.stopping()) {
			JsonObject o = notInWorld(DevServer.idle() ? "title" : server == null ? "starting" : "stopping");
			return CompletableFuture.completedFuture(o);
		}
		return ServerTasks.callOnServer(s -> {
			ServerPlayer p = Bot.player(s);
			if (p == null) {
				return notInWorld("joining");
			}
			JsonObject o = new JsonObject();
			boolean loaded = chunksLoaded(p, 0);
			o.addProperty("inWorld", true);
			o.addProperty("ready", loaded);
			o.addProperty("loading", !loaded);
			o.addProperty("paused", ServerSidecar.paused());
			o.addProperty("headless", true);
			o.addProperty("minecraft", SharedConstants.getCurrentVersion().name());
			o.addProperty("frame", DevServer.ticks());
			o.add("screen", JsonNull.INSTANCE);
			JsonObject pl = new JsonObject();
			pl.addProperty("name", p.getGameProfile().name());
			pl.addProperty("x", p.getX());
			pl.addProperty("y", p.getY());
			pl.addProperty("z", p.getZ());
			pl.addProperty("eyeY", p.getEyeY());
			pl.addProperty("yaw", p.getYRot());
			pl.addProperty("pitch", p.getXRot());
			pl.addProperty("flying", p.getAbilities().flying);
			pl.addProperty("gameMode", p.gameMode().getName());
			o.add("player", pl);
			ServerLevel level = p.level();
			JsonObject wo = new JsonObject();
			wo.addProperty("name", s.getWorldData().getLevelName());
			wo.addProperty("dimension", level.dimension().identifier().toString());
			wo.addProperty("time", level.getDefaultClockTime());
			wo.addProperty("raining", level.isRaining());
			wo.addProperty("thundering", level.isThundering());
			o.add("world", wo);
			JsonObject ch = new JsonObject();
			ch.addProperty("loadedAll", chunksLoaded(p, FULL_RADIUS));
			ch.addProperty("renderDistance", Bot.viewDistance());
			o.add("chunks", ch);
			return o;
		});
	}

	private static JsonObject notInWorld(String phase) {
		JsonObject o = new JsonObject();
		o.addProperty("inWorld", false);
		o.addProperty("ready", false);
		o.addProperty("loading", true);
		o.addProperty("paused", false);
		o.addProperty("headless", true);
		o.addProperty("phase", phase);
		o.add("screen", JsonNull.INSTANCE);
		o.add("player", JsonNull.INSTANCE);
		o.add("world", JsonNull.INSTANCE);
		return o;
	}

	/** Every chunk within {@code radius} of the player is loaded at FULL (server thread). */
	static boolean chunksLoaded(ServerPlayer p, int radius) {
		ServerLevel level = p.level();
		int cx = p.chunkPosition().x();
		int cz = p.chunkPosition().z();
		for (int dx = -radius; dx <= radius; dx++) {
			for (int dz = -radius; dz <= radius; dz++) {
				if (level.getChunkSource().getChunkNow(cx + dx, cz + dz) == null) {
					return false;
				}
			}
		}
		return true;
	}

	static CompletableFuture<Void> waitChunks(int radius, long deadline) {
		CompletableFuture<Void> done = new CompletableFuture<>();
		DevServer.everyTick(server -> {
			if (done.isDone()) {
				return true;
			}
			ServerPlayer p = Bot.player(server);
			if (p != null && chunksLoaded(p, radius)) {
				done.complete(null);
				return true;
			}
			if (System.currentTimeMillis() >= deadline) {
				done.completeExceptionally(new DevBridge.DevException("chunks around the player not loaded within the timeout"));
				return true;
			}
			return false;
		});
		return done;
	}

	// ------------------------------------------------------------------ command (DevCommands.serverCommand)

	public static CompletableFuture<JsonObject> command(String cmd, boolean asPlayer) {
		return ServerTasks.callOnServer(server -> {
			ServerPlayer sp = Bot.player(server);
			List<String> messages = new ArrayList<>();
			AtomicBoolean success = new AtomicBoolean(true);
			AtomicInteger result = new AtomicInteger(0);
			AtomicBoolean callbackFired = new AtomicBoolean(false);
			CommandSource capture = new CommandSource() {
				@Override
				public void sendSystemMessage(Component message) {
					messages.add(message.getString());
				}

				@Override
				public boolean acceptsSuccess() {
					return true;
				}

				@Override
				public boolean acceptsFailure() {
					return true;
				}

				@Override
				public boolean shouldInformAdmins() {
					return false;
				}
			};
			CommandSourceStack base = sp != null ? sp.createCommandSourceStack() : server.createCommandSourceStack();
			CommandSourceStack source = (asPlayer ? base.withSource(capture) : base.withSource(capture).withPermission(LevelBasedPermissionSet.OWNER))
				.withCallback((ok, value) -> {
					callbackFired.set(true);
					if (!ok) {
						success.set(false);
					}
					result.set(value);
				});
			server.getCommands().performPrefixedCommand(source, cmd);
			JsonObject o = new JsonObject();
			o.addProperty("cmd", cmd);
			JsonArray arr = new JsonArray();
			messages.forEach(arr::add);
			o.add("messages", arr);
			if (callbackFired.get()) {
				o.addProperty("success", success.get());
				o.addProperty("result", result.get());
			} else {
				o.addProperty("success", false);
				o.add("result", JsonNull.INSTANCE);
			}
			return o;
		});
	}

	// ------------------------------------------------------------------ camera: the player moves there

	static CompletableFuture<JsonObject> camera(JsonObject req) {
		Fields f = Fields.of(req);
		if (req.has("anchor")) {
			throw new DevBridge.DevException("headless: dev.camera {anchor} is client-only (pass x, y, z)");
		}
		double x = f.num("x");
		double y = f.num("y");
		double z = f.num("z");
		boolean feet = f.optBool("feet", false);
		String mode = f.optStr("mode", "spectator");
		float yaw0;
		float pitch0;
		if (req.has("lookAt")) {
			Fields l = f.optObj("lookAt");
			double dx = l.num("x") - x;
			double dy = l.num("y") - y;
			double dz = l.num("z") - z;
			yaw0 = (float) (Math.toDegrees(Math.atan2(-dx, dz)));
			pitch0 = (float) (-Math.toDegrees(Math.atan2(dy, Math.sqrt(dx * dx + dz * dz))));
		} else {
			yaw0 = (float) f.optNum("yaw", 0, -360, 360);
			pitch0 = (float) f.optNum("pitch", 0, -90, 90);
		}
		final float yaw = yaw0;
		final float pitch = pitch0;
		return ServerTasks.callAsPlayer((level, sp) -> {
			if (sp.getCamera() != sp) {
				sp.setCamera(sp);
			}
			if (mode.equals("spectator") && sp.gameMode() != GameType.SPECTATOR) {
				sp.setGameMode(GameType.SPECTATOR);
			} else if (mode.equals("creative")) {
				if (sp.gameMode() != GameType.CREATIVE) {
					sp.setGameMode(GameType.CREATIVE);
				}
				sp.getAbilities().flying = true;
				sp.onUpdateAbilities();
			}
			double feetY = feet ? y : y - sp.getEyeHeight(net.minecraft.world.entity.Pose.STANDING);
			sp.teleportTo(level, x, feetY, z, Set.of(), yaw, pitch, true);
			JsonObject o = new JsonObject();
			Vec3 at = sp.position();
			o.addProperty("x", at.x);
			o.addProperty("y", sp.getEyeY());
			o.addProperty("z", at.z);
			o.addProperty("yaw", yaw);
			o.addProperty("pitch", pitch);
			o.addProperty("headless", true);
			return o;
		});
	}
}
