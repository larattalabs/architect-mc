package dev.larattalabs.architect.placed;

import static dev.larattalabs.architect.placed.PlacedRules.empty;
import static dev.larattalabs.architect.placed.PlacedRules.records;

import dev.larattalabs.architect.placed.PlacedRules.Kind;
import dev.larattalabs.architect.placed.PlacedRules.Use;

import com.mojang.serialization.Codec;
import dev.larattalabs.architect.Architect;
import dev.larattalabs.architect.journal.Pt;
import dev.larattalabs.architect.journal.SectionCells;
import dev.larattalabs.architect.journal.Sections;
import it.unimi.dsi.fastutil.longs.Long2ObjectOpenHashMap;
import it.unimi.dsi.fastutil.longs.LongArrayList;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Deque;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.function.LongPredicate;
import net.fabricmc.fabric.api.attachment.v1.AttachmentRegistry;
import net.fabricmc.fabric.api.attachment.v1.AttachmentType;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.nbt.CompoundTag;
import net.minecraft.resources.ResourceKey;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.tags.ItemTags;
import net.minecraft.world.item.BlockItem;
import net.minecraft.world.item.BucketItem;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.LiquidBlock;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.block.state.properties.BlockStateProperties;
import net.minecraft.world.level.block.state.properties.IntegerProperty;
import net.minecraft.world.level.block.state.properties.SlabType;
import net.minecraft.world.level.chunk.LevelChunk;
import net.minecraft.world.phys.BlockHitResult;
import net.minecraft.world.phys.HitResult;
import org.jspecify.annotations.Nullable;

/**
 * Player-placed tracking (docs/CONTRACT.md "Phase 6c slice PT"): the per-chunk set ({@link PlacedChunk}, the data attachment
 * {@code architect_mc:placed}), what records a cell (§2: a player's {@code useItemOn}/{@code useItem}, pistons, falling blocks) and
 * what clears it (§3: the cell becomes air or a fluid, another placement replaces it, or Architect writes it), the journal's
 * {@code pt} capture and restore (§5), and the single predicate every write path consults ({@link #build}, §7).
 *
 * <p>The scopes are the server thread's: a player's use of an item ({@link #beginUse}), Architect's own writes ({@link #set},
 * {@link #beginWrites}), a piston's move and a moving block settling, a falling block landing. Off the server thread a block
 * change only clears (a cell becoming air or a fluid).
 */
public final class Placed {
	private Placed() {
	}

	public static final Codec<PlacedChunk> CODEC = CompoundTag.CODEC.xmap(PlacedChunk::read, PlacedChunk::write);
	/** The attachment: persistent, never synced to clients. */
	public static final AttachmentType<PlacedChunk> TYPE = AttachmentRegistry.<PlacedChunk>builder().persistent(CODEC).buildAndRegister(Architect.id(
		"placed"));

	private static volatile @Nullable Thread serverThread;
	private static volatile @Nullable MinecraftServer server;

	public static void init() {
		// TYPE registers on class load
		Architect.LOGGER.debug("PT attachment {}", TYPE.identifier());
		net.fabricmc.fabric.api.event.lifecycle.v1.ServerLifecycleEvents.SERVER_STARTING.register(s -> {
			server = s;
			serverThread = Thread.currentThread();
			RESTORES.clear();
		});
		net.fabricmc.fabric.api.event.lifecycle.v1.ServerLifecycleEvents.SERVER_STOPPED.register(s -> {
			server = null;
			RESTORES.clear();
			USES.clear();
			writePos = Long.MIN_VALUE;
			writeBoxes.clear();
		});
		dev.larattalabs.architect.journal.JournalStore.ptSource = Placed::annotate;
		Builds.init();
	}

	public static boolean on() {
		return TrackingRule.on;
	}

	public static @Nullable MinecraftServer server() {
		return server;
	}

	private static boolean onServerThread() {
		return Thread.currentThread() == serverThread;
	}

	// ------------------------------------------------------------------ scopes

	private static final Deque<@Nullable Use> USES = new ArrayDeque<>();
	private static @Nullable Use use;

	/** {@code ServerPlayerGameMode.useItemOn}/{@code useItem} HEAD; always paired with {@link #endUse}. {@code hit}: null for useItem. */
	public static void beginUse(ServerPlayer p, Level level, ItemStack stack, @Nullable BlockHitResult hit) {
		USES.push(use == null ? NONE_USE : use);
		if (!(level instanceof ServerLevel sl) || !TrackingRule.on) {
			use = null;
			return;
		}
		Kind k = stack.getItem() instanceof BlockItem ? Kind.BLOCK : stack.getItem() instanceof BucketItem ? Kind.BUCKET
			: stack.is(ItemTags.HOES) || stack.is(ItemTags.SHOVELS) || stack.is(ItemTags.AXES) ? Kind.TOOL : Kind.NONE;
		BlockPos click = null;
		Direction face = null;
		if (hit != null) {
			click = hit.getBlockPos();
			face = hit.getDirection();
		} else if (k != Kind.NONE) {
			HitResult h = p.pick(p.blockInteractionRange(), 1f, true);
			if (h instanceof BlockHitResult b && h.getType() == HitResult.Type.BLOCK) {
				click = b.getBlockPos();
				face = b.getDirection();
			}
		}
		use = new Use(sl, p.getUUID(), k, click, face);
	}

	private static final Use NONE_USE = new Use(null, PlacedChunk.NIL, Kind.NONE, null, null);

	public static void endUse() {
		Use prev = USES.isEmpty() ? null : USES.pop();
		use = prev == NONE_USE ? null : prev;
	}

	/** Architect writes: the position being written now (Long.MIN_VALUE: none) and the boxes of a template write. */
	private static long writePos = Long.MIN_VALUE;
	private static final List<LongPredicate> writeBoxes = new ArrayList<>();

	/** An Architect write of one cell ({@code level.setBlock}): the cell's record is cleared, or restored by an undo (§3, §5). */
	public static boolean set(Level level, BlockPos pos, BlockState state, int flags) {
		long prev = writePos;
		writePos = pos.asLong();
		try {
			return level.setBlock(pos, state, flags);
		} finally {
			writePos = prev;
		}
	}

	/** Architect writes through vanilla code (a structure template's placement): every cell {@code box} holds. Paired with {@link #endWrites}. */
	public static void beginWrites(LongPredicate box) {
		writeBoxes.add(box);
	}

	public static void endWrites() {
		if (!writeBoxes.isEmpty()) {
			writeBoxes.remove(writeBoxes.size() - 1);
		}
	}

	private static boolean architectWrites(long pos) {
		if (writePos == pos) {
			return true;
		}
		for (int i = writeBoxes.size() - 1; i >= 0; i--) {
			if (writeBoxes.get(i).test(pos)) {
				return true;
			}
		}
		return false;
	}

	// pistons (§2): the moved blocks carry their records on the moving block entity
	private static @Nullable Level pistonLevel;
	private static final LongArrayList pistonDests = new LongArrayList();

	public static void beginPiston(Level level) {
		pistonLevel = level instanceof ServerLevel ? level : null;
		pistonDests.clear();
	}

	/** {@code MovingPistonBlock.newMovingBlockEntity} RETURN inside a piston's move: the moved block's record goes with it. */
	public static void movingEntity(net.minecraft.world.level.block.entity.BlockEntity be) {
		Level level = pistonLevel;
		if (level == null || !(be instanceof net.minecraft.world.level.block.piston.PistonMovingBlockEntity m) || m.isSourcePiston()
			|| !(be instanceof Carrier c)) {
			return;
		}
		BlockPos dest = m.getBlockPos();
		BlockPos src = dest.relative(m.getMovementDirection().getOpposite());
		c.architect$setPlaced(record(level, src));
		pistonDests.add(dest.asLong());
	}

	public static void endPiston() {
		Level level = pistonLevel;
		pistonLevel = null;
		if (level == null) {
			return;
		}
		// the destinations hold moving blocks now: their old records (the blocks pushed on from there) are stale
		for (int i = 0; i < pistonDests.size(); i++) {
			BlockPos p = BlockPos.of(pistonDests.getLong(i));
			if (level.getBlockState(p).is(Blocks.MOVING_PISTON)) {
				clear(level, p);
			}
		}
		pistonDests.clear();
	}

	/** A block entity or entity that carries a record (the moving piston block, the falling block). */
	public interface Carrier {
		@Nullable Rec architect$placed();

		void architect$setPlaced(@Nullable Rec p);
	}

	/** A record outside the set: the placer and its build id (null: incidental). */
	public record Rec(UUID placer, @Nullable String build) {
		public CompoundTag toNbt() {
			CompoundTag t = new CompoundTag();
			t.putIntArray("placer", PlacedChunk.uuidInts(placer));
			if (build != null) {
				t.putString("build", build);
			}
			return t;
		}

		public static @Nullable Rec fromNbt(@Nullable CompoundTag t) {
			if (t == null) {
				return null;
			}
			int[] a = t.getIntArray("placer").orElse(null);
			if (a == null || a.length != 4) {
				return null;
			}
			String b = t.getStringOr("build", "");
			return new Rec(PlacedChunk.uuid(a), b.isEmpty() ? null : b);
		}
	}

	// a moving block settling (PistonMovingBlockEntity.tick / finalTick) or a falling block landing
	private static @Nullable Level settleLevel;
	private static long settlePos = Long.MIN_VALUE;
	private static @Nullable Rec settleRec;
	private static @Nullable Level landLevel;
	private static @Nullable Rec landRec;

	public static void beginSettle(@Nullable Level level, BlockPos pos, @Nullable Rec rec) {
		settleLevel = level instanceof ServerLevel ? level : null;
		settlePos = pos.asLong();
		settleRec = rec;
	}

	public static void endSettle() {
		settleLevel = null;
		settlePos = Long.MIN_VALUE;
		settleRec = null;
	}

	public static void beginLand(Level level, @Nullable Rec rec) {
		landLevel = level instanceof ServerLevel && rec != null ? level : null;
		landRec = rec;
	}

	public static void endLand() {
		landLevel = null;
		landRec = null;
	}

	/** End of every server tick: a scope an exception left open is closed (and logged) so it can't record later changes. */
	static void tickEnd() {
		if (use != null || !USES.isEmpty() || writePos != Long.MIN_VALUE || !writeBoxes.isEmpty() || !RESTORES.isEmpty() || pistonLevel != null
			|| settleLevel != null || landLevel != null) {
			Architect.LOGGER.warn("PT: a tracking scope was left open at the end of a tick (an exception mid-use?); closed");
			use = null;
			USES.clear();
			writePos = Long.MIN_VALUE;
			writeBoxes.clear();
			RESTORES.clear();
			pistonLevel = null;
			pistonDests.clear();
			endSettle();
			endLand();
		}
	}

	// ------------------------------------------------------------------ the hook

	/** {@code LevelChunk.setBlockState} RETURN: a block changed from {@code old} to {@code now}. */
	public static void changed(LevelChunk chunk, BlockPos pos, BlockState old, BlockState now) {
		if (!TrackingRule.on || old == now || !(chunk.getLevel() instanceof ServerLevel level)) {
			return;
		}
		if (!onServerThread()) {
			if (empty(now) && chunk.getAttached(TYPE) != null) {
				clear(chunk, pos);
			}
			return;
		}
		long p = pos.asLong();
		// Architect's own writes never record: they clear, or an undo restores the record it took (§3, §5)
		if (architectWrites(p)) {
			Expect e = RESTORES.isEmpty() ? null : restoring(p);
			if (e != null && !empty(now) && now.getBlock() == e.block) {
				put(chunk, pos, e.pt.placer(), e.pt.build(), false);
			} else {
				clear(chunk, pos);
			}
			return;
		}
		if (settleLevel == level && settlePos == p) {
			if (!now.is(Blocks.MOVING_PISTON)) {
				if (settleRec != null && !empty(now)) {
					put(chunk, pos, settleRec.placer(), settleRec.build(), false);
				} else {
					clear(chunk, pos);
				}
			}
			return;
		}
		if (landLevel == level && !empty(now) && (empty(old) || old.canBeReplaced()) && landRec != null) {
			put(chunk, pos, landRec.placer(), landRec.build(), false);
			landRec = null; // one cell per landing
			return;
		}
		Use u = use;
		if (u != null && u.level() == level && u.kind() != Kind.NONE && records(u, pos, old, now)) {
			put(chunk, pos, u.placer(), null, true);
			return;
		}
		if (empty(now)) {
			clear(chunk, pos);
		}
		// a cell that stays a block keeps its record (§3: weathering, grass on placed dirt, crops growing, waterlogging)
	}

	// ------------------------------------------------------------------ the set

	static @Nullable LevelChunk loadedChunk(Level level, int x, int z) {
		if (level instanceof ServerLevel sl) {
			return sl.getChunkSource().getChunkNow(x >> 4, z >> 4);
		}
		return null;
	}

	static void put(LevelChunk chunk, BlockPos pos, UUID placer, @Nullable String build, boolean byPlayer) {
		PlacedChunk pc = chunk.getAttached(TYPE);
		if (pc == null) {
			pc = new PlacedChunk();
			chunk.setAttached(TYPE, pc);
		}
		int v = PlacedChunk.value(pc.placerIndex(placer), pc.buildIndex(build));
		if (pc.put(pos.getX(), pos.getY(), pos.getZ(), v)) {
			chunk.markUnsaved();
			Builds.touched((ServerLevel) chunk.getLevel(), pos, byPlayer);
		}
	}

	static void clear(LevelChunk chunk, BlockPos pos) {
		PlacedChunk pc = chunk.getAttached(TYPE);
		if (pc == null) {
			return;
		}
		int old = pc.remove(pos.getX(), pos.getY(), pos.getZ());
		if (old >= 0) {
			if (pc.isEmpty()) {
				chunk.removeAttached(TYPE);
			}
			chunk.markUnsaved();
			Builds.touched((ServerLevel) chunk.getLevel(), pos, false);
		}
	}

	static void clear(Level level, BlockPos pos) {
		LevelChunk c = loadedChunk(level, pos.getX(), pos.getZ());
		if (c != null) {
			clear(c, pos);
		}
	}

	/** Sets a tracked cell's build (index) without touching its placer; no-op when untracked. Classifier only. */
	static boolean setBuild(LevelChunk chunk, int x, int y, int z, @Nullable String build) {
		PlacedChunk pc = chunk.getAttached(TYPE);
		if (pc == null) {
			return false;
		}
		if (pc.setBuild(x, y, z, pc.buildIndex(build))) {
			chunk.markUnsaved();
			return true;
		}
		return false;
	}

	/** Marks a cell as {@code placer}'s with no play scope (a claim, §8): a tracked cell keeps its own placer. */
	static void mark(LevelChunk chunk, BlockPos pos, UUID placer, @Nullable String build) {
		PlacedChunk pc = chunk.getAttached(TYPE);
		int cur = pc == null ? -1 : pc.get(pos.getX(), pos.getY(), pos.getZ());
		if (cur >= 0) {
			setBuild(chunk, pos.getX(), pos.getY(), pos.getZ(), build);
			return;
		}
		put(chunk, pos, placer, build, false);
	}

	// ------------------------------------------------------------------ queries

	/** The cell's record, or null when it is not tracked (or its chunk is not loaded). */
	public static @Nullable Rec record(Level level, BlockPos pos) {
		LevelChunk c = loadedChunk(level, pos.getX(), pos.getZ());
		return c == null ? null : record(c, pos.getX(), pos.getY(), pos.getZ());
	}

	public static @Nullable Rec record(LevelChunk c, int x, int y, int z) {
		PlacedChunk pc = c.getAttached(TYPE);
		if (pc == null) {
			return null;
		}
		int v = pc.get(x, y, z);
		if (v < 0) {
			return null;
		}
		return new Rec(pc.placer(PlacedChunk.placerOf(v)), Builds.resolve(pc.build(PlacedChunk.buildOf(v))));
	}

	/**
	 * <b>The single predicate</b> (§7): the id of the build the cell belongs to when that build is kept (ACTIVE, CLAIMED or
	 * PROVISIONAL), else null: not tracked, incidental, or in a RELEASED build. Tracking off (the world rule): always null.
	 */
	public static @Nullable String build(Level level, @Nullable LevelChunk chunk, BlockPos pos) {
		return build(level, chunk, pos.getX(), pos.getY(), pos.getZ());
	}

	public static @Nullable String build(Level level, @Nullable LevelChunk chunk, int x, int y, int z) {
		if (!TrackingRule.on) {
			return null;
		}
		LevelChunk c = chunk != null && chunk.getPos().x() == x >> 4 && chunk.getPos().z() == z >> 4 ? chunk : loadedChunk(level, x, z);
		if (c == null) {
			return null;
		}
		PlacedChunk pc = c.getAttached(TYPE);
		if (pc == null) {
			return null;
		}
		int v = pc.get(x, y, z);
		if (v < 0) {
			return null;
		}
		String id = pc.build(PlacedChunk.buildOf(v));
		return id == null ? null : Builds.kept(id);
	}

	/**
	 * §7 "incidental cells are natural": the cell is tracked and in no kept build, or in a build {@code consent} names: a write may
	 * take it as natural terrain (IF_NATURAL, fits, naturalOnly), whatever its voxel class. Its block entity keeps its own rules.
	 */
	public static boolean naturalForWrites(Level level, @Nullable LevelChunk chunk, int x, int y, int z, Consent consent) {
		if (!TrackingRule.on) {
			return false;
		}
		LevelChunk c = chunk != null && chunk.getPos().x() == x >> 4 && chunk.getPos().z() == z >> 4 ? chunk : loadedChunk(level, x, z);
		PlacedChunk pc = c == null ? null : c.getAttached(TYPE);
		if (pc == null) {
			return false;
		}
		int v = pc.get(x, y, z);
		if (v < 0) {
			return false;
		}
		String id = pc.build(PlacedChunk.buildOf(v));
		String kept = id == null ? null : Builds.kept(id);
		return kept == null || consent.allows(kept);
	}

	/** {@link #build} by packed position (no chunk at hand). */
	public static @Nullable String build(Level level, long pos) {
		return build(level, null, BlockPos.getX(pos), BlockPos.getY(pos), BlockPos.getZ(pos));
	}

	/** Whether the cell is in a kept build that {@code consent} does not name (the write must skip or refuse it). */
	public static @Nullable String blocks(Level level, long pos, @Nullable Consent consent) {
		String b = build(level, pos);
		return b == null || consent != null && consent.allows(b) ? null : b;
	}

	/**
	 * A request's consent, checked (§6): the builds it names explicitly whose actor is one of their placers (at least 10% of the
	 * cells) or an op. Built once per request ({@link Builds#consent}).
	 */
	public record Consent(java.util.Set<String> allowed) {
		public boolean allows(String buildId) {
			return allowed.contains(buildId) || allowed.contains(Builds.resolve(buildId));
		}

		public static final Consent NONE = new Consent(java.util.Set.of());
	}

	// a request's consent while its checks run (server thread): the API entry points and batch items set it around their checks
	private static final Deque<Consent> CONSENTS = new ArrayDeque<>();

	/** Runs {@code r} with {@code c} as the consent its checks see ({@link #consentNow}). */
	public static <T> T withConsent(@Nullable Consent c, java.util.function.Supplier<T> r) {
		CONSENTS.push(c == null ? Consent.NONE : c);
		try {
			return r.get();
		} finally {
			CONSENTS.pop();
		}
	}

	/** {@link #withConsent} for code that throws a checked exception. */
	public interface Body<T, E extends Exception> {
		T run() throws E;
	}

	public static <T, E extends Exception> T withConsentE(@Nullable Consent c, Body<T, E> r) throws E {
		CONSENTS.push(c == null ? Consent.NONE : c);
		try {
			return r.run();
		} finally {
			CONSENTS.pop();
		}
	}

	/** The consent of the request whose checks run now (none outside a request). */
	public static Consent consentNow() {
		Consent c = CONSENTS.peek();
		return c == null ? Consent.NONE : c;
	}

	// ------------------------------------------------------------------ the journal (§5)

	/**
	 * {@code JournalStore.Txn.create} (a new entry, committed before its blocks are written): each cell's current record goes
	 * into its {@code pt}. Server thread; a cell in an unloaded chunk carries none.
	 */
	static List<SectionCells> annotate(String dimension, Collection<SectionCells> cells) {
		MinecraftServer s = server;
		if (s == null || !TrackingRule.on || !onServerThread()) {
			return cells instanceof List<SectionCells> l ? l : new ArrayList<>(cells);
		}
		ServerLevel level = dev.larattalabs.architect.site.Sites.levelOf(s, dimension);
		List<SectionCells> out = new ArrayList<>(cells.size());
		for (SectionCells sc : cells) {
			out.add(level == null ? sc : annotate(level, sc));
		}
		return out;
	}

	/** One section's cells with the current records of their positions (the cells' befores are the world now). */
	public static SectionCells annotate(ServerLevel level, SectionCells sc) {
		int sx = Sections.sx(sc.key);
		int sz = Sections.sz(sc.key);
		LevelChunk c = level.getChunkSource().getChunkNow(sx, sz);
		PlacedChunk pc = c == null ? null : c.getAttached(TYPE);
		if (pc == null) {
			return sc.hasPt() ? sc.withPt(null) : sc;
		}
		Pt[] pt = new Pt[sc.size()];
		boolean any = false;
		for (int k = 0; k < sc.size(); k++) {
			long p = sc.pos(k);
			int v = pc.get(BlockPos.getX(p), BlockPos.getY(p), BlockPos.getZ(p));
			if (v >= 0) {
				pt[k] = new Pt(pc.placer(PlacedChunk.placerOf(v)), pc.build(PlacedChunk.buildOf(v)));
				any = true;
			}
		}
		return any || sc.hasPt() ? sc.withPt(any ? pt : null) : sc;
	}

	/** An undo's write of a cell whose before had a record: the block it puts back and that block's record. */
	public record Expect(Block block, Pt pt) {
	}

	private static final List<Long2ObjectOpenHashMap<Expect>> RESTORES = new ArrayList<>();

	/**
	 * An undo writing (§5): while its writes run, a cell in {@code pts} that gets its block back gets its record back too. A cell
	 * StillOurs leaves alone is never written and keeps its current record. Paired with {@link #endRestore}; server thread.
	 */
	public static void beginRestore(Long2ObjectOpenHashMap<Expect> pts) {
		RESTORES.add(pts);
	}

	public static void endRestore() {
		if (!RESTORES.isEmpty()) {
			RESTORES.remove(RESTORES.size() - 1);
		}
	}

	private static @Nullable Expect restoring(long pos) {
		for (int i = RESTORES.size() - 1; i >= 0; i--) {
			Expect e = RESTORES.get(i).get(pos);
			if (e != null) {
				return e;
			}
		}
		return null;
	}
}
