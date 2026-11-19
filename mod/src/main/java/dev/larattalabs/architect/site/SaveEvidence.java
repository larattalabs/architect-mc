package dev.larattalabs.architect.site;

import dev.larattalabs.architect.Architect;
import java.util.ArrayList;
import java.util.List;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerLifecycleEvents;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import org.jspecify.annotations.Nullable;

/**
 * (slice SOFF, review findings 4 and 5) What one world save (one {@code saveAllChunks} call) actually wrote, recorded while it runs, never
 * read off the {@code noSave} flags afterwards: the levels it saved and the ones it skipped ({@code SaveEvidenceLevelMixin}, at each level's
 * save), and whether the players were saved with it (inside {@code saveEverything}, which saves them first, or the stop's save, which does
 * too). A ledger publisher that rides on a world save requires this evidence from that save: every level written, and for the world save's
 * callback the players too. A level flipped off and back on around a save, or another mod's {@code saveAllChunks(.., force)} (no players),
 * is then never taken for a coherent save. Server thread.
 */
public final class SaveEvidence {
	private SaveEvidence() {
	}

	private static final List<String> SAVED = new ArrayList<>();
	private static final List<String> SKIPPED = new ArrayList<>();
	/** Depth of {@code saveEverything} calls (players saved first, then the chunks). */
	private static int everything;
	/** The server is stopping: vanilla's stop saves the players, turns saving on, then saves the chunks. */
	private static boolean stopping;
	/** (TEST) a dev hook's raw chunk save stands for an autosave: the players are taken as saved with it (behaviour as before SOFF). */
	private static boolean testAssumePlayers;
	/** The players were saved with the current save (fixed at its start). */
	private static boolean playersWithIt;

	static void init() {
		ServerLifecycleEvents.BEFORE_SAVE.register((srv, flush, force) -> started());
		ServerLifecycleEvents.SERVER_STOPPING.register(srv -> stopping = true);
		ServerLifecycleEvents.SERVER_STARTING.register(srv -> {
			stopping = false;
			everything = 0;
			SAVED.clear();
			SKIPPED.clear();
		});
	}

	/** A tick's start: no save is running (a saveEverything that threw never leaves its depth set). */
	static void tickStart() {
		everything = 0;
	}

	/** saveAllChunks' head (BEFORE_SAVE): a new record. */
	static void started() {
		SAVED.clear();
		SKIPPED.clear();
		playersWithIt = everything > 0 || stopping || testAssumePlayers;
	}

	/** (SaveEvidenceLevelMixin) a level's save starts: {@code skip} is vanilla's {@code noSave && !force}. */
	public static void level(ServerLevel l, boolean skip) {
		(skip ? SKIPPED : SAVED).add(l.dimension().identifier().toString());
	}

	/** (SaveEvidenceServerMixin) saveEverything's head and return. */
	public static void everything(boolean enter) {
		everything = Math.max(0, everything + (enter ? 1 : -1));
	}

	/** (TEST) {@code r} runs with its raw chunk save counted as an autosave's (the players taken as saved), as dev hooks did before SOFF. */
	public static void asAutosave(Runnable r) {
		boolean was = testAssumePlayers;
		testAssumePlayers = true;
		try {
			r.run();
		} finally {
			testAssumePlayers = was;
		}
	}

	/**
	 * (pure) Why a save is not coherent, or null: every one of {@code levels} written (none skipped), and (when {@code needPlayers}) the
	 * players saved with it.
	 */
	static @Nullable String incoherent(int levels, List<String> saved, List<String> skipped, boolean needPlayers, boolean players) {
		if (!skipped.isEmpty()) {
			return "the save skipped " + String.join(", ", skipped) + " (saving off: /save-off)";
		}
		if (saved.size() < levels) {
			return "the save wrote " + saved.size() + " of " + levels + " levels";
		}
		if (needPlayers && !players) {
			return "the players were not saved with it (a chunk save alone)";
		}
		return null;
	}

	/** The last save's levels: why they are not all written, or null. Read inside or right after the save. */
	static @Nullable String chunksRefusal(MinecraftServer srv) {
		return incoherent(levels(srv), SAVED, SKIPPED, false, true);
	}

	/** The world save's callback: why its save can't carry the ledger (a level not written, the players not saved), or null. */
	static @Nullable String worldSaveRefusal(MinecraftServer srv) {
		return incoherent(levels(srv), SAVED, SKIPPED, true, playersWithIt);
	}

	private static int levels(MinecraftServer srv) {
		int n = 0;
		for (ServerLevel l : srv.getAllLevels()) {
			n++;
		}
		return n;
	}

	/** (dev) the last save's record. */
	static com.google.gson.JsonObject json() {
		com.google.gson.JsonObject o = new com.google.gson.JsonObject();
		com.google.gson.JsonArray a = new com.google.gson.JsonArray();
		SAVED.forEach(a::add);
		com.google.gson.JsonArray b = new com.google.gson.JsonArray();
		SKIPPED.forEach(b::add);
		o.add("saved", a);
		o.add("skipped", b);
		o.addProperty("playersWithIt", playersWithIt);
		return o;
	}

	static void log(String what, String why) {
		Architect.LOGGER.warn("Stockpiles: {} did not write the stockpile ledger: {}; it stays pending until a coherent save", what, why);
	}
}
