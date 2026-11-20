package dev.larattalabs.architect.site;

import dev.larattalabs.architect.Architect;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.List;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import org.jspecify.annotations.Nullable;

/**
 * (slice SOFF, review findings 4 and 5; slice SOFF2, per invocation) What each world save actually wrote, recorded while it runs, never read
 * off the {@code noSave} flags afterwards. Every {@code saveAllChunks} call is a {@link Frame} of its own on a stack
 * ({@code SaveEvidenceServerMixin}: pushed and popped around the whole method, an exception included, so a nested call never touches the outer
 * one's record): the levels it wrote (each recorded when its save <b>returns</b>, {@code SaveEvidenceLevelMixin}) and the ones it skipped.
 * Its players are saved with it only when it is the own chunk save of a {@code saveEverything} or the stop's {@code stopServer} whose
 * {@code PlayerList.saveAll} has <b>completed</b> (no player save failing in it) before it started: a chunk save from a player-save hook, a
 * stopping listener, a BEFORE_SAVE listener (nested) or another mod's raw {@code saveAllChunks(.., force)} never inherits that. A ledger
 * publisher that rides on a world save requires its own save's frame: the world-save callback (AFTER_SAVE, inside the frame) the top frame,
 * every level written and the players with it; an explicit caller the frame of the call it just made ({@link #mark}, {@link #ownRefusal}).
 * Server thread.
 */
public final class SaveEvidence {
	private SaveEvidence() {
	}

	/** What a frame stands for. */
	public enum Kind {
		/** saveEverything (an autosave, /save-all): the players, then its own chunk save. */
		EVERYTHING,
		/** stopServer: the players, then (saving turned on) its own chunk save. */
		STOP,
		/** one saveAllChunks call. */
		CHUNKS
	}

	/** One invocation's record. */
	public static final class Frame {
		final Kind kind;
		final long id;
		final List<String> saved = new ArrayList<>();
		final List<String> skipped = new ArrayList<>();
		/** EVERYTHING/STOP: its PlayerList.saveAll completed with no player save failing. CHUNKS: the players were saved with it. */
		boolean players;
		/** EVERYTHING/STOP: its own saveAllChunks call is starting (the next CHUNKS frame pushed is that call's). */
		boolean ownChunkSave;
		boolean completed;

		Frame(Kind kind, long id) {
			this.kind = kind;
			this.id = id;
		}
	}

	private static final ArrayDeque<Frame> STACK = new ArrayDeque<>();
	private static long nextId = 1;
	/** The last CHUNKS frame popped (an explicit caller's own, read right after its call). */
	private static @Nullable Frame lastChunks;
	/** (TEST) the next CHUNKS frame pushed stands for an autosave's: its players are taken as saved (dev hooks, as before SOFF). */
	private static boolean testAssumePlayers;

	static void init() {
		net.fabricmc.fabric.api.event.lifecycle.v1.ServerLifecycleEvents.SERVER_STARTING.register(srv -> {
			STACK.clear();
			lastChunks = null;
		});
	}

	/** A tick's start: no save is running (a frame still open here is a bug: logged, dropped). */
	static void tickStart() {
		if (!STACK.isEmpty()) {
			Architect.LOGGER.error("SaveEvidence: {} save frame(s) open at a tick's start; dropped", STACK.size());
			STACK.clear();
		}
	}

	/** (SaveEvidenceServerMixin) A save method's start: its frame pushed. A CHUNKS frame takes its players from its direct parent's own save. */
	public static Frame enter(Kind kind) {
		Frame f = new Frame(kind, nextId++);
		if (kind == Kind.CHUNKS) {
			Frame parent = STACK.peek();
			if (parent != null && parent.kind != Kind.CHUNKS && parent.ownChunkSave) {
				f.players = parent.players;
				parent.ownChunkSave = false; // only that one call: a later chunk save inside the same method inherits nothing
			}
			if (testAssumePlayers) {
				testAssumePlayers = false;
				f.players = true;
			}
		}
		STACK.push(f);
		return f;
	}

	/** (SaveEvidenceServerMixin) A save method's end, normal or exceptional: its frame (and anything left above it) popped. */
	public static void exit(Frame f, boolean completed) {
		while (!STACK.isEmpty()) {
			Frame top = STACK.pop();
			if (top == f) {
				break;
			}
		}
		f.completed = completed;
		f.ownChunkSave = false;
		if (f.kind == Kind.CHUNKS) {
			lastChunks = f;
		}
	}

	/** (SaveEvidenceServerMixin) saveEverything's or stopServer's PlayerList.saveAll returned; {@code ok}: no player save failed in it. */
	public static void playersSaved(Frame owner, boolean ok) {
		owner.players = ok;
	}

	/** (SaveEvidenceServerMixin) saveEverything's or stopServer's own saveAllChunks call starts (its frame is the next pushed). */
	public static void ownChunkSave(Frame owner) {
		owner.ownChunkSave = true;
	}

	/** (SaveEvidenceLevelMixin) A level's save: skipped at its head ({@code noSave && !force}), written when it returns. */
	public static void level(ServerLevel l, boolean skip, boolean returned) {
		level(l.dimension().identifier().toString(), skip, returned);
	}

	static void level(String dim, boolean skip, boolean returned) {
		Frame top = STACK.peek();
		if (top == null || top.kind != Kind.CHUNKS) {
			return; // a level's save outside a world save (a level's close): no frame's
		}
		if (skip && !returned) {
			top.skipped.add(dim);
		} else if (!skip && returned) {
			top.saved.add(dim);
		}
	}

	/** (SaveEvidenceServerMixin) The innermost frame open, or null. */
	public static @Nullable Frame top() {
		return STACK.peek();
	}

	/** Whether {@code f} is a saveEverything's or stopServer's frame (it owns a player save and its own chunk save). */
	public static boolean owner(@Nullable Frame f) {
		return f != null && f.kind != Kind.CHUNKS;
	}

	/** Whether any save is running now (a frame open). */
	public static boolean saving() {
		return !STACK.isEmpty();
	}

	/** (TEST) {@code r}'s own raw chunk save counted as an autosave's (the players taken as saved), as dev hooks did before SOFF. */
	public static void asAutosave(Runnable r) {
		testAssumePlayers = true;
		try {
			r.run();
		} finally {
			testAssumePlayers = false;
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
			return "the players were not saved with it (a chunk save alone, or one started before the players' save completed)";
		}
		return null;
	}

	/** The id the next frame pushed gets: an explicit caller takes it right before its own saveAllChunks call. */
	static long mark() {
		return nextId;
	}

	/** (pure seam) A frame's refusal: none, or not this call's, or not completed, or incoherent. */
	static @Nullable String refusal(@Nullable Frame f, long mark, int levels, boolean needPlayers) {
		if (f == null || f.id != mark) {
			return "no record of this save (its saveAllChunks call left no frame)";
		}
		if (!f.completed) {
			return "the save did not complete";
		}
		return incoherent(levels, f.saved, f.skipped, needPlayers, f.players);
	}

	/** An explicit caller's own chunk save (the one it started after {@code mark}): why its levels are not all written, or null. */
	static @Nullable String ownRefusal(MinecraftServer srv, long mark) {
		return refusal(lastChunks, mark, levels(srv), false);
	}

	/** Inside a world save's callback (AFTER_SAVE: its frame on top): why its levels are not all written, or null. */
	static @Nullable String currentChunksRefusal(MinecraftServer srv) {
		Frame top = STACK.peek();
		return top == null || top.kind != Kind.CHUNKS ? "no save running" : incoherent(levels(srv), top.saved, top.skipped, false, true);
	}

	/** The world save's callback: why its save can't carry the ledger (a level not written, the players not saved with it), or null. */
	static @Nullable String worldSaveRefusal(MinecraftServer srv) {
		Frame top = STACK.peek();
		return top == null || top.kind != Kind.CHUNKS ? "no save running" : incoherent(levels(srv), top.saved, top.skipped, true, top.players);
	}

	private static int levels(MinecraftServer srv) {
		int n = 0;
		for (ServerLevel l : srv.getAllLevels()) {
			n++;
		}
		return n;
	}

	/** (dev) the last chunk save's record and the frames open. */
	static com.google.gson.JsonObject json() {
		com.google.gson.JsonObject o = new com.google.gson.JsonObject();
		Frame f = lastChunks;
		com.google.gson.JsonArray a = new com.google.gson.JsonArray();
		com.google.gson.JsonArray b = new com.google.gson.JsonArray();
		if (f != null) {
			f.saved.forEach(a::add);
			f.skipped.forEach(b::add);
			o.addProperty("id", f.id);
			o.addProperty("completed", f.completed);
		}
		o.add("saved", a);
		o.add("skipped", b);
		o.addProperty("playersWithIt", f != null && f.players);
		o.addProperty("open", STACK.size());
		return o;
	}

	static void log(String what, String why) {
		Architect.LOGGER.warn("Stockpiles: {} did not write the stockpile ledger: {}; it stays pending until a coherent save", what, why);
	}
}
