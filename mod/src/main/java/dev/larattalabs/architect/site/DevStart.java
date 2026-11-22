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
 * <pre>{"killAt": "KS1" | "KS1+save" | any kill point, "failWriteNow": true, "startGrace": ticks}</pre>
 *
 * {@code KS1}: the Sites check's outcome is on disk (its journal release flushed, its pending records saved) and a restore it wrote at the
 * start is not saved with the chunks yet. {@code failWriteNow}: the check's write of a committed restore (a K6 construction removal that reads restored)
 * fails. {@code startGrace} (slice T4R hooks): Placement's start grace in ticks (40 when absent), so a gate can act inside it. Nothing here
 * runs without the file.
 */
public final class DevStart {
	private DevStart() {
	}

	static final String FILE = "dev-start.json";
	/** (slice T4R-D last round, P2) The marker a start-armed kill writes right before its halt ({@link #markKilled}). */
	static final String KILLED = "dev-killed.json";
	private static volatile boolean failWriteNow;
	private static volatile int startGrace;
	/** (last round, P2) The kill point this start's dev-start.json armed, and its world: only that point writes the marker. */
	private static volatile @org.jspecify.annotations.Nullable String startKill;
	private static volatile @org.jspecify.annotations.Nullable Path startWorld;

	/** Reads and deletes {@code <world>/architect/dev-start.json}, arming what it names. */
	static void arm(Path worldDir) {
		failWriteNow = false;
		startGrace = 0;
		startKill = null;
		startWorld = worldDir;
		Path f = worldDir.resolve("architect").resolve(FILE);
		if (!Files.exists(f)) {
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

	/** (TEST, slice T4R hooks) Placement's start grace for this start: 0 (the default) or the ticks dev-start.json named. */
	static int startGrace() {
		return startGrace;
	}

	/** Whether the start's write of a committed restore is to fail (TEST). */
	static boolean failWriteNow() {
		return failWriteNow;
	}
}
