package dev.larattalabs.architect.survival;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.larattalabs.architect.Architect;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.function.Consumer;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerLifecycleEvents;
import net.minecraft.server.MinecraftServer;
import net.minecraft.world.level.GameType;
import net.minecraft.world.level.storage.LevelResource;
import org.jspecify.annotations.Nullable;

/**
 * The per-world survival toggle (docs/CONTRACT.md phase 3 "The toggle"): {@code <world>/architect-world.json}
 * {@code {"survival": bool, "blocksPerTick": 4}}. At the first load it defaults to on for survival and hardcore worlds and
 * off for creative (and adventure/spectator) ones, and is written then. Off: placement is instant (phases 1-2). On: Place
 * creates a construction site. Changing it needs permission level 2 ({@code /architect survival on|off}, the Status tab).
 * {@code blocksPerTick} is the builder's speed per site (1-64, default 4). Loaded before the sites when a world starts.
 */
public final class SurvivalWorld {
	public static final String FILE = "architect-world.json";
	public static final int DEFAULT_BLOCKS_PER_TICK = 4;
	private static final Gson GSON = new GsonBuilder().setPrettyPrinting().create();

	/** The world's settings. */
	public record Settings(boolean survival, int blocksPerTick) {
		public Settings {
			blocksPerTick = Math.max(1, Math.min(64, blocksPerTick));
		}

		public JsonObject toJson() {
			JsonObject o = new JsonObject();
			o.addProperty("survival", survival);
			o.addProperty("blocksPerTick", blocksPerTick);
			return o;
		}

		/** Parses the file; a missing {@code survival} takes {@code def}. */
		public static Settings fromJson(JsonObject o, boolean def) {
			return new Settings(o.has("survival") ? o.get("survival").getAsBoolean() : def,
				o.has("blocksPerTick") ? o.get("blocksPerTick").getAsInt() : DEFAULT_BLOCKS_PER_TICK);
		}
	}

	private static volatile @Nullable Settings current;
	private static final java.util.List<Consumer<Boolean>> LISTENERS = new CopyOnWriteArrayList<>();

	private SurvivalWorld() {
	}

	/** The default at a world's first load: on for survival and hardcore worlds, off otherwise. Pure. */
	public static boolean defaultOn(String gameType, boolean hardcore) {
		return hardcore || "survival".equals(gameType);
	}

	public static void init() {
		ServerLifecycleEvents.SERVER_STARTED.register(SurvivalWorld::load);
		ServerLifecycleEvents.SERVER_STOPPED.register(server -> current = null);
	}

	/** Whether the running world builds construction sites. False with no world. Any thread. */
	public static boolean on() {
		Settings s = current;
		return s != null && s.survival();
	}

	public static int blocksPerTick() {
		Settings s = current;
		return s == null ? DEFAULT_BLOCKS_PER_TICK : s.blocksPerTick();
	}

	/** Whether a world is loaded (the toggle has a value). */
	public static boolean loaded() {
		return current != null;
	}

	/** Called with the new value after every change (server thread). */
	public static void addListener(Consumer<Boolean> l) {
		LISTENERS.add(l);
	}

	private static Path file(MinecraftServer server) {
		return server.getWorldPath(LevelResource.ROOT).resolve(FILE);
	}

	static void load(MinecraftServer server) {
		GameType type = server.getDefaultGameType();
		boolean def = defaultOn(type.getName(), server.isHardcore());
		Path f = file(server);
		Settings s;
		if (Files.exists(f)) {
			try {
				s = Settings.fromJson(JsonParser.parseString(Files.readString(f, StandardCharsets.UTF_8)).getAsJsonObject(), def);
			} catch (IOException | RuntimeException e) {
				Architect.LOGGER.warn("Could not read {}; survival {} (the default for this world)", f, def ? "on" : "off", e);
				s = new Settings(def, DEFAULT_BLOCKS_PER_TICK);
			}
		} else {
			s = new Settings(def, DEFAULT_BLOCKS_PER_TICK);
			write(server, s);
			Architect.LOGGER.info("First load of this world with Architect: survival construction sites {} ({} world{})", def ? "on" : "off",
				type.getName(), server.isHardcore() ? ", hardcore" : "");
		}
		current = s;
	}

	/** Turns construction sites on or off for this world (the caller checked permission level 2). Server thread. */
	public static void set(MinecraftServer server, boolean on) {
		Settings s = current;
		Settings n = new Settings(on, s == null ? DEFAULT_BLOCKS_PER_TICK : s.blocksPerTick());
		current = n;
		write(server, n);
		Architect.LOGGER.info("Survival construction sites turned {}", on ? "on" : "off");
		LISTENERS.forEach(l -> l.accept(on));
	}

	private static void write(MinecraftServer server, Settings s) {
		Path f = file(server);
		try {
			Path tmp = f.resolveSibling(FILE + ".tmp");
			Files.writeString(tmp, GSON.toJson(s.toJson()), StandardCharsets.UTF_8);
			Files.move(tmp, f, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
		} catch (IOException e) {
			Architect.LOGGER.warn("Could not save {}", f, e);
		}
	}
}
