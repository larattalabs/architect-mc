package dev.larattalabs.architect.site;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.larattalabs.architect.Architect;
import dev.larattalabs.architect.api.ProtectedArea;
import dev.larattalabs.architect.journal.Journal;
import dev.larattalabs.architect.placement.Anchors;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerLifecycleEvents;
import net.minecraft.core.registries.Registries;
import net.minecraft.resources.Identifier;
import net.minecraft.resources.ResourceKey;
import net.minecraft.server.MinecraftServer;
import net.minecraft.world.level.storage.LevelResource;
import org.jspecify.annotations.Nullable;

/**
 * C17, protected areas (docs/CONTRACT.md phase 6c slice 0c §8): columns an owner marked, at every height. An op of the same
 * owner that would write into one is refused {@code PROTECTED}, whatever its {@code force}; ops of other owners and of the
 * player (a null owner) pass. Remove and undo are never checked. Kept in {@code <world>/architect/protected.json} (a temp file,
 * then a rename). Writes on the server thread; reads from any thread (an immutable snapshot).
 */
public final class Protected {
	public static final String FILE = "protected.json";
	private static final Gson GSON = new GsonBuilder().setPrettyPrinting().disableHtmlEscaping().create();

	/** Per owner, per area id (insertion order). Replaced whole on every change. */
	private static volatile Map<String, Map<String, ProtectedArea>> areas = Map.of();
	private static @Nullable Path dir;

	private Protected() {
	}

	static void init() {
		ServerLifecycleEvents.SERVER_STARTED.register(Protected::load);
		ServerLifecycleEvents.SERVER_STOPPED.register(s -> {
			areas = Map.of();
			dir = null;
		});
	}

	// ------------------------------------------------------------------ API

	/** Marks (or with the same owner and id, replaces) an area. Server thread. */
	public static ProtectedArea protect(ProtectedArea a) {
		Objects.requireNonNull(a, "area");
		if (a.owner() == null || a.owner().isBlank() || a.owner().indexOf(':') <= 0) {
			throw new IllegalArgumentException("a protected area needs an owner <modid>:<thing> (got " + a.owner() + ")");
		}
		if (a.id() == null || a.id().isBlank()) {
			throw new IllegalArgumentException("a protected area needs an id");
		}
		if (a.dimension() == null) {
			throw new IllegalArgumentException("a protected area needs a dimension");
		}
		long sx = (long) a.x1() - a.x0() + 1;
		long sz = (long) a.z1() - a.z0() + 1;
		if (sx > ProtectedArea.MAX_SPAN || sz > ProtectedArea.MAX_SPAN) {
			throw new IllegalArgumentException("a protected area is at most " + ProtectedArea.MAX_SPAN + " x " + ProtectedArea.MAX_SPAN + " columns (got " + sx
				+ " x " + sz + ")");
		}
		Map<String, Map<String, ProtectedArea>> next = copy();
		Map<String, ProtectedArea> mine = next.computeIfAbsent(a.owner(), k -> new LinkedHashMap<>());
		if (!mine.containsKey(a.id()) && mine.size() >= ProtectedArea.MAX_PER_OWNER) {
			throw new IllegalArgumentException(a.owner() + " already has " + ProtectedArea.MAX_PER_OWNER + " protected areas (the most per owner)");
		}
		mine.put(a.id(), a);
		commit(next);
		return a;
	}

	/** Lifts an area; false when there was none. Server thread. */
	public static boolean unprotect(String owner, String id) {
		Map<String, ProtectedArea> mine = areas.get(owner);
		if (mine == null || !mine.containsKey(id)) {
			return false;
		}
		Map<String, Map<String, ProtectedArea>> next = copy();
		next.get(owner).remove(id);
		if (next.get(owner).isEmpty()) {
			next.remove(owner);
		}
		commit(next);
		return true;
	}

	/** The areas of {@code owner}, or (null) of every owner. Any thread. */
	public static List<ProtectedArea> list(@Nullable String owner) {
		List<ProtectedArea> out = new ArrayList<>();
		areas.forEach((o, m) -> {
			if (owner == null || owner.equals(o)) {
				out.addAll(m.values());
			}
		});
		return out;
	}

	// ------------------------------------------------------------------ checks

	/** The areas of {@code owner} in {@code dimension} (empty for a null owner: the player marks none). */
	public static List<ProtectedArea> of(String dimension, @Nullable String owner) {
		if (owner == null) {
			return List.of();
		}
		Map<String, ProtectedArea> mine = areas.get(owner);
		if (mine == null || mine.isEmpty()) {
			return List.of();
		}
		List<ProtectedArea> out = new ArrayList<>();
		for (ProtectedArea a : mine.values()) {
			if (a.dimension().identifier().toString().equals(dimension)) {
				out.add(a);
			}
		}
		return out;
	}

	/** The first area of {@code owner} the column box touches, or null. */
	public static @Nullable ProtectedArea hit(String dimension, @Nullable String owner, int minX, int minZ, int maxX, int maxZ) {
		for (ProtectedArea a : of(dimension, owner)) {
			if (a.intersects(minX, minZ, maxX, maxZ)) {
				return a;
			}
		}
		return null;
	}

	public static @Nullable ProtectedArea hit(String dimension, @Nullable String owner, Anchors.Bounds b) {
		return b == null ? null : hit(dimension, owner, b.minX(), b.minZ(), b.maxX(), b.maxZ());
	}

	/** The first area of {@code owner} holding one of the cells ({@link Journal#pos} longs), or null. */
	public static @Nullable ProtectedArea hitCells(String dimension, @Nullable String owner, Iterable<Long> cells) {
		List<ProtectedArea> mine = of(dimension, owner);
		if (mine.isEmpty()) {
			return null;
		}
		for (long p : cells) {
			int x = Journal.x(p);
			int z = Journal.z(p);
			for (ProtectedArea a : mine) {
				if (a.contains(x, z)) {
					return a;
				}
			}
		}
		return null;
	}

	public static @Nullable ProtectedArea hitCells(String dimension, @Nullable String owner, long[] cells) {
		List<ProtectedArea> mine = of(dimension, owner);
		if (mine.isEmpty()) {
			return null;
		}
		for (long p : cells) {
			int x = Journal.x(p);
			int z = Journal.z(p);
			for (ProtectedArea a : mine) {
				if (a.contains(x, z)) {
					return a;
				}
			}
		}
		return null;
	}

	/** A column test over {@code owner}'s areas (null when it has none here: nothing to test). */
	public interface Columns {
		@Nullable ProtectedArea at(int x, int z);
	}

	public static @Nullable Columns columns(String dimension, @Nullable String owner) {
		List<ProtectedArea> mine = of(dimension, owner);
		if (mine.isEmpty()) {
			return null;
		}
		return (x, z) -> {
			for (ProtectedArea a : mine) {
				if (a.contains(x, z)) {
					return a;
				}
			}
			return null;
		};
	}

	/** The refusal's words: "{what} writes into protected area {id} ({label}) of {owner}; lift it first ({@code force} doesn't)". */
	public static String message(String what, ProtectedArea a) {
		return what + " writes into protected area " + a.id() + (a.label().isBlank() ? "" : " (" + a.label() + ")") + " of " + a.owner() + " (x " + a.x0()
			+ ".." + a.x1() + ", z " + a.z0() + ".." + a.z1() + "); lift it with unprotect first (force doesn't override it)";
	}

	// ------------------------------------------------------------------ storage

	private static Map<String, Map<String, ProtectedArea>> copy() {
		Map<String, Map<String, ProtectedArea>> next = new LinkedHashMap<>();
		areas.forEach((o, m) -> next.put(o, new LinkedHashMap<>(m)));
		return next;
	}

	private static void commit(Map<String, Map<String, ProtectedArea>> next) {
		Map<String, Map<String, ProtectedArea>> frozen = new LinkedHashMap<>();
		next.forEach((o, m) -> frozen.put(o, java.util.Collections.unmodifiableMap(new LinkedHashMap<>(m))));
		areas = java.util.Collections.unmodifiableMap(frozen);
		save();
	}

	static JsonObject toJson(List<ProtectedArea> list) {
		JsonObject root = new JsonObject();
		root.addProperty("format", 1);
		JsonArray a = new JsonArray();
		for (ProtectedArea p : list) {
			JsonObject o = new JsonObject();
			o.addProperty("owner", p.owner());
			o.addProperty("id", p.id());
			o.addProperty("dimension", p.dimension().identifier().toString());
			o.addProperty("x0", p.x0());
			o.addProperty("z0", p.z0());
			o.addProperty("x1", p.x1());
			o.addProperty("z1", p.z1());
			o.addProperty("label", p.label());
			a.add(o);
		}
		root.add("areas", a);
		return root;
	}

	static List<ProtectedArea> fromJson(JsonObject root) {
		List<ProtectedArea> out = new ArrayList<>();
		JsonArray a = root.has("areas") && root.get("areas").isJsonArray() ? root.getAsJsonArray("areas") : new JsonArray();
		for (JsonElement e : a) {
			JsonObject o = e.getAsJsonObject();
			Identifier dim = Identifier.tryParse(o.get("dimension").getAsString());
			if (dim == null) {
				continue;
			}
			out.add(new ProtectedArea(o.get("owner").getAsString(), o.get("id").getAsString(), ResourceKey.create(Registries.DIMENSION, dim), o.get("x0")
				.getAsInt(), o.get("z0").getAsInt(), o.get("x1").getAsInt(), o.get("z1").getAsInt(), o.has("label") ? o.get("label").getAsString() : ""));
		}
		return out;
	}

	private static void save() {
		Path d = dir;
		if (d == null) {
			return;
		}
		Path f = d.resolve(FILE);
		try {
			Files.createDirectories(d);
			Path tmp = d.resolve(FILE + ".tmp");
			Files.writeString(tmp, GSON.toJson(toJson(list(null))), StandardCharsets.UTF_8);
			Files.move(tmp, f, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
		} catch (IOException e) {
			Architect.LOGGER.warn("Could not save {}", f, e);
		}
	}

	private static void load(MinecraftServer server) {
		dir = server.getWorldPath(LevelResource.ROOT).resolve("architect");
		Path f = dir.resolve(FILE);
		Map<String, Map<String, ProtectedArea>> next = new LinkedHashMap<>();
		if (Files.isRegularFile(f)) {
			try {
				for (ProtectedArea a : fromJson(JsonParser.parseString(Files.readString(f, StandardCharsets.UTF_8)).getAsJsonObject())) {
					next.computeIfAbsent(a.owner(), k -> new LinkedHashMap<>()).put(a.id(), a);
				}
			} catch (IOException | RuntimeException e) {
				Architect.LOGGER.warn("Could not read {}; no protected areas loaded", f, e);
			}
		}
		Map<String, Map<String, ProtectedArea>> frozen = new LinkedHashMap<>();
		next.forEach((o, m) -> frozen.put(o, java.util.Collections.unmodifiableMap(m)));
		areas = java.util.Collections.unmodifiableMap(frozen);
		if (!frozen.isEmpty()) {
			Architect.LOGGER.info("Protected areas: {} loaded", list(null).size());
		}
	}
}
