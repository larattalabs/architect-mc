package dev.larattalabs.architect.client.dev;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import dev.larattalabs.architect.api.BrushKind;
import dev.larattalabs.architect.api.BrushRequest;
import dev.larattalabs.architect.api.BrushShape;
import dev.larattalabs.architect.api.Destruction;
import dev.larattalabs.architect.api.Mask;
import dev.larattalabs.architect.api.Pattern;
import dev.larattalabs.architect.api.RegionView;
import dev.larattalabs.architect.client.world.ServerTasks;
import dev.larattalabs.architect.region.Brushes;
import java.util.Locale;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import net.minecraft.core.BlockPos;
import net.minecraft.world.level.Level;

/**
 * Phase 6c slice B DevBridge hooks (docs/DEVBRIDGE.md; CONTRACT B §6): a brush stroke through the API (the player as the actor, none,
 * a given UUID, or the console's path), and the strokes' latency marks. Pure server work: generated for the headless server too.
 */
public final class SliceBDev {
	private SliceBDev() {
	}

	static JsonObject view(RegionView v) {
		JsonObject o = new JsonObject();
		o.addProperty("region", v.id());
		o.addProperty("planId", v.planId());
		o.addProperty("irSha", v.irSha());
		o.addProperty("state", v.state().name());
		o.addProperty("owner", v.owner());
		o.addProperty("groupId", v.groupId());
		o.addProperty("brush", v.brush());
		o.addProperty("cellsWritten", v.cellsWritten());
		JsonObject sk = new JsonObject();
		v.cellsSkipped().forEach(sk::addProperty);
		o.add("cellsSkipped", sk);
		JsonArray c = new JsonArray();
		c.add(v.claim().minX());
		c.add(v.claim().minY());
		c.add(v.claim().minZ());
		c.add(v.claim().maxX());
		c.add(v.claim().maxY());
		c.add(v.claim().maxZ());
		o.add("claim", c);
		if (v.waiting() != null) {
			o.addProperty("waiting", v.waiting().reason() + ": " + v.waiting().message());
		}
		return o;
	}

	public static void init() {
		DevBridge.register("dev.brush", 600_000, "{kind, at: [x,y,z], radius?: 6, strength?: 3, shape?: sphere|cylinder, mask?: {..}, pattern?: {..}, "
			+ "destruction?: natural_only|player_blocks, owner?: architect:player, actor?: me|none|<uuid>, console?: false, seed?: 0, dimension?: overworld|nether|end} - (6c B) one "
			+ "brush stroke (Regions.brush; console: the command's console path) -> the region's view once realised {region, planId, irSha, state, "
			+ "brush, cellsWritten, cellsSkipped, claim, ms} or {refused, reason}", (req, mc) -> {
				Fields f = Fields.of(req);
				BrushKind kind = BrushKind.valueOf(f.nonBlank("kind").toUpperCase(Locale.ROOT));
				JsonArray a = req.getAsJsonArray("at");
				BlockPos at = new BlockPos(a.get(0).getAsInt(), a.get(1).getAsInt(), a.get(2).getAsInt());
				int radius = f.optInt("radius", 6, -1000, 1000);
				int strength = f.optInt("strength", 3, -1000, 1000);
				BrushShape shape = BrushShape.valueOf(f.optStr("shape", "sphere").toUpperCase(Locale.ROOT));
				Destruction d = Destruction.valueOf(f.optStr("destruction", "natural_only").toUpperCase(Locale.ROOT));
				String owner = req.has("owner") && req.get("owner").isJsonNull() ? null : f.optStr("owner", Brushes.PLAYER_OWNER);
				String actor = f.optStr("actor", "me");
				boolean console = f.optBool("console", false);
				long seed = f.optLong("seed", 0, Long.MIN_VALUE, Long.MAX_VALUE);
				var dimension = switch (f.optStr("dimension", "overworld")) {
					case "nether", "the_nether" -> Level.NETHER;
					case "end", "the_end" -> Level.END;
					default -> Level.OVERWORLD;
				};
				Mask mask = req.get("mask") instanceof JsonObject m ? new Mask(m) : null;
				Pattern pattern = req.get("pattern") instanceof JsonObject p ? new Pattern(p) : null;
				long t0 = System.nanoTime();
				return ServerTasks.callAsPlayer((level, player) -> {
					UUID who = switch (actor) {
						case "me" -> player.getUUID();
						case "none" -> null;
						default -> UUID.fromString(actor);
					};
					return Brushes.stroke(new BrushRequest(owner, dimension, kind, shape, at, radius, strength, mask, pattern, d, who, seed), console);
				}).thenCompose(x -> x).handle((v, e) -> {
					if (e != null) {
						Throwable c = e instanceof java.util.concurrent.CompletionException && e.getCause() != null ? e.getCause() : e;
						JsonObject o = new JsonObject();
						if (c instanceof dev.larattalabs.architect.api.ArchitectRefused r) {
							o.addProperty("reason", r.reason().name());
							o.addProperty("refused", r.reason() + ": " + r.getMessage());
						} else {
							o.addProperty("refused", String.valueOf(c));
						}
						return o;
					}
					JsonObject o = view(v);
					o.addProperty("ms", (System.nanoTime() - t0) / 1e6);
					return o;
				});
			});
		DevBridge.register("dev.brush.stats", 10_000, "{} - (6c B) every stroke's latency marks {region, requested, planned, realised} (epoch ms)",
			(req, mc) -> {
				JsonObject o = new JsonObject();
				JsonArray a = new JsonArray();
				Brushes.times().forEach(a::add);
				o.add("strokes", a);
				return CompletableFuture.completedFuture(o);
			});
	}
}
