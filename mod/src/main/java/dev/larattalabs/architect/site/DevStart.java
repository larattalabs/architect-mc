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
	private static volatile boolean failWriteNow;
	private static volatile int startGrace;

	/** Reads and deletes {@code <world>/architect/dev-start.json}, arming what it names. */
	static void arm(Path worldDir) {
		failWriteNow = false;
		startGrace = 0;
		Path f = worldDir.resolve("architect").resolve(FILE);
		if (!Files.exists(f)) {
			return;
		}
		try {
			JsonObject o = JsonParser.parseString(Files.readString(f, StandardCharsets.UTF_8)).getAsJsonObject();
			Files.delete(f);
			if (o.has("killAt") && !o.get("killAt").isJsonNull()) {
				WorldJournal.killAt(o.get("killAt").getAsString());
			}
			failWriteNow = o.has("failWriteNow") && o.get("failWriteNow").getAsBoolean();
			startGrace = o.has("startGrace") ? o.get("startGrace").getAsInt() : 0;
			Architect.LOGGER.warn("TEST {}: armed {} for this start", FILE, o);
		} catch (IOException | RuntimeException e) {
			Architect.LOGGER.warn("TEST {}: could not be read ({})", FILE, e.toString());
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
