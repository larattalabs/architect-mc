package dev.larattalabs.architect.site;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import java.util.ArrayList;
import java.util.List;
import net.minecraft.core.BlockPos;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.resources.Identifier;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.material.Fluid;
import net.minecraft.world.ticks.ScheduledTick;
import net.minecraft.world.ticks.TickPriority;
import org.jspecify.annotations.Nullable;

/**
 * Holds back the block and fluid ticks a ticked placement schedules while it writes (a falling block's tick on placement, a
 * path or leaf shape update), and schedules them again, with the delays they had, once the placement is complete. The
 * atomic placement writes everything in one tick, so its ticks always run on the finished building; held back, a ticked
 * placement's ticks do too, which keeps the two equal cell for cell (docs/CONTRACT.md phase 4d). Capture is on only inside
 * {@link #begin} / {@link #end}, around Architect's own writes on the server thread ({@code LevelTicksMixin}).
 */
public final class TickDeferral {
	private static @Nullable List<Held> active;
	private static @Nullable Thread owner;
	private static long gameTime;

	private TickDeferral() {
	}

	/**
	 * A held-back tick.
	 *
	 * @param fluid a fluid tick (else a block tick)
	 * @param type the block or fluid id
	 * @param delay ticks left until it was due when it was held back
	 */
	public record Held(boolean fluid, String type, long pos, int delay, int priority) {
		JsonArray toJson() {
			JsonArray a = new JsonArray();
			a.add(fluid ? 1 : 0);
			a.add(type);
			a.add(pos);
			a.add(delay);
			a.add(priority);
			return a;
		}

		static Held fromJson(JsonArray a) {
			return new Held(a.get(0).getAsInt() == 1, a.get(1).getAsString(), a.get(2).getAsLong(), a.get(3).getAsInt(), a.get(4).getAsInt());
		}
	}

	/** Starts holding back ticks into {@code into} (the job's list). Server thread; always paired with {@link #end} in a finally. */
	static void begin(ServerLevel level, List<Held> into) {
		active = into;
		owner = Thread.currentThread();
		gameTime = level.getGameTime();
	}

	static void end() {
		active = null;
		owner = null;
	}

	/** {@code LevelTicksMixin}: true when the tick was held back (and must not be scheduled now). */
	public static boolean capture(ScheduledTick<?> tick) {
		List<Held> into = active;
		if (into == null || Thread.currentThread() != owner) {
			return false;
		}
		Object type = tick.type();
		String id;
		boolean fluid;
		if (type instanceof Block b) {
			id = BuiltInRegistries.BLOCK.getKey(b).toString();
			fluid = false;
		} else if (type instanceof Fluid f) {
			id = BuiltInRegistries.FLUID.getKey(f).toString();
			fluid = true;
		} else {
			return false;
		}
		into.add(new Held(fluid, id, tick.pos().asLong(), (int) Math.max(0, tick.triggerTick() - gameTime), tick.priority().getValue()));
		return true;
	}

	/** Schedules held-back ticks again, in the order they were held, with the delays they had. */
	static void release(ServerLevel level, List<Held> held) {
		for (Held h : held) {
			Identifier key = Identifier.tryParse(h.type());
			if (key == null) {
				continue;
			}
			BlockPos p = BlockPos.of(h.pos());
			TickPriority pr = TickPriority.byValue(h.priority());
			if (h.fluid()) {
				BuiltInRegistries.FLUID.getOptional(key).ifPresent(f -> level.scheduleTick(p, f, h.delay(), pr));
			} else {
				BuiltInRegistries.BLOCK.getOptional(key).ifPresent(b -> level.scheduleTick(p, b, h.delay(), pr));
			}
		}
	}

	static JsonArray toJson(List<Held> held) {
		JsonArray a = new JsonArray();
		held.forEach(h -> a.add(h.toJson()));
		return a;
	}

	static List<Held> fromJson(@Nullable JsonElement e) {
		List<Held> out = new ArrayList<>();
		if (e != null && e.isJsonArray()) {
			for (JsonElement x : e.getAsJsonArray()) {
				out.add(Held.fromJson(x.getAsJsonArray()));
			}
		}
		return out;
	}
}
