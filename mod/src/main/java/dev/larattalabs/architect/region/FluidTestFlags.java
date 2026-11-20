package dev.larattalabs.architect.region;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.larattalabs.architect.Architect;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import net.fabricmc.loader.api.FabricLoader;

/**
 * (slice T5Fa) TEST: the fluid holds and traces armed before a world opens. A crash row's restart replays open txns in the recovery slot,
 * before any DevBridge call can reach the new server (the headless host starts the JVM with dev.world.open), so the driver writes
 * {@code <gameDir>/architect/t5f-test-flags.json} ({@code {holdDrain?, holdWrite?, holdSettle?, holdChunk?: [x,z], writeTrace?, forceTrace?}})
 * while no server runs; the next txn core's registration applies it once and deletes it. Development environments only: in production the
 * file is never read.
 */
public final class FluidTestFlags {
	private FluidTestFlags() {
	}

	static final String FILE = "t5f-test-flags.json";

	/** Applies and deletes the flags file, if any (FluidTxns.register: every txn core, before recovery). */
	static void applyAtLoad() {
		FabricLoader fl = FabricLoader.getInstance();
		if (!fl.isDevelopmentEnvironment()) {
			return;
		}
		Path f = fl.getGameDir().resolve("architect").resolve(FILE);
		if (!Files.isRegularFile(f)) {
			return;
		}
		try {
			JsonObject o = JsonParser.parseString(Files.readString(f, StandardCharsets.UTF_8)).getAsJsonObject();
			Files.delete(f);
			if (o.has("holdDrain")) {
				RegionFluids.holdDrain = o.get("holdDrain").getAsBoolean();
			}
			if (o.has("holdWrite")) {
				RegionFluids.holdWrite = o.get("holdWrite").getAsBoolean();
			}
			if (o.has("holdSettle")) {
				RegionFluids.holdSettle = o.get("holdSettle").getAsBoolean();
			}
			if (o.get("holdChunk") instanceof JsonArray a) {
				FluidTxns.holdChunkBefore.clear();
				FluidTxns.holdChunk = new int[] {a.get(0).getAsInt(), a.get(1).getAsInt()};
			}
			if (o.has("writeTrace") && o.get("writeTrace").getAsBoolean()) {
				RegionFluids.writeTrace = java.util.concurrent.ConcurrentHashMap.newKeySet();
			}
			if (o.has("forceTrace") && o.get("forceTrace").getAsBoolean()) {
				RegionFluids.forceTrace = new java.util.concurrent.CopyOnWriteArrayList<>();
			}
			Architect.LOGGER.warn("(slice T5Fa TEST) {} applied before the world's recovery: {}", FILE, o);
		} catch (Exception e) {
			Architect.LOGGER.error("(slice T5Fa TEST) {} unreadable", FILE, e);
		}
	}
}
