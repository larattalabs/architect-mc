package dev.larattalabs.architect.site;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.larattalabs.architect.Architect;
import dev.larattalabs.architect.journal.WorldJournal;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

/**
 * (TEST, slice T4a) Faults armed for the world's own start, before the DevBridge can reach the server: a gate writes
 * {@code <world>/architect/dev-start.json} while the world is closed, then opens it. The file is read once and deleted at SERVER_STARTED,
 * before the stores load and before the Sites check, so a halt it arms never repeats at the next start.
 *
 * <pre>{"killAt": "KS1" | "KS1+save" | any kill point, "failWriteNow": true, "startGrace": ticks, "entityHide": ticks, "entityHideAfterW": ticks}</pre>
 *
 * {@code KS1}: the Sites check's outcome is on disk (its journal release flushed, its pending records saved) and a restore it wrote at the
 * start is not saved with the chunks yet. {@code failWriteNow}: the check's write of a committed restore (a K6 construction removal that reads restored)
 * fails. {@code startGrace} (slice T4R hooks): Placement's start grace in ticks (40 when absent), so a gate can act inside it. Nothing here
 * runs without the file. {@code entityHide} (slice LR2-FIX): for that many ticks after the start, chunks' entity sections stay hidden and their
 * stored entities unloaded ({@code EntityVisibilityMixin}), as a chunk loaded at world start before its entities load; {@code entityHideAfterW}
 * ends that window that many ticks after the first clearing W restore of a single removal wrote ({@link #wrote}).
 */
public final class DevStart {
	private DevStart() {
	}

	static final String FILE = "dev-start.json";
	/** (slice T4R-D last round, P2) The marker a start-armed kill writes right before its halt ({@link #markKilled}). */
	static final String KILLED = "dev-killed.json";
	private static volatile boolean failWriteNow;
	private static volatile int startGrace;
	/** (slice LR2-FIX) The entity-hide window: its length in ticks (0: off), the tick it began (-1: not yet), its end after a W write (-1: none). */
	private static volatile int entityHide;
	private static volatile int entityHideAfterW = -1;
	private static volatile int hideFrom = -1;
	private static volatile int hideUntilW = Integer.MAX_VALUE;
	/** (last round, P2) The kill point this start's dev-start.json armed, and its world: only that point writes the marker. */
	private static volatile @org.jspecify.annotations.Nullable String startKill;
	private static volatile @org.jspecify.annotations.Nullable Path startWorld;

	/** Reads and deletes {@code <world>/architect/dev-start.json}, arming what it names: on a development start only ({@link #development}). */
	static void arm(Path worldDir) {
		arm(worldDir, development());
	}

	/**
	 * (REL-v0910 fix round, P2-3) Whether this start may arm test faults: a development environment, as the DevBridge (the dev client) and the
	 * devserver (the headless gate server, run from runServer's classpath) require. A built jar in a player's launcher never reads the file.
	 */
	static boolean development() {
		return net.fabricmc.loader.api.FabricLoader.getInstance().isDevelopmentEnvironment();
	}

	/**
	 * The start's reset, then {@code <world>/architect/dev-start.json} read and deleted when {@code development} (else left as it is, nothing
	 * armed). (REL-v0910 fix round, P2-3) The reset disarms what the previous start's file armed, its kill point in {@code WorldJournal}
	 * included, so a point it never reached can't fire in this world. A kill point armed over the DevBridge for this start (gate4e's
	 * migration kills, armed with no world open) is not the previous start's and stays.
	 */
	static void arm(Path worldDir, boolean development) {
		String previous = startKill;
		if (previous != null && previous.equals(WorldJournal.armed())) {
			WorldJournal.killAt(null);
		}
		failWriteNow = false;
		startGrace = 0;
		disarmHide();
		startKill = null;
		startWorld = worldDir;
		Path f = worldDir.resolve("architect").resolve(FILE);
		if (!Files.exists(f)) {
			return;
		}
		if (!development) {
			Architect.LOGGER.warn("TEST {}: ignored (not a development start); nothing armed", FILE);
			return;
		}
		try {
			JsonObject o = JsonParser.parseString(Files.readString(f, StandardCharsets.UTF_8)).getAsJsonObject();
			Files.delete(f);
			if (o.has("killAt") && !o.get("killAt").isJsonNull()) {
				WorldJournal.killAt(o.get("killAt").getAsString());
				startKill = o.get("killAt").getAsString();
			}
			failWriteNow = o.has("failWriteNow") && o.get("failWriteNow").getAsBoolean();
			startGrace = o.has("startGrace") ? o.get("startGrace").getAsInt() : 0;
			entityHide = o.has("entityHide") ? o.get("entityHide").getAsInt() : 0;
			entityHideAfterW = o.has("entityHideAfterW") ? o.get("entityHideAfterW").getAsInt() : -1;
			Architect.LOGGER.warn("TEST {}: armed {} for this start", FILE, o);
		} catch (IOException | RuntimeException e) {
			Architect.LOGGER.warn("TEST {}: could not be read ({})", FILE, e.toString());
		}
	}

	/**
	 * (TEST, slice T4R-D last round, P2) Called by {@code WorldJournal.kill} right before it halts at {@code armed} (the armed point, with its
	 * {@code +save} suffix when it has one): when this start's dev-start.json armed it, {@code <world>/architect/dev-killed.json} gets
	 * {@code {"point": armed}}, forced to disk. The durable proof that the start-armed kill fired at its point (a gate's second crash counts
	 * only with it: tools/lib/second-crash.mjs); any other halt, or a start without dev-start.json, writes nothing.
	 */
	public static void markKilled(String armed) {
		String k = startKill;
		Path w = startWorld;
		if (k == null || w == null || !k.equals(armed)) {
			return;
		}
		Path f = w.resolve("architect").resolve(KILLED);
		JsonObject o = new JsonObject();
		o.addProperty("point", armed);
		try (java.nio.channels.FileChannel ch = java.nio.channels.FileChannel.open(f, java.nio.file.StandardOpenOption.CREATE,
			java.nio.file.StandardOpenOption.TRUNCATE_EXISTING, java.nio.file.StandardOpenOption.WRITE)) {
			ch.write(java.nio.ByteBuffer.wrap(o.toString().getBytes(StandardCharsets.UTF_8)));
			ch.force(true);
		} catch (IOException | RuntimeException e) {
			Architect.LOGGER.warn("TEST {}: could not be written ({})", KILLED, e.toString()); // no marker: the gate's row FAILS
		}
	}

	/**
	 * (REL-v0910 fix round, P2-3) SERVER_STOPPED: every test fault is disarmed (this start's dev-start.json state, any {@code WorldJournal} kill
	 * point and next-commit failure, armed by the file or over the DevBridge), so nothing armed in this world outlives its server.
	 */
	static void stopped() {
		failWriteNow = false;
		startGrace = 0;
		disarmHide();
		startKill = null;
		startWorld = null;
		WorldJournal.disarm();
	}

	/** (TEST, slice T4R hooks) Placement's start grace for this start: 0 (the default) or the ticks dev-start.json named. */
	static int startGrace() {
		return startGrace;
	}

	private static void disarmHide() {
		entityHide = 0;
		entityHideAfterW = -1;
		hideFrom = -1;
		hideUntilW = Integer.MAX_VALUE;
	}

	/**
	 * (TEST, slice LR2-FIX) Whether chunks' entity sections are kept hidden now: inside this start's {@code entityHide} window (counted from the
	 * first tick it is asked with a server running), and not past {@code entityHideAfterW} ticks after the first clearing W write.
	 */
	public static boolean entitiesHidden() {
		if (entityHide <= 0) {
			return false;
		}
		net.minecraft.server.MinecraftServer srv = dev.larattalabs.architect.placed.Placed.server();
		if (srv == null) {
			return true;
		}
		int now = srv.getTickCount();
		if (hideFrom < 0) {
			hideFrom = now;
		}
		return now < hideFrom + entityHide && now < hideUntilW;
	}

	/** (TEST, slice LR2-FIX) A single removal's clearing W restore wrote: an armed {@code entityHideAfterW} ends the window that many ticks later. */
	static void wrote() {
		if (entityHide <= 0 || entityHideAfterW < 0 || hideUntilW != Integer.MAX_VALUE) {
			return;
		}
		net.minecraft.server.MinecraftServer srv = dev.larattalabs.architect.placed.Placed.server();
		if (srv != null) {
			hideUntilW = srv.getTickCount() + entityHideAfterW;
			Architect.LOGGER.warn("TEST {}: the first W restore wrote; entities shown from tick {}", FILE, hideUntilW);
		}
	}

	/** Whether the start's write of a committed restore is to fail (TEST). */
	static boolean failWriteNow() {
		return failWriteNow;
	}
}
