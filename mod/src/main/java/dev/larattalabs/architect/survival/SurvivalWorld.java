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
 * {@code {"survival": bool, "blocksPerTick": 4, "placementBudgetMs": 4}}. At the first load it defaults to on for survival and hardcore worlds and
 * off for creative (and adventure/spectator) ones, and is written then. Off: placement is instant (phases 1-2). On: Place
 * creates a construction site. Changing it needs permission level 2 ({@code /architect survival on|off}, the Status tab).
 * {@code blocksPerTick} is the builder's speed per site (1-64, default 4). {@code placementBudgetMs} (phase 4d) is the server time
 * per tick that ticked placements, restores and the builder share (1-20, default 4). Loaded before the sites when a world starts.
 * Every real change (on to off or back), and the default written at the first load, fires the API's {@code WORLD_MODE_CHANGED}
 * (server thread).
 */
public final class SurvivalWorld {
	public static final String FILE = "architect-world.json";
	public static final int DEFAULT_BLOCKS_PER_TICK = 4;
	/** The default per-tick placement budget in ms (docs/CONTRACT.md phase 4d). */
	public static final int DEFAULT_PLACEMENT_BUDGET_MS = 4;
	private static final Gson GSON = new GsonBuilder().setPrettyPrinting().create();

	/** The world's settings. */
	public record Settings(boolean survival, int blocksPerTick, int placementBudgetMs) {
		public Settings {
			blocksPerTick = Math.max(1, Math.min(64, blocksPerTick));
			placementBudgetMs = Math.max(1, Math.min(20, placementBudgetMs));
		}

		public Settings(boolean survival, int blocksPerTick) {
			this(survival, blocksPerTick, DEFAULT_PLACEMENT_BUDGET_MS);
		}

		public JsonObject toJson() {
			JsonObject o = new JsonObject();
			o.addProperty("survival", survival);
			o.addProperty("blocksPerTick", blocksPerTick);
			o.addProperty("placementBudgetMs", placementBudgetMs);
			return o;
		}

		/** Parses the file; a missing {@code survival} takes {@code def}. */
		public static Settings fromJson(JsonObject o, boolean def) {
			return new Settings(o.has("survival") ? o.get("survival").getAsBoolean() : def,
				o.has("blocksPerTick") ? o.get("blocksPerTick").getAsInt() : DEFAULT_BLOCKS_PER_TICK,
				o.has("placementBudgetMs") ? o.get("placementBudgetMs").getAsInt() : DEFAULT_PLACEMENT_BUDGET_MS);
		}
	}

	private static volatile @Nullable Settings current;
	/** The world journal's region cache (phase 4e, decision N7): {@code journalCacheMb} in the file, default 64. */
	private static volatile int journalCacheMb = 64;
	/** The journal size at which a warning shows (phase 4e, N7): {@code journalWarnMb}, default 1024 (1 GB). */
	private static volatile int journalWarnMb = 1024;

	public static int journalCacheMb() {
		return journalCacheMb;
	}

	public static int journalWarnMb() {
		return journalWarnMb;
	}

	private static void readJournalConfig(JsonObject o) {
		journalCacheMb = o.has("journalCacheMb") ? Math.max(8, Math.min(4096, o.get("journalCacheMb").getAsInt())) : 64;
		journalWarnMb = o.has("journalWarnMb") ? Math.max(16, o.get("journalWarnMb").getAsInt()) : 1024;
	}
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

	/** The per-tick placement budget in ms (1-20). */
	public static int placementBudgetMs() {
		Settings s = current;
		return s == null ? DEFAULT_PLACEMENT_BUDGET_MS : s.placementBudgetMs();
	}

	/** Sets the per-tick placement budget (1-20 ms) for this world and saves it. Server thread. */
	public static void setPlacementBudget(MinecraftServer server, int ms) {
		Settings s = current;
		Settings n = s == null ? new Settings(false, DEFAULT_BLOCKS_PER_TICK, ms) : new Settings(s.survival(), s.blocksPerTick(), ms);
		current = n;
		write(server, n);
		Architect.LOGGER.info("Placement budget set to {} ms per tick", n.placementBudgetMs());
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
		journalCacheMb = 64;
		journalWarnMb = 1024;
		GameType type = server.getDefaultGameType();
		boolean def = defaultOn(type.getName(), server.isHardcore());
		Path f = file(server);
		Settings s;
		if (Files.exists(f)) {
			try {
				JsonObject root = JsonParser.parseString(Files.readString(f, StandardCharsets.UTF_8)).getAsJsonObject();
				s = Settings.fromJson(root, def);
				readJournalConfig(root);
			} catch (IOException | RuntimeException e) {
				Architect.LOGGER.warn("Could not read {}; survival {} (the default for this world)", f, def ? "on" : "off", e);
				s = new Settings(def, DEFAULT_BLOCKS_PER_TICK);
			}
		} else {
			s = new Settings(def, DEFAULT_BLOCKS_PER_TICK);
			write(server, s);
			Architect.LOGGER.info("First load of this world with Architect: survival construction sites {} ({} world{})", def ? "on" : "off",
				type.getName(), server.isHardcore() ? ", hardcore" : "");
			current = s;
			// the default at the first load is a change too (API 1.2.0 WORLD_MODE_CHANGED)
			dev.larattalabs.architect.apiimpl.ApiEvents.worldModeChanged(s.survival(), s.blocksPerTick());
			return;
		}
		current = s;
	}

	/** Turns construction sites on or off for this world (the caller checked permission level 2). Server thread. */
	public static void set(MinecraftServer server, boolean on) {
		Settings s = current;
		Settings n = new Settings(on, s == null ? DEFAULT_BLOCKS_PER_TICK : s.blocksPerTick(), s == null ? DEFAULT_PLACEMENT_BUDGET_MS : s.placementBudgetMs());
		boolean changed = s == null || s.survival() != on;
		current = n;
		write(server, n);
		Architect.LOGGER.info("Survival construction sites turned {}", on ? "on" : "off");
		LISTENERS.forEach(l -> l.accept(on));
		if (changed) {
			dev.larattalabs.architect.apiimpl.ApiEvents.worldModeChanged(on, n.blocksPerTick());
		}
	}

	private static void write(MinecraftServer server, Settings s) {
		Path f = file(server);
		try {
			Path tmp = f.resolveSibling(FILE + ".tmp");
			JsonObject o = s.toJson();
			o.addProperty("journalCacheMb", journalCacheMb);
			o.addProperty("journalWarnMb", journalWarnMb);
			Files.writeString(tmp, GSON.toJson(o), StandardCharsets.UTF_8);
			Files.move(tmp, f, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
		} catch (IOException e) {
			Architect.LOGGER.warn("Could not save {}", f, e);
		}
	}
}
