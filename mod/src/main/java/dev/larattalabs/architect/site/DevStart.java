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
 * <pre>{"killAt": "KS1" | "KS1+save" | any kill point, "failWriteNow": true}</pre>
 *
 * {@code KS1}: the Sites check released a settled removal's journal entries (flushed to disk) before any restore it wrote at the start is
 * saved with the chunks. {@code failWriteNow}: the check's write of a committed restore (a K6 construction removal that reads restored)
 * fails. Nothing here runs without the file.
 */
public final class DevStart {
	private DevStart() {
	}

	static final String FILE = "dev-start.json";
	private static volatile boolean failWriteNow;

	/** Reads and deletes {@code <world>/architect/dev-start.json}, arming what it names. */
	static void arm(Path worldDir) {
		failWriteNow = false;
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
			Architect.LOGGER.warn("TEST {}: armed {} for this start", FILE, o);
		} catch (IOException | RuntimeException e) {
			Architect.LOGGER.warn("TEST {}: could not be read ({})", FILE, e.toString());
		}
	}

	/** Whether the start's write of a committed restore is to fail (TEST). */
	static boolean failWriteNow() {
		return failWriteNow;
	}
}
