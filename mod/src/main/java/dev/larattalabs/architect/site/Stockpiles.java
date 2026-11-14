package dev.larattalabs.architect.site;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.larattalabs.architect.Architect;
import dev.larattalabs.architect.api.ProtectedArea;
import dev.larattalabs.architect.api.Reason;
import dev.larattalabs.architect.batch.QBatch;
import dev.larattalabs.architect.journal.JournalStore;
import dev.larattalabs.architect.journal.WorldJournal;
import dev.larattalabs.architect.survival.CrateBlockEntity;
import dev.larattalabs.architect.survival.CrateBlocks;
import dev.larattalabs.architect.survival.Equivalents;
import dev.larattalabs.architect.survival.Ledger;
import dev.larattalabs.architect.survival.StockLedger;
import dev.larattalabs.architect.survival.SurvivalItems;
import dev.larattalabs.architect.survival.SurvivalWorld;
import dev.larattalabs.architect.survival.WaitCalc;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.concurrent.ConcurrentHashMap;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerLifecycleEvents;
import net.minecraft.core.BlockPos;
import net.minecraft.nbt.NbtUtils;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.item.Item;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.block.entity.BlockEntity;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.storage.LevelResource;
import org.jspecify.annotations.Nullable;

/**
 * Settlement stockpiles (docs/CONTRACT.md phase 6c slice Y, C24; Y1): one per owner, a ledger with block inlets. Every new
 * construction item of an owner that has one (batch buildings and roads, standalone construction roads, construction deltas)
 * draws from it and places no crate of its own: its {@link Construction#crate()} is null. Such a target is fed by one loop per
 * owner, in feed order with reservations ({@link FeedOrder}); refunds of its deconstruct, undo and deltas are credited back into
 * the stockpile once per key ({@link StockLedger#credit}).
 *
 * <p>The crates are {@code architect_mc:construction_crate} blocks whose block entity carries {@code stockpile:<owner>}; each has
 * its own journal entry under that id, outside every group and site undo. The ledger is the owner's, not the blocks':
 * {@code <world>/architect/stockpiles.json} (a temp file, then a rename), written in the world-save callback that saves the
 * chunks (autosave and stop), and on crate and feed-order changes. Server thread.
 */
public final class Stockpiles {
	/** The prefix of a stockpile crate's owner id in its block entity (never a site id, never {@code group:}). */
	public static final String PREFIX = "stockpile:";
	public static final String FILE = "stockpiles.json";
	/** At most this many crates per stockpile ({@code Limits.STOCKPILE_CRATES}). */
	public static final int MAX_CRATES = 16;
	/** STOCKPILE_CHANGED at most once per this many ticks per owner. */
	static final int EVENT_TICKS = 20;
	private static final Gson GSON = new GsonBuilder().setPrettyPrinting().disableHtmlEscaping().create();

	/** By stockpile id. */
	private static final Map<String, Pile> PILES = new LinkedHashMap<>();
	/** The next stockpile id's number (saved with the file). */
	private static long nextId = 1;
	private static @Nullable Path dir;
	private static long ticks;
	private static final Map<String, Integer> MAX_STACK = new ConcurrentHashMap<>();
	/** Dev hook: log every save of the file (the clean-stop check). */
	static volatile int saves;
	/**
	 * (PS, F11) The file's format. 2 since PS: the same fields as 1 (JR's {@code paid} and {@code legacy}, RL's {@code books} additively),
	 * bumped so a later reader can tell a file with JR's paid records from an older one. A format 1 file is read as before (converted
	 * at its next save); a newer one is refused (loadFailed).
	 */
	static final int FORMAT = 2;
	/** (PS, F4 b) A changed ledger is saved with the world (players, chunks, ledger) at most this often: 10 s (Noah, "safety: defaults"). */
	static final int PERIODIC_TICKS = 200;
	/** (PS) The tick of the last ledger save (any: autosave, explicit, periodic). */
	private static long lastSaveTick;
	/**
	 * (PS, F6) The file could not be read (or is newer than this reader): nothing was loaded and nothing is saved for this session, so
	 * the file stays as it is for the player to fix or restore ({@code stockpiles.json.bak} is the last file that loaded).
	 */
	private static volatile boolean loadFailed;
	private static volatile @Nullable String loadFailedWhy;
	/** (PS, dev) the periodic saves: count, last and max time (ms), the recent times for a median. */
	static volatile int periodicSaves;
	static volatile double lastPeriodicMs, maxPeriodicMs;
	static final java.util.ArrayDeque<Double> PERIODIC_MS = new java.util.ArrayDeque<>();
	/** (PS, TEST) the gate's before-the-fix cases: the periodic save off; a finished undo's refund not saved at its credit. */
	static volatile boolean testNoPeriodic, testNoCreditSave;
	/** (RL, TEST) RL's save when a target joins the feed off: set with {@code noPeriodic}, unless {@code joinSave} says otherwise. */
	static volatile boolean testNoJoinSave;
	/** (PS) the next saveWithWorld is the periodic one (not logged at INFO). Server thread. */
	private static boolean quietSave;

	private Stockpiles() {
	}

	/** One crate of a stockpile: its cell, what the cell held before (put back when it goes) and its journal entry. */
	record CrateRec(int x, int y, int z, String snapshotState, @Nullable String snapshotNbt, @Nullable String entry) {
		BlockPos pos() {
			return new BlockPos(x, y, z);
		}

		Construction.Crate asCrate() {
			return new Construction.Crate(x, y, z, snapshotState, snapshotNbt);
		}

		JsonObject toJson() {
			JsonObject o = asCrate().toJson();
			if (entry != null) {
				o.addProperty("entry", entry);
			}
			return o;
		}

		static CrateRec fromJson(JsonObject o) {
			Construction.Crate c = Construction.Crate.fromJson(o);
			return new CrateRec(c.x(), c.y(), c.z(), c.snapshotState(), c.snapshotNbt(), o.has("entry") ? o.get("entry").getAsString() : null);
		}
	}

	/** One owner's stockpile. */
	public static final class Pile {
		/** The stockpile's own id ({@code sp<n>}): its key in the file, its crates' and journal entries' owner id ({@code stockpile:<id>}). */
		final String id;
		/** Who owns it: an attribute, never part of a key (owners may change hands later: a re-key changes no format). */
		final String owner;
		final String dimension;
		final List<CrateRec> crates = new ArrayList<>();
		final StockLedger ledger;
		/** Target ids (sites, roads, delta sites), first fed first. */
		final List<String> order = new ArrayList<>();
		/** C25's saved waits (slice Y2): kept as they are. */
		JsonObject waits = new JsonObject();
		boolean dirty;
		/** (RL) A target joined the feed this pass: the ledger is saved after it. */
		boolean joined;
		long lastEvent = Long.MIN_VALUE / 2;

		Pile(String id, String owner, String dimension, StockLedger ledger) {
			this.id = id;
			this.owner = owner;
			this.dimension = dimension;
			this.ledger = ledger;
		}

		public String id() {
			return id;
		}

		public String owner() {
			return owner;
		}

		public String dimension() {
			return dimension;
		}

		public StockLedger ledger() {
			return ledger;
		}

		public List<BlockPos> crates() {
			return crates.stream().map(CrateRec::pos).toList();
		}

		public List<String> order() {
			return List.copyOf(order);
		}

		String crateOwner() {
			return PREFIX + id;
		}

		JsonObject toJson() {
			JsonObject o = new JsonObject();
			o.addProperty("id", id);
			o.addProperty("owner", owner);
			o.addProperty("dimension", dimension);
			JsonArray c = new JsonArray();
			crates.forEach(x -> c.add(x.toJson()));
			o.add("crates", c);
			o.add("ledger", ledger.toJson());
			JsonArray f = new JsonArray();
			order.forEach(f::add);
			o.add("feedOrder", f);
			o.add("waits", waits.deepCopy());
			return o;
		}

		static Pile fromJson(JsonObject o) {
			// a file written before stockpiles had their own id (pre-release Y1 builds): one is assigned at load
			Pile p = new Pile(o.has("id") ? o.get("id").getAsString() : "sp" + nextId++, o.get("owner").getAsString(), o.get("dimension").getAsString(), StockLedger.fromJson(o.has("ledger") ? o.getAsJsonObject(
				"ledger") : null));
			if (o.has("crates")) {
				o.getAsJsonArray("crates").forEach(e -> p.crates.add(CrateRec.fromJson(e.getAsJsonObject())));
			}
			if (o.has("feedOrder")) {
				o.getAsJsonArray("feedOrder").forEach(e -> p.order.add(e.getAsString()));
			}
			if (o.has("waits") && o.get("waits").isJsonObject()) {
				p.waits = o.getAsJsonObject("waits");
			}
			return p;
		}
	}

	static void init() {
		ServerLifecycleEvents.SERVER_STARTED.register(Stockpiles::load);
		// C25 (Y2's seam): a stockpile's target waits on what its place in the feed order leaves it (stock - reserved); a crate-less
		// target of an owner with no stockpile (dissolved) has nothing; any other target reads its own or its group's crate
		SiteWaits.source((srv, level, target) -> {
			Pile p = pileOf(target);
			if (p != null) {
				return new SiteWaits.Supply() {
					Map<String, Integer> avail;

					@Override
					public int available(String item) {
						if (avail == null) {
							avail = availableTo(srv, target.id());
						}
						return avail.getOrDefault(item, 0);
					}

					@Override
					public long version() {
						return 31L * p.ledger.stock().hashCode() + 17L * p.order.hashCode() + LAST_RESERVED.getOrDefault(p.id, Map.of()).hashCode();
					}
				};
			}
			Construction c = target.construction();
			if (c != null && c.crate() == null && target.owner() != null) {
				return new SiteWaits.Supply() {
					@Override
					public int available(String item) {
						return 0;
					}

					@Override
					public long version() {
						return 0;
					}
				};
			}
			CrateBlockEntity crate = Builder.crate(level, target, false);
			if (crate == null) {
				return null;
			}
			Ledger ledger = crate.ledger();
			return new SiteWaits.Supply() {
				@Override
				public int available(String item) {
					return ledger.stock(item);
				}

				@Override
				public long version() {
					return ledger.stock().hashCode();
				}
			};
		});
		// the world-save callback that saves the chunks (autosave and stop): the ledger and the chunks are saved together
		ServerLifecycleEvents.BEFORE_SAVE.register((server, flush, force) -> {
			if (!explicitSave) { // (HF) an explicit save writes the ledger itself, after the chunks are on disk
				save();
			}
		});
		// (HF, F9) a logout saves that player (PlayerList.remove): a ledger change not saved yet (a deposit, a Take) is saved with the world
		// right after it, so a crash then never finds the player saved and the ledger rewound. Queued: it runs after the removal's save.
		net.fabricmc.fabric.api.networking.v1.ServerPlayConnectionEvents.DISCONNECT.register((handler, server) -> server.execute(() -> {
			if (unsaved && server.isRunning()) {
				saveWithWorld(server);
			}
		}));
		// a clean stop: the ticks have ended; saved again here in case the stop's chunk save doesn't run BEFORE_SAVE (logged with the trace)
		ServerLifecycleEvents.SERVER_STOPPING.register(server -> {
			if (TRACE_SAVES) {
				Architect.LOGGER.info("Stockpiles: world stopping, saving");
			}
			save();
		});
		ServerLifecycleEvents.SERVER_STOPPED.register(s -> {
			SERVER = null;
			PILES.clear();
			dir = null;
			ticks = 0;
			lastSaveTick = 0;
		});
		SaveGuards.init();
	}

	// ------------------------------------------------------------------ lookups

	public static @Nullable Pile get(@Nullable String owner) {
		if (owner == null) {
			return null;
		}
		for (Pile p : PILES.values()) {
			if (owner.equals(p.owner)) {
				return p;
			}
		}
		return null;
	}

	/** A stockpile by its own id. */
	public static @Nullable Pile byId(@Nullable String id) {
		return id == null ? null : PILES.get(id);
	}

	/** {@code stockpile:<id>} (a crate's owner id), or (dev hooks) {@code stockpile:<owner>}: the stockpile it names. */
	public static @Nullable Pile named(String ref) {
		String x = ref.startsWith(PREFIX) ? ref.substring(PREFIX.length()) : ref;
		Pile p = byId(x);
		return p != null ? p : get(x);
	}

	public static boolean has(@Nullable String owner) {
		return get(owner) != null;
	}

	public static List<Pile> all() {
		return List.copyOf(PILES.values());
	}

	/** The stockpile a construction site draws from: its owner's, when its construction has no crate of its own. */
	static @Nullable Pile pileOf(Site s) {
		Construction c = s.construction();
		if (c == null || c.crate() != null) {
			return null;
		}
		Pile p = get(s.owner());
		return p != null && p.dimension.equals(s.dimension()) ? p : null;
	}

	static @Nullable Pile pileOf(Infra i) {
		Construction c = i.construction();
		if (c == null || c.crate() != null) {
			return null;
		}
		Pile p = get(i.owner());
		return p != null && p.dimension.equals(i.dimension()) ? p : null;
	}

	/** Whether a building site is fed by a stockpile (the owner loop, not {@link Builder#tick}). */
	static boolean fed(Site s) {
		return s.building() && pileOf(s) != null;
	}

	static boolean fed(Infra i) {
		return i.building() && pileOf(i) != null;
	}

	/** Whether a construction site or road draws from a stockpile, or would (a crate-less construction of an owner). */
	static boolean crateless(@Nullable Construction c) {
		return c != null && c.crate() == null;
	}

	/** Whether new construction items of {@code owner} in {@code dimension} draw from a stockpile. */
	public static boolean drawsFrom(@Nullable String owner, String dimension) {
		Pile p = get(owner);
		return p != null && p.dimension.equals(dimension);
	}

	/** The refusal for a construction item of an owner whose stockpile is in another dimension (S-Y-6), or null. */
	public static @Nullable String dimensionRefusal(@Nullable String owner, String dimension) {
		Pile p = get(owner);
		return p != null && !p.dimension.equals(dimension) ? "the owner's stockpile is in " + p.dimension : null;
	}

	static int maxStack(String item) {
		return MAX_STACK.computeIfAbsent(item, id -> {
			Item it = Cells.item(id);
			try {
				return it == null ? 64 : new ItemStack(it).getMaxStackSize();
			} catch (RuntimeException e) {
				return 64; // (unit tests: the item components are not bound)
			}
		});
	}

	// ------------------------------------------------------------------ crates

	/** The crates whose block is there now (a crate in an unloaded chunk counts as present: nothing says it went). */
	static List<CrateRec> present(MinecraftServer srv, Pile p) {
		ServerLevel level = Sites.levelOf(srv, p.dimension);
		List<CrateRec> out = new ArrayList<>();
		for (CrateRec c : p.crates) {
			// read without a chunk ticket (Builder.entityIfLoaded): the crates' chunks unload like any other
			if (level == null || !level.isLoaded(c.pos()) || Builder.entityIfLoaded(level, c.pos()) instanceof CrateBlockEntity be && p.crateOwner().equals(be
				.siteId())) {
				out.add(c);
			}
		}
		return out;
	}

	static List<BlockPos> missing(MinecraftServer srv, Pile p) {
		List<CrateRec> pr = present(srv, p);
		return p.crates.stream().filter(c -> !pr.contains(c)).map(CrateRec::pos).toList();
	}

	static int capacity(MinecraftServer srv, Pile p) {
		return StockLedger.STACKS_PER_CRATE * present(srv, p).size();
	}

	/** Where a stockpile's overflow and drops go: above its first present crate, else {@code fallback}. */
	static BlockPos dropAt(MinecraftServer srv, Pile p, BlockPos fallback) {
		List<CrateRec> pr = present(srv, p);
		return pr.isEmpty() ? fallback : pr.get(0).pos().above();
	}

	// ------------------------------------------------------------------ API: create, crates, dissolve

	static void requireOwner(@Nullable String owner) throws Sites.SiteException {
		if (owner == null || owner.isBlank() || owner.indexOf(':') <= 0) {
			throw new Sites.SiteException(Reason.FIELD_LIMIT, "a stockpile needs an owner <modid>:<thing> (got " + owner + ")");
		}
	}

	/** {@code createStockpile}: idempotent per owner; adds the named crates that aren't crates of it yet. Server thread. */
	public static Pile create(MinecraftServer srv, String owner, String dimension, List<BlockPos> crates) throws Sites.SiteException {
		requireOwner(owner);
		requireLoaded();
		if (!SurvivalWorld.on()) {
			throw new Sites.SiteException(Reason.NOT_ALLOWED, "a stockpile needs the survival toggle on (instant placements use none)");
		}
		Pile p = get(owner);
		if (p != null && !p.dimension.equals(dimension)) {
			throw new Sites.SiteException(Reason.NOT_ALLOWED, "the stockpile of " + owner + " is in " + p.dimension + " (one dimension per stockpile)");
		}
		ServerLevel level = Sites.levelOf(srv, dimension);
		if (level == null) {
			throw new Sites.SiteException(Reason.NOT_LOADED, dimension + " is not loaded");
		}
		List<BlockPos> add = new ArrayList<>();
		for (BlockPos c : crates == null ? List.<BlockPos>of() : crates) {
			if ((p == null || p.crates.stream().noneMatch(x -> x.pos().equals(c))) && !add.contains(c)) {
				add.add(c.immutable());
			}
		}
		int have = p == null ? 0 : p.crates.size();
		if (have + add.size() > MAX_CRATES) {
			throw new Sites.SiteException(Reason.FIELD_LIMIT, "crates: " + (have + add.size()) + " crates, at most " + MAX_CRATES + " per stockpile");
		}
		for (BlockPos c : add) {
			String why = crateRefusal(level, owner, c);
			if (why != null) {
				throw new Sites.SiteException(why.startsWith("PROTECTED") ? Reason.PROTECTED : why.startsWith("NOT_LOADED") ? Reason.NOT_LOADED : Reason.NOT_ALLOWED,
					why.substring(why.indexOf(' ') + 1));
			}
		}
		boolean created = p == null;
		if (p == null) {
			p = new Pile("sp" + nextId++, owner, dimension, new StockLedger());
			PILES.put(p.id, p);
		}
		for (BlockPos c : add) {
			p.crates.add(putCrate(level, p, c));
		}
		p.dirty = true;
		saveWithWorld(srv); // (JR) with the chunks, as autosave: the ledger never ahead of the world
		Architect.LOGGER.info("Stockpile {}: {} in {} with {} crate(s){}", owner, created ? "created" : "updated", dimension, p.crates.size(), add.isEmpty() ? ""
			: " (+" + add.size() + ")");
		return p;
	}

	/** {@code addStockpileCrate}. */
	public static Pile addCrate(MinecraftServer srv, String owner, String dimension, BlockPos at) throws Sites.SiteException {
		requireLoaded();
		Pile p = get(owner);
		if (p == null) {
			throw new Sites.SiteException(Reason.NOT_ALLOWED, owner + " has no stockpile (createStockpile first)");
		}
		if (!p.dimension.equals(dimension)) {
			throw new Sites.SiteException(Reason.NOT_ALLOWED, "the stockpile of " + owner + " is in " + p.dimension + "; a crate in " + dimension + " is refused");
		}
		return create(srv, owner, dimension, List.of(at));
	}

	/** Why a cell can't hold a new crate ("REASON message"), or null. */
	static @Nullable String crateRefusal(ServerLevel level, String owner, BlockPos c) {
		String at = c.getX() + "," + c.getY() + "," + c.getZ();
		if (!level.isLoaded(c)) {
			return "NOT_LOADED the crate cell " + at + " is not loaded";
		}
		BlockState st = level.getBlockState(c);
		if (!(st.isAir() || st.canBeReplaced())) {
			return "NOT_ALLOWED the crate cell " + at + " holds " + Cells.blockId(st) + " (air or a replaceable block only)";
		}
		String dim = Sites.dimensionId(level);
		for (Site s : Sites.all()) {
			if (s.dimension().equals(dim) && s.restoreBox().contains(c.getX(), c.getY(), c.getZ())) {
				return "NOT_ALLOWED the crate cell " + at + " is in the restore box of site " + s.id();
			}
		}
		if (SiteJournal.owned(dim, c.asLong())) {
			return "NOT_ALLOWED the crate cell " + at + " is a cell a placement wrote (in the world journal)";
		}
		for (ProtectedArea a : Protected.list(null)) {
			if (!a.owner().equals(owner) && a.dimension().identifier().toString().equals(dim) && a.contains(c.getX(), c.getZ())) {
				return "PROTECTED the crate cell " + at + " is in protected area " + a.id() + " of " + a.owner();
			}
		}
		return null;
	}

	/** Puts a crate down: its own journal entry ({@code stockpile:<owner>}, no group), then the block. */
	private static CrateRec putCrate(ServerLevel level, Pile p, BlockPos at) throws Sites.SiteException {
		BlockState was = level.getBlockState(at);
		BlockEntity wasBe = level.getBlockEntity(at);
		String wasNbt = wasBe == null ? null : wasBe.saveWithFullMetadata(level.registryAccess()).toString();
		JournalStore s = SiteJournal.store();
		JournalStore.Txn t = s.begin().label("crate:" + p.crateOwner());
		String entry = SiteJournal.crateEntry(t, level, p.crateOwner(), null, at, WorldJournal.value(CrateBlocks.CRATE.defaultBlockState()));
		SiteJournal.await(s.submit(t), "the stockpile crate of " + p.owner);
		dev.larattalabs.architect.placed.Placed.set(level, at, CrateBlocks.CRATE.defaultBlockState(), Sites.FLAGS);
		if (level.getBlockEntity(at) instanceof CrateBlockEntity be) {
			be.setSiteId(p.crateOwner());
		}
		return new CrateRec(at.getX(), at.getY(), at.getZ(), NbtUtils.writeBlockState(was).toString(), wasNbt, entry);
	}

	/** Takes a crate away: its cell gets its before-state back and its journal entry is released. */
	private static void takeCrate(ServerLevel level, CrateRec c) {
		Builder.restoreCrateCell(level, c.asCrate());
		if (c.entry() != null) {
			SiteJournal.releaseEntry(c.entry());
		}
	}

	/** What {@code removeStockpileCrate} did: removed, the items it dropped (forced excess), and why not. */
	public record CrateRemoval(boolean removed, Map<String, Integer> dropped, @Nullable String refusal, boolean ended) {
	}

	/** Whether any target of the owner is building (from the stockpile). */
	static boolean anyBuilding(Pile p) {
		for (Site s : Sites.all()) {
			if (fed(s) && p.owner.equals(s.owner())) {
				return true;
			}
		}
		for (Infra i : Infras.all()) {
			if (fed(i) && p.owner.equals(i.owner())) {
				return true;
			}
		}
		return false;
	}

	/**
	 * {@code removeStockpileCrate}: refused while it would leave the stock over capacity, unless {@code force}, which drops the
	 * excess at that cell ({@code dropped}). Removing the last crate with targets building is refused even with force; removing it
	 * with nothing building ends the stockpile.
	 */
	public static CrateRemoval removeCrate(MinecraftServer srv, String owner, BlockPos at, boolean force) throws Sites.SiteException {
		Pile p = get(owner);
		if (p == null) {
			throw new Sites.SiteException(Reason.NOT_ALLOWED, owner + " has no stockpile");
		}
		CrateRec c = p.crates.stream().filter(x -> x.pos().equals(at)).findFirst().orElse(null);
		if (c == null) {
			throw new Sites.SiteException(Reason.NOT_ALLOWED, at.toShortString() + " is not a crate of the stockpile of " + owner);
		}
		ServerLevel level = Sites.levelOf(srv, p.dimension);
		if (level == null || !level.isLoaded(at)) {
			throw new Sites.SiteException(Reason.NOT_LOADED, "the crate " + at.toShortString() + " is not loaded");
		}
		boolean last = p.crates.size() == 1;
		if (last && anyBuilding(p)) {
			return new CrateRemoval(false, Map.of(), "the last crate of " + owner + " can't go while its targets build (force doesn't override it)", false);
		}
		// capacity without this crate (a missing crate already counts for nothing)
		List<CrateRec> pr = present(srv, p);
		int capAfter = StockLedger.STACKS_PER_CRATE * (int) pr.stream().filter(x -> !x.equals(c)).count();
		int used = p.ledger.usedStacks(Stockpiles::maxStack);
		Map<String, Integer> drop = new TreeMap<>();
		if (used > capAfter) {
			if (!force) {
				return new CrateRemoval(false, Map.of(), "the stock (" + used + " stacks) would be over the capacity left (" + capAfter + " stacks); "
					+ "withdraw first, or remove with force (drops the excess at the crate)", false);
			}
			drop.putAll(excess(p.ledger, capAfter, Stockpiles::maxStack));
			drop.forEach((k, v) -> p.ledger.drop(k, v));
		}
		takeCrate(level, c);
		p.crates.remove(c);
		Builder.dropItems(level, at, drop, null);
		boolean ended = p.crates.isEmpty();
		if (ended) {
			PILES.remove(p.id);
		}
		p.dirty = true;
		saveWithWorld(srv); // (JR) with the chunks, as autosave: the ledger never ahead of the world
		dev.larattalabs.architect.apiimpl.ApiEvents.stockpileChanged(srv, owner);
		Architect.LOGGER.info("Stockpile {}: crate {} removed{}{}", owner, at.toShortString(), drop.isEmpty() ? "" : ", excess dropped " + drop, ended
			? "; the stockpile ended" : "");
		return new CrateRemoval(true, drop, null, ended);
	}

	/** The least stock (whole stacks, partial ones first, by item id) whose removal brings the stock within {@code cap}. Pure. */
	static Map<String, Integer> excess(StockLedger l, int cap, java.util.function.ToIntFunction<String> maxStack) {
		Map<String, Integer> stock = new TreeMap<>(l.stock());
		Map<String, Integer> out = new TreeMap<>();
		int used = 0;
		for (var e : stock.entrySet()) {
			used += (e.getValue() + maxStack.applyAsInt(e.getKey()) - 1) / maxStack.applyAsInt(e.getKey());
		}
		for (var e : stock.entrySet()) {
			int max = maxStack.applyAsInt(e.getKey());
			int s = e.getValue();
			while (used > cap && s > 0) {
				int chunk = s % max == 0 ? max : s % max;
				s -= chunk;
				used--;
				out.merge(e.getKey(), chunk, Integer::sum);
			}
		}
		return out;
	}

	/**
	 * {@code dissolveStockpile}: every unit, reserved or not, goes to {@code to} (its inventory; what doesn't fit drops at the
	 * player) or (null) drops at the first present crate; every crate block is restored and the stockpile ends. Its targets keep
	 * building with no stockpile: they wait (C25) until one exists again. Every unit is booked as withdrawn (into the player's
	 * inventory) or dropped. Returns what went out per item.
	 */
	public static Map<String, Integer> dissolve(MinecraftServer srv, String owner, @Nullable ServerPlayer to) throws Sites.SiteException {
		Pile p = get(owner);
		if (p == null) {
			throw new Sites.SiteException(Reason.NOT_ALLOWED, owner + " has no stockpile");
		}
		ServerLevel level = Sites.levelOf(srv, p.dimension);
		if (level == null) {
			throw new Sites.SiteException(Reason.NOT_LOADED, p.dimension + " is not loaded");
		}
		for (CrateRec c : p.crates) {
			if (!level.isLoaded(c.pos())) {
				throw new Sites.SiteException(Reason.NOT_LOADED, "the crate " + c.pos().toShortString() + " is not loaded");
			}
		}
		BlockPos at = dropAt(srv, p, p.crates.isEmpty() ? BlockPos.ZERO : p.crates.get(0).pos().above());
		Map<String, Integer> toPlayer = new TreeMap<>();
		Map<String, Integer> toGround = new TreeMap<>();
		Map<String, Integer> out = dissolveLedger(p.ledger, to == null ? null : (item, n) -> give(to, item, n), toPlayer, toGround);
		if (to != null) {
			Builder.dropItems((ServerLevel) to.level(), to.blockPosition(), toGround, null);
		} else {
			Builder.dropItems(level, at, toGround, null);
		}
		for (CrateRec c : p.crates) {
			takeCrate(level, c);
		}
		JsonObject last = p.toJson();
		PILES.remove(p.id);
		saveWithWorld(srv); // (JR) with the chunks, as autosave: the ledger never ahead of the world
		Architect.LOGGER.info("Stockpile {} dissolved: to the player {}, dropped {}; ledger at the end {}", owner, toPlayer, toGround, last.get("ledger"));
		dev.larattalabs.architect.apiimpl.ApiEvents.stockpileChanged(srv, owner);
		LAST_DISSOLVED.put(p.id, last);
		return out;
	}

	/**
	 * The ledger half of {@link #dissolve}: every unit in stock, reserved or not, goes to the player ({@code give} answers how many of
	 * {@code n} went into the inventory; booked as withdrawn) and the rest to the ground (booked as dropped), or all to the ground with no
	 * player. Fills {@code toPlayer} and {@code toGround}; returns what went out per item. Pure of the level: the survival ledger lint's
	 * seam (docs/FAST-CHECKS.md "Survival ledger lint").
	 */
	static Map<String, Integer> dissolveLedger(StockLedger l, java.util.function.@Nullable ToIntBiFunction<String, Integer> give, Map<String, Integer> toPlayer,
		Map<String, Integer> toGround) {
		Map<String, Integer> out = new TreeMap<>(l.stock());
		for (var e : out.entrySet()) {
			if (give != null) {
				int in = give.applyAsInt(e.getKey(), e.getValue());
				l.withdraw(e.getKey(), in);
				if (in > 0) {
					toPlayer.put(e.getKey(), in);
				}
				int rest = e.getValue() - in;
				if (rest > 0) {
					l.drop(e.getKey(), rest);
					toGround.put(e.getKey(), rest);
				}
			} else {
				l.drop(e.getKey(), e.getValue());
				toGround.put(e.getKey(), e.getValue());
			}
		}
		return out;
	}

	/** Dev: the ledger of a stockpile when it was dissolved (the gate checks its identity). */
	static final Map<String, JsonObject> LAST_DISSOLVED = new ConcurrentHashMap<>();

	/** Puts up to {@code n} of {@code item} into the player's inventory; returns how many went in. */
	static int give(ServerPlayer to, String item, int n) {
		Item it = Cells.item(item);
		if (it == null || n <= 0) {
			return 0;
		}
		int left = n;
		int max = new ItemStack(it).getMaxStackSize();
		while (left > 0) {
			int k = Math.min(max, left);
			ItemStack st = new ItemStack(it, k);
			to.getInventory().add(st);
			int went = k - st.getCount();
			left -= went;
			if (went < k) {
				break;
			}
		}
		to.getInventory().setChanged();
		return n - left;
	}

	// ------------------------------------------------------------------ API: feed order, withdraw, adopt

	public static List<String> feedOrder(MinecraftServer srv, String owner) throws Sites.SiteException {
		Pile p = get(owner);
		if (p == null) {
			throw new Sites.SiteException(Reason.NOT_ALLOWED, owner + " has no stockpile");
		}
		reconcile(srv, p);
		return List.copyOf(p.order);
	}

	public static List<String> setFeedOrder(MinecraftServer srv, String owner, List<String> ids) throws Sites.SiteException {
		Pile p = get(owner);
		if (p == null) {
			throw new Sites.SiteException(Reason.NOT_ALLOWED, owner + " has no stockpile");
		}
		reconcile(srv, p);
		try {
			List<String> next = FeedOrder.setFront(p.order, ids == null ? List.of() : ids);
			p.order.clear();
			p.order.addAll(next);
		} catch (IllegalArgumentException e) {
			throw new Sites.SiteException(Reason.FIELD_LIMIT, "ids: " + e.getMessage());
		}
		saveWithWorld(srv); // (JR) with the chunks, as autosave: the ledger never ahead of the world
		Architect.LOGGER.info("Stockpile {}: feed order {}", owner, p.order);
		return List.copyOf(p.order);
	}

	/**
	 * Per item, the unbuilt cost over every building target of the owner (paused ones too; C29: not a target being removed, which
	 * needs nothing more).
	 */
	static Map<String, Integer> unbuiltAll(MinecraftServer srv, Pile p) {
		Map<String, Integer> out = new TreeMap<>();
		for (Object t : targets(srv, p)) {
			if (Groups.leaving(idOf(t))) {
				continue;
			}
			Builder.Run r = run(srv, t);
			if (r != null) {
				r.unbuilt.forEach((k, v) -> {
					if (v > 0) {
						out.merge(k, v, Integer::sum);
					}
				});
			}
		}
		// (6c RS) a survival region's bodies' pending charge (lava buckets, grates' iron bars) is needed too
		dev.larattalabs.architect.region.RegionFluids.pendingCharges(p.owner).values().forEach(m -> m.forEach((k, v) -> out.merge(k, v, Integer::sum)));
		// (7a GM-a2) and its gate mechanisms' bills not yet charged
		MechCharges.pendingCharges(p.owner).values().forEach(m -> m.forEach((k, v) -> out.merge(k, v, Integer::sum)));
		return out;
	}

	/** Credit: the stock beyond what every building target still needs. */
	static Map<String, Integer> credit(MinecraftServer srv, Pile p) {
		Map<String, Integer> need = unbuiltAll(srv, p);
		Map<String, Integer> out = new TreeMap<>();
		p.ledger.stock().forEach((k, v) -> {
			int c = v - need.getOrDefault(k, 0);
			if (c > 0) {
				out.put(k, c);
			}
		});
		return out;
	}

	/** {@code withdraw}: credit only, into the player's inventory (what doesn't fit drops at the player). Returns what came out. */
	public static Map<String, Integer> withdraw(MinecraftServer srv, String owner, Map<String, Integer> items, ServerPlayer to) throws Sites.SiteException {
		Pile p = get(owner);
		if (p == null) {
			throw new Sites.SiteException(Reason.NOT_ALLOWED, owner + " has no stockpile");
		}
		if (to == null) {
			throw new Sites.SiteException(Reason.FIELD_LIMIT, "to: a player is required");
		}
		Map<String, Integer> credit = credit(srv, p);
		Map<String, Integer> out = new TreeMap<>();
		Map<String, Integer> ground = new TreeMap<>();
		for (var e : new TreeMap<>(items).entrySet()) {
			int n = Math.min(Math.max(0, e.getValue()), credit.getOrDefault(e.getKey(), 0));
			if (n <= 0) {
				continue;
			}
			p.ledger.withdraw(e.getKey(), n);
			int in = give(to, e.getKey(), n);
			if (n - in > 0) {
				ground.put(e.getKey(), n - in);
			}
			out.put(e.getKey(), n);
		}
		Builder.dropItems((ServerLevel) to.level(), to.blockPosition(), ground, null);
		if (!out.isEmpty()) {
			changed(p);
		}
		return out;
	}

	/** (PS, F6) A new stockpile or crate is refused while the file failed to load: it would be lost (never saved) and reuse the file's ids. */
	private static void requireLoaded() throws Sites.SiteException {
		if (loadFailed) {
			throw new Sites.SiteException(Reason.NOT_ALLOWED, FILE + " could not be loaded (" + loadFailedWhy + "); stockpiles are off until it is fixed or "
				+ FILE + ".bak is restored and the world reopened");
		}
	}

	/**
	 * {@code adoptCrates} (§5): every legacy crate of the owner (a building site's own crate, a group's shared crate, a delta's
	 * crate) joins the stockpile: its ledger is adopted (delivered and placed, so the stock grows by the crate's stock; what doesn't
	 * fit drops at the first crate, booked as dropped), its cell is restored and its journal kind released, and its targets lose
	 * their crate (they draw from the stockpile, joining the feed order at the end in placement order). Idempotent.
	 */
	public static Pile adopt(MinecraftServer srv, String owner) throws Sites.SiteException {
		Pile p = get(owner);
		if (p == null) {
			throw new Sites.SiteException(Reason.NOT_ALLOWED, owner + " has no stockpile (createStockpile first)");
		}
		ServerLevel level = Sites.levelOf(srv, p.dimension);
		if (level == null) {
			throw new Sites.SiteException(Reason.NOT_LOADED, p.dimension + " is not loaded");
		}
		// the crates, by owner id in their block entity: a site's own id, or group:<id>
		Map<String, Construction.Crate> crates = new LinkedHashMap<>();
		List<Site> sites = new ArrayList<>();
		for (Site s : Sites.all()) {
			if (s.building() && owner.equals(s.owner()) && s.construction().crate() != null && p.dimension.equals(s.dimension())) {
				sites.add(s);
				crates.putIfAbsent(Builder.crateOwner(s), s.construction().crate());
			}
		}
		List<Infra> roads = new ArrayList<>();
		for (Infra i : Infras.all()) {
			if (i.building() && owner.equals(i.owner()) && i.construction().crate() != null && p.dimension.equals(i.dimension())) {
				roads.add(i);
				if (i.group() != null) {
					crates.putIfAbsent(SiteGroupRec.CRATE_PREFIX + i.group(), i.construction().crate());
				}
			}
		}
		Map<String, Integer> dropped = new TreeMap<>();
		BlockPos drop = dropAt(srv, p, p.crates.isEmpty() ? BlockPos.ZERO : p.crates.get(0).pos().above());
		for (var e : crates.entrySet()) {
			Construction.Crate c = e.getValue();
			BlockPos cp = new BlockPos(c.x(), c.y(), c.z());
			if (level.getBlockEntity(cp) instanceof CrateBlockEntity be && e.getKey().equals(be.siteId())) {
				Ledger l = be.ledger();
				Map<String, Map<String, Integer>> byTarget = adoptedPaid(srv, level, e.getKey(), sites, roads, l.placed());
				Map<String, Integer> over = p.ledger.adopt("adopt:" + e.getKey() + "@" + cp.asLong(), l.delivered(), l.placed(), byTarget, capacity(srv, p),
					Stockpiles::maxStack);
				Map<String, Integer> keyed = new TreeMap<>();
				byTarget.values().forEach(m -> m.forEach((k, v) -> keyed.merge(k, v, Integer::sum)));
				Map<String, Integer> unkeyed = new TreeMap<>();
				l.placed().forEach((k, v) -> {
					if (v - keyed.getOrDefault(k, 0) > 0) {
						unkeyed.put(k, v - keyed.getOrDefault(k, 0));
					}
				});
				if (!unkeyed.isEmpty()) {
					Architect.LOGGER.info("Stockpile {}: adopted crate {}: placed {} keyed to no target (none of its targets stands on it; never refundable)", owner,
						e.getKey(), unkeyed);
				}
				over.forEach((k, v) -> dropped.merge(k, v, Integer::sum));
				l.takeStock(); // the crate's ledger now holds nothing (its block goes next)
				be.ledgerChanged();
			}
			Builder.restoreCrateCell(level, c);
			SiteJournal.releaseKind(e.getKey(), WorldJournal.CRATE);
			if (e.getKey().startsWith(SiteGroupRec.CRATE_PREFIX)) {
				SiteGroupRec g = Sites.group(e.getKey().substring(SiteGroupRec.CRATE_PREFIX.length()));
				if (g != null) {
					Sites.putGroup(srv, g.withCrate(null));
				}
			}
		}
		List<Object> joined = new ArrayList<>();
		for (Site s : sites) {
			Site cur = Sites.get(s.id());
			if (cur != null && cur.construction() != null) {
				Sites.replace(srv, cur.withConstruction(cur.construction().withCrate(null)));
				Builder.forgetRun(s.id());
				joined.add(Sites.get(s.id()));
			}
		}
		for (Infra i : roads) {
			Infra cur = Infras.get(i.id());
			if (cur != null && cur.construction() != null) {
				Infras.put(srv, cur.withConstruction(cur.construction().withCrate(null)));
				joined.add(Infras.get(i.id()));
			}
		}
		// they join the feed order at the end, in placement order
		joined.sort(java.util.Comparator.comparingLong(Stockpiles::placedAt));
		for (Object t : joined) {
			if (t != null && !p.order.contains(idOf(t))) {
				p.order.add(idOf(t));
			}
		}
		Builder.dropItems(level, drop, dropped, null);
		changed(p);
		saveWithWorld(srv); // (JR) with the chunks, as autosave: the ledger never ahead of the world
		Architect.LOGGER.info("Stockpile {}: adopted {} crate(s) ({} site(s), {} road(s)){}", owner, crates.size(), sites.size(), roads.size(), dropped
			.isEmpty() ? "" : "; over capacity, dropped " + dropped);
		return p;
	}

	/**
	 * (JR-b, F3) An adopted crate's placed counts by the credit keys of the targets it fed, in placement order, for their paid records: a crate
	 * of one target gives it all; a shared crate gives each what of its paid cost stands (capped by the crate in {@link StockLedger#adopt}).
	 */
	private static Map<String, Map<String, Integer>> adoptedPaid(MinecraftServer srv, ServerLevel level, String crateKey, List<Site> sites, List<Infra> roads,
		Map<String, Integer> placed) {
		List<Object> fed = new ArrayList<>();
		for (Site s : sites) {
			if (crateKey.equals(Builder.crateOwner(s))) {
				fed.add(s);
			}
		}
		for (Infra i : roads) {
			if (i.group() != null && crateKey.equals(SiteGroupRec.CRATE_PREFIX + i.group())) {
				fed.add(i);
			}
		}
		fed.sort(java.util.Comparator.comparingLong(Stockpiles::placedAt));
		Map<String, Map<String, Integer>> out = new LinkedHashMap<>();
		if (fed.size() == 1) {
			out.put(fed.get(0) instanceof Site s ? Builder.creditKey(s) : RoadBuilder.creditKey((Infra) fed.get(0)), new TreeMap<>(placed));
			return out;
		}
		for (Object t : fed) {
			if (t instanceof Site s) {
				Builder.Run r = Builder.run(srv, s);
				out.put(Builder.creditKey(s), r == null ? new TreeMap<>() : Builder.paidStanding(level, s, r));
			} else {
				Infra i = (Infra) t;
				Map<String, Integer> one = new TreeMap<>();
				Builder.Run r = RoadBuilder.run(srv, i);
				if (r != null) {
					r.rescan(level, false, true); // never loads a chunk
					java.util.BitSet free = i.construction().free();
					for (int q = r.built.nextSetBit(0); q >= 0; q = r.built.nextSetBit(q + 1)) {
						if (!free.get(q)) {
							r.cost.get(q).forEach(x -> one.merge(x.item(), x.count(), Integer::sum));
						}
					}
				}
				out.put(RoadBuilder.creditKey(i), one);
			}
		}
		return out;
	}

	// ------------------------------------------------------------------ inserting and refunds

	/**
	 * A stockpile crate's acceptance rule: what one unit of {@code item} would credit (itself or an equivalent the owner's building
	 * targets, pooled, still miss) and whether it fits; booked when {@code commit}. Null when nothing needs it or it doesn't fit.
	 */
	public static Ledger.@Nullable Accepted accept(MinecraftServer srv, String crateOwner, String item, boolean commit) {
		Pile p = byId(crateOwner.substring(PREFIX.length()));
		if (p == null) {
			return null;
		}
		Map<String, Integer> need = unbuiltAll(srv, p);
		if (need.isEmpty()) {
			return null;
		}
		Ledger.Accepted a = p.ledger.accept(item, it -> need.getOrDefault(it, 0), Equivalents.bundled(), capacity(srv, p), Stockpiles::maxStack, commit);
		if (a != null && commit) {
			changed(p);
		}
		return a;
	}

	/** Marks a stockpile changed (STOCKPILE_CHANGED, rate-limited, on the next tick). */
	static void changed(Pile p) {
		p.dirty = true;
		unsaved = true;
	}

	/** (HF) a ledger change since the last save (a logout saves the world when set). */
	static volatile boolean unsaved;
	/** (HF) inside saveWithWorld: BEFORE_SAVE leaves the ledger to it. Server thread. */
	private static boolean explicitSave;

	/**
	 * Credits refunds into the owner's stockpile once per {@code key} (§4): up to capacity returned, the rest dropped above the first
	 * present crate (else at {@code fallback}) and booked as refundOverflow. Returns what was credited; empty (already) for a key
	 * credited before.
	 */
	static StockLedger.Credit credit(MinecraftServer srv, Pile p, String key, Map<String, Integer> items, BlockPos fallback) {
		if (items.isEmpty() && !p.ledger.credited(key) && p.ledger.custody(key).isEmpty()) { // (M5 FK) custody still refunds
			p.ledger.dropPaid(key); // (JR) nothing of it stood: its paid record goes with it
			return StockLedger.Credit.NONE;
		}
		StockLedger.Credit c = p.ledger.credit(key, items, capacity(srv, p), Stockpiles::maxStack);
		if (!c.shortfall().isEmpty()) {
			// (JR) more stands than the ledger says this target consumed (a crash: the world was saved after the ledger): not credited
			Architect.LOGGER.warn("Stockpile {}: refund {} capped at what the ledger recorded consumed; not credited {}", p.owner, key, c.shortfall());
		}
		if (c.already()) {
			Architect.LOGGER.info("Stockpile {}: refund {} already credited; nothing credited again", p.owner, key);
			return c;
		}
		dropOverflow(srv, p, c.overflow(), fallback);
		changed(p);
		Architect.LOGGER.info("Stockpile {}: refund {} returned {}{}", p.owner, key, c.returned(), c.overflow().isEmpty() ? "" : ", overflow dropped "
			+ c.overflow());
		return c;
	}

	/**
	 * (6c RS, §7.3) A survival region's bodies' write: takes {@code items} (a lava bucket per lava source, the grates' iron bars) from the
	 * owner's stockpile, a lava bucket's empty bucket given back (C24's container rule). Only when every item is available after the feed's
	 * reservations (the bodies come after every target of the region, so they take what is left); false (nothing taken) otherwise.
	 */
	/**
	 * (JR) A retake of {@code targetId}'s paid blocks: capped by and taken out of its paid record in the stockpile that tracks it (items
	 * as they are when none does).
	 */
	static Map<String, Integer> fromPaid(String targetId, Map<String, Integer> items) {
		Pile tracking = null;
		for (Pile p : PILES.values()) {
			if (p.ledger.tracks(targetId)) {
				tracking = p;
				break;
			}
		}
		Site s = Sites.get(targetId);
		Infra i = s == null ? Infras.get(targetId) : null;
		long placedAt = s != null ? s.placedAt() : i != null ? i.placedAt() : -1; // (JR-b) with no record, the pool only if placed before it
		if (tracking == null) {
			// (RL, audit F7) no record: a target a stockpile feeds was fed after the save (or before JR): its pile caps it (the legacy pool,
			// else nothing); only a target no stockpile feeds (a legacy crate's) gives back as it is
			tracking = s != null ? pileOf(s) : i != null ? pileOf(i) : null;
			if (tracking == null) {
				return items;
			}
		}
		Map<String, Integer> out = tracking.ledger.fromPaid(targetId, items, placedAt);
		changed(tracking); // (PS) the record moved: saved with the world at the next periodic save
		if (!out.equals(items)) {
			Architect.LOGGER.warn("Stockpile {}: retake of {} capped at what the ledger recorded consumed: {} of {}", tracking.owner, targetId, out, items);
		}
		return out;
	}

	public static boolean charge(MinecraftServer srv, @Nullable String owner, Map<String, Integer> items) {
		Pile p = get(owner);
		if (p == null) {
			return items.values().stream().allMatch(n -> n <= 0);
		}
		Map<String, Integer> reserved = LAST_RESERVED.getOrDefault(p.id, Map.of());
		for (var e : items.entrySet()) {
			if (e.getValue() > 0 && p.ledger.stock(e.getKey()) - reserved.getOrDefault(e.getKey(), 0) < e.getValue()) {
				return false;
			}
		}
		int cap = capacity(srv, p);
		Map<String, Integer> over = new TreeMap<>();
		for (var e : new TreeMap<>(items).entrySet()) {
			p.ledger.consume(e.getKey(), e.getValue(), cap, Stockpiles::maxStack, over);
		}
		dropOverflow(srv, p, over, p.crates.isEmpty() ? BlockPos.ZERO : p.crates.get(0).pos().above());
		changed(p);
		saveWithWorld(srv); // (JR) with the chunks, as autosave: the ledger never ahead of the world
		Architect.LOGGER.info("Stockpile {}: a region's bodies took {}", p.owner, items);
		return true;
	}

	/** (6c RS) What {@link #charge} would still lack: per item, {@code need - (stock - reserved)} when short. */
	public static Map<String, Integer> chargeShort(@Nullable String owner, Map<String, Integer> items) {
		Map<String, Integer> out = new TreeMap<>();
		Pile p = get(owner);
		Map<String, Integer> reserved = p == null ? Map.of() : LAST_RESERVED.getOrDefault(p.id, Map.of());
		for (var e : items.entrySet()) {
			int have = p == null ? 0 : p.ledger.stock(e.getKey()) - reserved.getOrDefault(e.getKey(), 0);
			if (have < e.getValue()) {
				out.put(e.getKey(), e.getValue() - Math.max(0, have));
			}
		}
		return out;
	}

	/**
	 * (6c RS, §9.2, S-RS-6) A survival region's removal: its standing lava sources are scooped (for each, a bucket from stock becomes a lava
	 * bucket credited; with no bucket in stock the source drains and nothing is credited: never a bucket minted) and its standing grates
	 * refunded, once per {@code key} (a resumed removal credits nothing again). Returns what was credited.
	 */
	public static Map<String, Integer> scoop(MinecraftServer srv, @Nullable String owner, String key, int lavaSources, int grates) {
		Pile p = get(owner);
		if (p == null || p.ledger.credited(key)) {
			return Map.of();
		}
		int cap = capacity(srv, p);
		Map<String, Integer> over = new TreeMap<>();
		StockLedger.Credit c = scoopInto(p.ledger, key, lavaSources, grates, cap, Stockpiles::maxStack, over);
		BlockPos fb = p.crates.isEmpty() ? BlockPos.ZERO : p.crates.get(0).pos().above();
		dropOverflow(srv, p, over, fb);
		dropOverflow(srv, p, c.overflow(), fb);
		changed(p);
		saveWithWorld(srv); // (JR) with the chunks, as autosave: the ledger never ahead of the world
		Architect.LOGGER.info("Stockpile {}: a region's removal scooped and refunded {} ({} lava source(s), {} grate(s); {})", p.owner, c.returned(), lavaSources, grates, key);
		Map<String, Integer> out = new TreeMap<>(c.returned());
		c.overflow().forEach((k, v) -> out.merge(k, v, Integer::sum));
		return out;
	}

	/**
	 * (6c RS, S-RS-6) The scoop on a ledger, pure: per standing lava source a bucket from stock becomes a lava bucket (as many as there are
	 * buckets, never more: no bucket is minted), the grates' iron bars credited, all of it once under {@code key}. {@code over}: the
	 * consumed buckets' overflow (none: a consume returns nothing); the returned credit's overflow is the caller's to drop.
	 */
	static StockLedger.Credit scoopInto(StockLedger led, String key, int lavaSources, int grates, int cap, java.util.function.ToIntFunction<String> maxStack,
		Map<String, Integer> over) {
		if (led.credited(key)) {
			return new StockLedger.Credit(Map.of(), Map.of(), true);
		}
		int take = Math.max(0, Math.min(lavaSources, led.stock(StockLedger.BUCKET)));
		if (take > 0) {
			led.consume(StockLedger.BUCKET, take, cap, maxStack, over);
		}
		Map<String, Integer> items = new TreeMap<>();
		if (take > 0) {
			items.put("minecraft:lava_bucket", take);
		}
		if (grates > 0) {
			items.put("minecraft:iron_bars", grates);
		}
		return led.credit(key, items, cap, maxStack);
	}

	/** Credits without a key (a swap's old block, a bucket's container) as it happens. */
	static StockLedger.Credit giveBack(MinecraftServer srv, Pile p, Map<String, Integer> items, BlockPos fallback) {
		StockLedger.Credit c = p.ledger.giveBack(items, capacity(srv, p), Stockpiles::maxStack);
		dropOverflow(srv, p, c.overflow(), fallback);
		changed(p);
		return c;
	}

	static void dropOverflow(MinecraftServer srv, Pile p, Map<String, Integer> over, BlockPos fallback) {
		if (over.isEmpty()) {
			return;
		}
		ServerLevel level = Sites.levelOf(srv, p.dimension);
		if (level != null) {
			Builder.dropItems(level, dropAt(srv, p, fallback), over, null);
			OVERFLOW_DROPPED.merge(p.id, sumOf(over), Integer::sum);
		}
	}

	private static int sumOf(Map<String, Integer> m) {
		return m.values().stream().mapToInt(Integer::intValue).sum();
	}

	/** Dev: overflow units dropped as entities this session, per owner (the gate counts the entities against it). */
	static final Map<String, Integer> OVERFLOW_DROPPED = new ConcurrentHashMap<>();

	// ------------------------------------------------------------------ the owner feed loop

	static String idOf(Object t) {
		return t instanceof Site s ? s.id() : ((Infra) t).id();
	}

	static long placedAt(Object t) {
		return t instanceof Site s ? s.placedAt() : ((Infra) t).placedAt();
	}

	static Builder.@Nullable Run run(MinecraftServer srv, Object t) {
		return t instanceof Site s ? Builder.run(srv, s) : RoadBuilder.run(srv, (Infra) t);
	}

	/** Where a target came from in its batch (the default order's batch item order). */
	static FeedOrder.Origin origin(String id) {
		Site s = Sites.get(id);
		Site.Member m = s != null ? s.member() : Infras.get(id) != null ? Infras.get(id).member() : null;
		if (m == null || m.batchId() == null || m.itemKey() == null) {
			return FeedOrder.Origin.NONE;
		}
		QBatch b = Batches.get(m.batchId());
		if (b == null) {
			return new FeedOrder.Origin(m.batchId(), Integer.MAX_VALUE / 2);
		}
		for (int i = 0; i < b.items.size(); i++) {
			if (m.itemKey().equals(b.items.get(i).key)) {
				return new FeedOrder.Origin(m.batchId(), i);
			}
		}
		return new FeedOrder.Origin(m.batchId(), Integer.MAX_VALUE / 2);
	}

	/** The owner's building targets in feed order; the order joins new ones (default order) and drops finished ones. */
	static List<Object> targets(MinecraftServer srv, Pile p) {
		Map<String, Object> building = new LinkedHashMap<>();
		List<Object> fresh = new ArrayList<>();
		for (Site s : Sites.all()) {
			if (!s.placing() && fed(s) && p.owner.equals(s.owner())) {
				building.put(s.id(), s);
			}
		}
		for (Infra i : Infras.all()) {
			if (!i.placing() && fed(i) && p.owner.equals(i.owner())) {
				building.put(i.id(), i);
			}
		}
		boolean changed = p.order.removeIf(id -> !building.containsKey(id));
		for (var e : building.entrySet()) {
			if (!p.order.contains(e.getKey())) {
				fresh.add(e.getValue());
			}
		}
		fresh.sort(java.util.Comparator.comparingLong(Stockpiles::placedAt));
		for (Object t : fresh) {
			FeedOrder.insert(p.order, idOf(t), origin(idOf(t)), Stockpiles::origin);
			changed = true;
			p.joined = true;
		}
		if (changed) {
			p.dirty = true;
		}
		List<Object> out = new ArrayList<>(p.order.size());
		for (String id : p.order) {
			out.add(building.get(id));
		}
		return out;
	}

	static void reconcile(MinecraftServer srv, Pile p) {
		targets(srv, p);
	}

	/** Dev/state: per target, what it may use now ({@code stock - reserved}) and whether it reserves. */
	static final Map<String, Map<String, Integer>> LAST_RESERVED = new ConcurrentHashMap<>();

	/** One server tick: every stockpile feeds its targets in feed order, with reservations (§3). */
	static void tick(MinecraftServer srv) {
		ticks++;
		for (Pile p : List.copyOf(PILES.values())) {
			ServerLevel level = Sites.levelOf(srv, p.dimension);
			if (level == null) {
				continue;
			}
			try {
				feed(srv, level, p);
			} catch (RuntimeException e) {
				Architect.LOGGER.error("Stockpile {}: feed step failed", p.owner, e);
			}
			if (p.dirty && ticks - p.lastEvent >= EVENT_TICKS) {
				p.dirty = false;
				p.lastEvent = ticks;
				dev.larattalabs.architect.apiimpl.ApiEvents.stockpileChanged(srv, p.owner);
			}
		}
		periodicSave(srv);
	}

	/**
	 * (PS, F4 b) A ledger changed since its last save (a hopper's or a player's delivery, a feed's consumption, a refund) is saved with
	 * the world at most every {@link #PERIODIC_TICKS}: a crash then loses at most about 10 s of deliveries (the hopper's chunk saves
	 * eagerly in about 10 s too, so a delivery's source and the ledger drift apart by that much at most), never the 5 minutes to the next
	 * autosave. The same save as the explicit ones (players, chunks flushed, ledger), so the ledger is never on disk ahead of them.
	 */
	static void periodicSave(MinecraftServer srv) {
		if (!unsaved || testNoPeriodic || loadFailed || ticks - lastSaveTick < PERIODIC_TICKS) {
			return;
		}
		long t0 = System.nanoTime();
		quietSave = true; // logged with ARCHITECT_TRACE_STOCKPILE only: it runs every 10 s while a build feeds
		saveWithWorld(srv);
		double ms = (System.nanoTime() - t0) / 1e6;
		periodicSaves++;
		lastPeriodicMs = ms;
		maxPeriodicMs = Math.max(maxPeriodicMs, ms);
		synchronized (PERIODIC_MS) {
			PERIODIC_MS.addLast(ms);
			while (PERIODIC_MS.size() > 512) {
				PERIODIC_MS.removeFirst();
			}
		}
		lastSaveTick = ticks; // also when the save was refused, so a failing disk is retried every 10 s, not every tick
	}

	/** (PS, dev) the median of the recent periodic saves (ms); -1 before the first. */
	static double periodicMedianMs() {
		double[] a;
		synchronized (PERIODIC_MS) {
			a = PERIODIC_MS.stream().mapToDouble(Double::doubleValue).sorted().toArray();
		}
		return a.length == 0 ? -1 : a[a.length / 2];
	}

	private static void feed(MinecraftServer srv, ServerLevel level, Pile p) {
		List<Object> ts = targets(srv, p);
		if (ts.isEmpty()) {
			return;
		}
		int cap = capacity(srv, p);
		BlockPos fallback = dropAt(srv, p, p.crates.isEmpty() ? BlockPos.ZERO : p.crates.get(0).pos().above());
		Map<String, Integer> reserved = feedPass(ts, new FeedVisit<Object>() {
			@Override
			public boolean leaving(Object t) {
				return Groups.leaving(idOf(t));
			}

			@Override
			public void left(Object t) {
				// C29 (a): a removal started on it: it left the feed (no step, nothing consumed, no reservation); it keeps its place in
				// the order, so a removal that ends without removing it (a player stayed, blockers) feeds it again from there
				SiteWaits.observe(srv, level, idOf(t), WaitCalc.Outcome.ENDED);
			}

			@Override
			public Builder.@Nullable Run run(Object t) {
				return Stockpiles.run(srv, t);
			}

			@Override
			public boolean paused(Object t) {
				return t instanceof Site s ? s.construction().paused() : ((Infra) t).construction().paused();
			}

			@Override
			public void step(Object t, Builder.Run r, FeedOrder.Reserve reserve) {
				Builder.Purse purse = new Builder.Purse() {
					@Override
					public int stock(String item) {
						return reserve.available(item, p.ledger::stock);
					}

					@Override
					public void pay(List<SurvivalItems.Cost> costs) {
						Map<String, Integer> over = new TreeMap<>();
						String key = keyOf(t);
						for (SurvivalItems.Cost c : costs) {
							if (p.ledger.consume(c.item(), c.count(), cap, Stockpiles::maxStack, over)) {
								p.ledger.pay(key, c.item(), c.count()); // (JR) with consumed, saved with it
							}
						}
						dropOverflow(srv, p, over, fallback);
					}

					@Override
					public void giveBack(Map<String, Integer> items, BlockPos fb) {
						Stockpiles.giveBack(srv, p, items, fb);
					}

					@Override
					public Map<String, Integer> giveBackPaid(String targetId, Map<String, Integer> items, BlockPos fb) {
						// (RL, audit F7) a swap's old block: out of the target's paid record, capped by it
						Map<String, Integer> back = p.ledger.fromPaid(targetId, items, t instanceof Site st ? st.placedAt() : ((Infra) t).placedAt()); // (JR-b)
						Stockpiles.changed(p); // (PS) the record moved
						if (!back.equals(items)) {
							Architect.LOGGER.warn("Stockpile {}: swap refund of {} capped at what the ledger recorded consumed: {} of {}", p.owner, targetId, back,
								items);
						}
						if (!back.isEmpty()) {
							Stockpiles.giveBack(srv, p, back, fb);
						}
						return back;
					}

					@Override
					public void changed() {
						Stockpiles.changed(p);
					}

					@Override
					public StockLedger ledger() {
						return p.ledger; // (M5 FK) the fill's commit point
					}
				};
				// (RL) what it owes after a crash is charged first: an owed cell is built only once paid
				r.attachOwed(owedOf(p, keyOf(t), r));
				r.settleOwed(level, purse, SurvivalWorld.blocksPerTick() * 4);
				int before = r.built.cardinality();
				if (t instanceof Site s) {
					Builder.stepFed(srv, level, s, r, purse);
				} else {
					RoadBuilder.stepFed(srv, level, (Infra) t, r, purse);
				}
				if (r.owedShort && r.built.cardinality() == before) {
					// (RL, C25) nothing built this turn and an owed cell waits on the stock: it waits for materials (its step saw the owed
					// cell's block and moved on: IDLE)
					SiteWaits.observe(srv, level, idOf(t), WaitCalc.Outcome.STARVED);
				}
			}

			@Override
			public boolean building(Object t) {
				return t instanceof Site s ? Sites.get(s.id()) != null && Sites.get(s.id()).building() : Infras.get(idOf(t)) != null && Infras.get(idOf(t))
					.building();
			}

			@Override
			public boolean frontierLoaded(Object t, Builder.Run r) {
				return r.frontierLoaded(level, ticks);
			}

			@Override
			public Map<String, Integer> reservation(Object t, Builder.Run r) {
				return t instanceof Infra ri && RegionTargets.is(ri) ? RegionTargets.reservation(srv, ri, r) : r.unbuilt;
			}
		});
		LAST_RESERVED.put(p.id, reserved);
		if (p.joined) {
			// (RL) a target joined the feed: the ledger (and its book of the target's cells) saved now, with the chunks, so a crash before
			// the next autosave finds the target in the saved ledger. TEST: dev.stockpile.ps noPeriodic turns it off with the periodic save
			// (the before-the-fix cases: nothing saved between lifecycle saves); joinSave: true keeps it on with the periodic save off
			p.joined = false;
			if (!testNoJoinSave) {
				saveWithWorld(srv);
			}
		}
	}

	/**
	 * What one feed pass asks of each target, in feed order ({@link #feedPass}). Production's is {@link #feed}'s; the survival ledger
	 * lint (docs/FAST-CHECKS.md "Survival ledger lint") passes its simulated targets, so the pass's order of decisions is the real one.
	 */
	interface FeedVisit<T> {
		/** C29: a removal started on the target. */
		boolean leaving(T t);

		/** The target left the feed this pass (C29). */
		void left(T t);

		/** Its run (null: none, skipped). */
		Builder.@Nullable Run run(T t);

		/** Paused (read before its step). */
		boolean paused(T t);

		/** Its builder step, fed at {@code stock - reserved} ({@code reserve} holds the targets before it). */
		void step(T t, Builder.Run r, FeedOrder.Reserve reserve);

		/** Still building after its step. */
		boolean building(T t);

		/** S-Y-1: some of its remaining frontier is in a loaded chunk. */
		boolean frontierLoaded(T t, Builder.Run r);

		/** (6c RS, §6.2) What it reserves when it reserves: its unbuilt cost; a survival region's target only its current run's bill. */
		default Map<String, Integer> reservation(T t, Builder.Run r) {
			return r.unbuilt;
		}
	}

	/**
	 * One feed pass (§3, C29, S-Y-1): every target in feed order; a target being removed leaves the feed (no step, no reservation);
	 * each other target steps at {@code stock - reserved} and then reserves its unbuilt cost when {@link FeedOrder#reserves} says so.
	 * Returns the reservation after the last target. The seam the ledger lint drives.
	 */
	static <T> Map<String, Integer> feedPass(List<T> ts, FeedVisit<T> v) {
		FeedOrder.Reserve reserve = new FeedOrder.Reserve();
		for (T t : ts) {
			if (v.leaving(t)) {
				v.left(t);
				continue;
			}
			Builder.Run r = v.run(t);
			if (r == null) {
				continue;
			}
			boolean paused = v.paused(t);
			v.step(t, r, reserve);
			boolean reserves = FeedOrder.reserves(v.building(t), paused, r.pending(), v.frontierLoaded(t, r));
			reserve.add(v.reservation(t, r), reserves); // (6c RS, §6.2) a region's target: only its current run's bill
		}
		return reserve.reserved();
	}

	/** What a target may use now of each item its unbuilt cells need: {@code stock - reserved} at its position in the order. */
	public static Map<String, Integer> availableTo(MinecraftServer srv, String targetId) {
		Site s = Sites.get(targetId);
		Infra i = s == null ? Infras.get(targetId) : null;
		Pile p = s != null ? pileOf(s) : i != null ? pileOf(i) : null;
		if (p == null) {
			return Map.of();
		}
		ServerLevel level = Sites.levelOf(srv, p.dimension);
		FeedOrder.Reserve reserve = new FeedOrder.Reserve();
		for (Object t : targets(srv, p)) {
			Builder.Run r = run(srv, t);
			if (r == null) {
				continue;
			}
			boolean leaving = Groups.leaving(idOf(t));
			if (idOf(t).equals(targetId)) {
				if (leaving) {
					return Map.of(); // C29: being removed, it is fed nothing
				}
				Map<String, Integer> out = new TreeMap<>();
				r.unbuilt.forEach((k, v) -> {
					if (v > 0) {
						out.put(k, reserve.available(k, p.ledger::stock));
					}
				});
				return out;
			}
			if (leaving) {
				continue; // C29: its reservation was released
			}
			boolean paused = t instanceof Site x ? x.construction().paused() : ((Infra) t).construction().paused();
			reserve.add(t instanceof Infra ri && RegionTargets.is(ri) ? RegionTargets.reservation(srv, ri, r) : r.unbuilt, FeedOrder.reserves(true, paused, r
				.pending(), level == null || r.frontierLoaded(level, ticks)));
		}
		return Map.of();
	}

	// ------------------------------------------------------------------ views

	/** The API's view of a stockpile, by item id ({@code Views.stockpile} maps the ids to items). */
	public record View(String owner, String dimension, List<BlockPos> crates, int capacityStacks, int usedStacks, Map<String, Integer> stock,
		Map<String, Integer> reserved, Map<String, Integer> credit, Map<String, Integer> delivered, Map<String, Integer> consumed,
		Map<String, Integer> returned, Map<String, Integer> withdrawn, Map<String, Integer> dropped, Map<String, Integer> refundOverflow,
		Map<String, Map<String, Integer>> outstandingByTarget, Map<String, Integer> outstanding, List<String> feedOrder, List<BlockPos> missingCrates,
		Map<String, dev.larattalabs.architect.api.SiteWait> waiting) {
	}

	public static @Nullable View view(MinecraftServer srv, String owner) {
		Pile p = get(owner);
		if (p == null) {
			return null;
		}
		Map<String, Map<String, Integer>> byT = new LinkedHashMap<>();
		Map<String, Integer> total = new TreeMap<>();
		for (Object t : targets(srv, p)) {
			if (Groups.leaving(idOf(t))) {
				continue; // C29: being removed, it needs nothing more (it stays in feedOrder until its record goes)
			}
			Builder.Run r = run(srv, t);
			Map<String, Integer> out = new TreeMap<>();
			if (r != null) {
				r.unbuilt.forEach((k, v) -> {
					if (v > 0) {
						out.put(k, v);
						total.merge(k, v, Integer::sum);
					}
				});
			}
			byT.put(idOf(t), out);
		}
		// (6c RS) a survival region's bodies' pending charge: listed as its own outstanding ({region}:fluids), until the bodies are written
		dev.larattalabs.architect.region.RegionFluids.pendingCharges(p.owner).forEach((id, m) -> {
			byT.put(id, new TreeMap<>(m));
			m.forEach((k, v) -> total.merge(k, v, Integer::sum));
		});
		// (7a GM-a2) a survival region's gate mechanism's bill: its own outstanding ({region}:mech:{lot}), until it is charged
		MechCharges.pendingCharges(p.owner).forEach((id, m) -> {
			byT.put(id, new TreeMap<>(m));
			m.forEach((k, v) -> total.merge(k, v, Integer::sum));
		});
		// C25 per target (Y2's SiteWaits, fed by this stockpile's supply)
		Map<String, dev.larattalabs.architect.api.SiteWait> waits = new LinkedHashMap<>();
		for (String id : byT.keySet()) {
			dev.larattalabs.architect.api.SiteWait w = SiteWaits.view(srv, id);
			if (w != null) {
				waits.put(id, w);
			}
		}
		Map<String, Integer> stock = p.ledger.stock();
		Map<String, Integer> reserved = new TreeMap<>();
		LAST_RESERVED.getOrDefault(p.id, Map.of()).forEach((k, v) -> {
			int r = Math.min(v, stock.getOrDefault(k, 0));
			if (r > 0) {
				reserved.put(k, r);
			}
		});
		Map<String, Integer> credit = new TreeMap<>();
		stock.forEach((k, v) -> {
			int c = v - total.getOrDefault(k, 0);
			if (c > 0) {
				credit.put(k, c);
			}
		});
		return new View(owner, p.dimension, p.crates(), capacity(srv, p), p.ledger.usedStacks(Stockpiles::maxStack), stock, reserved, credit,
			p.ledger.delivered(), p.ledger.consumed(), p.ledger.returned(), p.ledger.withdrawn(), p.ledger.dropped(), p.ledger.refundOverflow(), byT, total,
			List.copyOf(p.order), missing(srv, p), waits);
	}

	/** The DevBridge's and the crate screen's view of a stockpile (also the API's source). */
	public static @Nullable JsonObject json(MinecraftServer srv, String owner) {
		Pile p = get(owner);
		if (p == null) {
			return null;
		}
		JsonObject o = new JsonObject();
		o.addProperty("owner", owner);
		o.addProperty("dimension", p.dimension);
		JsonArray cr = new JsonArray();
		p.crates.forEach(c -> {
			JsonArray a = new JsonArray();
			a.add(c.x());
			a.add(c.y());
			a.add(c.z());
			cr.add(a);
		});
		o.add("crates", cr);
		JsonArray miss = new JsonArray();
		missing(srv, p).forEach(b -> {
			JsonArray a = new JsonArray();
			a.add(b.getX());
			a.add(b.getY());
			a.add(b.getZ());
			miss.add(a);
		});
		o.add("missingCrates", miss);
		o.addProperty("capacityStacks", capacity(srv, p));
		o.addProperty("usedStacks", p.ledger.usedStacks(Stockpiles::maxStack));
		o.add("stock", Builder.counts(p.ledger.stock()));
		Map<String, Integer> need = unbuiltAll(srv, p);
		o.add("outstanding", Builder.counts(need));
		o.add("credit", Builder.counts(credit(srv, p)));
		o.addProperty("id", p.id);
		o.add("reserved", Builder.counts(LAST_RESERVED.getOrDefault(p.id, Map.of())));
		JsonObject l = p.ledger.toJson();
		l.remove("credited");
		o.add("ledger", l);
		o.addProperty("creditedKeys", p.ledger.creditedKeys().size());
		o.addProperty("identity", p.ledger.identityHolds());
		JsonArray f = new JsonArray();
		JsonObject byT = new JsonObject();
		for (Object t : targets(srv, p)) {
			f.add(idOf(t));
			Builder.Run r = run(srv, t);
			JsonObject x = new JsonObject();
			if (r != null) {
				Map<String, Integer> out = new TreeMap<>();
				r.unbuilt.forEach((k, v) -> {
					if (v > 0) {
						out.put(k, v);
					}
				});
				x.add("outstanding", Builder.counts(out));
				x.addProperty("built", r.built.cardinality());
				x.addProperty("queued", r.size());
				ServerLevel lv = Sites.levelOf(srv, p.dimension);
				boolean paused = t instanceof Site st ? st.construction().paused() : ((Infra) t).construction().paused();
				boolean fl = lv != null && r.frontierLoaded(lv, ticks);
				boolean leaving = Groups.leaving(idOf(t));
				x.addProperty("paused", paused);
				x.addProperty("frontierLoaded", fl);
				x.addProperty("leaving", leaving); // C29: a removal started on it: out of the feed
				x.addProperty("reserves", !leaving && FeedOrder.reserves(true, paused, r.pending(), fl));
			}
			byT.add(idOf(t), x);
		}
		o.add("feedOrder", f);
		o.add("targets", byT);
		o.addProperty("overflowDroppedThisSession", OVERFLOW_DROPPED.getOrDefault(p.id, 0));
		return o;
	}

	// ------------------------------------------------------------------ dev hooks (DevBridge dev.stockpile.*)

	private static BlockPos pos(JsonArray a) {
		return new BlockPos(a.get(0).getAsInt(), a.get(1).getAsInt(), a.get(2).getAsInt());
	}

	private static Map<String, Integer> counts(@Nullable JsonObject o) {
		Map<String, Integer> m = new TreeMap<>();
		if (o != null) {
			o.entrySet().forEach(e -> m.put(e.getKey(), e.getValue().getAsInt()));
		}
		return m;
	}

	/**
	 * The DevBridge's stockpile hooks (docs/DEVBRIDGE.md, 6c Y1): {@code op} is create | addcrate | removecrate | state | order |
	 * withdraw | adopt | dissolve | audit | saved. Server thread; {@code player}: the client's player (withdraw, dissolve to the
	 * player, the dimension of create). Refusals come back as {@code {refused: {reason, message}}}.
	 */
	public static JsonObject dev(MinecraftServer srv, ServerPlayer player, String op, JsonObject req) {
		JsonObject o = new JsonObject();
		String owner = req.has("owner") ? req.get("owner").getAsString() : null;
		try {
			switch (op) {
				case "create" -> {
					List<BlockPos> cr = new ArrayList<>();
					if (req.has("crates")) {
						req.getAsJsonArray("crates").forEach(e -> cr.add(pos(e.getAsJsonArray())));
					}
					String dim = req.has("dimension") ? req.get("dimension").getAsString() : Sites.dimensionId((ServerLevel) player.level());
					create(srv, owner, dim, cr);
				}
				case "addcrate" -> addCrate(srv, owner, req.has("dimension") ? req.get("dimension").getAsString() : Sites.dimensionId((ServerLevel) player
					.level()), pos(req.getAsJsonArray("pos")));
				case "removecrate" -> {
					CrateRemoval r = removeCrate(srv, owner, pos(req.getAsJsonArray("pos")), req.has("force") && req.get("force").getAsBoolean());
					o.addProperty("removed", r.removed());
					o.add("dropped", Builder.counts(r.dropped()));
					if (r.refusal() != null) {
						o.addProperty("refusal", r.refusal());
					}
					o.addProperty("ended", r.ended());
				}
				case "order" -> {
					if (req.has("ids")) {
						List<String> ids = new ArrayList<>();
						req.getAsJsonArray("ids").forEach(e -> ids.add(e.getAsString()));
						setFeedOrder(srv, owner, ids);
					}
				}
				case "withdraw" -> o.add("withdrawn", Builder.counts(withdraw(srv, owner, counts(req.getAsJsonObject("items")), player)));
				case "adopt" -> adopt(srv, owner);
				case "dissolve" -> {
					JsonObject last = null;
					o.add("out", Builder.counts(dissolve(srv, owner, req.has("toPlayer") && req.get("toPlayer").getAsBoolean() ? player : null)));
					last = LAST_DISSOLVED.values().stream().filter(x -> owner.equals(x.get("owner").getAsString())).reduce((a, b) -> b).orElse(null);
					if (last != null) {
						o.add("ledgerAtEnd", last.get("ledger"));
					}
				}
				case "audit" -> {
					return audit(srv, player, owner, req);
				}
				case "pause" -> Builder.pauseTarget(srv, req.get("site").getAsString(), !req.has("paused") || req.get("paused").getAsBoolean()); // C29: Sites.pause's path
				case "tickets" -> {
					// dev: the vanilla tickets on a chunk (what keeps it loaded)
					BlockPos at = pos(req.getAsJsonArray("pos"));
					ServerLevel lv = (ServerLevel) player.level();
					net.minecraft.world.level.TicketStorage ts = lv.getDataStorage().computeIfAbsent(net.minecraft.world.level.TicketStorage.TYPE);
					long key = net.minecraft.world.level.ChunkPos.pack(at.getX() >> 4, at.getZ() >> 4);
					o.addProperty("loaded", lv.isLoaded(at));
					o.addProperty("loading", ts.getTicketDebugString(key, false));
					o.addProperty("simulation", ts.getTicketDebugString(key, true));
					return o;
				}
				case "saved" -> {
					JsonObject f = savedJson();
					o.add("file", f == null ? new JsonObject() : f);
					o.add("loaded", LOADED == null ? new JsonObject() : LOADED);
					o.addProperty("saves", saves);
					o.addProperty("worldSaves", worldSaves);
					o.addProperty("lastWorldSaveMs", lastWorldSaveMs);
					o.addProperty("maxWorldSaveMs", maxWorldSaveMs);
					o.addProperty("bookRefreshes", bookRefreshes);
					o.addProperty("lastBookMs", lastBookMs);
					o.addProperty("maxBookMs", maxBookMs);
					o.addProperty("playerSaves", playerSaves);
					o.addProperty("lastPlayerSaveMs", lastPlayerSaveMs);
					o.addProperty("maxPlayerSaveMs", maxPlayerSaveMs);
					o.addProperty("periodicSaves", periodicSaves); // (PS)
					o.addProperty("lastPeriodicMs", lastPeriodicMs);
					o.addProperty("maxPeriodicMs", maxPeriodicMs);
					o.addProperty("medianPeriodicMs", periodicMedianMs());
					o.addProperty("unsaved", unsaved);
					o.addProperty("loadFailed", loadFailed);
					if (loadFailedWhy != null) {
						o.addProperty("loadFailedWhy", loadFailedWhy);
					}
					o.addProperty("format", FORMAT);
					return o;
				}
				case "ps" -> {
					// (PS, TEST) the gate's before-the-fix cases
					if (req.has("noPeriodic")) {
						testNoPeriodic = req.get("noPeriodic").getAsBoolean();
						testNoJoinSave = testNoPeriodic;
					}
					if (req.has("joinSave")) {
						testNoJoinSave = !req.get("joinSave").getAsBoolean(); // (RL) the save on join on or off on its own
					}
					if (req.has("noCreditSave")) {
						testNoCreditSave = req.get("noCreditSave").getAsBoolean();
					}
					if (req.has("resetPeriodic") && req.get("resetPeriodic").getAsBoolean()) {
						periodicSaves = 0;
						lastPeriodicMs = 0;
						maxPeriodicMs = 0;
						synchronized (PERIODIC_MS) {
							PERIODIC_MS.clear();
						}
					}
					o.addProperty("noPeriodic", testNoPeriodic);
					o.addProperty("joinSave", !testNoJoinSave);
					o.addProperty("noCreditSave", testNoCreditSave);
					return o;
				}
				case "state" -> {
				}
				default -> throw new IllegalArgumentException("unknown stockpile op " + op);
			}
		} catch (Sites.SiteException e) {
			JsonObject r = new JsonObject();
			r.addProperty("reason", e.reason().name());
			r.addProperty("message", e.getMessage());
			o.add("refused", r);
		}
		JsonObject st = owner == null ? null : json(srv, owner);
		o.add("stockpile", st == null ? com.google.gson.JsonNull.INSTANCE : st);
		return o;
	}

	/**
	 * The gate's conservation parts (6c Y1 gate items 4-9, 12), per item: the stockpile's stock; the cost of every paid cell
	 * standing in the owner's construction sites and roads (built, not placed free; a swap cell still holding its old paid block
	 * at the old block's cost); the stock of the owner's legacy crates; item entities, container contents (hoppers, chests:
	 * crates excluded) in the box {@code min..max}; the player's inventory. The driver adds the blocks it placed by hand.
	 */
	static JsonObject audit(MinecraftServer srv, ServerPlayer player, @Nullable String owner, JsonObject req) {
		JsonObject o = new JsonObject();
		ServerLevel level = (ServerLevel) player.level();
		Pile p = owner == null ? null : get(owner);
		o.add("stock", Builder.counts(p == null ? Map.of() : p.ledger.stock()));
		if (p != null) {
			JsonObject l = p.ledger.toJson();
			l.remove("credited");
			o.add("ledger", l);
			o.addProperty("identity", p.ledger.identityHolds());
		}
		Map<String, Integer> paid = new TreeMap<>();
		Map<String, Integer> retaken = new TreeMap<>();
		Map<String, Integer> crateStock = new TreeMap<>();
		java.util.Set<BlockPos> crates = new java.util.HashSet<>();
		JsonObject byTarget = new JsonObject();
		// active and pending (removed, restore maybe unfinished: what still stands counts) records alike; a restored cell isn't built
		List<Site> recs = new ArrayList<>(Sites.all());
		for (Site ps : Sites.pendingSites()) {
			if (Sites.get(ps.id()) == null) {
				recs.add(ps);
			}
		}
		for (Site s : recs) {
			if (owner == null || !owner.equals(s.owner()) || s.construction() == null || s.placing()) {
				continue;
			}
			Builder.Run r = Builder.run(srv, s);
			if (r == null) {
				continue;
			}
			// (XR) less the cells a later writer of its survival region owns (that writer counts them)
			Map<String, Integer> one = Builder.paidStanding(level, s, r, RegionOverwrites.shadowedCells(srv, level, s.group(), s.id(), s.placedAt(), r, false));
			one.forEach((k, v) -> paid.merge(k, v, Integer::sum));
			byTarget.add(s.id(), Builder.counts(one));
			Map<String, Integer> back = RegionTargets.RETAKEN.get(s.id()); // (XR) a lot's paid cells a later writer of its region took up
			if (back != null) {
				back.forEach((k, v) -> retaken.merge(k, v, Integer::sum));
			}
			CrateBlockEntity be = Builder.crate(level, s, false);
			if (be != null && crates.add(be.getBlockPos())) {
				be.ledger().stock().forEach((k, v) -> crateStock.merge(k, v, Integer::sum));
			}
		}
		List<Infra> infs = new ArrayList<>(Infras.all());
		for (Infra pi : Infras.allPending()) {
			if (Infras.get(pi.id()) == null) {
				infs.add(pi);
			}
		}
		for (Infra i : infs) {
			if (owner == null || !owner.equals(i.owner()) || i.construction() == null || i.placing()) {
				continue;
			}
			Builder.Run r = RoadBuilder.run(srv, i);
			if (r == null) {
				continue;
			}
			r.rescan(level, false, true); // never loads a chunk
			Map<String, Integer> one = new TreeMap<>();
			var shadow = RegionOverwrites.shadowedCells(srv, level, i.group(), i.id(), i.placedAt(), r, false); // (XR) a later writer's
			for (int q = r.built.nextSetBit(0); q >= 0; q = r.built.nextSetBit(q + 1)) {
				if (shadow.contains(r.pos(q).asLong())) {
					continue;
				}
				r.cost.get(q).forEach(x -> one.merge(x.item(), x.count(), Integer::sum));
			}
			one.forEach((k, v) -> paid.merge(k, v, Integer::sum));
			byTarget.add(i.id(), Builder.counts(one));
			Map<String, Integer> back = RegionTargets.RETAKEN.get(i.id()); // (XL) given back when a later target wrote over its paid cells
			if (back != null) {
				back.forEach((k, v) -> retaken.merge(k, v, Integer::sum));
			}
			CrateBlockEntity be = Builder.crate(level, RoadBuilder.probe(i), false);
			if (be != null && crates.add(be.getBlockPos())) {
				be.ledger().stock().forEach((k, v) -> crateStock.merge(k, v, Integer::sum));
			}
		}
		// (6c RS) a survival region's standing lava sources (a lava bucket less its bucket each) and grates: what its bodies took
		Map<String, Integer> fluids = dev.larattalabs.architect.region.RegionFluids.survivalStanding(srv, owner);
		if (!fluids.isEmpty()) {
			fluids.forEach((k, v) -> paid.merge(k, v, Integer::sum));
			JsonObject fo = new JsonObject();
			fluids.forEach(fo::addProperty);
			o.add("fluidStanding", fo);
		}
		// (7a GM-a2) a survival region's charged gate mechanisms as they stand
		Map<String, Integer> mech = MechCharges.standing(srv, owner);
		if (!mech.isEmpty()) {
			mech.forEach((k, v) -> paid.merge(k, v, Integer::sum));
			JsonObject mo = new JsonObject();
			mech.forEach(mo::addProperty);
			o.add("mechStanding", mo);
		}
		o.add("paidStanding", Builder.counts(paid));
		o.add("paidByTarget", byTarget);
		JsonObject rc = new JsonObject(); // (RL, dev) what this world's start reconciled, per target
		LAST_RECONCILE.forEach(rc::add);
		o.add("reconciled", rc);
		o.addProperty("uncleanStart", SiteDeltas.lastStartUnclean);
		o.add("retaken", Builder.counts(retaken)); // (XL, dev) items given back this session as later targets wrote over paid cells
		o.add("legacyCrateStock", Builder.counts(crateStock));
		Map<String, Integer> ents = new TreeMap<>();
		Map<String, Integer> cont = new TreeMap<>();
		JsonArray crateBlocks = new JsonArray();
		if (req.has("min") && req.has("max")) {
			BlockPos a = pos(req.getAsJsonArray("min"));
			BlockPos b = pos(req.getAsJsonArray("max"));
			net.minecraft.world.phys.AABB box = new net.minecraft.world.phys.AABB(a.getX(), a.getY(), a.getZ(), b.getX() + 1, b.getY() + 1, b.getZ() + 1);
			int stacks = 0;
			for (net.minecraft.world.entity.item.ItemEntity e : level.getEntitiesOfClass(net.minecraft.world.entity.item.ItemEntity.class, box)) {
				stacks++;
				ents.merge(net.minecraft.core.registries.BuiltInRegistries.ITEM.getKey(e.getItem().getItem()).toString(), e.getItem().getCount(), Integer::sum);
			}
			o.addProperty("entityStacks", stacks);
			o.add("crateBlocks", crateBlocks);
			for (int cx = a.getX() >> 4; cx <= b.getX() >> 4; cx++) {
				for (int cz = a.getZ() >> 4; cz <= b.getZ() >> 4; cz++) {
					if (!level.hasChunk(cx, cz)) {
						continue;
					}
					for (BlockEntity be : level.getChunk(cx, cz).getBlockEntities().values()) {
						BlockPos bp = be.getBlockPos();
						boolean in = bp.getX() >= a.getX() && bp.getX() <= b.getX() && bp.getY() >= a.getY() && bp.getY() <= b.getY() && bp.getZ() >= a.getZ() && bp
							.getZ() <= b.getZ();
						if (in && be instanceof CrateBlockEntity crate) {
							JsonObject cb = new JsonObject();
							cb.addProperty("pos", bp.getX() + "," + bp.getY() + "," + bp.getZ());
							cb.addProperty("owner", crate.siteId());
							crateBlocks.add(cb);
						}
						if (be instanceof net.minecraft.world.Container c && !(be instanceof CrateBlockEntity) && in) {
							for (int k = 0; k < c.getContainerSize(); k++) {
								ItemStack st = c.getItem(k);
								if (!st.isEmpty()) {
									cont.merge(net.minecraft.core.registries.BuiltInRegistries.ITEM.getKey(st.getItem()).toString(), st.getCount(), Integer::sum);
								}
							}
						}
					}
				}
			}
		}
		o.add("entities", Builder.counts(ents));
		o.add("containers", Builder.counts(cont));
		Map<String, Integer> inv = new TreeMap<>();
		var pi = player.getInventory();
		for (int k = 0; k < pi.getContainerSize(); k++) {
			ItemStack st = pi.getItem(k);
			if (!st.isEmpty()) {
				inv.merge(net.minecraft.core.registries.BuiltInRegistries.ITEM.getKey(st.getItem()).toString(), st.getCount(), Integer::sum);
			}
		}
		o.add("inventory", Builder.counts(inv));
		o.addProperty("gameTime", level.getGameTime());
		return o;
	}

	// ------------------------------------------------------------------ persistence

	static JsonObject toJson() {
		JsonObject root = new JsonObject();
		root.addProperty("format", FORMAT);
		root.addProperty("nextId", nextId);
		JsonArray a = new JsonArray();
		PILES.values().forEach(p -> a.add(p.toJson()));
		root.add("stockpiles", a);
		return root;
	}

	/** Writes the file now (a temp file, then a rename). */
	/** (JR, dev) explicit saves with the world: count, last and max time (ms). */
	// ------------------------------------------------------------------ (slice RL) the targets' cell books and the reconcile at load

	/** (RL) The server of the loaded world (the books are refreshed on its thread at each save). */
	static volatile @Nullable MinecraftServer SERVER;

	/** (RL) A feed target's credit key (its paid record's key). */
	static String keyOf(Object t) {
		return t instanceof Site s ? Builder.creditKey(s) : RoadBuilder.creditKey((Infra) t);
	}

	private static Construction constructionOf(Object t) {
		return t instanceof Site s ? s.construction() : ((Infra) t).construction();
	}

	/** (RL) The target's owed cells (its book's live bits) when its book indexes this run's queue, else null. */
	static java.util.@Nullable BitSet owedOf(Pile p, String key, Builder.Run r) {
		StockLedger.Book b = p.ledger.book(key);
		return b != null && b.fits(r.queue) ? b.owed() : null;
	}

	/** (RL) The owner's construction sites and roads this stockpile feeds or fed (crate-less, not placing), BUILT ones too. */
	private static List<Object> bookTargets(Pile p) {
		List<Object> out = new ArrayList<>();
		for (Site s : Sites.all()) {
			if (!s.placing() && pileOf(s) == p) {
				out.add(s);
			}
		}
		for (Infra i : Infras.all()) {
			if (!i.placing() && pileOf(i) == p) {
				out.add(i);
			}
		}
		return out;
	}

	/**
	 * (RL) Before each save of the file: every building target's book from its run (a quiet rescan first, so a cell a player mined or placed
	 * a moment ago is as it stands): the cells the run has read become known, and stand paid when built and not placed free. A cell the run
	 * has not read keeps what the last book said. A target no longer building has no book (its records are all paid). Server thread.
	 */
	static int refreshBooks(MinecraftServer srv) {
		int n = 0;
		for (Pile p : PILES.values()) {
			ServerLevel level = Sites.levelOf(srv, p.dimension);
			java.util.Set<String> keep = new java.util.HashSet<>();
			if (level != null) {
				for (Object t : bookTargets(p)) {
					if (!(t instanceof Site s ? s.building() : ((Infra) t).building())) {
						continue;
					}
					Builder.Run r = run(srv, t);
					if (r == null) {
						continue;
					}
					String key = keyOf(t);
					StockLedger.Book old = p.ledger.book(key);
					boolean fits = old != null && old.fits(r.queue);
					java.util.BitSet owed = fits ? old.owed() : new java.util.BitSet();
					r.attachOwed(owed);
					r.rescan(level, false, true);
					r.newlyCount = 0;
					java.util.BitSet known = fits ? (java.util.BitSet) old.known().clone() : new java.util.BitSet();
					java.util.BitSet standing = fits ? (java.util.BitSet) old.standing().clone() : new java.util.BitSet();
					java.util.BitSet free = constructionOf(t).free();
					for (int i = r.seen.nextSetBit(0); i >= 0 && i < r.size(); i = r.seen.nextSetBit(i + 1)) {
						known.set(i);
						standing.set(i, r.built.get(i) && !free.get(i));
					}
					p.ledger.book(key, new StockLedger.Book(java.util.Arrays.hashCode(r.queue), r.size(), known, standing, owed));
					keep.add(key);
					n++;
				}
			}
			p.ledger.retainBooks(keep);
		}
		return n;
	}

	/** (RL, dev) The books' refresh before each save: how many this session, the last and the longest (the coordinator's bound). */
	static volatile int bookRefreshes;
	static volatile double lastBookMs, maxBookMs;

	/** (RL, dev/state) What the last reconcile did, per target id. */
	static final Map<String, JsonObject> LAST_RECONCILE = new ConcurrentHashMap<>();

	/**
	 * (RL) At the world's start, after the sites, the stockpiles and the region targets loaded: every target's owed cells are attached to
	 * its run; after an unclean stop (the running marker was there) each target with a book is reconciled with the loaded world
	 * ({@link #reconcile}). Then the file is saved once (the books now say what stands). Server thread.
	 */
	static void reconcileAtStart(MinecraftServer srv) {
		LAST_RECONCILE.clear();
		long t0 = System.nanoTime();
		boolean unclean = SiteDeltas.lastStartUnclean;
		boolean any = false;
		for (Pile p : List.copyOf(PILES.values())) {
			ServerLevel level = Sites.levelOf(srv, p.dimension);
			if (level == null) {
				continue;
			}
			boolean moved = false;
			for (Object t : bookTargets(p)) {
				String key = keyOf(t);
				StockLedger.Book b = p.ledger.book(key);
				if (b == null) {
					continue;
				}
				Builder.Run r = run(srv, t);
				if (r == null || !b.fits(r.queue)) {
					Architect.LOGGER.warn("Stockpile {}: {}'s cell book indexes another queue; not reconciled", p.owner, idOf(t));
					p.ledger.book(key, null);
					continue;
				}
				r.attachOwed(b.owed());
				if (unclean) {
					try {
						moved |= reconcile(srv, level, p, t, key, r, b);
						any = true;
					} catch (RuntimeException e) {
						Architect.LOGGER.error("Stockpile {}: the reconcile of {} failed", p.owner, idOf(t), e);
					}
				}
			}
			if (moved) {
				changed(p);
			}
		}
		if (any) {
			saveWithWorld(srv); // (HF) as every explicit save: the players and the chunks with the ledger
			Architect.LOGGER.info("Stockpiles: the reconcile after an unclean stop took {} ms ({} target(s))", String.format(java.util.Locale.ROOT, "%.1f",
				(System.nanoTime() - t0) / 1e6), LAST_RECONCILE.size());
		}
	}

	/**
	 * (RL) One target after an unclean stop: the loaded world (its chunks loaded) against its book, cell by cell, over the cells the book
	 * knows, less the cells placed free and the cells another writer of its region owns (XR):
	 * <ul>
	 * <li>a cell that stands now but did not stand paid at the save (the world ahead of the ledger: built after the save and the ledger
	 * never charged it) is charged now from the stock, at its target's cost, in queue order while the stock affords it; the rest is owed
	 * (the feed charges it before it counts as built);</li>
	 * <li>a cell that stood paid at the save and is gone (the ledger ahead of the world: its chunk never reached the disk) gives its cost
	 * back to the stock, capped by the target's paid record and taken out of it, so the builder's new charge when it places the cell again is
	 * the only one.</li>
	 * </ul>
	 * A target that was built and now owes or lost cells builds again. The book then says what stands, so a second load changes nothing.
	 */
	static boolean reconcile(MinecraftServer srv, ServerLevel level, Pile p, Object t, String key, Builder.Run r, StockLedger.Book b) {
		String id = idOf(t);
		r.rescan(level, true); // every cell, its chunk loaded (as the sites check at the start)
		r.newlyCount = 0;
		Construction c = constructionOf(t);
		java.util.BitSet free = c.free();
		var shadow = t instanceof Site s ? RegionOverwrites.shadowedCells(srv, level, s.group(), s.id(), s.placedAt(), r, true)
			: RegionOverwrites.shadowedCells(srv, level, ((Infra) t).group(), id, ((Infra) t).placedAt(), r, true);
		java.util.BitSet stands = new java.util.BitSet();
		for (int i = 0; i < r.size(); i++) {
			if (!free.get(i) && !shadow.contains(r.pos(i).asLong()) && r.matches(level.getBlockState(r.pos(i)), i)) {
				stands.set(i);
			}
		}
		StockLedger.Plan plan = StockLedger.plan(b, stands, i -> free.get(i) || shadow.contains(r.pos(i).asLong()));
		java.util.BitSet ahead = plan.ahead();
		java.util.BitSet lost = plan.lost();
		int cap = capacity(srv, p);
		BlockPos fallback = dropAt(srv, p, p.crates.isEmpty() ? BlockPos.ZERO : p.crates.get(0).pos().above());
		// the ledger ahead: what the lost cells cost goes back (capped by the record), the builder charges them again as it places them
		Map<String, Integer> lostCost = new TreeMap<>();
		for (int i = lost.nextSetBit(0); i >= 0; i = lost.nextSetBit(i + 1)) {
			r.cost.get(i).forEach(x -> lostCost.merge(x.item(), x.count(), Integer::sum));
		}
		Map<String, Integer> back = lostCost.isEmpty() ? Map.of() : p.ledger.fromPaid(id, lostCost, t instanceof Site st ? st.placedAt() : ((Infra) t).placedAt());
		StockLedger.Credit cr = back.isEmpty() ? StockLedger.Credit.NONE : p.ledger.giveBack(back, cap, Stockpiles::maxStack);
		dropOverflow(srv, p, cr.overflow(), fallback);
		// the world ahead: charged now while the stock affords it, the rest owed
		java.util.BitSet owed = b.owed();
		owed.clear();
		Map<String, Integer> charged = new TreeMap<>();
		Map<String, Integer> owes = new TreeMap<>();
		Map<String, Integer> over = new TreeMap<>();
		for (int i = ahead.nextSetBit(0); i >= 0; i = ahead.nextSetBit(i + 1)) {
			List<SurvivalItems.Cost> cost = r.cost.get(i);
			Map<String, Integer> need = new TreeMap<>();
			cost.forEach(x -> need.merge(x.item(), x.count(), Integer::sum));
			if (need.entrySet().stream().allMatch(e -> p.ledger.stock(e.getKey()) >= e.getValue())) {
				for (SurvivalItems.Cost x : cost) {
					if (p.ledger.consume(x.item(), x.count(), cap, Stockpiles::maxStack, over)) {
						p.ledger.pay(key, x.item(), x.count());
					}
				}
				need.forEach((k, v) -> charged.merge(k, v, Integer::sum));
				r.markBuilt(i, true);
			} else {
				owed.set(i);
				r.markBuilt(i, false);
				need.forEach((k, v) -> owes.merge(k, v, Integer::sum));
			}
		}
		dropOverflow(srv, p, over, fallback);
		java.util.BitSet standing = (java.util.BitSet) stands.clone();
		standing.andNot(owed);
		java.util.BitSet known = new java.util.BitSet();
		known.set(0, r.size());
		p.ledger.book(key, new StockLedger.Book(b.queueHash(), b.size(), known, standing, owed));
		// a target being removed is not reopened (its removal takes its blocks; its refund is capped by the record, JR)
		boolean reopen = !c.building() && (!owed.isEmpty() || !lost.isEmpty()) && !Groups.leaving(id);
		if (reopen) {
			Construction nc = c.withState(Construction.BUILDING, c.crate());
			if (t instanceof Site s) {
				Sites.replace(srv, s.withConstruction(nc));
			} else {
				Infras.put(srv, ((Infra) t).withConstruction(nc));
			}
		}
		JsonObject o = new JsonObject();
		o.addProperty("key", key);
		o.addProperty("aheadCells", ahead.cardinality());
		o.addProperty("owedCells", owed.cardinality());
		o.addProperty("lostCells", lost.cardinality());
		o.add("charged", Builder.counts(charged));
		o.add("owes", Builder.counts(owes));
		o.add("creditedBack", Builder.counts(cr.returned()));
		o.add("overflow", Builder.counts(cr.overflow()));
		o.addProperty("reopened", reopen);
		LAST_RECONCILE.put(id, o);
		boolean moved = !ahead.isEmpty() || !lost.isEmpty();
		if (moved) {
			Architect.LOGGER.warn("Stockpile {}: reconciled {} after an unclean stop: {} cell(s) stood unpaid, charged {} and owes {} ({} cell(s)); {} paid "
				+ "cell(s) lost, credited back {}{}", p.owner, key, ahead.cardinality(), charged, owes, owed.cardinality(), lost.cardinality(), cr.returned(),
				reopen ? "; it builds again" : "");
		}
		return moved;
	}

	static volatile int worldSaves;
	static volatile double lastWorldSaveMs, maxWorldSaveMs;
	/** (HF, dev) the players' share of those saves: count, last and max time (ms). */
	static volatile int playerSaves;
	static volatile double lastPlayerSaveMs, maxPlayerSaveMs;

	/**
	 * (JR) An explicit ledger save outside the world's save (a crate, the feed order, a dissolve, an adoption, a region's bodies' charge or
	 * scoop): the loaded chunks are saved with it, as autosave saves them (its BEFORE_SAVE writes the file), so a crash after it never finds
	 * the ledger ahead of the world (consumption recorded for blocks the saved world lost). Server thread.
	 */
	static void saveWithWorld(MinecraftServer srv) {
		boolean quiet = quietSave;
		quietSave = false;
		if (loadFailed) {
			refusedSave();
			return; // (PS, F6) nothing of the stockpiles is written this session
		}
		long t0 = System.nanoTime();
		if (srv != null && srv.isSameThread()) {
			// (HF) the players first: a ledger save that booked a deposit (items out of an inventory) or a dissolve or withdraw (items into one)
			// is never on disk ahead of player.dat, so a crash after it neither dupes nor loses those items. saveAllChunks never saves players
			// (26.3: level.dat keeps only the singleplayer host's UUID; every player, the host too, is in playerdata/<uuid>.dat).
			long p0 = System.nanoTime();
			srv.getPlayerList().saveAll();
			double pms = (System.nanoTime() - p0) / 1e6;
			playerSaves++;
			lastPlayerSaveMs = pms;
			maxPlayerSaveMs = Math.max(maxPlayerSaveMs, pms);
			// (HF, N3) then the chunks, flushed (BEFORE_SAVE runs at saveAllChunks' head: it is skipped here), then the ledger: it is never on
			// disk ahead of the world's chunks either
			explicitSave = true;
			try {
				srv.saveAllChunks(true, true, false);
			} finally {
				explicitSave = false;
			}
			if (Fills.haltBeforeLedger()) {
				// (M5 FK, TEST kill point FK3) a crash inside the commit: the players and the chunks are on disk, the ledger is not
				Architect.LOGGER.error("Stockpiles: kill point FK3: the chunks flushed, halting before the ledger write (dev.journal.killAt)");
				Runtime.getRuntime().halt(7);
			}
		}
		save();
		double ms = (System.nanoTime() - t0) / 1e6;
		worldSaves++;
		lastWorldSaveMs = ms;
		maxWorldSaveMs = Math.max(maxWorldSaveMs, ms);
		if (!quiet || TRACE_SAVES) {
			Architect.LOGGER.info("Stockpiles: saved with the world's chunks in {} ms{}", String.format(java.util.Locale.ROOT, "%.1f", ms), quiet ? " (periodic)" : "");
		}
	}

	static void save() {
		Path d = dir;
		if (d == null) {
			return;
		}
		if (loadFailed) {
			refusedSave();
			return; // (PS, F6) the unreadable file is never overwritten (with an empty registry or anything else)
		}
		MinecraftServer sv = SERVER;
		if (sv != null && sv.isSameThread()) {
			try {
				long t0 = System.nanoTime();
				int n = refreshBooks(sv);
				double ms = (System.nanoTime() - t0) / 1e6;
				bookRefreshes++;
				lastBookMs = ms;
				maxBookMs = Math.max(maxBookMs, ms);
				if (n > 0 && (ms >= 5 || TRACE_SAVES || bookRefreshes <= 3)) {
					// (PS saves a changed ledger every 10 s while a build feeds: logged when slow, traced, or the first few; dev.stockpile.saved has all)
					Architect.LOGGER.info("Stockpiles: cell books of {} target(s) refreshed in {} ms", n, String.format(java.util.Locale.ROOT, "%.1f", ms));
				}
			} catch (RuntimeException e) {
				Architect.LOGGER.error("Stockpiles: the targets' cell books could not be refreshed; the last ones are saved", e);
			}
		}
		Path f = d.resolve(FILE);
		try {
			if (PILES.isEmpty() && !Files.exists(f)) {
				return; // a world that never had a stockpile keeps no file (0.17.0 worlds load unchanged)
			}
			Files.createDirectories(d);
			Path tmp = d.resolve(FILE + ".tmp");
			Files.writeString(tmp, GSON.toJson(toJson()), StandardCharsets.UTF_8);
			Files.move(tmp, f, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
			saves++;
			unsaved = false;
			lastSaveTick = ticks;
			if (TRACE_SAVES) {
				Architect.LOGGER.info("Stockpiles saved ({} stockpile(s), save #{})", PILES.size(), saves);
			}
		} catch (IOException e) {
			Architect.LOGGER.warn("Could not save {}", f, e);
		}
	}

	/** Logs every save (dev: ARCHITECT_TRACE_STOCKPILE=1; the gate's clean-stop check reads it). */
	static final boolean TRACE_SAVES = System.getenv("ARCHITECT_TRACE_STOCKPILE") != null;

	private static void load(MinecraftServer server) {
		SERVER = server;
		loadFrom(server.getWorldPath(LevelResource.ROOT).resolve("architect"));
	}

	/** (PS) The registry from {@code <d>/stockpiles.json} (the world's architect dir); the save guard set when it can't be read. Tests call it. */
	static void loadFrom(Path d) {
		dir = d;
		PILES.clear();
		nextId = 1;
		loadFailed = false;
		loadFailedWhy = null;
		refusedLogged = false;
		Path f = dir.resolve(FILE);
		if (!Files.isRegularFile(f)) {
			return;
		}
		String why = loadFile(f);
		if (why != null) {
			// (PS, F6, F11) nothing loaded, nothing saved: the file stays as it is
			PILES.clear();
			nextId = 1;
			loadFailed = true;
			loadFailedWhy = why;
			Architect.LOGGER.error("Stockpiles: could not load {} ({}). No stockpile is loaded and none is saved this session, so the file is kept as it"
				+ " is; fix it or restore {} and reopen the world", f, why, FILE + ".bak");
			SaveGuards.failed(FILE, why);
		}
	}

	/** (PS) Loads the file into the registry; null when it loaded (then it is kept as {@code .bak}), else why not (the registry unchanged or partial). */
	static @Nullable String loadFile(Path f) {
		JsonObject root;
		try {
			root = JsonParser.parseString(Files.readString(f, StandardCharsets.UTF_8)).getAsJsonObject();
		} catch (IOException | RuntimeException e) {
			Architect.LOGGER.warn("Could not read {}", f, e);
			return "unreadable: " + e.getClass().getSimpleName() + (e.getMessage() == null ? "" : ": " + e.getMessage());
		}
		String newer = newerFormat(root);
		if (newer != null) {
			return newer;
		}
		try {
			readInto(root); // a pile that fails midway fails the whole file (the caller clears what was read)
		} catch (RuntimeException e) {
			Architect.LOGGER.warn("Could not read {}", f, e);
			return "a stockpile could not be read: " + e.getClass().getSimpleName() + (e.getMessage() == null ? "" : ": " + e.getMessage());
		}
		LOADED = root.deepCopy();
		Architect.LOGGER.info("Stockpiles: {} loaded (format {})", PILES.size(), root.has("format") ? root.get("format").getAsString() : "none");
		try {
			Files.copy(f, f.resolveSibling(FILE + ".bak"), StandardCopyOption.REPLACE_EXISTING); // (PS, F6) the last file that loaded
		} catch (IOException e) {
			Architect.LOGGER.warn("Could not keep {}.bak", f, e);
		}
		return null;
	}

	/** (PS, F11) Why a file's format is refused (newer than {@link #FORMAT}, or not a number); null when this reader reads it. */
	static @Nullable String newerFormat(JsonObject root) {
		if (!root.has("format")) {
			return null; // a pre-release file (Y1): read as format 1
		}
		int fmt;
		try {
			fmt = root.get("format").getAsInt();
		} catch (RuntimeException e) {
			return "format " + root.get("format") + " is not a number";
		}
		return fmt > FORMAT ? "format " + fmt + " was written by a newer Architect (this one reads up to " + FORMAT + ")" : null;
	}

	/** (PS) Whether the file failed to load this session (dev, status). */
	public static boolean loadFailed() {
		return loadFailed;
	}

	private static boolean refusedLogged;

	private static void refusedSave() {
		if (!refusedLogged) {
			refusedLogged = true;
			Architect.LOGGER.error("Stockpiles: not saved: {} failed to load this session ({}); the file is kept as it is", FILE, loadFailedWhy);
		}
	}

	/**
	 * Reads a parsed {@code stockpiles.json} into the registry (replacing it). Ids already in the file are never handed out again; a
	 * stockpile without an id (a file of a pre-release Y1 build) gets the next free one. Pure apart from the registry.
	 */
	static void readInto(JsonObject root) {
		PILES.clear();
		nextId = root.has("nextId") ? root.get("nextId").getAsLong() : 1;
		if (root.has("stockpiles")) {
			for (JsonElement e : root.getAsJsonArray("stockpiles")) {
				JsonObject x = e.getAsJsonObject();
				if (x.has("id") && x.get("id").getAsString().matches("sp\\d+")) {
					nextId = Math.max(nextId, Long.parseLong(x.get("id").getAsString().substring(2)) + 1);
				}
			}
			for (JsonElement e : root.getAsJsonArray("stockpiles")) {
				Pile p = Pile.fromJson(e.getAsJsonObject());
				PILES.put(p.id, p);
			}
		}
	}

	/** The id the next new stockpile gets (tests). */
	static String peekNextId() {
		return "sp" + nextId;
	}

	/** Dev: the file as this world session loaded it (the restart check compares it with the file the stop wrote). */
	static @Nullable JsonObject LOADED;

	/** Dev: the stockpile file as saved (the restart checks compare it). */
	static @Nullable JsonObject savedJson() {
		Path d = dir;
		if (d == null || !Files.isRegularFile(d.resolve(FILE))) {
			return null;
		}
		try {
			return JsonParser.parseString(Files.readString(d.resolve(FILE), StandardCharsets.UTF_8)).getAsJsonObject();
		} catch (IOException | RuntimeException e) {
			return null;
		}
	}

	static Map<String, Integer> asCounts(@Nullable JsonObject o) {
		Map<String, Integer> m = new HashMap<>();
		if (o != null) {
			o.entrySet().forEach(e -> m.put(e.getKey(), e.getValue().getAsInt()));
		}
		return m;
	}
}
