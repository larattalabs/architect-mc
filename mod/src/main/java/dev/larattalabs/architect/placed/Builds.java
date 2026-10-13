package dev.larattalabs.architect.placed;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.larattalabs.architect.Architect;
import dev.larattalabs.architect.api.BuildKind;
import dev.larattalabs.architect.api.BuildState;
import dev.larattalabs.architect.api.VoxelClass;
import dev.larattalabs.architect.journal.Sections;
import dev.larattalabs.architect.region.volume.VoxelTable;
import it.unimi.dsi.fastutil.longs.Long2IntOpenHashMap;
import it.unimi.dsi.fastutil.longs.Long2LongOpenHashMap;
import it.unimi.dsi.fastutil.longs.LongArrayList;
import it.unimi.dsi.fastutil.longs.LongOpenHashSet;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.UUID;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerChunkEvents;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerLifecycleEvents;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerTickEvents;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.core.registries.Registries;
import net.minecraft.resources.Identifier;
import net.minecraft.resources.ResourceKey;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.tags.BlockTags;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.block.BedBlock;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.DoorBlock;
import net.minecraft.world.level.block.FenceGateBlock;
import net.minecraft.world.level.block.LiquidBlock;
import net.minecraft.world.level.block.TrapDoorBlock;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.block.state.properties.BlockStateProperties;
import net.minecraft.world.level.block.state.properties.DoubleBlockHalf;
import net.minecraft.world.level.chunk.LevelChunk;
import net.minecraft.world.level.levelgen.Heightmap;
import net.minecraft.world.level.levelgen.structure.BoundingBox;
import net.minecraft.world.level.storage.LevelResource;
import org.jspecify.annotations.Nullable;

/**
 * Builds (docs/CONTRACT.md "Phase 6c slice PT" §4, §8): the raw set grouped into builds, which every write path keeps.
 * A tracked cell is <b>fill</b> when it is natural-looking and lies at or below the surrounding untracked ground (the median
 * surface of the columns within 3); farmland, crops, path blocks and bucket sources are always structural; every other tracked
 * cell is <b>structural</b>. Structural cells within 2 of each other (Chebyshev) are a component. A component is promoted to a
 * build ({@link #promotes}), kept by hysteresis ({@link #demotes}: two evaluations 60 s apart), or, with 24+ structural cells a
 * player changed in the last 10 minutes, a <b>provisional</b> build (N-PT-2). The classifier runs 5 s after the last change in
 * a component (debounce), sliced at 1 ms of its own CPU a tick, 65,536 cells per flood, over loaded chunks only.
 *
 * <p>The index ({@code <world>/architect/builds.json}, temp file then rename) holds each build: id ({@code build-<n>} from the
 * world's counter, never from geometry or an owner string), dimension, bounds, footprint, entrances, kind and confidence,
 * structural cell count, placers, state, aliases, change times and a revision bumped on every change. Server thread.
 */
public final class Builds {
	private Builds() {
	}

	private static final Gson GSON = new GsonBuilder().setPrettyPrinting().disableHtmlEscaping().create();

	// ------------------------------------------------------------------ rules (world rules, N-PT-3: tunable)

	/** The world rules ({@code builds.json} {@code rules}; {@code /architect build rule}). */
	public static final class Rules {
		public boolean playerTracking = true;
		public int promote = 40;
		public int promoteNonNatural = 24;
		public int demote = 20;
		public int demoteNoQualifier = 48;
		public int provisional = 24;
		public int big = 96;
		public int farm = 16;
		public long debounceMs = 5_000;
		public long demoteGapMs = 60_000;
		public long graceMs = 600_000;

		JsonObject json() {
			return GSON.toJsonTree(this).getAsJsonObject();
		}
	}

	static Rules rules = new Rules();

	public static Rules rules() {
		return rules;
	}

	/** A rule changed (the command): tracking on/off takes effect at once, and the index is saved with it. */
	static void rulesChanged() {
		Placed.on = rules.playerTracking;
		indexDirty = true;
		save(true);
	}

	// ------------------------------------------------------------------ the index

	/** One build's index record. */
	static final class Rec {
		String id = "";
		long n;
		String dimension = "minecraft:overworld";
		int[] bounds = new int[6];
		int[] footprint = new int[0];
		List<Ent> entrances = new ArrayList<>();
		BuildKind kind = BuildKind.OTHER;
		float confidence;
		int cells;
		Map<UUID, Integer> placers = new LinkedHashMap<>();
		BuildState state = BuildState.ACTIVE;
		List<String> aliases = new ArrayList<>();
		@Nullable String mergedInto;
		long firstChange;
		long lastChange;
		long lastPlayerChange;
		long revision;
		long demoteSince;
		int releasedCells;
		boolean partial;
		/** Gone (demoted below every bar, or merged away): kept for its id's alias only. */
		boolean gone;
		/** A claim's claimer (the nil UUID for the console), or null. */
		@Nullable UUID claimedBy;
		/** The revision BUILD_CHANGED last fired for (not saved). */
		transient long lastFired = -1;

		boolean kept() {
			return !gone && mergedInto == null && (state == BuildState.ACTIVE || state == BuildState.CLAIMED || state == BuildState.PROVISIONAL);
		}

		BoundingBox box() {
			return new BoundingBox(bounds[0], bounds[1], bounds[2], bounds[3], bounds[4], bounds[5]);
		}

		@Nullable UUID primary() {
			UUID best = null;
			int n = -1;
			for (var e : placers.entrySet()) {
				if (e.getValue() > n) {
					n = e.getValue();
					best = e.getKey();
				}
			}
			return best;
		}
	}

	/** An entrance: a door's lower half, a fence gate or a trapdoor at the build's ground, with its facing. */
	record Ent(long pos, Direction facing, String block) {
	}

	private static final Map<String, Rec> RECS = new LinkedHashMap<>();
	private static long next = 1;
	private static @Nullable Path file;
	private static boolean indexDirty;
	private static long lastWrite;
	private static @Nullable MinecraftServer server;

	public static void init() {
		ServerLifecycleEvents.SERVER_STARTED.register(Builds::load);
		ServerLifecycleEvents.SERVER_STOPPING.register(s -> {
			save(true);
			JOBS.clear();
			LEVELS.clear();
			BuildViews.stopClaims();
		});
		ServerTickEvents.END_SERVER_TICK.register(Builds::tick);
		ServerChunkEvents.CHUNK_LOAD.register((level, chunk, generated) -> loaded(level, chunk));
		dev.larattalabs.architect.placed.BuildCommands.init();
	}

	static void load(MinecraftServer s) {
		server = s;
		RECS.clear();
		LEVELS.clear();
		JOBS.clear();
		next = 1;
		rules = new Rules();
		file = s.getWorldPath(LevelResource.ROOT).resolve("architect").resolve("builds.json");
		if (Files.exists(file)) {
			try {
				JsonObject o = JsonParser.parseString(Files.readString(file, StandardCharsets.UTF_8)).getAsJsonObject();
				next = o.has("next") ? o.get("next").getAsLong() : 1;
				if (o.get("rules") instanceof JsonObject r) {
					rules = GSON.fromJson(r, Rules.class);
				}
				if (o.get("builds") instanceof JsonArray a) {
					for (JsonElement e : a) {
						Rec r = fromJson(e.getAsJsonObject());
						RECS.put(r.id, r);
					}
				}
			} catch (IOException | RuntimeException e) {
				Architect.LOGGER.error("PT: the build index {} can't be read ({}); builds are re-found as chunks are classified", file, e.toString());
			}
		}
		Placed.on = rules.playerTracking;
	}

	/** Writes the index when it changed (at most once a second unless {@code now}): a temp file, then an atomic rename. */
	static void save(boolean now) {
		Path f = file;
		if (f == null || !indexDirty || !now && System.currentTimeMillis() - lastWrite < 1000) {
			return;
		}
		JsonObject o = new JsonObject();
		o.addProperty("version", 1);
		o.addProperty("next", next);
		o.add("rules", rules.json());
		JsonArray a = new JsonArray();
		for (Rec r : RECS.values()) {
			a.add(toJson(r));
		}
		o.add("builds", a);
		try {
			Files.createDirectories(f.getParent());
			Path tmp = f.resolveSibling("builds.json.tmp");
			Files.writeString(tmp, GSON.toJson(o) + "\n", StandardCharsets.UTF_8);
			Files.move(tmp, f, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
			indexDirty = false;
			lastWrite = System.currentTimeMillis();
		} catch (IOException e) {
			Architect.LOGGER.error("PT: could not write the build index {}: {}", f, e.toString());
		}
	}

	static JsonObject toJson(Rec r) {
		JsonObject o = new JsonObject();
		o.addProperty("id", r.id);
		o.addProperty("n", r.n);
		o.addProperty("dimension", r.dimension);
		o.add("bounds", ints(r.bounds));
		o.add("footprint", ints(r.footprint));
		JsonArray en = new JsonArray();
		for (Ent e : r.entrances) {
			JsonObject x = new JsonObject();
			x.addProperty("pos", e.pos);
			x.addProperty("facing", e.facing.getSerializedName());
			x.addProperty("block", e.block);
			en.add(x);
		}
		o.add("entrances", en);
		o.addProperty("kind", r.kind.name());
		o.addProperty("confidence", r.confidence);
		o.addProperty("cells", r.cells);
		JsonObject pl = new JsonObject();
		r.placers.forEach((u, c) -> pl.addProperty(u.toString(), c));
		o.add("placers", pl);
		o.addProperty("state", r.state.name());
		JsonArray al = new JsonArray();
		r.aliases.forEach(al::add);
		o.add("aliases", al);
		if (r.mergedInto != null) {
			o.addProperty("mergedInto", r.mergedInto);
		}
		o.addProperty("firstChange", r.firstChange);
		o.addProperty("lastChange", r.lastChange);
		o.addProperty("lastPlayerChange", r.lastPlayerChange);
		o.addProperty("revision", r.revision);
		o.addProperty("demoteSince", r.demoteSince);
		o.addProperty("releasedCells", r.releasedCells);
		o.addProperty("partial", r.partial);
		o.addProperty("gone", r.gone);
		if (r.claimedBy != null) {
			o.addProperty("claimedBy", r.claimedBy.toString());
		}
		return o;
	}

	static Rec fromJson(JsonObject o) {
		Rec r = new Rec();
		r.id = o.get("id").getAsString();
		r.n = o.has("n") ? o.get("n").getAsLong() : idNumber(r.id);
		r.dimension = o.get("dimension").getAsString();
		r.bounds = intsOf(o.getAsJsonArray("bounds"));
		r.footprint = intsOf(o.getAsJsonArray("footprint"));
		for (JsonElement e : o.getAsJsonArray("entrances")) {
			JsonObject x = e.getAsJsonObject();
			r.entrances.add(new Ent(x.get("pos").getAsLong(), Direction.byName(x.get("facing").getAsString()), x.get("block").getAsString()));
		}
		r.kind = BuildKind.valueOf(o.get("kind").getAsString());
		r.confidence = o.get("confidence").getAsFloat();
		r.cells = o.get("cells").getAsInt();
		for (var e : o.getAsJsonObject("placers").entrySet()) {
			r.placers.put(UUID.fromString(e.getKey()), e.getValue().getAsInt());
		}
		r.state = BuildState.valueOf(o.get("state").getAsString());
		for (JsonElement e : o.getAsJsonArray("aliases")) {
			r.aliases.add(e.getAsString());
		}
		r.mergedInto = o.has("mergedInto") ? o.get("mergedInto").getAsString() : null;
		r.firstChange = o.get("firstChange").getAsLong();
		r.lastChange = o.get("lastChange").getAsLong();
		r.lastPlayerChange = o.has("lastPlayerChange") ? o.get("lastPlayerChange").getAsLong() : r.lastChange;
		r.revision = o.get("revision").getAsLong();
		r.demoteSince = o.has("demoteSince") ? o.get("demoteSince").getAsLong() : 0;
		r.releasedCells = o.has("releasedCells") ? o.get("releasedCells").getAsInt() : 0;
		r.partial = o.has("partial") && o.get("partial").getAsBoolean();
		r.gone = o.has("gone") && o.get("gone").getAsBoolean();
		r.claimedBy = o.has("claimedBy") ? UUID.fromString(o.get("claimedBy").getAsString()) : null;
		return r;
	}

	private static JsonArray ints(int[] a) {
		JsonArray j = new JsonArray();
		for (int v : a) {
			j.add(v);
		}
		return j;
	}

	private static int[] intsOf(JsonArray a) {
		int[] out = new int[a.size()];
		for (int i = 0; i < out.length; i++) {
			out[i] = a.get(i).getAsInt();
		}
		return out;
	}

	static long idNumber(String id) {
		try {
			return Long.parseLong(id.substring(id.lastIndexOf('-') + 1));
		} catch (RuntimeException e) {
			return Long.MAX_VALUE;
		}
	}

	private static Rec newRec(String dimension, long now) {
		Rec r = new Rec();
		r.n = next++;
		r.id = "build-" + r.n;
		r.dimension = dimension;
		r.firstChange = now;
		r.lastChange = now;
		RECS.put(r.id, r);
		indexDirty = true;
		return r;
	}

	// ------------------------------------------------------------------ lookups

	/** The survivor an id resolves to (an alias of a merged build resolves to the build it merged into); null for null. */
	public static @Nullable String resolve(@Nullable String id) {
		if (id == null) {
			return null;
		}
		String cur = id;
		for (int i = 0; i < 16; i++) {
			Rec r = RECS.get(cur);
			if (r == null || r.mergedInto == null) {
				return cur;
			}
			cur = r.mergedInto;
		}
		return cur;
	}

	/** The id when that build (after aliases) is kept: ACTIVE, CLAIMED or PROVISIONAL; else null (incidental, released, gone). */
	static @Nullable String kept(String id) {
		String s = resolve(id);
		Rec r = RECS.get(s);
		return r != null && r.kept() ? s : null;
	}

	/** The kind of a build (OTHER when unknown). */
	public static BuildKind kindOf(String id) {
		Rec r = rec(id);
		return r == null ? BuildKind.OTHER : r.kind;
	}

	static @Nullable Rec rec(@Nullable String id) {
		String s = resolve(id);
		return s == null ? null : RECS.get(s);
	}

	/** Every build that is not gone or merged, in a dimension (null: all) meeting a box (null: anywhere), by id number. */
	static List<Rec> list(@Nullable String dimension, @Nullable BoundingBox within) {
		List<Rec> out = new ArrayList<>();
		for (Rec r : RECS.values()) {
			if (r.gone || r.mergedInto != null || dimension != null && !dimension.equals(r.dimension)) {
				continue;
			}
			if (within != null && !within.intersects(r.bounds[0], r.bounds[2], r.bounds[3], r.bounds[5])) {
				continue;
			}
			if (within != null && (r.bounds[4] < within.minY() || r.bounds[1] > within.maxY())) {
				continue;
			}
			out.add(r);
		}
		out.sort(Comparator.comparingLong(r -> r.n));
		return out;
	}

	// ------------------------------------------------------------------ dirty sections and the debounce

	/** Per dimension: when each section last changed (any change; a player's), and the sections waiting for the classifier. */
	static final class LevelState {
		final Long2LongOpenHashMap changed = new Long2LongOpenHashMap();
		final Long2LongOpenHashMap byPlayer = new Long2LongOpenHashMap();
		/** section key -> when it is due (its last change plus the debounce, or a scheduled re-evaluation). */
		final Long2LongOpenHashMap due = new Long2LongOpenHashMap();
	}

	private static final Map<ResourceKey<Level>, LevelState> LEVELS = new HashMap<>();

	private static LevelState state(ServerLevel level) {
		return LEVELS.computeIfAbsent(level.dimension(), k -> new LevelState());
	}

	/** A tracked cell was recorded, cleared or changed build (by a player's use when {@code byPlayer}). */
	static void touched(ServerLevel level, BlockPos pos, boolean byPlayer) {
		long now = System.currentTimeMillis();
		LevelState ls = state(level);
		long key = Sections.key(pos.getX() >> 4, pos.getY() >> 4, pos.getZ() >> 4);
		ls.changed.put(key, now);
		if (byPlayer) {
			ls.byPlayer.put(key, now);
		}
		ls.due.put(key, now + rules.debounceMs);
	}

	/** Schedules a section's re-evaluation at {@code at} (a demotion's second look, a grace's end). */
	static void schedule(ServerLevel level, long key, long at) {
		LevelState ls = state(level);
		long cur = ls.due.getOrDefault(key, Long.MAX_VALUE);
		if (at < cur || !ls.due.containsKey(key)) {
			ls.due.put(key, at);
		}
	}

	private static void loaded(ServerLevel level, LevelChunk chunk) {
		if (RECS.isEmpty() || chunk.getAttached(Placed.TYPE) == null) {
			return;
		}
		// a partial build (it reached an unloaded chunk) is merged when the chunk loads
		String dim = level.dimension().identifier().toString();
		int cx = chunk.getPos().x();
		int cz = chunk.getPos().z();
		for (Rec r : RECS.values()) {
			if (r.partial && !r.gone && r.dimension.equals(dim) && r.bounds[0] >> 4 <= cx + 1 && r.bounds[3] >> 4 >= cx - 1 && r.bounds[2] >> 4 <= cz + 1
				&& r.bounds[5] >> 4 >= cz - 1) {
				for (int sy : chunk.getAttached(Placed.TYPE).sectionYs()) {
					schedule(level, Sections.key(cx, sy, cz), System.currentTimeMillis() + rules.debounceMs);
				}
				return;
			}
		}
	}

	// ------------------------------------------------------------------ the classifier's tick

	/** Own CPU per tick (ns): the budget and the max seen (recorded by the gate). */
	public static final long BUDGET_NS = 1_000_000L;
	static long maxTickNs;
	static long jobsRun;
	private static final Map<ResourceKey<Level>, Job> JOBS = new HashMap<>();

	public static long maxTickNs() {
		return maxTickNs;
	}

	public static void resetMax() {
		maxTickNs = 0;
	}

	public static long jobsRun() {
		return jobsRun;
	}

	/** Sections waiting (due or not) plus running jobs: 0 when the classifier is idle. */
	public static int pending() {
		int n = JOBS.size();
		for (LevelState ls : LEVELS.values()) {
			n += ls.due.size();
		}
		return n;
	}

	/** Sections due now or running jobs (the gate waits for 0 after the debounce). */
	public static int pendingNow() {
		long now = System.currentTimeMillis();
		int n = JOBS.size();
		for (LevelState ls : LEVELS.values()) {
			for (long t : ls.due.values()) {
				if (t <= now) {
					n++;
				}
			}
		}
		return n;
	}

	private static void tick(MinecraftServer s) {
		Placed.tickEnd();
		if (!Placed.on) {
			save(false);
			return;
		}
		BuildViews.tickClaims();
		long t0 = System.nanoTime();
		long deadline = t0 + BUDGET_NS;
		long now = System.currentTimeMillis();
		for (ServerLevel level : s.getAllLevels()) {
			if (System.nanoTime() >= deadline) {
				break;
			}
			Job j = JOBS.get(level.dimension());
			if (j == null) {
				LevelState ls = LEVELS.get(level.dimension());
				if (ls == null || ls.due.isEmpty()) {
					continue;
				}
				// the earliest due section
				long best = Long.MIN_VALUE;
				long bestAt = Long.MAX_VALUE;
				for (var e : ls.due.long2LongEntrySet()) {
					if (e.getLongValue() <= now && e.getLongValue() < bestAt) {
						bestAt = e.getLongValue();
						best = e.getLongKey();
					}
				}
				if (bestAt == Long.MAX_VALUE) {
					continue;
				}
				ls.due.remove(best);
				j = new Job(level, best, now);
				JOBS.put(level.dimension(), j);
			}
			boolean done;
			try {
				done = j.step(deadline);
			} catch (RuntimeException e) {
				Architect.LOGGER.error("PT: the classifier failed on section {} of {}", j.section, level.dimension().identifier(), e);
				done = true;
			}
			if (done) {
				JOBS.remove(level.dimension());
				jobsRun++;
			}
		}
		long took = System.nanoTime() - t0;
		if (took > maxTickNs) {
			maxTickNs = took;
		}
		save(false);
	}

	/** Runs the classifier until it is idle (the gate and the claim; ignores the debounce of sections not yet due). */
	public static void drain(MinecraftServer s, boolean ignoreDebounce) {
		for (int guard = 0; guard < 100_000; guard++) {
			if (ignoreDebounce) {
				long now = System.currentTimeMillis();
				for (LevelState ls : LEVELS.values()) {
					for (var e : ls.due.long2LongEntrySet()) {
						if (e.getLongValue() > now) {
							e.setValue(now);
						}
					}
				}
			}
			boolean any = !JOBS.isEmpty();
			long now = System.currentTimeMillis();
			for (LevelState ls : LEVELS.values()) {
				for (long t : ls.due.values()) {
					any |= t <= now;
				}
			}
			if (!any) {
				return;
			}
			tickUnbounded(s);
		}
	}

	private static void tickUnbounded(MinecraftServer s) {
		long now = System.currentTimeMillis();
		for (ServerLevel level : s.getAllLevels()) {
			Job j = JOBS.remove(level.dimension());
			if (j == null) {
				LevelState ls = LEVELS.get(level.dimension());
				if (ls == null || ls.due.isEmpty()) {
					continue;
				}
				long best = Long.MIN_VALUE;
				long bestAt = Long.MAX_VALUE;
				for (var e : ls.due.long2LongEntrySet()) {
					if (e.getLongValue() <= now && e.getLongValue() < bestAt) {
						bestAt = e.getLongValue();
						best = e.getLongKey();
					}
				}
				if (bestAt == Long.MAX_VALUE) {
					continue;
				}
				ls.due.remove(best);
				j = new Job(level, best, now);
			}
			while (!j.step(Long.MAX_VALUE)) {
				// unbounded
			}
			jobsRun++;
		}
		save(false);
	}

	// ------------------------------------------------------------------ the cell rules

	static boolean alwaysStructural(BlockState s) {
		Block b = s.getBlock();
		return b == Blocks.FARMLAND || b == Blocks.DIRT_PATH || s.is(BlockTags.CROPS) || b instanceof net.minecraft.world.level.block.StemBlock
			|| b instanceof LiquidBlock && s.getFluidState().isSource();
	}

	static boolean naturalLooking(BlockState s) {
		return VoxelTable.get().natural(s.getBlock());
	}

	static boolean ground(BlockState s) {
		VoxelClass c = VoxelTable.get().of(s.getBlock());
		return c == VoxelClass.ROCK || c == VoxelClass.SOIL || c == VoxelClass.LOOSE;
	}

	static boolean farmCell(BlockState s) {
		return s.is(Blocks.FARMLAND) || s.is(BlockTags.CROPS) || s.getBlock() instanceof net.minecraft.world.level.block.StemBlock;
	}

	static boolean entranceBlock(BlockState s) {
		Block b = s.getBlock();
		return b instanceof DoorBlock && s.getValue(DoorBlock.HALF) == DoubleBlockHalf.LOWER || b instanceof FenceGateBlock || b instanceof TrapDoorBlock;
	}

	// ------------------------------------------------------------------ one classification job

	/**
	 * Re-classifies what one dirty section touches: its tracked cells and every build whose bounds meet it (cells added, cleared
	 * or re-labelled). Floods the structural components (sliced), then resolves ids (merge: the oldest wins, the others become
	 * aliases; split: the largest part keeps the id), states and labels in one step. A change inside a visited section while
	 * it ran makes it start again after the debounce.
	 */
	static final class Job {
		final ServerLevel level;
		final long section;
		final long started;
		final String dim;
		int phase;
		final LongArrayList seeds = new LongArrayList();
		final Set<String> affected = new LinkedHashSet2();
		int seedCursor;
		final LongOpenHashSet visited = new LongOpenHashSet();
		final LongOpenHashSet sectionsSeen = new LongOpenHashSet();
		final List<Comp> comps = new ArrayList<>();
		final LongArrayList fill = new LongArrayList();
		@Nullable Comp cur;
		java.util.@Nullable ArrayDeque<Long> queue;
		final Long2IntOpenHashMap surface = new Long2IntOpenHashMap();
		final Long2IntOpenHashMap median = new Long2IntOpenHashMap();
		boolean partialHit;

		Job(ServerLevel level, long section, long now) {
			this.level = level;
			this.section = section;
			this.started = now;
			this.dim = level.dimension().identifier().toString();
			surface.defaultReturnValue(Integer.MIN_VALUE);
			median.defaultReturnValue(Integer.MIN_VALUE);
		}

		/** Works until the deadline; true when done. */
		boolean step(long deadline) {
			if (phase == 0) {
				init();
				phase = 1;
			}
			if (phase == 1) {
				if (!flood(deadline)) {
					return false;
				}
				phase = 2;
			}
			// a change while it ran: start again after the debounce
			LevelState ls = state(level);
			for (long k : sectionsSeen) {
				if (ls.changed.getOrDefault(k, 0L) > started) {
					schedule(level, section, ls.changed.get(k) + rules.debounceMs);
					return true;
				}
			}
			resolveAll();
			return true;
		}

		private void init() {
			int sx = Sections.sx(section);
			int sy = Sections.sy(section);
			int sz = Sections.sz(section);
			LevelChunk c = level.getChunkSource().getChunkNow(sx, sz);
			if (c != null) {
				addSectionCells(c, sy, null);
			}
			// the builds this section meets (expanded by the join distance): their cells are seeds too (a split, a removal)
			int x0 = (sx << 4) - 2;
			int y0 = (sy << 4) - 2;
			int z0 = (sz << 4) - 2;
			int x1 = (sx << 4) + 17;
			int y1 = (sy << 4) + 17;
			int z1 = (sz << 4) + 17;
			for (Rec r : RECS.values()) {
				if (r.gone || r.mergedInto != null || !r.dimension.equals(dim)) {
					continue;
				}
				if (r.bounds[3] < x0 || r.bounds[0] > x1 || r.bounds[4] < y0 || r.bounds[1] > y1 || r.bounds[5] < z0 || r.bounds[2] > z1) {
					continue;
				}
				affected.add(r.id);
			}
			for (String id : new ArrayList<>(affected)) {
				Rec r = RECS.get(id);
				for (int cx = r.bounds[0] >> 4; cx <= r.bounds[3] >> 4; cx++) {
					for (int cz = r.bounds[2] >> 4; cz <= r.bounds[5] >> 4; cz++) {
						LevelChunk ch = level.getChunkSource().getChunkNow(cx, cz);
						if (ch == null) {
							continue;
						}
						for (int y = r.bounds[1] >> 4; y <= r.bounds[4] >> 4; y++) {
							addSectionCells(ch, y, id);
						}
					}
				}
			}
		}

		/** The tracked cells of a section (only those labelled {@code onlyBuild}'s, when given) as seeds. */
		private void addSectionCells(LevelChunk c, int sy, @Nullable String onlyBuild) {
			PlacedChunk pc = c.getAttached(Placed.TYPE);
			if (pc == null) {
				return;
			}
			int[] cells = pc.cells(sy);
			int bx = c.getPos().x() << 4;
			int bz = c.getPos().z() << 4;
			for (int i = 0; i < cells.length; i += 2) {
				int idx = cells[i];
				int v = cells[i + 1];
				String b = pc.build(PlacedChunk.buildOf(v));
				if (onlyBuild != null && !onlyBuild.equals(resolve(b))) {
					continue;
				}
				if (b != null && onlyBuild == null) {
					String rb = resolve(b);
					if (rb != null && RECS.containsKey(rb)) {
						affected.add(rb);
					}
				}
				seeds.add(BlockPos.asLong(bx + (idx & 15), (sy << 4) + (idx >> 8), bz + (idx >> 4 & 15)));
			}
		}

		/** The cell's packed value (-1: untracked or unloaded). */
		int value(int x, int y, int z) {
			LevelChunk c = level.getChunkSource().getChunkNow(x >> 4, z >> 4);
			if (c == null) {
				partialHit = true;
				return -1;
			}
			PlacedChunk pc = c.getAttached(Placed.TYPE);
			return pc == null ? -1 : pc.get(x, y, z);
		}

		@Nullable String labelOf(int x, int y, int z, int v) {
			LevelChunk c = level.getChunkSource().getChunkNow(x >> 4, z >> 4);
			PlacedChunk pc = c == null ? null : c.getAttached(Placed.TYPE);
			return pc == null ? null : resolve(pc.build(PlacedChunk.buildOf(v)));
		}

		/** A claimed build's cells are never re-classified: they are the claim's, whatever they look like. */
		boolean claimedLabel(@Nullable String label) {
			Rec r = label == null ? null : RECS.get(label);
			return r != null && r.state == BuildState.CLAIMED && !r.gone && r.mergedInto == null;
		}

		boolean structural(int x, int y, int z, BlockState s) {
			if (alwaysStructural(s)) {
				return true;
			}
			if (Placed.empty(s)) {
				return false;
			}
			if (!naturalLooking(s)) {
				return true;
			}
			int m = medianSurface(x, z);
			return m == Integer.MIN_VALUE || y > m;
		}

		/** The median of the untracked ground surface of the 7x7 columns around (x, z) (loaded columns only). */
		int medianSurface(int x, int z) {
			long k = BlockPos.asLong(x, 0, z);
			int m = median.get(k);
			if (m != Integer.MIN_VALUE) {
				return m;
			}
			int[] s = new int[49];
			int n = 0;
			for (int dx = -3; dx <= 3; dx++) {
				for (int dz = -3; dz <= 3; dz++) {
					int v = surface(x + dx, z + dz);
					if (v != Integer.MIN_VALUE) {
						s[n++] = v;
					}
				}
			}
			if (n == 0) {
				return Integer.MIN_VALUE;
			}
			java.util.Arrays.sort(s, 0, n);
			m = s[n / 2];
			median.put(k, m);
			return m;
		}

		/** The top untracked natural ground block of a column (64 below the motion-blocking top at most), or MIN_VALUE when unloaded. */
		int surface(int x, int z) {
			long k = BlockPos.asLong(x, 0, z);
			int v = surface.get(k);
			if (v != Integer.MIN_VALUE || surface.containsKey(k)) {
				return v;
			}
			LevelChunk c = level.getChunkSource().getChunkNow(x >> 4, z >> 4);
			if (c == null) {
				surface.put(k, Integer.MIN_VALUE);
				return Integer.MIN_VALUE;
			}
			PlacedChunk pc = c.getAttached(Placed.TYPE);
			int top = c.getHeight(Heightmap.Types.MOTION_BLOCKING_NO_LEAVES, x & 15, z & 15);
			BlockPos.MutableBlockPos m = new BlockPos.MutableBlockPos();
			int out = top;
			for (int y = top; y >= Math.max(level.getMinY(), top - 64); y--) {
				if (pc != null && pc.get(x, y, z) >= 0) {
					continue;
				}
				if (ground(c.getBlockState(m.set(x, y, z)))) {
					out = y;
					break;
				}
				out = y - 1;
			}
			surface.put(k, out);
			return out;
		}

		private boolean flood(long deadline) {
			BlockPos.MutableBlockPos m = new BlockPos.MutableBlockPos();
			int n = 0;
			while (true) {
				if ((++n & 63) == 0 && System.nanoTime() >= deadline) {
					return false;
				}
				if (queue == null || queue.isEmpty()) {
					if (cur != null) {
						comps.add(cur);
						cur = null;
					}
					// the next unvisited seed
					long seed = Long.MIN_VALUE;
					while (seedCursor < seeds.size()) {
						long q = seeds.getLong(seedCursor++);
						if (!visited.contains(q)) {
							seed = q;
							break;
						}
					}
					if (seed == Long.MIN_VALUE) {
						return true;
					}
					int x = BlockPos.getX(seed);
					int y = BlockPos.getY(seed);
					int z = BlockPos.getZ(seed);
					visited.add(seed);
					sectionsSeen.add(Sections.key(x >> 4, y >> 4, z >> 4));
					int v = value(x, y, z);
					if (v < 0) {
						continue;
					}
					String label = labelOf(x, y, z, v);
					if (claimedLabel(label)) {
						continue;
					}
					BlockState s = level.getBlockState(m.set(x, y, z));
					if (!structural(x, y, z, s)) {
						fill.add(seed);
						continue;
					}
					cur = new Comp();
					cur.add(seed, v, label, s);
					queue = new java.util.ArrayDeque<>();
					queue.add(seed);
					continue;
				}
				long q = queue.poll();
				int x = BlockPos.getX(q);
				int y = BlockPos.getY(q);
				int z = BlockPos.getZ(q);
				for (int dx = -2; dx <= 2; dx++) {
					for (int dy = -2; dy <= 2; dy++) {
						for (int dz = -2; dz <= 2; dz++) {
							if (dx == 0 && dy == 0 && dz == 0) {
								continue;
							}
							int nx = x + dx;
							int ny = y + dy;
							int nz = z + dz;
							long np = BlockPos.asLong(nx, ny, nz);
							if (visited.contains(np)) {
								continue;
							}
							int v = value(nx, ny, nz);
							if (v < 0) {
								if (level.getChunkSource().getChunkNow(nx >> 4, nz >> 4) == null) {
									cur.partial = true;
								}
								continue;
							}
							visited.add(np);
							sectionsSeen.add(Sections.key(nx >> 4, ny >> 4, nz >> 4));
							String label = labelOf(nx, ny, nz, v);
							if (claimedLabel(label)) {
								continue;
							}
							BlockState s = level.getBlockState(m.set(nx, ny, nz));
							if (!structural(nx, ny, nz, s)) {
								fill.add(np);
								continue;
							}
							if (cur.cells.size() >= 65_536) {
								cur.partial = true;
								continue;
							}
							cur.add(np, v, label, s);
							queue.add(np);
						}
					}
				}
			}
		}

		// ---------------------------------------------------------------- resolution

		private void resolveAll() {
			long now = System.currentTimeMillis();
			LevelState ls = state(level);
			// 1. per component: its stats and the ids its cells carry
			for (Comp c : comps) {
				c.stats(this, ls);
			}
			// 2. merges: a component holding cells of several kept builds keeps the oldest id; the others become its aliases
			Map<String, String> mergedInto = new HashMap<>();
			for (Comp c : comps) {
				List<String> ids = new ArrayList<>();
				for (String id : c.labels.keySet()) {
					Rec r = RECS.get(id);
					if (r != null && !r.gone && r.mergedInto == null && r.state != BuildState.RELEASED) {
						ids.add(id);
					}
				}
				if (ids.size() > 1) {
					ids.sort(Comparator.comparingLong(Builds::idNumber));
					String survivor = ids.get(0);
					for (String other : ids.subList(1, ids.size())) {
						mergedInto.put(other, survivor);
					}
					c.chosen = survivor;
				} else if (ids.size() == 1) {
					c.chosen = ids.get(0);
				} else {
					// only released (or no) labels
					for (String id : c.labels.keySet()) {
						Rec r = RECS.get(id);
						if (r != null && !r.gone && r.state == BuildState.RELEASED) {
							c.released = id;
						}
					}
				}
			}
			// 3. splits: an id two components chose stays with the larger; the others start without one
			Map<String, Comp> owner = new HashMap<>();
			for (Comp c : comps) {
				if (c.chosen == null) {
					continue;
				}
				Comp o = owner.get(c.chosen);
				if (o == null) {
					owner.put(c.chosen, c);
				} else if (c.cells.size() > o.cells.size() || c.cells.size() == o.cells.size() && c.min() < o.min()) {
					o.splitFrom = o.chosen;
					o.chosen = null;
					owner.put(c.chosen, c);
				} else {
					c.splitFrom = c.chosen;
					c.chosen = null;
				}
			}
			for (var e : mergedInto.entrySet()) {
				Rec r = RECS.get(e.getKey());
				Rec s = RECS.get(e.getValue());
				r.mergedInto = e.getValue();
				if (!s.aliases.contains(r.id)) {
					s.aliases.add(r.id);
				}
				for (String a : r.aliases) {
					if (!s.aliases.contains(a)) {
						s.aliases.add(a);
					}
				}
				r.revision++;
				indexDirty = true;
				changed(r, "merged");
			}
			// 4. states
			Set<String> stillOwned = new HashSet<>();
			for (Comp c : comps) {
				decide(c, now, ls);
				if (c.finalId != null) {
					stillOwned.add(c.finalId);
				}
			}
			// 5. the labels: every component cell gets its final id (0: incidental); fill cells labelled with a build lose it
			for (Comp c : comps) {
				String label = c.finalId != null ? c.finalId : c.released;
				for (int i = 0; i < c.cells.size(); i++) {
					relabel(c.cells.getLong(i), label);
				}
			}
			for (int i = 0; i < fill.size(); i++) {
				relabel(fill.getLong(i), null);
			}
			// 6. affected builds no component owns any more (every cell gone, or all became fill): gone, unless claimed or partial
			for (String id : affected) {
				Rec r = RECS.get(id);
				if (r == null || r.gone || r.mergedInto != null || stillOwned.contains(id) || mergedInto.containsKey(id)) {
					continue;
				}
				if (r.state == BuildState.CLAIMED) {
					recountClaimed(r);
					continue;
				}
				if (r.state == BuildState.RELEASED) {
					boolean any = false;
					for (Comp c : comps) {
						any |= id.equals(c.released);
					}
					if (!any) {
						gone(r, "gone");
					}
					continue;
				}
				if (r.partial) {
					continue;
				}
				gone(r, "gone");
			}
		}

		private void relabel(long p, @Nullable String id) {
			int x = BlockPos.getX(p);
			int y = BlockPos.getY(p);
			int z = BlockPos.getZ(p);
			LevelChunk c = level.getChunkSource().getChunkNow(x >> 4, z >> 4);
			if (c != null) {
				Placed.setBuild(c, x, y, z, id);
			}
		}

		/** A component's state: promoted, kept (hysteresis), provisional (the grace) or incidental; the index updated. */
		private void decide(Comp c, long now, LevelState ls) {
			boolean promotes = promotes(c);
			boolean grace = c.cells.size() >= rules.provisional && now - c.lastPlayer <= rules.graceMs;
			Rec r = c.chosen == null ? null : RECS.get(c.chosen);
			if (r == null && c.released != null) {
				Rec rel = RECS.get(c.released);
				// a released build is not promoted again unless it grew by 25% since (or is claimed)
				if (rel != null && c.cells.size() >= Math.ceil(rel.releasedCells * 1.25) && promotes) {
					rel.state = BuildState.ACTIVE;
					rel.demoteSince = 0;
					fill(rel, c, now);
					c.finalId = rel.id;
					c.released = null;
					changed(rel, "found");
				}
				return;
			}
			if (r == null) {
				if (promotes || grace) {
					r = newRec(dim, now);
					r.state = promotes ? BuildState.ACTIVE : BuildState.PROVISIONAL;
					fill(r, c, now);
					c.finalId = r.id;
					if (!promotes) {
						scheduleAll(c, c.lastPlayer + rules.graceMs + 1000);
					}
					changed(r, c.splitFrom != null ? "split" : "found");
				}
				return;
			}
			// an existing build
			if (promotes) {
				boolean was = r.state != BuildState.ACTIVE;
				r.state = BuildState.ACTIVE;
				r.demoteSince = 0;
				fill(r, c, now);
				c.finalId = r.id;
				changed(r, was ? "found" : "changed");
				return;
			}
			if (r.state == BuildState.PROVISIONAL) {
				if (grace) {
					fill(r, c, now);
					c.finalId = r.id;
					scheduleAll(c, c.lastPlayer + rules.graceMs + 1000);
					changed(r, "changed");
				} else {
					gone(r, "gone");
				}
				return;
			}
			// ACTIVE: hysteresis
			if (demotes(c) && !c.partial) {
				if (r.demoteSince == 0) {
					r.demoteSince = now;
					fill(r, c, now);
					c.finalId = r.id;
					scheduleAll(c, now + rules.demoteGapMs);
					changed(r, "changed");
					return;
				}
				if (now - r.demoteSince < rules.demoteGapMs) {
					fill(r, c, now);
					c.finalId = r.id;
					scheduleAll(c, r.demoteSince + rules.demoteGapMs);
					return;
				}
				if (grace) {
					r.state = BuildState.PROVISIONAL;
					r.demoteSince = 0;
					fill(r, c, now);
					c.finalId = r.id;
					scheduleAll(c, c.lastPlayer + rules.graceMs + 1000);
					changed(r, "changed");
					return;
				}
				gone(r, "gone");
				return;
			}
			r.demoteSince = 0;
			fill(r, c, now);
			c.finalId = r.id;
			changed(r, "changed");
		}

		private void scheduleAll(Comp c, long at) {
			LongOpenHashSet keys = new LongOpenHashSet();
			for (int i = 0; i < c.cells.size(); i++) {
				long p = c.cells.getLong(i);
				keys.add(Sections.key(BlockPos.getX(p) >> 4, BlockPos.getY(p) >> 4, BlockPos.getZ(p) >> 4));
			}
			// one section is enough: its job re-floods the whole component
			if (!keys.isEmpty()) {
				schedule(level, keys.iterator().nextLong(), at);
			}
		}

		private void recountClaimed(Rec r) {
			int n = 0;
			Map<UUID, Integer> pl = new LinkedHashMap<>();
			for (int cx = r.bounds[0] >> 4; cx <= r.bounds[3] >> 4; cx++) {
				for (int cz = r.bounds[2] >> 4; cz <= r.bounds[5] >> 4; cz++) {
					LevelChunk ch = level.getChunkSource().getChunkNow(cx, cz);
					PlacedChunk pc = ch == null ? null : ch.getAttached(Placed.TYPE);
					if (pc == null) {
						continue;
					}
					for (int sy : pc.sectionYs()) {
						int[] cells = pc.cells(sy);
						for (int i = 0; i < cells.length; i += 2) {
							if (r.id.equals(resolve(pc.build(PlacedChunk.buildOf(cells[i + 1]))))) {
								n++;
								pl.merge(pc.placer(PlacedChunk.placerOf(cells[i + 1])), 1, Integer::sum);
							}
						}
					}
				}
			}
			if (n != r.cells || !pl.equals(r.placers)) {
				r.cells = n;
				r.placers = pl;
				r.revision++;
				r.lastChange = System.currentTimeMillis();
				indexDirty = true;
				changed(r, "changed");
			}
		}
	}

	/** {@code java.util.LinkedHashSet} under a short name (the job's affected builds keep their order). */
	static final class LinkedHashSet2 extends java.util.LinkedHashSet<String> {
	}

	/** One structural component: its cells and what they hold. */
	static final class Comp {
		final LongArrayList cells = new LongArrayList();
		final LongOpenHashSet set = new LongOpenHashSet();
		final Map<String, Integer> labels = new LinkedHashMap<>();
		final List<Integer> placerIdx = new ArrayList<>();
		final List<BlockState> states = new ArrayList<>();
		boolean partial;
		@Nullable String chosen;
		@Nullable String splitFrom;
		@Nullable String released;
		@Nullable String finalId;
		// stats
		int minX = Integer.MAX_VALUE;
		int minY = Integer.MAX_VALUE;
		int minZ = Integer.MAX_VALUE;
		int maxX = Integer.MIN_VALUE;
		int maxY = Integer.MIN_VALUE;
		int maxZ = Integer.MIN_VALUE;
		int nonNatural;
		int farm;
		int path;
		boolean bed;
		long lastPlayer;
		final List<Ent> entrances = new ArrayList<>();
		int enclosed;
		int enclosedFloor;
		final Map<UUID, Integer> placers = new LinkedHashMap<>();
		int[] footprint = new int[0];

		void add(long p, int v, @Nullable String label, BlockState s) {
			cells.add(p);
			set.add(p);
			if (label != null) {
				labels.merge(label, 1, Integer::sum);
			}
			placerIdx.add(PlacedChunk.placerOf(v));
			states.add(s);
			int x = BlockPos.getX(p);
			int y = BlockPos.getY(p);
			int z = BlockPos.getZ(p);
			minX = Math.min(minX, x);
			minY = Math.min(minY, y);
			minZ = Math.min(minZ, z);
			maxX = Math.max(maxX, x);
			maxY = Math.max(maxY, y);
			maxZ = Math.max(maxZ, z);
		}

		long min() {
			return BlockPos.asLong(minX, minY, minZ);
		}

		int spans() {
			int n = 0;
			n += maxX - minX + 1 >= 3 ? 1 : 0;
			n += maxY - minY + 1 >= 3 ? 1 : 0;
			n += maxZ - minZ + 1 >= 3 ? 1 : 0;
			return n;
		}

		boolean qualifier() {
			return !entrances.isEmpty() || enclosed >= 8 || farm >= rules.farm || cells.size() >= rules.big;
		}

		void stats(Job j, LevelState ls) {
			Map<Long, Integer> cols = new TreeMap<>();
			for (int i = 0; i < cells.size(); i++) {
				long p = cells.getLong(i);
				BlockState s = states.get(i);
				int x = BlockPos.getX(p);
				int y = BlockPos.getY(p);
				int z = BlockPos.getZ(p);
				if (!naturalLooking(s)) {
					nonNatural++;
				}
				if (farmCell(s)) {
					farm++;
				}
				if (s.is(Blocks.DIRT_PATH)) {
					path++;
				}
				if (s.getBlock() instanceof BedBlock) {
					bed = true;
				}
				if (entranceBlock(s)) {
					int g = j.medianSurface(x, z);
					if (g == Integer.MIN_VALUE || y <= g + 2) {
						Direction f = s.hasProperty(BlockStateProperties.HORIZONTAL_FACING) ? s.getValue(BlockStateProperties.HORIZONTAL_FACING) : Direction.NORTH;
						entrances.add(new Ent(p, f, BuiltInRegistries.BLOCK.getKey(s.getBlock()).toString()));
					}
				}
				long k = Sections.key(x >> 4, y >> 4, z >> 4);
				lastPlayer = Math.max(lastPlayer, ls.byPlayer.getOrDefault(k, 0L));
				cols.merge(BlockPos.asLong(x, 0, z), 1, Integer::sum);
			}
			// placers
			for (int i = 0; i < cells.size(); i++) {
				long p = cells.getLong(i);
				LevelChunk c = j.level.getChunkSource().getChunkNow(BlockPos.getX(p) >> 4, BlockPos.getZ(p) >> 4);
				PlacedChunk pc = c == null ? null : c.getAttached(Placed.TYPE);
				UUID u = pc == null ? PlacedChunk.NIL : pc.placer(placerIdx.get(i));
				placers.merge(u, 1, Integer::sum);
			}
			// the footprint: column runs per z (z, x0, x1, z, x0, x1, ...)
			List<Integer> fp = new ArrayList<>();
			for (int z = minZ; z <= maxZ; z++) {
				int run = Integer.MIN_VALUE;
				for (int x = minX; x <= maxX + 1; x++) {
					boolean in = x <= maxX && cols.containsKey(BlockPos.asLong(x, 0, z));
					if (in && run == Integer.MIN_VALUE) {
						run = x;
					} else if (!in && run != Integer.MIN_VALUE) {
						fp.add(z);
						fp.add(run);
						fp.add(x - 1);
						run = Integer.MIN_VALUE;
					}
				}
			}
			footprint = fp.stream().mapToInt(Integer::intValue).toArray();
			enclosure(j);
		}

		/** Air cells with a structural cell above within 6 and walls on 3 of 4 sides within 8 (bounded volume). */
		void enclosure(Job j) {
			long vol = (long) (maxX - minX + 1) * (maxY - minY + 1) * (maxZ - minZ + 1);
			if (vol > 262_144) {
				return;
			}
			BlockPos.MutableBlockPos m = new BlockPos.MutableBlockPos();
			LongOpenHashSet floor = new LongOpenHashSet();
			for (int y = minY; y <= maxY; y++) {
				for (int z = minZ; z <= maxZ; z++) {
					for (int x = minX; x <= maxX; x++) {
						long p = BlockPos.asLong(x, y, z);
						if (set.contains(p) || !j.level.getBlockState(m.set(x, y, z)).isAir()) {
							continue;
						}
						boolean roof = false;
						for (int d = 1; d <= 6 && !roof; d++) {
							roof = set.contains(BlockPos.asLong(x, y + d, z));
						}
						if (!roof) {
							continue;
						}
						int walls = 0;
						for (Direction dir : Direction.Plane.HORIZONTAL) {
							for (int d = 1; d <= 8; d++) {
								if (set.contains(BlockPos.asLong(x + dir.getStepX() * d, y, z + dir.getStepZ() * d))) {
									walls++;
									break;
								}
							}
						}
						if (walls >= 3) {
							enclosed++;
							floor.add(BlockPos.asLong(x, 0, z));
						}
					}
				}
			}
			enclosedFloor = floor.size();
		}
	}

	/** §4 promote: enough structural cells (fewer when half are non-natural), spanning 3 in two axes, and a qualifier. */
	static boolean promotes(Comp c) {
		int n = c.cells.size();
		int bar = c.nonNatural * 2 >= n ? rules.promoteNonNatural : rules.promote;
		return n >= bar && c.spans() >= 2 && c.qualifier();
	}

	/** §4 demote (hysteresis): below 20 structural cells, or below 48 with no qualifier left. */
	static boolean demotes(Comp c) {
		int n = c.cells.size();
		return n < rules.demote || n < rules.demoteNoQualifier && !c.qualifier();
	}

	/** §4 kind guess and confidence. */
	static void kind(Rec r, Comp c) {
		int n = c.cells.size();
		int fpCols = 0;
		for (int i = 0; i + 2 < c.footprint.length; i += 3) {
			fpCols += c.footprint[i + 2] - c.footprint[i + 1] + 1;
		}
		int xs = c.maxX - c.minX + 1;
		int zs = c.maxZ - c.minZ + 1;
		int ys = c.maxY - c.minY + 1;
		boolean enclosure = c.enclosed >= 8;
		BuildKind k;
		float conf;
		if (c.path * 2 > n) {
			k = BuildKind.PATH;
			conf = 0.6f + 0.4f * c.path / n;
		} else if (fpCols > 0 && c.farm * 2 > fpCols) {
			k = BuildKind.FARM;
			conf = Math.min(1f, 0.6f + 0.4f * c.farm / fpCols);
		} else if (enclosure && c.enclosedFloor > 200 && !c.bed) {
			k = BuildKind.BARN;
			conf = 0.7f;
		} else if (enclosure && !c.entrances.isEmpty() || c.bed) {
			k = BuildKind.HOUSE;
			conf = enclosure && !c.entrances.isEmpty() && c.bed ? 0.95f : enclosure && !c.entrances.isEmpty() ? 0.85f : 0.6f;
		} else if (ys >= 2 * Math.max(xs, zs)) {
			k = BuildKind.TOWER;
			conf = 0.7f;
		} else if (Math.min(xs, zs) <= 2 && Math.max(xs, zs) >= 8 && !enclosure) {
			k = BuildKind.WALL;
			conf = 0.8f;
		} else {
			k = BuildKind.OTHER;
			conf = 0.5f;
		}
		r.kind = k;
		r.confidence = Math.round(conf * 100) / 100f;
	}

	/** The index record from a component (bounds, footprint, entrances, kind, cells, placers); the revision bumped on any change. */
	static void fill(Rec r, Comp c, long now) {
		int[] b = {c.minX, c.minY, c.minZ, c.maxX, c.maxY, c.maxZ};
		BuildKind k0 = r.kind;
		float conf0 = r.confidence;
		kind(r, c);
		boolean diff = !java.util.Arrays.equals(b, r.bounds) || r.cells != c.cells.size() || !r.placers.equals(c.placers) || !java.util.Arrays.equals(
			r.footprint, c.footprint) || !r.entrances.equals(c.entrances) || k0 != r.kind || conf0 != r.confidence || r.partial != c.partial;
		r.bounds = b;
		r.footprint = c.footprint;
		r.entrances = new ArrayList<>(c.entrances);
		r.entrances.sort(Comparator.comparingLong(Ent::pos));
		r.cells = c.cells.size();
		r.placers = new LinkedHashMap<>(c.placers);
		r.partial = c.partial;
		r.lastPlayerChange = Math.max(r.lastPlayerChange, c.lastPlayer);
		if (diff || r.revision == 0) {
			r.revision++;
			r.lastChange = now;
			indexDirty = true;
		}
	}

	// ------------------------------------------------------------------ claim and release (§8)

	static Rec newClaim(String dimension, UUID placer, long now) {
		Rec r = newRec(dimension, now);
		r.state = BuildState.CLAIMED;
		r.claimedBy = placer;
		r.placers.put(placer, 0);
		return r;
	}

	/** A claim's cells marked: its index record from them (no promote bar), CLAIMED. */
	static void finishClaim(ServerLevel level, String id, Comp comp) {
		Rec r = RECS.get(id);
		if (r == null) {
			return;
		}
		long now = System.currentTimeMillis();
		if (comp.cells.isEmpty()) {
			r.cells = 0;
			r.revision++;
			indexDirty = true;
		} else {
			Job j = new Job(level, Long.MIN_VALUE, now);
			comp.stats(j, state(level));
			fill(r, comp, now);
		}
		r.state = BuildState.CLAIMED;
		r.demoteSince = 0;
		changed(r, "claimed");
		save(true);
	}

	static void release(Rec r) {
		r.state = BuildState.RELEASED;
		r.releasedCells = r.cells;
		r.demoteSince = 0;
		r.revision++;
		r.lastChange = System.currentTimeMillis();
		indexDirty = true;
		changed(r, "released");
		save(true);
	}

	static void gone(Rec r, String why) {
		if (r.gone) {
			return;
		}
		r.gone = true;
		r.revision++;
		r.lastChange = System.currentTimeMillis();
		indexDirty = true;
		changed(r, why);
	}

	/** Fires BUILD_CHANGED (server thread). Revisions not bumped are not changes. */
	static void changed(Rec r, String what) {
		if (what.equals("changed") && r.revision == r.lastFired) {
			return;
		}
		r.lastFired = r.revision;
		BuildViews.fire(r, what);
	}
}
