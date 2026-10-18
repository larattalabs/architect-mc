package dev.larattalabs.architect.region;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import java.util.ArrayDeque;
import net.fabricmc.fabric.api.entity.event.v1.ServerLivingEntityEvents;
import net.minecraft.world.damagesource.DamageSource;
import net.minecraft.world.entity.LivingEntity;

/**
 * (6c H §12, gate item 9) The last damage and deaths of living entities, for DevBridge {@code dev.entity.damage}: a villager stand in a
 * body counts its drowning. A ring of {@link #CAP} events (game time, entity type and uuid, the damage type, amount, position, death);
 * cheap, kept on every server, read only by the dev hook.
 */
public final class DamageLog {
	static final int CAP = 2000;
	private static final ArrayDeque<JsonObject> EVENTS = new ArrayDeque<>();

	private DamageLog() {
	}

	public static void init() {
		ServerLivingEntityEvents.AFTER_DAMAGE.register((e, src, base, taken, blocked) -> add(e, src, taken, false));
		ServerLivingEntityEvents.AFTER_DEATH.register((e, src) -> add(e, src, 0, true));
	}

	static synchronized void add(LivingEntity e, DamageSource src, float amount, boolean death) {
		JsonObject o = new JsonObject();
		o.addProperty("t", e.level().getGameTime());
		o.addProperty("ms", System.currentTimeMillis());
		o.addProperty("entity", net.minecraft.core.registries.BuiltInRegistries.ENTITY_TYPE.getKey(e.getType()).toString());
		o.addProperty("uuid", e.getStringUUID());
		o.addProperty("type", src.typeHolder().unwrapKey().map(k -> k.identifier().getPath()).orElse("?"));
		o.addProperty("amount", amount);
		o.addProperty("death", death);
		JsonArray at = new JsonArray();
		at.add(e.getBlockX());
		at.add(e.getBlockY());
		at.add(e.getBlockZ());
		o.add("at", at);
		EVENTS.addLast(o);
		while (EVENTS.size() > CAP) {
			EVENTS.removeFirst();
		}
	}

	/** The events since {@code sinceMs} (epoch ms), of a damage type ({@code drown}, ...) or all (null). */
	public static synchronized JsonArray since(long sinceMs, String type) {
		JsonArray out = new JsonArray();
		for (JsonObject o : EVENTS) {
			if (o.get("ms").getAsLong() >= sinceMs && (type == null || type.equals(o.get("type").getAsString()))) {
				out.add(o.deepCopy());
			}
		}
		return out;
	}
}
