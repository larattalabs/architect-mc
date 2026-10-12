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

	private static final Map<String, Pile> PILES = new LinkedHashMap<>();
	private static @Nullable Path dir;
	private static long ticks;
	private static final Map<String, Integer> MAX_STACK = new ConcurrentHashMap<>();
	/** Dev hook: log every save of the file (the clean-stop check). */
	static volatile int saves;

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
		final String owner;
		final String dimension;
		final List<CrateRec> crates = new ArrayList<>();
		final StockLedger ledger;
		/** Target ids (sites, roads, delta sites), first fed first. */
		final List<String> order = new ArrayList<>();
		/** C25's saved waits (slice Y2): kept as they are. */
		JsonObject waits = new JsonObject();
		boolean dirty;
		long lastEvent = Long.MIN_VALUE / 2;

		Pile(String owner, String dimension, StockLedger ledger) {
			this.owner = owner;
			this.dimension = dimension;
			this.ledger = ledger;
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
			return PREFIX + owner;
		}

		JsonObject toJson() {
			JsonObject o = new JsonObject();
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
			Pile p = new Pile(o.get("owner").getAsString(), o.get("dimension").getAsString(), StockLedger.fromJson(o.has("ledger") ? o.getAsJsonObject(
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
		// the world-save callback that saves the chunks (autosave and stop): the ledger and the chunks are saved together
		ServerLifecycleEvents.BEFORE_SAVE.register((server, flush, force) -> save());
		// a clean stop: the ticks have ended; saved again here in case the stop's chunk save doesn't run BEFORE_SAVE (logged with the trace)
		ServerLifecycleEvents.SERVER_STOPPING.register(server -> {
			if (TRACE_SAVES) {
				Architect.LOGGER.info("Stockpiles: world stopping, saving");
			}
			save();
		});
		ServerLifecycleEvents.SERVER_STOPPED.register(s -> {
			PILES.clear();
			dir = null;
			ticks = 0;
		});
	}

	// ------------------------------------------------------------------ lookups

	public static @Nullable Pile get(@Nullable String owner) {
		return owner == null ? null : PILES.get(owner);
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
			return it == null ? 64 : new ItemStack(it).getMaxStackSize();
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
		if (!SurvivalWorld.on()) {
			throw new Sites.SiteException(Reason.NOT_ALLOWED, "a stockpile needs the survival toggle on (instant placements use none)");
		}
		Pile p = PILES.get(owner);
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
			p = new Pile(owner, dimension, new StockLedger());
			PILES.put(owner, p);
		}
		for (BlockPos c : add) {
			p.crates.add(putCrate(level, p, c));
		}
		p.dirty = true;
		save();
		Architect.LOGGER.info("Stockpile {}: {} in {} with {} crate(s){}", owner, created ? "created" : "updated", dimension, p.crates.size(), add.isEmpty() ? ""
			: " (+" + add.size() + ")");
		return p;
	}

	/** {@code addStockpileCrate}. */
	public static Pile addCrate(MinecraftServer srv, String owner, String dimension, BlockPos at) throws Sites.SiteException {
		Pile p = PILES.get(owner);
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
		level.setBlock(at, CrateBlocks.CRATE.defaultBlockState(), Sites.FLAGS);
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
		Pile p = PILES.get(owner);
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
			PILES.remove(owner);
		}
		p.dirty = true;
		save();
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
		Pile p = PILES.get(owner);
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
		Map<String, Integer> out = new TreeMap<>(p.ledger.stock());
		Map<String, Integer> toPlayer = new TreeMap<>();
		Map<String, Integer> toGround = new TreeMap<>();
		for (var e : out.entrySet()) {
			if (to != null) {
				int in = give(to, e.getKey(), e.getValue());
				p.ledger.withdraw(e.getKey(), in);
				if (in > 0) {
					toPlayer.put(e.getKey(), in);
				}
				int rest = e.getValue() - in;
				if (rest > 0) {
					p.ledger.drop(e.getKey(), rest);
					toGround.put(e.getKey(), rest);
				}
			} else {
				p.ledger.drop(e.getKey(), e.getValue());
				toGround.put(e.getKey(), e.getValue());
			}
		}
		if (to != null) {
			Builder.dropItems((ServerLevel) to.level(), to.blockPosition(), toGround, null);
		} else {
			Builder.dropItems(level, at, toGround, null);
		}
		for (CrateRec c : p.crates) {
			takeCrate(level, c);
		}
		JsonObject last = p.toJson();
		PILES.remove(owner);
		save();
		Architect.LOGGER.info("Stockpile {} dissolved: to the player {}, dropped {}; ledger at the end {}", owner, toPlayer, toGround, last.get("ledger"));
		dev.larattalabs.architect.apiimpl.ApiEvents.stockpileChanged(srv, owner);
		LAST_DISSOLVED.put(owner, last);
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
		Pile p = PILES.get(owner);
		if (p == null) {
			throw new Sites.SiteException(Reason.NOT_ALLOWED, owner + " has no stockpile");
		}
		reconcile(srv, p);
		return List.copyOf(p.order);
	}

	public static List<String> setFeedOrder(MinecraftServer srv, String owner, List<String> ids) throws Sites.SiteException {
		Pile p = PILES.get(owner);
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
		save();
		Architect.LOGGER.info("Stockpile {}: feed order {}", owner, p.order);
		return List.copyOf(p.order);
	}

	/** Per item, the unbuilt cost over every building target of the owner (paused ones too). */
	static Map<String, Integer> unbuiltAll(MinecraftServer srv, Pile p) {
		Map<String, Integer> out = new TreeMap<>();
		for (Object t : targets(srv, p)) {
			Builder.Run r = run(srv, t);
			if (r != null) {
				r.unbuilt.forEach((k, v) -> {
					if (v > 0) {
						out.merge(k, v, Integer::sum);
					}
				});
			}
		}
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
		Pile p = PILES.get(owner);
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

	/**
	 * {@code adoptCrates} (§5): every legacy crate of the owner (a building site's own crate, a group's shared crate, a delta's
	 * crate) joins the stockpile: its ledger is adopted (delivered and placed, so the stock grows by the crate's stock; what doesn't
	 * fit drops at the first crate, booked as dropped), its cell is restored and its journal kind released, and its targets lose
	 * their crate (they draw from the stockpile, joining the feed order at the end in placement order). Idempotent.
	 */
	public static Pile adopt(MinecraftServer srv, String owner) throws Sites.SiteException {
		Pile p = PILES.get(owner);
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
				Map<String, Integer> over = p.ledger.adopt("adopt:" + e.getKey() + "@" + cp.asLong(), l.delivered(), l.placed(), capacity(srv, p),
					Stockpiles::maxStack);
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
		save();
		Architect.LOGGER.info("Stockpile {}: adopted {} crate(s) ({} site(s), {} road(s)){}", owner, crates.size(), sites.size(), roads.size(), dropped
			.isEmpty() ? "" : "; over capacity, dropped " + dropped);
		return p;
	}

	// ------------------------------------------------------------------ inserting and refunds

	/**
	 * A stockpile crate's acceptance rule: what one unit of {@code item} would credit (itself or an equivalent the owner's building
	 * targets, pooled, still miss) and whether it fits; booked when {@code commit}. Null when nothing needs it or it doesn't fit.
	 */
	public static Ledger.@Nullable Accepted accept(MinecraftServer srv, String crateOwner, String item, boolean commit) {
		Pile p = PILES.get(crateOwner.substring(PREFIX.length()));
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
	}

	/**
	 * Credits refunds into the owner's stockpile once per {@code key} (§4): up to capacity returned, the rest dropped above the first
	 * present crate (else at {@code fallback}) and booked as refundOverflow. Returns what was credited; empty (already) for a key
	 * credited before.
	 */
	static StockLedger.Credit credit(MinecraftServer srv, Pile p, String key, Map<String, Integer> items, BlockPos fallback) {
		if (items.isEmpty() && !p.ledger.credited(key)) {
			return StockLedger.Credit.NONE;
		}
		StockLedger.Credit c = p.ledger.credit(key, items, capacity(srv, p), Stockpiles::maxStack);
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
			OVERFLOW_DROPPED.merge(p.owner, sumOf(over), Integer::sum);
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
	}

	private static void feed(MinecraftServer srv, ServerLevel level, Pile p) {
		List<Object> ts = targets(srv, p);
		if (ts.isEmpty()) {
			return;
		}
		FeedOrder.Reserve reserve = new FeedOrder.Reserve();
		int cap = capacity(srv, p);
		BlockPos fallback = dropAt(srv, p, p.crates.isEmpty() ? BlockPos.ZERO : p.crates.get(0).pos().above());
		for (Object t : ts) {
			Builder.Run r = run(srv, t);
			if (r == null) {
				continue;
			}
			boolean paused = t instanceof Site s ? s.construction().paused() : ((Infra) t).construction().paused();
			Builder.Purse purse = new Builder.Purse() {
				@Override
				public int stock(String item) {
					return reserve.available(item, p.ledger::stock);
				}

				@Override
				public void pay(List<SurvivalItems.Cost> costs) {
					Map<String, Integer> over = new TreeMap<>();
					for (SurvivalItems.Cost c : costs) {
						p.ledger.consume(c.item(), c.count(), cap, Stockpiles::maxStack, over);
					}
					dropOverflow(srv, p, over, fallback);
				}

				@Override
				public void giveBack(Map<String, Integer> items, BlockPos fb) {
					Stockpiles.giveBack(srv, p, items, fb);
				}

				@Override
				public void changed() {
					Stockpiles.changed(p);
				}
			};
			if (t instanceof Site s) {
				Builder.stepFed(srv, level, s, r, purse);
			} else {
				RoadBuilder.stepFed(srv, level, (Infra) t, r, purse);
			}
			boolean building = t instanceof Site s ? Sites.get(s.id()) != null && Sites.get(s.id()).building() : Infras.get(idOf(t)) != null && Infras.get(
				idOf(t)).building();
			boolean reserves = FeedOrder.reserves(building, paused, r.built.cardinality() < r.size(), r.frontierLoaded(level, ticks));
			reserve.add(r.unbuilt, reserves);
		}
		LAST_RESERVED.put(p.owner, reserve.reserved());
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
			if (idOf(t).equals(targetId)) {
				Map<String, Integer> out = new TreeMap<>();
				r.unbuilt.forEach((k, v) -> {
					if (v > 0) {
						out.put(k, reserve.available(k, p.ledger::stock));
					}
				});
				return out;
			}
			boolean paused = t instanceof Site x ? x.construction().paused() : ((Infra) t).construction().paused();
			reserve.add(r.unbuilt, FeedOrder.reserves(true, paused, r.built.cardinality() < r.size(), level == null || r.frontierLoaded(level, ticks)));
		}
		return Map.of();
	}

	// ------------------------------------------------------------------ views

	/** The API's view of a stockpile, by item id ({@code Views.stockpile} maps the ids to items). */
	public record View(String owner, String dimension, List<BlockPos> crates, int capacityStacks, int usedStacks, Map<String, Integer> stock,
		Map<String, Integer> reserved, Map<String, Integer> credit, Map<String, Integer> delivered, Map<String, Integer> consumed,
		Map<String, Integer> returned, Map<String, Integer> withdrawn, Map<String, Integer> dropped, Map<String, Integer> refundOverflow,
		Map<String, Map<String, Integer>> outstandingByTarget, Map<String, Integer> outstanding, List<String> feedOrder, List<BlockPos> missingCrates) {
	}

	public static @Nullable View view(MinecraftServer srv, String owner) {
		Pile p = PILES.get(owner);
		if (p == null) {
			return null;
		}
		Map<String, Map<String, Integer>> byT = new LinkedHashMap<>();
		Map<String, Integer> total = new TreeMap<>();
		for (Object t : targets(srv, p)) {
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
		Map<String, Integer> stock = p.ledger.stock();
		Map<String, Integer> reserved = new TreeMap<>();
		LAST_RESERVED.getOrDefault(owner, Map.of()).forEach((k, v) -> {
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
			List.copyOf(p.order), missing(srv, p));
	}

	/** The DevBridge's and the crate screen's view of a stockpile (also the API's source). */
	public static @Nullable JsonObject json(MinecraftServer srv, String owner) {
		Pile p = PILES.get(owner);
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
		o.add("reserved", Builder.counts(LAST_RESERVED.getOrDefault(owner, Map.of())));
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
				x.addProperty("paused", paused);
				x.addProperty("frontierLoaded", fl);
				x.addProperty("reserves", FeedOrder.reserves(true, paused, r.built.cardinality() < r.size(), fl));
			}
			byT.add(idOf(t), x);
		}
		o.add("feedOrder", f);
		o.add("targets", byT);
		o.addProperty("overflowDroppedThisSession", OVERFLOW_DROPPED.getOrDefault(owner, 0));
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
					last = LAST_DISSOLVED.get(owner);
					if (last != null) {
						o.add("ledgerAtEnd", last.get("ledger"));
					}
				}
				case "audit" -> {
					return audit(srv, player, owner, req);
				}
				case "pause" -> Builder.setPaused(srv, req.get("site").getAsString(), !req.has("paused") || req.get("paused").getAsBoolean());
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
		Pile p = owner == null ? null : PILES.get(owner);
		o.add("stock", Builder.counts(p == null ? Map.of() : p.ledger.stock()));
		if (p != null) {
			JsonObject l = p.ledger.toJson();
			l.remove("credited");
			o.add("ledger", l);
			o.addProperty("identity", p.ledger.identityHolds());
		}
		Map<String, Integer> paid = new TreeMap<>();
		Map<String, Integer> crateStock = new TreeMap<>();
		java.util.Set<BlockPos> crates = new java.util.HashSet<>();
		JsonObject byTarget = new JsonObject();
		for (Site s : Sites.all()) {
			if (owner == null || !owner.equals(s.owner()) || s.construction() == null || s.placing()) {
				continue;
			}
			Builder.Run r = Builder.run(srv, s);
			if (r == null) {
				continue;
			}
			Map<String, Integer> one = Builder.paidStanding(level, s, r);
			one.forEach((k, v) -> paid.merge(k, v, Integer::sum));
			byTarget.add(s.id(), Builder.counts(one));
			CrateBlockEntity be = Builder.crate(level, s, true);
			if (be != null && crates.add(be.getBlockPos())) {
				be.ledger().stock().forEach((k, v) -> crateStock.merge(k, v, Integer::sum));
			}
		}
		for (Infra i : Infras.all()) {
			if (owner == null || !owner.equals(i.owner()) || i.construction() == null || i.placing()) {
				continue;
			}
			Builder.Run r = RoadBuilder.run(srv, i);
			if (r == null) {
				continue;
			}
			r.rescan(level, true);
			Map<String, Integer> one = new TreeMap<>();
			for (int q = r.built.nextSetBit(0); q >= 0; q = r.built.nextSetBit(q + 1)) {
				r.cost.get(q).forEach(x -> one.merge(x.item(), x.count(), Integer::sum));
			}
			one.forEach((k, v) -> paid.merge(k, v, Integer::sum));
			byTarget.add(i.id(), Builder.counts(one));
			CrateBlockEntity be = Builder.crate(level, RoadBuilder.probe(i), true);
			if (be != null && crates.add(be.getBlockPos())) {
				be.ledger().stock().forEach((k, v) -> crateStock.merge(k, v, Integer::sum));
			}
		}
		o.add("paidStanding", Builder.counts(paid));
		o.add("paidByTarget", byTarget);
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
		root.addProperty("format", 1);
		JsonArray a = new JsonArray();
		PILES.values().forEach(p -> a.add(p.toJson()));
		root.add("stockpiles", a);
		return root;
	}

	/** Writes the file now (a temp file, then a rename). */
	static void save() {
		Path d = dir;
		if (d == null) {
			return;
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
		dir = server.getWorldPath(LevelResource.ROOT).resolve("architect");
		PILES.clear();
		Path f = dir.resolve(FILE);
		if (!Files.isRegularFile(f)) {
			return;
		}
		try {
			JsonObject root = JsonParser.parseString(Files.readString(f, StandardCharsets.UTF_8)).getAsJsonObject();
			if (root.has("stockpiles")) {
				for (JsonElement e : root.getAsJsonArray("stockpiles")) {
					Pile p = Pile.fromJson(e.getAsJsonObject());
					PILES.put(p.owner, p);
				}
			}
			LOADED = root.deepCopy();
			Architect.LOGGER.info("Stockpiles: {} loaded", PILES.size());
		} catch (IOException | RuntimeException e) {
			Architect.LOGGER.warn("Could not read {}; no stockpiles loaded", f, e);
		}
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
