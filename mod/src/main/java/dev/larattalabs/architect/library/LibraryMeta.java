package dev.larattalabs.architect.library;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.ArrayList;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.function.UnaryOperator;
import org.jspecify.annotations.Nullable;

/**
 * User metadata of a library entry (docs/CONTRACT.md "Phase 2 contract: Library entry"): {@code favorite}, {@code userTags}
 * and {@code displayName}. The mod is their only writer; the sidecar and the kit's build leave them alone.
 *
 * <p>Where they live:
 * <ul>
 * <li>a <b>user</b> entry ({@code <gameDir>/architect/library/<id>/}): in its {@code <id>.blueprint.json}, edited in place
 * ({@link #editInPlace}: re-read from disk, only the three keys patched, every other key kept, written to a temp file in the
 * same folder and moved over the old one);</li>
 * <li>a <b>bundled</b> entry (read-only, in the jar): in the overlay {@code <gameDir>/architect/library-meta.json}
 * ({@link Overlay}), keyed by id. The overlay is used for bundled entries only.</li>
 * </ul>
 * Pure (Gson + NIO), so it is tested without a game.
 *
 * @param displayName the user's name for the entry, or null (the design's own {@code name} shows)
 */
public record LibraryMeta(boolean favorite, List<String> userTags, @Nullable String displayName) {
	public static final LibraryMeta NONE = new LibraryMeta(false, List.of(), null);
	public static final int MAX_TAGS = 12;
	public static final int MAX_TAG = 24;
	public static final int MAX_NAME = 60;
	private static final Gson GSON = new GsonBuilder().setPrettyPrinting().disableHtmlEscaping().create();

	public LibraryMeta {
		userTags = normalizeTags(userTags);
		displayName = displayName == null || displayName.isBlank() ? null : clip(displayName.strip(), MAX_NAME);
	}

	public LibraryMeta withFavorite(boolean on) {
		return new LibraryMeta(on, userTags, displayName);
	}

	public LibraryMeta withTags(Collection<String> tags) {
		return new LibraryMeta(favorite, List.copyOf(tags), displayName);
	}

	public LibraryMeta withDisplayName(@Nullable String name) {
		return new LibraryMeta(favorite, userTags, name);
	}

	public boolean isEmpty() {
		return !favorite && userTags.isEmpty() && displayName == null;
	}

	/** Tags lower-cased, trimmed, spaces to {@code _}, empty and duplicate ones dropped, at most {@value #MAX_TAGS}. */
	public static List<String> normalizeTags(@Nullable Collection<String> tags) {
		LinkedHashSet<String> out = new LinkedHashSet<>();
		if (tags != null) {
			for (String t : tags) {
				if (t == null) {
					continue;
				}
				String s = clip(t.strip().toLowerCase(Locale.ROOT).replaceAll("\\s+", "_"), MAX_TAG);
				if (!s.isEmpty() && out.size() < MAX_TAGS) {
					out.add(s);
				}
			}
		}
		return List.copyOf(out);
	}

	/** Tags typed as one line: {@code "mine, river side"} -> {@code [mine, river_side]}. */
	public static List<String> parseTags(@Nullable String typed) {
		return typed == null ? List.of() : normalizeTags(List.of(typed.split("[,;]")));
	}

	private static String clip(String s, int max) {
		return s.length() <= max ? s : s.substring(0, max);
	}

	/** The metadata in a sidecar (or an overlay record); missing keys read as the defaults. */
	public static LibraryMeta read(@Nullable JsonObject o) {
		if (o == null) {
			return NONE;
		}
		boolean fav = o.has("favorite") && o.get("favorite").isJsonPrimitive() && o.get("favorite").getAsBoolean();
		List<String> tags = new ArrayList<>();
		JsonElement t = o.get("userTags");
		if (t != null && t.isJsonArray()) {
			for (JsonElement e : t.getAsJsonArray()) {
				if (e.isJsonPrimitive()) {
					tags.add(e.getAsString());
				}
			}
		}
		JsonElement n = o.get("displayName");
		return new LibraryMeta(fav, tags, n != null && n.isJsonPrimitive() ? n.getAsString() : null);
	}

	/**
	 * Sets the three keys on {@code o} (in place; returns it): {@code favorite} and {@code userTags} are always written,
	 * {@code displayName} is removed when null. Nothing else is touched.
	 */
	public JsonObject applyTo(JsonObject o) {
		o.addProperty("favorite", favorite);
		JsonArray a = new JsonArray();
		userTags.forEach(a::add);
		o.add("userTags", a);
		if (displayName == null) {
			o.remove("displayName");
		} else {
			o.addProperty("displayName", displayName);
		}
		return o;
	}

	/**
	 * Edits a user entry's sidecar in place: reads it from disk, applies {@code edit} to its metadata, patches the three
	 * keys and writes it back atomically. Returns the new metadata.
	 */
	public static LibraryMeta editInPlace(Path sidecar, UnaryOperator<LibraryMeta> edit) throws IOException {
		JsonObject o = JsonParser.parseString(Files.readString(sidecar, StandardCharsets.UTF_8)).getAsJsonObject();
		LibraryMeta next = edit.apply(read(o));
		next.applyTo(o);
		writeAtomically(sidecar, GSON.toJson(o) + "\n");
		return next;
	}

	/** Writes {@code text} to a temp file next to {@code file}, then moves it over {@code file} (atomically when the file system can). */
	public static void writeAtomically(Path file, String text) throws IOException {
		Path dir = file.toAbsolutePath().getParent();
		Files.createDirectories(dir);
		Path tmp = Files.createTempFile(dir, "." + file.getFileName(), ".tmp");
		try {
			Files.writeString(tmp, text, StandardCharsets.UTF_8);
			try {
				Files.move(tmp, file, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
			} catch (AtomicMoveNotSupportedException e) {
				Files.move(tmp, file, StandardCopyOption.REPLACE_EXISTING);
			}
		} finally {
			Files.deleteIfExists(tmp);
		}
	}

	/** Pretty JSON as the library writes it. */
	public static String pretty(JsonElement e) {
		return GSON.toJson(e) + "\n";
	}

	/**
	 * The overlay file for bundled entries ({@code <gameDir>/architect/library-meta.json}):
	 * {@code {"version": 1, "entries": {"<id>": {"favorite", "userTags", "displayName"}}}}. Loaded once and rewritten
	 * atomically on every change. Not thread-safe: the client thread owns it.
	 */
	public static final class Overlay {
		private final Path file;
		private final Map<String, LibraryMeta> map = new LinkedHashMap<>();
		private @Nullable String loadError;

		public Overlay(Path file) {
			this.file = file;
		}

		public Path file() {
			return file;
		}

		/** (Re)reads the file; a missing file is empty, a broken one is empty with {@link #loadError()} set (and is not overwritten until a change). */
		public Overlay load() {
			map.clear();
			loadError = null;
			if (!Files.exists(file)) {
				return this;
			}
			try {
				JsonObject root = JsonParser.parseString(Files.readString(file, StandardCharsets.UTF_8)).getAsJsonObject();
				JsonObject entries = root.has("entries") && root.get("entries").isJsonObject() ? root.getAsJsonObject("entries") : new JsonObject();
				for (var e : entries.entrySet()) {
					if (e.getValue().isJsonObject()) {
						LibraryMeta m = read(e.getValue().getAsJsonObject());
						if (!m.isEmpty()) {
							map.put(e.getKey(), m);
						}
					}
				}
			} catch (IOException | RuntimeException e) {
				loadError = e.getMessage() == null ? e.toString() : e.getMessage();
			}
			return this;
		}

		public @Nullable String loadError() {
			return loadError;
		}

		public LibraryMeta get(String id) {
			return map.getOrDefault(id, NONE);
		}

		public Map<String, LibraryMeta> all() {
			return Map.copyOf(map);
		}

		/** Changes one entry and rewrites the file. Returns the new metadata. */
		public LibraryMeta edit(String id, UnaryOperator<LibraryMeta> edit) throws IOException {
			LibraryMeta next = edit.apply(get(id));
			if (next.isEmpty()) {
				map.remove(id);
			} else {
				map.put(id, next);
			}
			JsonObject entries = new JsonObject();
			map.forEach((k, v) -> entries.add(k, v.applyTo(new JsonObject())));
			JsonObject root = new JsonObject();
			root.addProperty("version", 1);
			root.add("entries", entries);
			writeAtomically(file, pretty(root));
			loadError = null;
			return next;
		}
	}
}
