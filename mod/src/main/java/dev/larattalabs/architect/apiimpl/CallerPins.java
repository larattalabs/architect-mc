package dev.larattalabs.architect.apiimpl;

import com.google.gson.GsonBuilder;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.larattalabs.architect.Architect;
import dev.larattalabs.architect.placement.Blueprints;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.TreeSet;

/**
 * (6c slice 0a, C14; docs/CONTRACT.md "Phase 6c slice 0a" §9) Caller version pins: game-wide like the library, persisted in
 * {@code <gameDir>/architect/caller-pins.json} as {@code {entryId: {version: [owners]}}}, merged into {@code entry.pins} (the
 * helper's GC keeps them) and into {@code EntryVersion.pinned}. Thread-safe. Internal.
 */
public final class CallerPins {
	private CallerPins() {
	}

	private static final Map<String, TreeMap<Integer, TreeSet<String>>> PINS = new TreeMap<>();
	private static boolean loaded;

	static Path file() {
		return Blueprints.gameDataDir().resolve("caller-pins.json");
	}

	/** Pins (true when it was new). */
	public static synchronized boolean pin(String entryId, int version, String owner) {
		load();
		boolean added = PINS.computeIfAbsent(entryId, k -> new TreeMap<>()).computeIfAbsent(version, k -> new TreeSet<>()).add(owner);
		if (added) {
			save();
		}
		return added;
	}

	/** Unpins (idempotent; true when a pin went). */
	public static synchronized boolean unpin(String entryId, int version, String owner) {
		load();
		TreeMap<Integer, TreeSet<String>> e = PINS.get(entryId);
		TreeSet<String> os = e == null ? null : e.get(version);
		if (os == null || !os.remove(owner)) {
			return false;
		}
		if (os.isEmpty()) {
			e.remove(version);
		}
		if (e.isEmpty()) {
			PINS.remove(entryId);
		}
		save();
		return true;
	}

	/** The owners pinning a version, sorted. */
	public static synchronized List<String> owners(String entryId, int version) {
		load();
		TreeMap<Integer, TreeSet<String>> e = PINS.get(entryId);
		TreeSet<String> os = e == null ? null : e.get(version);
		return os == null ? List.of() : List.copyOf(os);
	}

	/** The versions any caller pins, per entry. */
	public static synchronized Map<String, Set<Integer>> pinned() {
		load();
		Map<String, Set<Integer>> out = new TreeMap<>();
		PINS.forEach((k, vs) -> out.put(k, Set.copyOf(vs.keySet())));
		return out;
	}

	private static void load() {
		if (loaded) {
			return;
		}
		loaded = true;
		Path f = file();
		if (!Files.exists(f)) {
			return;
		}
		try {
			JsonObject o = JsonParser.parseString(Files.readString(f, StandardCharsets.UTF_8)).getAsJsonObject();
			o.getAsJsonObject("pins").entrySet().forEach(e -> e.getValue().getAsJsonObject().entrySet().forEach(v -> {
				TreeSet<String> os = PINS.computeIfAbsent(e.getKey(), k -> new TreeMap<>()).computeIfAbsent(Integer.parseInt(v.getKey()), k -> new TreeSet<>());
				v.getValue().getAsJsonArray().forEach(x -> os.add(x.getAsString()));
			}));
		} catch (IOException | RuntimeException e) {
			Architect.LOGGER.warn("Could not read {}; caller pins start empty (the file is left as is)", f, e);
		}
	}

	private static void save() {
		JsonObject pins = new JsonObject();
		PINS.forEach((id, vs) -> {
			JsonObject v = new JsonObject();
			vs.forEach((n, os) -> {
				JsonArray a = new JsonArray();
				os.forEach(a::add);
				v.add(Integer.toString(n), a);
			});
			pins.add(id, v);
		});
		JsonObject o = new JsonObject();
		o.addProperty("version", 1);
		o.add("pins", pins);
		Path f = file();
		try {
			Files.createDirectories(f.getParent());
			Path tmp = f.resolveSibling(f.getFileName() + ".tmp");
			Files.writeString(tmp, new GsonBuilder().setPrettyPrinting().create().toJson(o), StandardCharsets.UTF_8);
			Files.move(tmp, f, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
		} catch (IOException e) {
			Architect.LOGGER.warn("Could not save {}", f, e);
		}
	}
}
