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
	/** (DR-S, TEST) every explicit save with the world refused (SS's refusal), until turned off. */
	static volatile boolean testRefuseSave;
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
		/** Not final: (T0 review 4 P1-2) a payout whose ledger write failed restores it in place. Server thread. */
		StockLedger ledger;
		/** Target ids (sites, roads, delta sites), first fed first. */
		final List<String> order = new ArrayList<>();
		/** C25's saved waits (slice Y2): kept as they are. */
		JsonObject waits = new JsonObject();
		boolean dirty;
		/** (RL) A target joined the feed this pass: the ledger is saved after it. */
		boolean joined;
		/** (8a HB) The tick a refused save on join is tried again (0: now), and how many were refused in a row. */
		long joinRetryAt;
		int joinFails;
		/** (8a HB, kill point JS1) The ids of the targets that joined the feed since the last feed pass. */
		final List<String> fresh = new ArrayList<>();
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
		SaveEvidence.init(); // (slice SOFF) first: its BEFORE_SAVE starts each save's record
		SaveHold.init(); // (slice SOFF) its START_SERVER_TICK before Builder's fillsAtStart
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
		// the world-save callback that saves the chunks (autosave, /save-all and stop): the ledger and the chunks are saved together.
		// (J1, PS's leftover, audit N3) after them, not at BEFORE_SAVE (saveAllChunks' head, ahead of the chunk writes): an unflushed save
		// (autosave) only queues its chunk writes, so their IO is waited for first. The ledger is then never on disk ahead of the chunks
		// (a hopper's source saved full while the ledger counts the delivery: a dupe). The players are saved before the chunks
		// (saveEverything), as in HF's order.
		ServerLifecycleEvents.AFTER_SAVE.register((server, flush, force) -> {
			if (explicitSave) { // (HF) an explicit save writes the ledger itself, after the chunks are on disk
				return;
			}
			boolean timed = SaveTiming.on();
			long w0 = timed ? SaveTiming.started() : System.nanoTime();
			// (slice SOFF, review findings 4 and 5) only over a save that wrote every level and saved the players with it, as recorded while it
			// ran (SaveEvidence; never the noSave flags read afterwards): an autosave, /save-all and the stop qualify; a save that skipped a
			// level (saving off) or another mod's chunk save alone (force, no players) does not. The ledger stays pending
			String incoherent = SaveEvidence.worldSaveRefusal(server);
			if (incoherent != null) {
				savingOffRefusals++;
				if (!incoherent.equals(lastIncoherent)) {
					lastIncoherent = incoherent;
					SaveEvidence.log(flush ? "the world save" : "the autosave", incoherent);
				}
				if (timed) {
					SaveTiming.stop();
				}
				return;
			}
			lastIncoherent = null;
			boolean ioFailed = false;
			if (!flush) {
				long t0 = System.nanoTime();
				SaveTiming.at(SaveTiming.IO); // (SS) J1's wait is the autosave's IO wait
				for (ServerLevel l : server.getAllLevels()) {
					try {
						l.getChunkSource().chunkMap.synchronize(true).join();
					} catch (RuntimeException e) {
						// (SS, review finding 5) fail closed: no ledger write over chunk writes not known durable; the ledger stays pending
						ioFailed = true;
						Architect.LOGGER.error("Stockpiles: waiting for {}'s chunk writes failed; the ledger is not saved now", l.dimension(), e);
					}
				}
				SaveTiming.at(SaveTiming.OTHER);
				double ms = (System.nanoTime() - t0) / 1e6;
				autosaveWaits++;
				lastAutosaveWaitMs = ms;
				maxAutosaveWaitMs = Math.max(maxAutosaveWaitMs, ms);
			}
			if (haltBeforeAutosaveLedger) {
				// (J1, TEST kill point AS1, dev.stockpile.ps haltBeforeAutosaveLedger) an autosave's chunks on disk, its ledger not: the ledger behind the world (RL's reconcile, a loss
				// of at most the window's deliveries), never ahead of it
				Architect.LOGGER.error("Stockpiles: kill point AS1: the autosave's chunks written, halting before the ledger write");
				Runtime.getRuntime().halt(7);
			}
			// (SS) the ledger only over durable chunk writes: an autosave forces the chunk storages (J1's wait), a flushed save the entities too
			RegionDurability.retryOwed(); // (SS) an owed path (a close whose force failed) reopened and forced: a recovered disk clears it
			java.util.List<String> undurable = flush ? RegionDurability.undurable("chunk", "entities") : RegionDurability.undurable("chunk");
			if (ioFailed || !undurable.isEmpty()) {
				refuseUndurable(flush ? "the world save" : "the autosave", undurable);
				if (timed) {
					logTiming((flush ? "world save (flush)" : "autosave") + " REFUSED", w0, SaveTiming.stop());
				}
				return;
			}
			evidencedSave = true; // (SOFF) this save wrote every level (its evidence): save()'s flag check lets it through
			try {
				save();
			} finally {
				evidencedSave = false;
			}
			if (timed) {
				logTiming(flush ? "world save (flush)" : "autosave", w0, SaveTiming.stop());
			}
		});
		// (HF, F9) a logout saves that player (PlayerList.remove): a ledger change not saved yet (a deposit, a Take) is saved with the world
		// right after it, so a crash then never finds the player saved and the ledger rewound. Queued: it runs after the removal's save.
		net.fabricmc.fabric.api.networking.v1.ServerPlayConnectionEvents.DISCONNECT.register((handler, server) -> server.execute(() -> {
			if (unsaved && server.isRunning() && savingOffCheck(server, false, "a logout's save") == null) { // (SOFF) quiet under /save-off
				saveWithWorld(server);
			}
		}));
		// a clean stop: the ticks have ended; saved again here in case the stop's chunk save doesn't run BEFORE_SAVE (logged with the trace)
		// (T0 review 3 finding 1) no ledger save at SERVER_STOPPING: Fabric fires it at stopServer's head, before vanilla saves the players
		// (saveAll, then removeAll's logouts) and the chunks. The stop's ledger is the AFTER_SAVE of its saveAllChunks, last: players, then
		// chunks, then the ledger, held over any save that failed on the way
		ServerLifecycleEvents.SERVER_STOPPING.register(server -> {
			if (TRACE_SAVES) {
				Architect.LOGGER.info("Stockpiles: world stopping; the ledger is saved after the players and the chunks (the stop's world save)");
			}
		});
		ServerLifecycleEvents.SERVER_STOPPED.register(s -> {
			RegionDurability.worldClosed(); // (SS) nothing of this world is owed in the next one
			testCapacity = -1;
			ChunkDebt.worldClosed(); // (slice T0)
			PlayerSaves.worldClosed();
			SERVER = null;
			PILES.clear();
			dir = null;
			ledgerFile = null; // (slice T0) the next world reads its own
			ledgerDebt = null;
			savingOffLast = null; // (SOFF)
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
		return testCapacity >= 0 ? testCapacity : StockLedger.STACKS_PER_CRATE * present(srv, p).size();
	}

	/** (OVF) The player message when an insert into a stockpile over capacity is refused (hoppers stay silent: the pile's view shows it). */
	public static final String OVER_CAPACITY = "This stockpile is over capacity: use or take stock first";

	/** (OVF) Whether the stock is past capacity (a keyed refund put it there): nothing new enters until it fits. */
	static boolean overCapacity(MinecraftServer srv, Pile p) {
		return p.ledger.usedStacks(Stockpiles::maxStack) > capacity(srv, p);
	}

	/** (OVF) Whether the stockpile {@code id} names ({@code stockpile:<owner>} or a target drawing from it) is over capacity. */
	public static boolean overCapacity(MinecraftServer srv, String id) {
		Pile p = Builder.pileNamed(id);
		return p != null && overCapacity(srv, p);
	}

	/** (OVF) The pile's count line: "used of cap stacks", with "over capacity" while used > cap. Pure. */
	public static String capacityLabel(int used, int cap) {
		return used + " of " + cap + " stacks" + (used > cap ? " · over capacity" : "");
	}

	/** (OVF, TEST) {@code dev.stockpile.ps capacity}: every stockpile's capacity in stacks (-1: the crates', as normal). */
	static volatile int testCapacity = -1;

	/** (OVF) a log suffix when a keyed credit left the stock over capacity (nothing dropped: nothing new enters until it fits). */
	private static String usedOver(MinecraftServer srv, Pile p) {
		int used = p.ledger.usedStacks(Stockpiles::maxStack), cap = capacity(srv, p);
		return used > cap ? " (the stock now over capacity: " + used + " of " + cap + " stacks; nothing dropped)" : "";
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
		SaveHold.require(srv); // (slice SOFF) held while saving is off: refused before anything changes
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
		SaveHold.require(srv); // (slice SOFF) held while saving is off: refused before anything changes
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
		SaveHold.require(srv); // (slice SOFF) held while saving is off: refused before anything changes
		requirePileFree(owner);
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
		}
		boolean ended;
		if (drop.isEmpty()) {
			takeCrate(level, c);
			p.crates.remove(c);
			ended = p.crates.isEmpty();
			if (ended) {
				PILES.remove(p.id);
			}
			p.dirty = true;
			saveWithWorld(srv); // (JR) with the chunks, as autosave: the ledger never ahead of the world (nothing is paid out)
		} else {
			// (T0 review 5 item 2) a payout: what was pending saved first, then the debit made durable before the crate goes and the excess drops
			payoutPreSave(() -> saveWithWorld(srv));
			ended = removeCrateCore(p, c, drop, () -> saveLedgerFirst(srv, () -> {
				takeCrate(level, c);
				Builder.dropItems(level, at, drop, null);
			}));
		}
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
		SaveHold.require(srv); // (slice SOFF) held while saving is off: refused before anything changes
		requireNoDebt();
		requirePileFree(owner);
		Pile p = get(owner);
		if (p == null) {
			throw new Sites.SiteException(Reason.NOT_ALLOWED, owner + " has no stockpile");
		}
		String heldBy = CrateSettle.pileHeld(owner);
		if (heldBy != null) {
			// (T4b fix round, finding 6) a removal's refund is to be credited into it (its txn, or its durable stash): it stays until then
			throw new Sites.SiteException(Reason.SITE_BUSY, "held(other) " + heldBy + ": the stockpile of " + owner + " receives a removal's refund first");
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
		payoutPreSave(() -> saveWithWorld(srv)); // (J1) what was pending first, in HF's order: the save after the dissolve then holds only the dissolve
		Map<String, Integer> toPlayer = new TreeMap<>();
		Map<String, Integer> toGround = new TreeMap<>();
		// (T0 review 4 P1-2) ledger first: the pile's removal is durable before a crate is taken or an item dropped; a failed write puts the
		// player's inventory and the pile back exactly, then refuses
		Map<String, Integer> out = dissolveCore(p, to == null ? null : holder(to), toPlayer, toGround, () -> saveLedgerFirst(srv, () -> {
			if (to != null) {
				Builder.dropItems((ServerLevel) to.level(), to.blockPosition(), toGround, null);
			} else {
				Builder.dropItems(level, at, toGround, null);
			}
			for (CrateRec c : p.crates) {
				takeCrate(level, c);
			}
		}));
		JsonObject last = p.toJson();
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

	/**
	 * (T0 review 4 P1-2) A dissolve's ledger side: the stock split between {@code h} (null: all to the ground) and the ground, the pile out of
	 * the registry, then {@code publish} (which takes the crates and drops the ground items once the ledger is durable). When it fails the
	 * holder and the pile are restored exactly, in the same call, and the dissolve is refused.
	 */
	static Map<String, Integer> dissolveCore(Pile p, @Nullable Holder h, Map<String, Integer> toPlayer, Map<String, Integer> toGround,
		java.util.function.BooleanSupplier publish) throws Sites.SiteException {
		JsonObject before = p.ledger.toJson();
		Object snap = h == null ? null : h.snapshot();
		Map<String, Integer> out = dissolveLedger(p.ledger, h == null ? null : h::give, toPlayer, toGround);
		Map<String, Pile> order = new LinkedHashMap<>(PILES);
		PILES.remove(p.id);
		if (!publish.getAsBoolean()) {
			if (h != null) {
				h.restore(snap);
			}
			p.ledger = StockLedger.fromJson(before);
			PILES.clear();
			PILES.putAll(order); // back in its place
			toPlayer.clear();
			toGround.clear();
			changed(p);
			compensate("the dissolve of " + p.owner + " was refused"); // (T0 review 5 item 1) the pile back on disk too
			throw new Sites.SiteException(Reason.NOT_ALLOWED, "the stockpile ledger could not be saved durably; nothing was dissolved (try again)");
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
		SaveHold.require(srv); // (slice SOFF) held while saving is off: refused before anything changes
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
		return unbuilt(srv, p, false);
	}

	/** (OVF) {@link #unbuiltAll} over the active (unpaused) targets only, with the regions' and mechanisms' pending charges. */
	static Map<String, Integer> unbuiltActive(MinecraftServer srv, Pile p) {
		return unbuilt(srv, p, true);
	}

	private static Map<String, Integer> unbuilt(MinecraftServer srv, Pile p, boolean activeOnly) {
		Map<String, Integer> out = new TreeMap<>();
		for (Object t : targets(srv, p)) {
			if (Groups.leaving(idOf(t))) {
				continue;
			}
			if (activeOnly && (t instanceof Site s ? s.construction().paused() : ((Infra) t).construction().paused())) {
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
		SaveHold.require(srv); // (slice SOFF) held while saving is off: refused before anything changes
		requireNoDebt();
		Pile p = get(owner);
		if (p == null) {
			throw new Sites.SiteException(Reason.NOT_ALLOWED, owner + " has no stockpile");
		}
		if (to == null) {
			throw new Sites.SiteException(Reason.FIELD_LIMIT, "to: a player is required");
		}
		payoutPreSave(() -> saveWithWorld(srv)); // (J1) what was pending first, in HF's order: the save after the Take then holds only the Take
		Map<String, Integer> credit = credit(srv, p);
		Map<String, Integer> ground = new TreeMap<>();
		// (T0 review 4 P1-2) the ledger's debit is durable before the items can leave the tick: the drop waits for it, and a failed write takes
		// the inventory back exactly and restores the ledger, then refuses
		return withdrawCore(p, credit, items, holder(to), ground, () -> saveLedgerFirst(srv, // (J1, HF's window, audit F5) the ledger before the player
			() -> Builder.dropItems((ServerLevel) to.level(), to.blockPosition(), ground, null)));
	}

	/**
	 * (T0 review 5 item 2) A forced crate removal's ledger side: the excess debited, the crate out of the pile (the pile out of the registry
	 * when it was the last), then {@code publish} (which takes the crate and drops the excess once the ledger is durable). When it fails the
	 * pile is restored exactly, the restored ledger written durably ({@link #compensate}), and the removal refused. Answers whether the
	 * stockpile ended.
	 */
	static boolean removeCrateCore(Pile p, CrateRec c, Map<String, Integer> drop, java.util.function.BooleanSupplier publish) throws Sites.SiteException {
		JsonObject before = p.ledger.toJson();
		List<CrateRec> crates = new ArrayList<>(p.crates);
		Map<String, Pile> order = new LinkedHashMap<>(PILES);
		drop.forEach((k, v) -> p.ledger.drop(k, v));
		p.crates.remove(c);
		boolean ended = p.crates.isEmpty();
		if (ended) {
			PILES.remove(p.id);
		}
		p.dirty = true;
		changed(p);
		if (!publish.getAsBoolean()) {
			p.ledger = StockLedger.fromJson(before);
			p.crates.clear();
			p.crates.addAll(crates);
			PILES.clear();
			PILES.putAll(order);
			changed(p);
			compensate("a forced removal of a crate of " + p.owner + " was refused");
			throw new Sites.SiteException(Reason.NOT_ALLOWED, "the stockpile ledger could not be saved durably; the crate stays and nothing was dropped (try"
				+ " again)");
		}
		return ended;
	}

	/** (T0 review 4 P1-2) Where a payout's items go (a player's inventory; the units give their own): put, snapshot, restore exactly. */
	interface Holder {
		/** Puts up to {@code n} of {@code item}; answers how many went in. */
		int give(String item, int n);

		Object snapshot();

		void restore(Object snapshot);
	}

	static Holder holder(ServerPlayer to) {
		return new Holder() {
			@Override
			public int give(String item, int n) {
				return Stockpiles.give(to, item, n);
			}

			@Override
			public Object snapshot() {
				net.minecraft.world.entity.player.Inventory inv = to.getInventory();
				List<ItemStack> l = new ArrayList<>(inv.getContainerSize());
				for (int i = 0; i < inv.getContainerSize(); i++) {
					l.add(inv.getItem(i).copy());
				}
				return l;
			}

			@Override
			@SuppressWarnings("unchecked")
			public void restore(Object snapshot) {
				net.minecraft.world.entity.player.Inventory inv = to.getInventory();
				List<ItemStack> l = (List<ItemStack>) snapshot;
				for (int i = 0; i < l.size() && i < inv.getContainerSize(); i++) {
					inv.setItem(i, l.get(i).copy());
				}
				inv.setChanged();
			}
		};
	}

	/**
	 * (T0 review 4 P1-2) A withdrawal: the ledger debited and the items put into {@code h} (what does not fit goes to {@code ground}, dropped by
	 * {@code publish} only once the ledger is durable), then {@code publish}. When it fails (REFUSED, IN_DOUBT, held) the holder is restored
	 * to its snapshot and the ledger to its copy, in the same call (the server thread: the player can't move or use the items meanwhile), and
	 * the withdrawal is refused.
	 */
	static Map<String, Integer> withdrawCore(Pile p, Map<String, Integer> credit, Map<String, Integer> items, Holder h, Map<String, Integer> ground,
		java.util.function.BooleanSupplier publish) throws Sites.SiteException {
		JsonObject before = p.ledger.toJson();
		Object snap = h.snapshot();
		Map<String, Integer> out = new TreeMap<>();
		for (var e : new TreeMap<>(items).entrySet()) {
			int n = Math.min(Math.max(0, e.getValue()), credit.getOrDefault(e.getKey(), 0));
			if (n <= 0) {
				continue;
			}
			p.ledger.withdraw(e.getKey(), n);
			int in = h.give(e.getKey(), n);
			if (n - in > 0) {
				ground.put(e.getKey(), n - in);
			}
			out.put(e.getKey(), n);
		}
		if (out.isEmpty()) {
			return out;
		}
		changed(p);
		if (!publish.getAsBoolean()) {
			h.restore(snap);
			p.ledger = StockLedger.fromJson(before);
			ground.clear();
			changed(p);
			compensate("a withdrawal from " + p.owner + " was refused"); // (T0 review 5 item 1) the disk back to memory too
			throw new Sites.SiteException(Reason.NOT_ALLOWED, "the stockpile ledger could not be saved durably; nothing was withdrawn (try again)");
		}
		return out;
	}

	/**
	 * (slice T0 review 2 finding 1) A payout (items out of the ledger into a player or the world) is refused while a player or chunk save is
	 * owed: its ledger save would publish every credit over that debt, and holding it would leave the items both paid and still in stock.
	 */
	/**
	 * (T0 review 3 finding 2) A payout's pre-save: what was pending is saved first ({@code preSave}), and the payout goes on only when that
	 * left nothing owed and the ledger durably saved; else it is refused before anything moves. Package-private for the units.
	 */
	static void payoutPreSave(Runnable preSave) throws Sites.SiteException {
		SaveHold.require(SERVER); // (slice SOFF) held while saving is off: refused before anything moves
		requireNoDebt();
		if (unsaved) {
			preSave.run();
		}
		requireNoDebt();
		if (unsaved) {
			throw new Sites.SiteException(Reason.NOT_ALLOWED, "the stockpile ledger's pending changes could not be saved durably; payouts wait until they are");
		}
	}

	private static void requireNoDebt() throws Sites.SiteException {
		java.util.List<String> owed = DurableBarrier.owedDebts();
		if (!owed.isEmpty()) {
			throw new Sites.SiteException(Reason.NOT_ALLOWED, owed.size() + " player or chunk save(s) could not be written; stockpile payouts wait until"
				+ " they are (" + owed.get(0) + ")");
		}
	}

	/** (PS, F6) A new stockpile or crate is refused while the file failed to load: it would be lost (never saved) and reuse the file's ids. */
	private static void requireLoaded() throws Sites.SiteException {
		if (loadFailed) {
			throw new Sites.SiteException(Reason.NOT_ALLOWED, FILE + " could not be loaded (" + loadFailedWhy + "); stockpiles are off until it is fixed or "
				+ FILE + ".bak is restored and the world reopened");
		}
	}

	/**
	 * {@code adoptCrates} (§5): every legacy crate of the owner (a building site's own crate, a group's shared crate, a delta's crate) joins
	 * the stockpile. (slice T3b) One {@code pile.adopt} txn per call ({@link PileAdopt}): the crates' stock taken into transit before the
	 * decision, then credited into the stock past capacity (nothing dropped), the cells restored, the journal kinds released and the records
	 * cleared, each keyed and recovered from the intent. A crate it can't read is deferred, untouched. Server thread.
	 */
	public static Pile adopt(MinecraftServer srv, String owner) throws Sites.SiteException {
		adoptResult(srv, owner);
		return java.util.Objects.requireNonNull(get(owner));
	}

	/** (slice T3b) {@link #adopt} with what it did: the crates joined, those deferred (and why), the txn's id. */
	public static PileAdopt.Result adoptResult(MinecraftServer srv, String owner) throws Sites.SiteException {
		requireLoaded();
		SaveHold.require(srv); // (slice SOFF) held while saving is off: refused before anything changes
		return PileAdopt.adopt(srv, owner);
	}

	/** (slice T3b) Refuses SITE_BUSY {@code held(other)} while an open txn holds the owner's pile (an adoption): dissolve, removeStockpileCrate. */
	static void requirePileFree(String owner) throws Sites.SiteException {
		String h = dev.larattalabs.architect.txn.TxnServer.heldWhy("pile:" + owner);
		if (h != null) {
			throw new Sites.SiteException(Reason.SITE_BUSY, owner + "'s stockpile: an open transaction holds it (" + h + ")", "held(other)");
		}
	}

	/** (DFG) A crate's fate in adoptCrates, DFG's names for {@link AdoptPlan.Fate} (FINISH, legacy, reads as JOIN here as in DFG). */
	enum CrateFate {
		JOIN, JOINED, GONE, DEFER
	}

	/**
	 * (DFG's pure seam, kept for its test; slice T3b) {@link AdoptPlan#classify} under DFG's four inputs: {@code read}, its block entity is
	 * its owner's crate; {@code credited}, its adoption key is in the ledger; {@code crateBlock}, any crate block stands at its cell;
	 * {@code known}, its cell was read.
	 */
	static CrateFate crateFate(boolean read, boolean credited, boolean crateBlock, boolean known) {
		if (read) {
			return CrateFate.JOIN; // (T3b: a credited one is FINISH, held for ops; never taken twice)
		}
		AdoptPlan.Verdict v = AdoptPlan.classify(new AdoptPlan.CrateRead("k", "minecraft:overworld", 0, 0, 0, 0L, crateBlock, crateBlock, crateBlock ? "other"
			: null, crateBlock, known), credited);
		return switch (v.fate()) {
			case JOINED -> CrateFate.JOINED;
			case GONE -> CrateFate.GONE;
			default -> CrateFate.DEFER; // DEFER, and FINISH under another tag (a crate stands there: never released)
		};
	}

	/** (slice T3b, from DFG/ADP) Whether any crate block (its block or a crate block entity, whatever its owner tag) stands at the cell. */
	static boolean crateBlockAt(@Nullable ServerLevel level, BlockPos p) {
		return level != null && (level.getBlockEntity(p) instanceof CrateBlockEntity || level.getBlockState(p).is(dev.larattalabs.architect.survival.CrateBlocks.CRATE));
	}

	/**
	 * (slice T3b, from DFG) For a guard: whether a site's crate reference may still name a standing crate. True unless its cell is read, on
	 * the server thread (its chunk loaded if need be), and holds no crate block of any owner: an unknown cell counts as a standing crate,
	 * never as gone. So a crate adoptCrates deferred (another tag) still stands for the guard.
	 */
	public static boolean crateMayStand(@Nullable ServerLevel level, Site s) {
		Construction c = s.construction();
		if (c == null || c.crate() == null) {
			return false;
		}
		if (level == null || !level.getServer().isSameThread()) {
			return true;
		}
		return crateBlockAt(level, new BlockPos(c.crate().x(), c.crate().y(), c.crate().z()));
	}

	/**
	 * (SAD, SAC2) At the world's start: a site's, road's or group's crate reference that names a crate its owner's stockpile ledger already
	 * joined (the adoption key credited: adoptCrates' first save happened, its second, the records', did not) is cleared, as adoptCrates'
	 * second half would have; a building target joins the feed order at the end. So no feed, refund or undo ever follows a reference to a
	 * crate whose stock and placed counts are the stockpile's. Saved once (with the world) when anything moved. Server thread.
	 */
	static void repairJoinedCrates(MinecraftServer srv) {
		boolean any = false;
		for (Pile p : List.copyOf(PILES.values())) {
			List<Object> joined = new ArrayList<>();
			// (T3b fix round, GPT P1) a credited key whose crate still stands is legacy FINISH (an A-model save): never repaired here (its stock
			// would be paid again through a freed crate), but held for ops with its references kept. Unknown cell (no level): not repaired either
			ServerLevel level = Sites.levelOf(srv, p.dimension);
			Map<BlockPos, List<String>> finish = new LinkedHashMap<>();
			java.util.function.BiPredicate<Construction.Crate, String> repairs = (c, res) -> {
				BlockPos at = new BlockPos(c.x(), c.y(), c.z());
				if (startRepairs(true, level == null || crateBlockAt(level, at))) {
					return true;
				}
				finish.computeIfAbsent(at, k -> new ArrayList<>()).add(res);
				return false;
			};
			for (Site s : Sites.all()) {
				if (p.owner.equals(s.owner()) && p.dimension.equals(s.dimension()) && joinedBefore(p, s) && !Sites.txnHeld(s.id()) && repairs.test(s
					.construction().crate(), "site:" + s.id())) { // (T3b) an open txn's: its own
					Sites.replace(srv, s.withConstruction(s.construction().withCrate(null)));
					Builder.forgetRun(s.id());
					any = true;
					if (s.building()) {
						joined.add(Sites.get(s.id()));
					}
					Architect.LOGGER.warn("Stockpile {}: site {} named a crate the stockpile had joined (adoptCrates stopped between its saves); reference cleared",
						p.owner, s.id());
				}
			}
			for (Infra i : Infras.all()) {
				Construction c = i.construction();
				if (c != null && c.crate() != null && p.owner.equals(i.owner()) && p.dimension.equals(i.dimension()) && i.group() != null && namesJoined(
					p.ledger::credited, i.id(), i.group(), c.crate().x(), c.crate().y(), c.crate().z()) && !Sites.txnHeld(i.id()) && repairs.test(c.crate(),
						"road:" + i.id())) {
					Infras.put(srv, i.withConstruction(c.withCrate(null)));
					any = true;
					if (i.building()) {
						joined.add(Infras.get(i.id()));
					}
				}
			}
			for (SiteGroupRec g : Sites.groups()) {
				Construction.Crate c = g.crate();
				if (c != null && p.owner.equals(g.owner()) && namesJoined(p.ledger::credited, g.crateOwner(), null, c.x(), c.y(), c.z()) && !Sites.txnHeld(g.id())
					&& repairs.test(c, "group:" + g.id())) {
					Sites.putGroup(srv, g.withCrate(null));
					any = true;
				}
			}
			finish.forEach((at, res) -> PileAdopt.holdFinish(p.owner, p.dimension, at, res));
			joined.sort(java.util.Comparator.comparingLong(Stockpiles::placedAt));
			for (Object t : joined) {
				if (t != null && !p.order.contains(idOf(t))) {
					p.order.add(idOf(t));
				}
			}
			if (!joined.isEmpty()) {
				changed(p);
				any = true;
			}
		}
		if (any) {
			saveWithWorld(srv);
		}
	}

	/**
	 * (T3b fix round, GPT P1, the pure seam) Whether the start's repair clears a reference: only to a crate this ledger credited AND whose cell
	 * holds no crate block now (JOINED). A credited crate that still stands is legacy FINISH: held for ops, its references kept. (Before: every
	 * credited reference was cleared, freeing a standing crate whose stock was already credited.)
	 */
	static boolean startRepairs(boolean credited, boolean crateStands) {
		return credited && !crateStands;
	}

	/**
	 * (SAD, SAC2, the pure seam) Whether a crate reference at (x, y, z) of target {@code id} (in {@code group}) names a crate whose
	 * adoption key the ledger credited: its own crate's key, or its group's shared one (the group's crate may be cleared already, then
	 * {@link Builder#crateOwner} names the target). With no adoption key credited (every ordinary world start) it is never true, so the
	 * start's repair writes and saves nothing.
	 */
	static boolean namesJoined(java.util.function.Predicate<String> credited, String id, @Nullable String group, int x, int y, int z) {
		String at = "@" + new BlockPos(x, y, z).asLong();
		return credited.test("adopt:" + id + at) || group != null && credited.test("adopt:" + SiteGroupRec.CRATE_PREFIX + group + at);
	}

	/** (SAD, SAC2) Whether a site's crate reference names a crate this stockpile's ledger already joined (its key credited, its block gone). */
	static boolean joinedBefore(Pile p, Site s) {
		Construction c = s.construction();
		if (c == null || c.crate() == null) {
			return false;
		}
		return namesJoined(p.ledger::credited, s.id(), s.group(), c.crate().x(), c.crate().y(), c.crate().z());
	}

	/**
	 * (SAD) Whether a construction site's crate block still stands with its owner id (its own crate, or its group's shared crate): a
	 * crate-fed site whose crate is gone (a legacy site's crate taken down at its completion) is not crate-fed any more.
	 */
	public static boolean crateStands(@Nullable ServerLevel level, Site s) {
		Construction c = s.construction();
		if (level == null || c == null || c.crate() == null) {
			return false;
		}
		BlockPos cp = new BlockPos(c.crate().x(), c.crate().y(), c.crate().z());
		return level.isLoaded(cp) && level.getBlockEntity(cp) instanceof CrateBlockEntity be && Builder.crateOwner(s).equals(be.siteId());
	}

	/**
	 * (JR-b, F3) An adopted crate's placed counts by the credit keys of the targets it fed, in placement order, for their paid records: a crate
	 * of one target gives it all; a shared crate gives each what of its paid cost stands (capped by the crate in {@link StockLedger#adopt}).
	 */
	static Map<String, Map<String, Integer>> adoptedPaid(MinecraftServer srv, ServerLevel level, String crateKey, List<Site> sites, List<Infra> roads,
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
		if (!SaveHold.admits(srv)) {
			return null; // (slice SOFF) held while saving is off: the crate takes nothing (a hopper keeps its items)
		}
		Pile p = byId(crateOwner.substring(PREFIX.length()));
		if (p == null) {
			return null;
		}
		Map<String, Integer> need = unbuiltAll(srv, p);
		if (need.isEmpty()) {
			return null;
		}
		int cap = capacity(srv, p);
		// (OVF) over capacity: only what the active (unpaused) targets still miss goes in (their builds never deadlock), up to that
		Map<String, Integer> active = p.ledger.usedStacks(Stockpiles::maxStack) > cap ? unbuiltActive(srv, p) : Map.of();
		Ledger.Accepted a = p.ledger.accept(item, it -> need.getOrDefault(it, 0), it -> active.getOrDefault(it, 0), Equivalents.bundled(), cap,
			Stockpiles::maxStack, commit);
		if (a != null && commit) {
			changed(p);
		}
		return a;
	}

	/** (T3b final check P2-2) Whether the rate-limited STOCKPILE_CHANGED of {@code p} fires at tick {@code ticks}. */
	static boolean eventDue(Pile p, long ticks) {
		return p.dirty && ticks - p.lastEvent >= EVENT_TICKS;
	}

	/**
	 * (T3b final check P2-2) A txn's persisted {@code stockpile_changed} delivered (at EFFECTS_DONE, again after a recovery): the pile marked
	 * changed for the normal limited emitter, so it fires at least once and is never doubled with the ledger's own change. No pile: nothing.
	 */
	public static void txnChanged(String owner) {
		txnChanged(get(owner));
	}

	static void txnChanged(@Nullable Pile p) {
		if (p != null) {
			p.dirty = true;
		}
	}

	/** Marks a stockpile changed (STOCKPILE_CHANGED, rate-limited, on the next tick). */
	static void changed(Pile p) {
		p.dirty = true;
		unsaved = true;
	}

	/**
	 * (T0 review 5 item 1) A payout was refused after its ledger write failed and the restored ledger could not be written durably either: the
	 * file may hold the refused move (an IN_DOUBT rename). Payouts refuse while it is set; the next durable ledger write clears it.
	 */
	private static volatile @Nullable String ledgerDebt;

	static @Nullable String ledgerDebt() {
		return ledgerDebt;
	}

	/**
	 * (T0 review 5 item 1) A payout's ledger write failed and its move was undone in memory: the restored ledger is written durably over
	 * whatever the failed write installed (an IN_DOUBT write already renamed the moved state into place), so the disk matches memory. When
	 * that fails too, a ledger debt refuses payouts until a later write is durable.
	 */
	static void compensate(String what) {
		unsaved = true;
		if (save()) {
			return;
		}
		ledgerDebt = what + ": the restored ledger could not be written durably";
		Architect.LOGGER.error("Stockpiles: {}; payouts are refused until a ledger save is durable", ledgerDebt);
	}

	/** (HF) a ledger change since the last save (a logout saves the world when set). */
	static volatile boolean unsaved;
	/** (HF) inside saveWithWorld: BEFORE_SAVE leaves the ledger to it. Server thread. */
	private static boolean explicitSave;

	/**
	 * Credits refunds into the owner's stockpile once per {@code key} (§4): (slice OVF) all of it returned, past capacity if need be, never
	 * dropped: the key and the stock land in one ledger write, so a crash at any point (CS1: the restore's chunks saved, the ledger not)
	 * books it once at the next start and no item entity can pay it twice. {@code fallback} is unused (kept for the callers). Returns what
	 * was credited; empty (already) for a key credited before.
	 */
	/**
	 * A credit of nothing (no block standing, no custody) under {@code key}: nothing books; its paid record (JR: nothing of it stood) and its
	 * pending credit (J2: nothing to roll forward) dropped. A key credited already is left as it is. Shared by {@link #credit} and
	 * {@link Builder#creditRefund} (fix/double-credit).
	 */
	static void creditOfNothing(Pile p, String key) {
		if (p.ledger.credited(key)) {
			return;
		}
		p.ledger.dropPaid(key);
		p.ledger.dropPending(key);
		changed(p);
	}

	static StockLedger.Credit credit(MinecraftServer srv, Pile p, String key, Map<String, Integer> items, BlockPos fallback) {
		if (items.isEmpty() && !p.ledger.credited(key) && p.ledger.custody(key).isEmpty()) { // (M5 FK) custody still refunds
			creditOfNothing(p, key);
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
		changed(p);
		Architect.LOGGER.info("Stockpile {}: refund {} returned {}{}", p.owner, key, c.returned(), usedOver(srv, p));
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
		return charge(srv, owner, items, null, 0);
	}

	/**
	 * (fix b5b, review finding 3) {@link #charge} under {@code key} (a region's fluids or a gate mechanism; null: unkeyed): the debit and the key
	 * are one ledger change in one save, and a key the ledger already holds debits nothing (true: the charge stands; the caller settles its
	 * record from {@link StockLedger#charged}).
	 */
	public static boolean charge(MinecraftServer srv, @Nullable String owner, Map<String, Integer> items, @Nullable String key, int rid) {
		if (!SaveHold.admits(srv)) {
			return false; // (slice SOFF) held while saving is off: the stage waits, nothing charged
		}
		Pile p = get(owner);
		if (p == null) {
			return items.values().stream().allMatch(n -> n <= 0);
		}
		if (key != null && p.ledger.charged(key) != null) {
			Architect.LOGGER.warn("Stockpile {}: region charge {} was booked before (its record not saved): not charged again", p.owner, key);
			saveConfirmed(srv); // (OVF) booked in memory only (its save refused): never returned as standing before the ledger is on disk
			return true;
		}
		Map<String, Integer> reserved = LAST_RESERVED.getOrDefault(p.id, Map.of());
		for (var e : items.entrySet()) {
			if (e.getValue() > 0 && p.ledger.stock(e.getKey()) - reserved.getOrDefault(e.getKey(), 0) < e.getValue()) {
				return false;
			}
		}
		int cap = capacity(srv, p);
		Map<String, Integer> over = new TreeMap<>();
		if (key != null) {
			p.ledger.chargeOnce(key, items, rid, cap, Stockpiles::maxStack, over); // (OVF) keyed: its empty buckets never overflow
		} else {
			for (var e : new TreeMap<>(items).entrySet()) {
				p.ledger.consume(e.getKey(), e.getValue(), cap, Stockpiles::maxStack, over, true); // (slice T0) its empty buckets enter the stock
			}
		}
		changed(p);
		if (key != null) {
			saveConfirmed(srv); // (OVF) keyed: the caller records the charge only once the ledger holds it on disk
		} else {
			saveWithWorld(srv); // (JR) with the chunks, as autosave: the ledger never ahead of the world
		}
		Architect.LOGGER.info("Stockpile {}: a region's bodies took {}{}", p.owner, items, key == null ? "" : " (" + key + ")");
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
		if (p == null) {
			return Map.of();
		}
		if (p.ledger.credited(key)) {
			saveConfirmed(srv); // (OVF) booked before; a refused save left it in memory only: the drain waits until it is on disk
			return Map.of();
		}
		int cap = capacity(srv, p);
		Map<String, Integer> over = new TreeMap<>();
		// (OVF) keyed: the lava buckets and bars enter the stock past capacity if need be (never dropped: once across any crash)
		StockLedger.Credit c = scoopInto(p.ledger, key, lavaSources, grates, cap, Stockpiles::maxStack, over);
		changed(p);
		saveConfirmed(srv); // (OVF) the caller persists the drain only after the scoop is on disk (a refusal throws: retried, once)
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

	/**
	 * (PS, audit N1; J1 for its other members) A refund credit that booked is saved with the world right there (players, the chunks
	 * flushed, the ledger), before the caller drops the record it came from: a removal's member (Groups.credit), a standalone road's
	 * restore job, a site's deconstruct, a construction delta's refund, a put-down's take-ups. TEST: {@code dev.stockpile.ps noCreditSave}
	 * turns it off (the case before). Server thread.
	 */
	static void saveCredit(MinecraftServer srv) {
		creditSaves++;
		if (!testNoCreditSave) {
			inCreditSave = true;
			boolean refuse = TEST_REFUSE_CREDIT_SAVES.get() > 0 && TEST_REFUSE_CREDIT_SAVES.getAndDecrement() > 0;
			boolean was = testRefuseSave;
			if (refuse) {
				testRefuseSave = true; // (slice T4a, TEST) this one credit save goes down the real refusal path (DR-S's refuseSave)
				Architect.LOGGER.warn("Stockpiles: TEST refuseCreditSaves: this credit save is refused ({} more)", Math.max(0, TEST_REFUSE_CREDIT_SAVES.get()));
			}
			try {
				saveWithWorld(srv);
			} finally {
				inCreditSave = false;
				if (refuse) {
					testRefuseSave = was;
				}
			}
		}
	}

	/** (slice T4a, TEST dev.stockpile.ps refuseCreditSaves) The next n {@link #saveCredit} calls are refused as refuseSave refuses a save. */
	static final java.util.concurrent.atomic.AtomicInteger TEST_REFUSE_CREDIT_SAVES = new java.util.concurrent.atomic.AtomicInteger();

	/**
	 * (J2) {@link #saveCredit} for a credit the ledger on disk already holds pending (a single-site removal's deconstruct,
	 * {@link #holdPendingCredits}): a save SS refuses (a chunk write not durable) leaves it so and the removal goes on; the next start books it
	 * once ({@link #settlePendingCredits}) unless a later save, the periodic one included, writes the credit first.
	 */
	static void saveCreditPending(MinecraftServer srv) {
		try {
			saveCredit(srv);
		} catch (IllegalStateException e) {
			Architect.LOGGER.error("Stockpiles: a removal's credit was not saved ({}); it stays pending in the saved ledger and books at the next start",
				e.getMessage());
		}
	}

	/** (J2, TEST kill point CS1) inside {@link #saveCredit}'s save: the players and the chunks on disk, the ledger not. */
	private static boolean inCreditSave;

	/**
	 * (J2, FK's durability leftover) A single-site removal's stockpile deconstructs: each credit held pending in its pile's ledger, saved with
	 * the world before the removal's commit (Sites.removeDetailed). Returns whether any was held.
	 */
	static boolean holdPendingCredits(java.util.Collection<Builder.Deconstruction> decs) {
		boolean any = false;
		for (Builder.Deconstruction d : decs) {
			Pile p = d.stockpile() == null || d.key() == null ? null : get(d.stockpile());
			if (p != null) {
				p.ledger.holdPending(d.key(), d.credit(), d.at().asLong());
				changed(p);
				any = true;
			}
		}
		return any;
	}

	/** (J2) The removal ended unwritten (its save refused): its pending credits dropped. */
	static void dropPendingCredits(java.util.Collection<Builder.Deconstruction> decs) {
		for (Builder.Deconstruction d : decs) {
			Pile p = d.stockpile() == null || d.key() == null ? null : get(d.stockpile());
			if (p != null) {
				p.ledger.dropPending(d.key());
				changed(p);
			}
		}
	}

	/**
	 * (J2) At the start, after the sites' settle and before the custody is written back (Fills.atStart): each pending credit (a single-site
	 * removal's, saved before its commit) is resolved by its site's state: credited already (its save reached the disk) or the site standing
	 * (the removal never settled: its custody goes back): dropped; the site still pending (its restore resumes): left; the site settled
	 * removed: booked now, once (credit's key rule), custody included, then saved with the world. A save SS refuses leaves the saved ledger
	 * as it was (pending): the next start resolves it again, and the credit's key keeps it once.
	 */
	static void settlePendingCredits(MinecraftServer srv) {
		if (Sites.loadFailed() || CrateSettle.journalUnreadable()) {
			// (T4b fix round, finding 4) its absence evidence (no site, no pending record) reads an empty registry: nothing is booked or dropped
			Architect.LOGGER.warn("Stockpiles: the pending credits wait: the sites or the world journal did not load");
			return;
		}
		boolean any = false;
		for (Pile p : List.copyOf(PILES.values())) {
			for (String key : p.ledger.pendingKeys()) {
				String what;
				PendingAction a;
				if (key.startsWith(CARGO_PREFIX)) {
					// (slice PSVLC3 fix round) a player holder's contents held before a group removal replaced it: the world decides
					ServerLevel lv = Sites.levelOf(srv, p.dimension);
					if (lv == null) {
						continue;
					}
					boolean holds = !Builder.holderContents(lv.getBlockEntity(BlockPos.of(p.ledger.pendingAt(key)))).isEmpty();
					a = cargoAction(p.ledger.credited(key), holds);
				} else {
					a = pendingAction(key, p.ledger.credited(key), standingSite(key) != null, pendingSite(key));
				}
				if (a == PendingAction.DROP && p.ledger.credited(key)) {
					p.ledger.dropPending(key);
					what = "already credited";
				} else if (a == PendingAction.DROP) {
					p.ledger.dropPending(key);
					what = "its site stands (the removal never settled)";
				} else if (a == PendingAction.LEAVE) {
					continue; // its removal is still pending (its restore resumes, or a repair rolls it forward): left for the next start
				} else {
					ServerLevel level = Sites.levelOf(srv, p.dimension);
					if (level == null) {
						continue;
					}
					// (DR-S) through credit() itself: a credit of nothing standing (no custody either) books NONE and drops its paid record too,
					// which Builder.creditRefund's early return kept (a PAID_ORPHAN after the settle)
					StockLedger.Credit c = credit(srv, p, key, new TreeMap<>(p.ledger.pendingItems(key)), BlockPos.of(p.ledger.pendingAt(key)));
					p.ledger.dropPending(key);
					// (Steward DR2-DOUBLE) an empty credit says so: nothing was credited
					what = c.returned().isEmpty() ? "its removal settled: nothing to credit" : "its removal settled: credited now " + c.returned();
				}
				changed(p);
				any = true;
				Architect.LOGGER.warn("Stockpile {}: pending credit {}: {}", p.owner, key, what);
			}
		}
		if (any) {
			try {
				saveWithWorld(srv);
			} catch (IllegalStateException e) {
				Architect.LOGGER.error("Stockpiles: the pending credits' save was refused ({}); resolved again at the next start", e.getMessage());
			}
		}
	}

	/** (J2) The standing site (or, slice DR-S, road) whose credit key is {@code key}, or null. */
	private static @Nullable Object standingSite(String key) {
		for (Site s : Sites.all()) {
			if (key.equals(Builder.creditKey(s))) {
				return s;
			}
		}
		Infra i = key.startsWith("road:") ? Infras.get(targetIdOf(key)) : null;
		return i != null && key.equals(RoadBuilder.creditKey(i)) ? i : null;
	}

	/** (DR-S) The target id of a {@code site:} or {@code road:} credit key ({@code site:s12@123} -> s12), or "" for any other key. */
	static String targetIdOf(String key) {
		int c = key.indexOf(':');
		int at = key.lastIndexOf('@');
		return (key.startsWith("site:") || key.startsWith("road:")) && at > c + 1 ? key.substring(c + 1, at) : "";
	}

	/**
	 * (DR-S) What the start (or a repair) does with a pending credit, pure: {@code DROP} when credited already or its target stands (the
	 * removal never settled: its custody goes back), {@code LEAVE} while its target is a pending record (its restore resumes or a repair rolls
	 * it forward) or the key is no target's ({@code region:...:mech:} keys are never held pending), else {@code BOOK} (its removal settled).
	 */
	enum PendingAction {
		DROP, LEAVE, BOOK
	}

	/** (slice PSVLC3 fix round, GPT P1 4) The key prefix of a player holder's contents a group removal credits ({@code Groups.cargoKey}). */
	static final String CARGO_PREFIX = "cargo:";

	/**
	 * (pure; fix round) A pending cargo credit at the start: {@code DROP} when credited already or the holder still holds items (the stop came
	 * before its replacement reached the disk: the holder keeps them), else {@code BOOK} (the holder is gone: its contents are only here).
	 */
	static PendingAction cargoAction(boolean credited, boolean holderHolds) {
		return credited || holderHolds ? PendingAction.DROP : PendingAction.BOOK;
	}

	static PendingAction pendingAction(String key, boolean credited, boolean standing, boolean pending) {
		if (credited) {
			return PendingAction.DROP;
		}
		if (standing) {
			return PendingAction.DROP;
		}
		if (pending || !dev.larattalabs.architect.survival.StockLedger.isTargetKey(key)) {
			return PendingAction.LEAVE;
		}
		return PendingAction.BOOK;
	}

	/**
	 * (DR-S) A repair's booking: only {@code keys}' pending credits (the removals it settled), each once by the credit's key rule, custody
	 * included, under the cap; a key with nothing standing drops its paid record (as a credit of nothing does). The ledger is then saved with
	 * the world. Returns per item what left the pending credits for the stock (slice OVF: all of it enters the stock, past capacity if need be).
	 */
	static Map<String, Integer> bookPendingFor(MinecraftServer srv, java.util.Collection<String> keys) {
		Map<String, Integer> out = new TreeMap<>();
		boolean any = false;
		for (Pile p : List.copyOf(PILES.values())) {
			for (String key : keys) {
				if (!p.ledger.pendingKeys().contains(key)) {
					continue;
				}
				PendingAction a = pendingAction(key, p.ledger.credited(key), standingSite(key) != null, pendingSite(key));
				if (a == PendingAction.LEAVE) {
					continue;
				}
				if (a == PendingAction.DROP) {
					p.ledger.dropPending(key);
				} else {
					ServerLevel level = Sites.levelOf(srv, p.dimension);
					if (level == null) {
						continue;
					}
					StockLedger.Credit c = credit(srv, p, key, new TreeMap<>(p.ledger.pendingItems(key)), BlockPos.of(p.ledger.pendingAt(key)));
					c.returned().forEach((k, v) -> out.merge(k, v, Integer::sum));
					c.overflow().forEach((k, v) -> out.merge(k, v, Integer::sum));
					p.ledger.dropPending(key);
					Architect.LOGGER.warn("Stockpile {}: pending credit {}: its removal was rolled forward by a repair: credited {} (overflow {})", p.owner, key,
						c.returned(), c.overflow());
				}
				changed(p);
				any = true;
			}
		}
		if (any) {
			saveCredit(srv);
		}
		return out;
	}

	/** (J2) Whether a pending record (a removal not settled yet; slice DR-S: a pending road too) has the credit key {@code key}. */
	private static boolean pendingSite(String key) {
		int at = key.lastIndexOf('@');
		if (key.startsWith("road:") && at > 5) {
			Infra i = Infras.pending(key.substring(5, at));
			return i != null && key.equals(RoadBuilder.creditKey(i));
		}
		if (!key.startsWith("site:") || at < 0) {
			return false;
		}
		Site s = Sites.pendingRecord(key.substring(5, at));
		return s != null && key.equals(Builder.creditKey(s));
	}

	/**
	 * (slice OVF, review finding 2) A keyed booking's save, confirmed: {@link #saveWithWorld}, run only when something is unsaved, and an
	 * {@link IllegalStateException} unless the ledger is on disk after it (a refused save, or a session whose stockpiles file failed to load,
	 * where nothing is written). Its caller persists what depends on the booking (a region's drained removal, its charged record) only after
	 * it returns, so a retry after a refusal saves first instead of trusting the in-memory key.
	 */
	/**
	 * (OVF, review round 4) Whether the ledger is on disk now: {@link #saveConfirmed}, false (logged) where it refused. A caller that settles
	 * a record from a booking the ledger holds ({@code charged}) does so only when this is true: never from an unsaved in-memory booking.
	 */
	public static boolean ledgerOnDisk(MinecraftServer srv) {
		try {
			saveConfirmed(srv);
			return true;
		} catch (IllegalStateException e) {
			Architect.LOGGER.error("Stockpiles: a booked charge waits: {}", e.getMessage());
			return false;
		}
	}

	public static void saveConfirmed(MinecraftServer srv) {
		if (unsaved || loadFailed) {
			saveWithWorld(srv);
		}
		if (unsaved || loadFailed) {
			throw new IllegalStateException("Stockpiles: the ledger was not saved" + (loadFailed ? " (its file failed to load this session)" : ""));
		}
	}

	/** (J1, dev) the credits saved by {@link #saveCredit} this session (counted with the test switch off too). */
	static volatile int creditSaves;
	/** (J1, dev) the autosaves' wait for their chunk writes before the ledger write: count, last and max (ms). */
	static volatile int autosaveWaits;
	static volatile double lastAutosaveWaitMs, maxAutosaveWaitMs;
	/** (J1, TEST) kill point AS1: the next unflushed world save halts after its chunk writes, before the ledger's. */
	static volatile boolean haltBeforeAutosaveLedger;

	/** The feed's charge of a placed cell's cost under the target's credit key (the live Purse.pay). */
	static void feedPay(MinecraftServer srv, Pile p, String key, List<SurvivalItems.Cost> costs, int cap, @Nullable Map<String, Integer> drawn,
		BlockPos fallback) {
		feedPay(srv, p, key, costs, cap, drawn, null, fallback);
	}

	/** The same, also tallying the lot's own draw (LCAP's per-lot cap). */
	static void feedPay(MinecraftServer srv, Pile p, String key, List<SurvivalItems.Cost> costs, int cap, @Nullable Map<String, Integer> drawn,
		@Nullable Map<String, Integer> lotDrawn, BlockPos fallback) {
		Map<String, Integer> over = new TreeMap<>();
		for (SurvivalItems.Cost c : costs) {
			// (slice T0) a filled bucket's empty one enters the stock, past capacity if need be: never dropped (a drop saved with the world before a
			// failed ledger write would exist twice once the reconcile charges the cell again)
			if (p.ledger.consume(c.item(), c.count(), cap, Stockpiles::maxStack, over, true)) {
				p.ledger.pay(key, c.item(), c.count()); // (JR) with consumed, saved with it
				if (drawn != null) {
					drawn.merge(c.item(), c.count(), Integer::sum);
				}
				if (lotDrawn != null) {
					lotDrawn.merge(c.item(), c.count(), Integer::sum); // (LCAP)
				}
			}
		}
	}

	/** (RL, audit F7) A construction swap's old block, live (Purse.giveBackPaid): out of the target's paid record, capped by it, credited. */
	static Map<String, Integer> swapGiveBack(MinecraftServer srv, Pile p, String targetId, Map<String, Integer> items, long placedAt, BlockPos fb) {
		Map<String, Integer> back = p.ledger.fromPaid(targetId, items, placedAt); // (JR-b)
		Stockpiles.changed(p); // (PS) the record moved
		if (!back.equals(items)) {
			Architect.LOGGER.warn("Stockpile {}: swap refund of {} capped at what the ledger recorded consumed: {} of {}", p.owner, targetId, back, items);
		}
		if (!back.isEmpty()) {
			Stockpiles.giveBack(srv, p, back, fb);
		}
		return back;
	}

	/**
	 * Credits without a key (a swap's old block, a bucket's container) as it happens: (slice T0) all of it, past capacity if need be, as OVF
	 * credits a keyed refund; nothing drops. A drop would be saved with the world before the ledger: after a failed ledger write and a crash
	 * the item would lie on the ground while the old book's reconcile credited it into the stock again.
	 */
	static StockLedger.Credit giveBack(MinecraftServer srv, Pile p, Map<String, Integer> items, BlockPos fallback) {
		StockLedger.Credit c = p.ledger.giveBack(items, capacity(srv, p), Stockpiles::maxStack, true);
		changed(p);
		return c;
	}

	/** Dev: overflow units dropped as entities this session, per owner (the gate counts the entities against it). */
	static final Map<String, Integer> OVERFLOW_DROPPED = new ConcurrentHashMap<>(); // (dev, historical) nothing drops since slice T0: stays 0

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
			p.fresh.add(idOf(t));
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

	/** (8a HB, JS1) Per target that joined the feed this pass (staged terrain aside: free), its built cell count now. */
	private static Map<String, Integer> freshBuilt(MinecraftServer srv, Pile p) {
		Map<String, Integer> out = new HashMap<>();
		for (String id : p.fresh) {
			Object t = Sites.get(id) != null ? Sites.get(id) : Infras.get(id);
			Builder.Run r = t == null || stagedTerrain(t) ? null : run(srv, t);
			if (r != null) {
				out.put(id, r.built.cardinality());
			}
		}
		return out;
	}

	/** (8a HB, JS1) Whether a target that joined this pass built a cell in its step (against {@link #freshBuilt}). */
	private static boolean freshWrote(MinecraftServer srv, Pile p, Map<String, Integer> before) {
		for (var e : before.entrySet()) {
			Object t = Sites.get(e.getKey()) != null ? Sites.get(e.getKey()) : Infras.get(e.getKey());
			Builder.Run r = t == null ? null : run(srv, t);
			if (r != null && r.built.cardinality() > e.getValue()) {
				return true;
			}
		}
		return false;
	}

	/** Dev/state: per target, what it may use now ({@code stock - reserved}) and whether it reserves. */
	static final Map<String, Map<String, Integer>> LAST_RESERVED = new ConcurrentHashMap<>();

	/** One server tick: every stockpile feeds its targets in feed order, with reservations (§3). */
	static void tick(MinecraftServer srv) {
		ticks++;
		if (!SaveHold.admits(srv)) {
			return; // (slice SOFF) feeding held while saving is off (nothing pending to save: the saves are refused)
		}
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
			if (eventDue(p, ticks)) {
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
		// (RL; 8a HB, the GPT review's P1, rule 17) a target joined the feed: the ledger (its book of the target's cells) is saved with the
		// world BEFORE any feed step, so a crash after the step finds the target in the saved ledger and RL charges what it built. Before, the
		// save came after the pass: a halt between left the target's paid blocks on the disk with no book (no charge: a dupe). A save that
		// does not complete holds the pass: nothing is built or charged until a later tick's save does. TEST: dev.stockpile.ps noPeriodic
		// turns it off with the periodic save (the before-the-fix cases); joinSave: true keeps it on with the periodic save off
		if (p.joined && !testNoJoinSave) {
			// (8a HB, the GPT check's P3) a refused barrier is retried after JOIN_RETRY_TICKS, not every tick; the pass is held meanwhile
			if (ticks < p.joinRetryAt) {
				return;
			}
			if (!joinSave(srv, p)) {
				p.joinRetryAt = joinRetryAt(ticks);
				return;
			}
			p.joinRetryAt = 0;
			p.joinFails = 0;
		}
		p.joined = false;
		// (8a HB, kill point JS1) the paid cells the targets that joined this pass have built before it
		Map<String, Integer> freshBuilt = freshBuilt(srv, p);
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
				if (Sites.txnHeld(idOf(t))) { // (slice T3b) site:, road: or group: (pile.adopt holds a road as road:<id>)
					return true; // (slice T1, §3.6 "Holds") a target an open txn holds is skipped: nothing consumed (SiteWait TXN_HELD)
				}
				return t instanceof Site s ? s.construction().paused() : ((Infra) t).construction().paused();
			}

			@Override
			public void step(Object t, Builder.Run r, FeedOrder.Reserve reserve) {
				// (BC, S-M5-9) the region's maxBill: what its group may still draw (its draws counted from the ledger, then as this step pays)
				BillCaps.Cap billCap = BillCaps.of(t);
				Map<String, Integer> drawn = billCap == null ? null : BillCaps.drawn(p.ledger, billCap); // (BC-c) the region's own charges too
				// (LCAP, S-M5-16) the target's lot cap (its rid's maxBillPerLot for its lot): both caps apply, the target draws what both leave
				BillCaps.Cap lotCap = BillCaps.lotOf(t);
				Map<String, Integer> lotDrawn = lotCap == null ? null : BillCaps.drawn(p.ledger, lotCap);
				boolean[] capHit = {false};
				boolean[] settling = {false}; // (BC-c) an owed cell stands: it is charged whatever the cap (refusing it would mint)
				Builder.Purse purse = new Builder.Purse() {
					@Override
					public int stock(String item) {
						int n = reserve.available(item, p.ledger::stock);
						if ((billCap != null || lotCap != null) && !settling[0]) {
							int left = BillCaps.leftUnder(billCap, drawn, lotCap, lotDrawn, item);
							if (left < n || left <= 0) { // (BC-c) at or past the cap with no stock either: still the cap's wait
								capHit[0] = true;
								return left;
							}
						}
						return n;
					}

					@Override
					public boolean pay(List<SurvivalItems.Cost> costs) {
						feedPay(srv, p, keyOf(t), costs, cap, drawn, lotDrawn, fallback);
						return true; // a stockpile target's stock is checked by its feed (stock - reserved) before the cell
					}

					@Override
					public void giveBack(Map<String, Integer> items, BlockPos fb) {
						Stockpiles.giveBack(srv, p, items, fb);
					}

					@Override
					public Map<String, Integer> giveBackPaid(String targetId, Map<String, Integer> items, BlockPos fb) {
						return swapGiveBack(srv, p, targetId, items, t instanceof Site st ? st.placedAt() : ((Infra) t).placedAt(), fb);
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
				settling[0] = true;
				try {
					r.settleOwed(level, purse, SurvivalWorld.blocksPerTick() * 4);
				} finally {
					settling[0] = false;
				}
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
				// (BC, S-M5-9) nothing built and the cap held a cell back: the typed wait bill_cap (else it lifts)
				boolean held = capHit[0] && r.built.cardinality() == before;
				// (LCAP) either cap's units over: the larger of each item (the cap that must rise most)
				Map<String, Integer> regionOver = billCap != null && held ? BillCaps.over(r, billCap, drawn) : Map.of();
				Map<String, Integer> lotOver = lotCap != null && held ? BillCaps.over(r, lotCap, lotDrawn) : Map.of();
				Map<String, Integer> capOver = BillCaps.mergeOver(regionOver, lotOver);
				if (!capOver.isEmpty()) {
					SiteWaits.billCapped(srv, idOf(t), capOver, BillCaps.scopeOf(regionOver, lotOver, lotCap == null ? null : lotCap.lot())); // (LCAP-Q1) which cap holds it
					SiteWaits.observe(srv, level, idOf(t), WaitCalc.Outcome.STARVED);
				} else if (billCap != null || lotCap != null) {
					SiteWaits.billUncapped(srv, idOf(t));
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
		// (8a HB, TEST kill point JS1: dev.journal.killAt) a target that joined this pass built a paid cell in its first feed step
		if (freshWrote(srv, p, freshBuilt)) {
			dev.larattalabs.architect.journal.WorldJournal.kill("JS1");
		}
		p.fresh.clear(); // (JS1) the targets that joined since the last pass (in it, or through a reconcile between passes) have had their step
	}

	/**
	 * (8a HB) RL's save on join, before the pass's steps, through the world barrier (slice T0: players, then chunks, then the ledger as a
	 * confirmed DurableFile write, its books refreshed first). True only when the barrier is OK: the ledger on the disk then holds the joined
	 * targets' books. REFUSED (save-off, a failed load or step) or IN_DOUBT holds the pass (rule 17: no step mutates the stock before a
	 * confirmed record); a later tick tries again.
	 */
	static boolean joinSave(MinecraftServer srv, Pile p) {
		DurableBarrier.Result r = barrier(srv);
		if (!r.ok()) {
			p.joinFails++;
			if (joinWarns(p.joinFails)) {
				Architect.LOGGER.warn("Stockpiles: the save on join was {} ({}); the feed of {} waits for it (failure {}, retried every {} s)", r.outcome(), r.reason(),
					p.owner, p.joinFails, JOIN_RETRY_TICKS / 20);
			}
			return false;
		}
		return true;
	}

	/** (8a HB) Ticks between tries of a refused save on join (the pass is held meanwhile; ST's staged retry uses the same 100). */
	static final int JOIN_RETRY_TICKS = 100;

	/** (8a HB) The tick a refused save on join is tried again. */
	static long joinRetryAt(long now) {
		return now + JOIN_RETRY_TICKS;
	}

	/** (8a HB) Whether the {@code n}th refused save on join in a row is logged: the first, then every 12th (once a minute at the retry rate). */
	static boolean joinWarns(int n) {
		return n == 1 || n % 12 == 0;
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
		o.addProperty("overCapacity", overCapacity(srv, p)); // (OVF) a keyed refund left it past capacity: inserts refused until it fits
		o.addProperty("capacityLabel", capacityLabel(p.ledger.usedStacks(Stockpiles::maxStack), capacity(srv, p)));
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
				case "adopt" -> {
					try {
						PileAdopt.Result r = adoptResult(srv, owner);
						JsonArray j = new JsonArray();
						r.joined().forEach(j::add);
						o.add("joined", j);
						JsonObject d = new JsonObject();
						r.deferred().forEach(d::addProperty);
						o.add("deferred", d);
						o.addProperty("txn", r.txnId());
					} catch (Sites.SiteException e) {
						if (!"held(decided)".equals(e.detail())) {
							throw e;
						}
						// (slice T3b) decided, then held (a dev pause, a refused barrier): it finishes later; the client hook waits for it
						var m = java.util.regex.Pattern.compile("tx-[0-9]+").matcher(String.valueOf(e.getMessage()));
						o.addProperty("heldDecided", e.getMessage());
						o.addProperty("pendingTxn", m.find() ? m.group() : null);
					}
				}
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
					o.addProperty("creditSaves", creditSaves); // (J1)
					o.addProperty("ledgerFirstSaves", ledgerFirstSaves); // (J1)
					o.addProperty("lastLedgerFirstMs", lastLedgerFirstMs);
					o.addProperty("autosaveWaits", autosaveWaits); // (J1)
					o.addProperty("lastAutosaveWaitMs", lastAutosaveWaitMs);
					o.addProperty("maxAutosaveWaitMs", maxAutosaveWaitMs);
					o.addProperty("regionForced", SaveTiming.FORCED.get()); // (SS)
					o.addProperty("regionBarriers", RegionDurability.BARRIERS.get());
					o.addProperty("regionOwedRetried", RegionDurability.RETRIED.get());
					o.addProperty("durabilityRefusals", durabilityRefusals);
					o.addProperty("savingOffRefusals", savingOffRefusals); // (SOFF)
					o.add("hold", SaveHold.json()); // (SOFF)
					o.add("lastSave", SaveEvidence.json());
					o.addProperty("undurable", RegionDurability.undurable("chunk", "entities").size());
					o.addProperty("regionForceSkipped", SaveTiming.SKIPPED.get());
					o.addProperty("forceAll", SaveTiming.forceAll);
					o.addProperty("chunkWaitsSkipped", SaveTiming.WAITS_SKIPPED.get());
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
				case "save" -> {
					// (S-M5-19) a save barrier that works on the integrated client (where /save-all is not a command): an explicit ledger save
					// with the world (players, chunks flushed, then stockpiles.json), on this, the server thread; answers once the file is written
					Path d = dir;
					if (d == null) {
						throw new IllegalStateException("dev.stockpile.save: no world is open");
					}
					if (loadFailed) {
						throw new IllegalStateException("dev.stockpile.save: not saved: " + FILE + " failed to load this session (" + loadFailedWhy + "); the file is kept as it is");
					}
					int before = saves;
					saveWithWorld(srv);
					Path f = d.resolve(FILE);
					boolean written = saves > before;
					if (!written && !(PILES.isEmpty() && OwedLedger.isEmpty() && CrateSettle.durableEmpty() && !Files.exists(f))) {
						throw new IllegalStateException("dev.stockpile.save: " + f + " was not written (the log says why)");
					}
					o.addProperty("written", written);
					o.addProperty("path", f.toString());
					try {
						o.addProperty("bytes", Files.exists(f) ? Files.size(f) : 0L);
					} catch (IOException e) {
						throw new java.io.UncheckedIOException(e);
					}
					o.addProperty("saves", saves);
					if (!written) {
						o.addProperty("why", "no stockpile in this world: no file is kept");
					}
				}
				case "ss" -> {
					// (SS, TEST) the region-file durability probe, with the mixins applied (SaveProbe)
					if (req.has("probe") && req.get("probe").getAsBoolean()) {
						try {
							return SaveProbe.run(srv, player);
						} catch (java.io.IOException e) {
							throw new java.io.UncheckedIOException(e);
						}
					}
					o.addProperty("forced", RegionDurability.FORCED.get());
					o.addProperty("skipped", RegionDurability.SKIPPED.get());
					o.addProperty("barriers", RegionDurability.BARRIERS.get());
					o.addProperty("undurable", RegionDurability.undurable("chunk", "entities").size());
					o.addProperty("durabilityRefusals", durabilityRefusals);
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
					if (req.has("failQueueWrites")) {
						Placement.TEST_FAIL_WRITES = req.get("failQueueWrites").getAsBoolean(); // (T2b last round, TEST)
					}
					if (req.has("failLedgerWrites")) {
						DurableFile.FAIL_BEFORE_RENAME.set(req.get("failLedgerWrites").getAsInt()); // (T2b last round, TEST) the next durable writes fail
					}
					if (req.has("refuseSave")) {
						testRefuseSave = req.get("refuseSave").getAsBoolean(); // (DR-S)
					}
					if (req.has("failLedgerOnly")) {
						TEST_FAIL_LEDGER.set(req.get("failLedgerOnly").getAsInt()); // (slice T4b fix round, TEST)
					}
					if (req.has("refuseCreditSaves")) {
						TEST_REFUSE_CREDIT_SAVES.set(req.get("refuseCreditSaves").getAsInt()); // (slice T4a, TEST) the next n credit saves refused
					}
					if (req.has("forceAll")) {
						SaveTiming.forceAll = req.get("forceAll").getAsBoolean(); // (SS) every region file forced at a flush, as vanilla (the before case)
					}
					if (req.has("waitAll")) {
						SaveTiming.waitAll = req.get("waitAll").getAsBoolean(); // (SS) a flushed save waits for every loading chunk, as vanilla
					}
					if (req.has("capacity")) {
						testCapacity = req.get("capacity").getAsInt(); // (OVF) every pile's capacity in stacks; -1 the crates'
					}
					if (req.has("failSitesSaves")) {
						Sites.FAIL_SAVES.set(req.get("failSitesSaves").getAsInt()); // (T3b fix round) the next n sites-file saves fail
					}
					if (req.has("creditKey") && owner != null && get(owner) != null) {
						// (T3b fix round) a legacy key credited with nothing (an A-model adoption's credit: FINISH at the next start)
						Pile cp = get(owner);
						cp.ledger.credit(req.get("creditKey").getAsString(), Map.of(), Integer.MAX_VALUE, Stockpiles::maxStack);
						changed(cp);
					}
					if (req.has("haltBeforeAutosaveLedger")) {
						haltBeforeAutosaveLedger = req.get("haltBeforeAutosaveLedger").getAsBoolean(); // (J1) kill point AS1
					}
					if (req.has("saveHold")) {
						SaveHold.testOff = !req.get("saveHold").getAsBoolean(); // (SOFF, TEST) the saving-off hold off: as before SOFF
					}
					if (req.has("noSave")) {
						// (SOFF, TEST) a level's saving flag set directly, as another mod would (no /save-off: no save first)
						for (var e : req.getAsJsonObject("noSave").entrySet()) {
							for (ServerLevel l : srv.getAllLevels()) {
								if (l.dimension().identifier().toString().equals(e.getKey())) {
									l.noSave = e.getValue().getAsBoolean();
								}
							}
						}
					}
					if (req.has("rawForceSave") && req.get("rawForceSave").getAsBoolean()) {
						srv.saveAllChunks(true, true, true); // (SOFF, TEST) another mod's forced chunk save: no players
					}
					if (req.has("autosave") && req.get("autosave").getAsBoolean()) {
						srv.saveEverything(true, false, false); // (SOFF, TEST) vanilla's autosave (MinecraftServer.autoSave): unflushed, not forced
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
					o.addProperty("refuseSave", testRefuseSave);
					o.addProperty("refuseCreditSaves", TEST_REFUSE_CREDIT_SAVES.get());
					o.addProperty("joinSave", !testNoJoinSave);
					o.addProperty("noCreditSave", testNoCreditSave);
					o.addProperty("forceAll", SaveTiming.forceAll);
					o.addProperty("waitAll", SaveTiming.waitAll);
					o.addProperty("capacity", testCapacity);
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
				be.ledger().heldStock().forEach((k, v) -> crateStock.merge(k, v, Integer::sum));
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
			boolean family = r.soilFamily;
			r.soilFamily = Infras.get(i.id()) != null; // (BC) a removed (pending) target matches strictly: the land put back is not its paid block
			try {
				r.rescan(level, false, true); // never loads a chunk
			} finally {
				r.soilFamily = family;
			}
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
				be.ledger().heldStock().forEach((k, v) -> crateStock.merge(k, v, Integer::sum));
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
		if (!OwedLedger.isEmpty()) {
			root.add("owed", OwedLedger.toJson()); // (slice T2b) owed collectibles: in this file, published only as the ledger is
		}
		if (!CrateSettle.durableEmpty()) {
			root.add("crateSettles", CrateSettle.durableJson()); // (T2b fix round P1-c) a removal's settle, its refunds, durable before its undo commits
		}
		return root;
	}

	/** (slice T2b) Whether {@code owner} has a stockpile (an owed entry can be credited into it). */
	public static boolean hasPile(String owner) {
		return get(owner) != null;
	}

	/**
	 * (slice T2b, {@code Sites.creditOwedToStock}) Owed entry {@code key}'s {@code items} into {@code owner}'s stock in one ledger change: the
	 * entry shrinks (marked {@code effectKey}) and the pile credits them keyed {@code owed:<effectKey>}, past capacity as OVF's keyed refunds.
	 * Throws (nothing changed) when there is no pile or the entry doesn't hold them. Server thread.
	 */
	public static void creditOwed(MinecraftServer srv, String owner, String key, Map<String, Integer> items, String effectKey) {
		Pile p = get(owner);
		if (p == null) {
			throw new IllegalStateException(owner + " has no stockpile");
		}
		OwedLedger.debit(key, items, effectKey); // throws first when the entry doesn't hold them
		p.ledger.credit("owed:" + effectKey, items, capacity(srv, p), Stockpiles::maxStack);
		changed(p);
	}

	/** (slice T2b) The owed ledger changed in memory: the next ledger save (a barrier) publishes it. Server thread. */
	public static void owedChanged() {
		unsaved = true;
	}

	/** Writes the file now (a temp file, then a rename). */
	/** (JR, dev) explicit saves with the world: count, last and max time (ms). */
	// ------------------------------------------------------------------ (slice RL) the targets' cell books and the reconcile at load

	/** (RL) The server of the loaded world (the books are refreshed on its thread at each save). */
	static volatile @Nullable MinecraftServer SERVER;

	/**
	 * (BC, S-M5-10) Attaches to a new run the cells its target's ledger book says stood paid at the last save ({@link Builder.Run#paidBefore}),
	 * when the book indexes this run's queue. Nothing for a target no stockpile feeds or with no book. Server thread.
	 */
	static void attachPaid(Object t, Builder.Run r) {
		Pile p = t instanceof Site s ? pileOf(s) : pileOf((Infra) t);
		if (p == null) {
			return;
		}
		StockLedger.Book b = p.ledger.book(keyOf(t));
		if (b != null && b.fits(r.queue)) {
			r.paidBefore.or(b.standing());
		}
	}

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
					if (stagedTerrain(t)) {
						// (8a HB, §4) a staged terrain target is free: its book marks every cell free (known, never standing paid, never owed),
						// with no rescan (nothing to charge or give back; a restart re-derives its progress from the world)
						p.ledger.book(key, freeBook(r.queue));
						keep.add(key);
						n++;
						continue;
					}
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
	/**
	 * (DR-S) The fed targets RL's reconcile left alone after this start's unclean stop (their book unusable, or the reconcile failed): their
	 * saved book may disagree with the world, and nothing settled it. Diagnose reports each as {@code BOOK} (report only: RL owns it). Per
	 * target id: {owner, credit key, why}. Cleared at each start.
	 */
	static final Map<String, String[]> UNRECONCILED = new ConcurrentHashMap<>();

	static void reconcileAtStart(MinecraftServer srv) {
		UNRECONCILED.clear();
		repairJoinedCrates(srv); // (SAD, SAC2) first: no reader below follows a reference to a crate the ledger already joined
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
					if (unclean) {
						UNRECONCILED.put(idOf(t), new String[] {p.owner, key, "its cell book indexes another queue"}); // (DR-S) BOOK
					}
					continue;
				}
				r.attachOwed(b.owed());
				if (unclean) {
					try {
						moved |= reconcile(srv, level, p, t, key, r, b);
						any = true;
					} catch (RuntimeException e) {
						UNRECONCILED.put(idOf(t), new String[] {p.owner, key, "its reconcile failed (" + e + ")"}); // (DR-S) BOOK
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
		if (stagedTerrain(t)) {
			return reconcileTerrain(srv, level, p, (Infra) t, key, r, constructionOf(t));
		}
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
		// the ledger ahead: what the lost cells cost goes back (capped by the record), the builder charges them again as it places them
		Map<String, Integer> lostCost = new TreeMap<>();
		for (int i = lost.nextSetBit(0); i >= 0; i = lost.nextSetBit(i + 1)) {
			r.cost.get(i).forEach(x -> lostCost.merge(x.item(), x.count(), Integer::sum));
		}
		AtStart lostBack = refundAtStart(p, id, lostCost, t instanceof Site st ? st.placedAt() : ((Infra) t).placedAt(), cap);
		Map<String, Integer> back = lostBack.back();
		StockLedger.Credit cr = lostBack.credit(); // (slice T0) all of it in the stock: nothing dropped
		// (J2, RL6) a construction delta's swap built after the save: the builder gave the old block back out of the record as it swapped
		// (Builder.refundSwap -> giveBackPaid: fromPaid under the target's key, then giveBack), and the unsaved ledger lost that. Done again
		// here, the same way, before the new block is charged. Once: the swap's give-back and its new block's charge are booked in the same
		// tick, so a saved ledger that holds the give-back holds the cell as standing paid in its book too (never ahead); the book written
		// below counts the cell standing, so a second load finds nothing ahead
		Map<String, Integer> swapOld = swapOldCost(level, r, ahead, free);
		AtStart swapAt = refundAtStart(p, id, swapOld, t instanceof Site st2 ? st2.placedAt() : ((Infra) t).placedAt(), cap);
		Map<String, Integer> swapBack = swapAt.back();
		StockLedger.Credit scr = swapAt.credit(); // (slice T0) all of it in the stock: nothing dropped
		if (!swapBack.equals(swapOld)) {
			Architect.LOGGER.warn("Stockpile {}: the reconcile's swap give-back of {} capped at the record: {} of {}", p.owner, id, swapBack, swapOld);
		}
		// the world ahead: charged now while the stock affords it, the rest owed
		java.util.BitSet owed = b.owed();
		owed.clear();
		Map<String, Integer> charged = new TreeMap<>();
		Map<String, Integer> owes = new TreeMap<>();
		Map<String, Integer> over = new TreeMap<>();
		int playerCells = 0;
		for (int i = ahead.nextSetBit(0); i >= 0; i = ahead.nextSetBit(i + 1)) {
			if (dev.larattalabs.architect.placed.Placed.record(level, r.pos(i)) != null) {
				// (J1, RL's known open) a PT record in the cell: a player placed this block (Architect's own writes clear the record), and the
				// record is a chunk attachment, on disk with the block itself. As the builder does for it, it stands built and is charged
				// nothing (JR-b's F10 then drops it as the player's at an undo). The player's inventory rolled back with the ledger (HF), so
				// the player holds the item again: that is vanilla's rollback dupe, no longer paid for out of the stock.
				r.markBuilt(i, true);
				playerCells++;
				continue;
			}
			List<SurvivalItems.Cost> cost = r.cost.get(i);
			Map<String, Integer> need = new TreeMap<>();
			cost.forEach(x -> need.merge(x.item(), x.count(), Integer::sum));
			if (need.entrySet().stream().allMatch(e -> p.ledger.stock(e.getKey()) >= e.getValue())) {
				for (SurvivalItems.Cost x : cost) {
					if (consumeAtStart(p, x.item(), x.count(), cap, over)) {
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
		// (slice T0) the charges' empty buckets entered the stock (consumeAtStart): nothing dropped
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
		o.add("swapBack", Builder.counts(scr.returned())); // (J2, RL6) the swaps' old blocks given back
		o.addProperty("reopened", reopen);
		o.addProperty("playerCells", playerCells); // (J1) ahead cells a player placed: not charged
		LAST_RECONCILE.put(id, o);
		boolean moved = !ahead.isEmpty() || !lost.isEmpty();
		if (moved) {
			Architect.LOGGER.warn("Stockpile {}: reconciled {} after an unclean stop: {} cell(s) stood unpaid, charged {} and owes {} ({} cell(s)); {} paid "
				+ "cell(s) lost, credited back {}{}", p.owner, key, ahead.cardinality(), charged, owes, owed.cardinality(), lost.cardinality(), cr.returned(),
				reopen ? "; it builds again" : "");
		}
		return moved;
	}

	/** (8a HB) Whether a feed target is a staged terrain target (free: no cell is charged, owed or given back). */
	static boolean stagedTerrain(Object t) {
		return t instanceof Infra i && RegionTargets.isTerrain(i);
	}

	/** (8a HB, §4) A staged terrain target's book over its queue: every cell known and free (never standing paid, never owed). */
	static StockLedger.Book freeBook(int[] queue) {
		java.util.BitSet known = new java.util.BitSet();
		known.set(0, queue.length);
		return new StockLedger.Book(java.util.Arrays.hashCode(queue), queue.length, known, new java.util.BitSet(), new java.util.BitSet());
	}

	/**
	 * (8a HB, docs/CONTRACT.md "Phase 8a" §4) A staged terrain target after an unclean stop: free, so nothing is charged, owed or given back
	 * (an older book's standing or owed bits are dropped). A target still building re-derives its progress from the world (the rescan): a
	 * cell missing from the saved world is queued again. A target recorded BUILT stays BUILT, even with cells that are not its block now: its
	 * cells cost nothing, so a hole mints and loses nothing, while a reopen could not tell a crash's hole from a later writer's deliberate cut
	 * or block (a lot's cellar, a road's cut, a paid wall: not all of them are construction queues) and would fill or clear it (the GPT
	 * review's P1s). It is logged. The book is then the free book, so a second load changes nothing.
	 */
	static boolean reconcileTerrain(MinecraftServer srv, ServerLevel level, Pile p, Infra t, String key, Builder.Run r, Construction c) {
		r.attachOwed(new java.util.BitSet()); // never owed (an older book's bits dropped), so the rescan marks every standing cell built
		r.rescan(level, true); // every cell, its chunk loaded (as the sites check at the start)
		r.newlyCount = 0;
		int missing = r.size() - r.built.cardinality();
		p.ledger.book(key, freeBook(r.queue));
		JsonObject o = new JsonObject();
		o.addProperty("key", key);
		o.addProperty("terrain", true);
		o.addProperty("aheadCells", 0);
		o.addProperty("owedCells", 0);
		o.addProperty("lostCells", 0);
		o.addProperty("missingCells", missing);
		o.addProperty("built", !c.building());
		o.add("charged", new JsonObject());
		o.add("owes", new JsonObject());
		o.add("creditedBack", new JsonObject());
		o.add("overflow", new JsonObject());
		o.add("swapBack", new JsonObject());
		o.addProperty("reopened", false);
		o.addProperty("playerCells", 0);
		LAST_RECONCILE.put(t.id(), o);
		if (!c.building() && missing > 0) {
			Architect.LOGGER.info("Stockpile {}: staged terrain target {} is BUILT with {} cell(s) not its block after an unclean stop (a later writer's or "
				+ "a crash's; free either way): left BUILT", p.owner, t.id(), missing);
		}
		return false;
	}

	/**
	 * (BC-c) After the reconcile, on the first server tick (the regions load after the stockpiles' SERVER_STARTED listener): the reconcile
	 * charged every standing cell whatever its region's {@code maxBill} (conservation wins: the blocks exist, and leaving one unpaid would mint
	 * it). A capped region whose group's draws (its targets' paid records and the region's own charges) are now past the cap is named in a WARN
	 * and in the target's reconcile record ({@code capOver}, {@code capRegion}); its targets draw no more of the items over and wait
	 * {@code bill_cap} (their feed step derives the wait; {@code nextNeeded} gives the units the cap must rise to finish). Server thread.
	 */
	static void capsAfterReconcile(MinecraftServer srv) {
		if (LAST_RECONCILE.isEmpty()) {
			return;
		}
		for (Pile p : List.copyOf(PILES.values())) {
			for (Object t : bookTargets(p)) {
				JsonObject o = LAST_RECONCILE.get(idOf(t));
				BillCaps.Cap cap = o == null ? null : BillCaps.of(t);
				BillCaps.Cap lotCap = o == null ? null : BillCaps.lotOf(t); // (LCAP) the target's lot cap, named the same way
				if (cap != null) {
					Map<String, Integer> over = cap.overshoot(BillCaps.drawn(p.ledger, cap));
					o.addProperty("capRegion", cap.region());
					o.add("capOver", Builder.counts(over));
					if (!over.isEmpty()) {
						Architect.LOGGER.warn("Stockpile {}: the reconcile of {} left region {}'s draws past its maxBill by {}: its standing cells were charged "
							+ "(the blocks exist); the region's targets draw no more of it and wait bill_cap", p.owner, o.get("key").getAsString(), cap.region(), over);
					}
				}
				if (lotCap != null) {
					Map<String, Integer> over = lotCap.overshoot(BillCaps.drawn(p.ledger, lotCap));
					o.addProperty("capRegion", lotCap.region());
					o.addProperty("capLot", lotCap.lot());
					o.add("lotCapOver", Builder.counts(over));
					if (!over.isEmpty()) {
						Architect.LOGGER.warn("Stockpile {}: the reconcile of {} left lot {} of region {} past its maxBillPerLot by {}: its standing cells were "
							+ "charged (the blocks exist); the lot's targets draw no more of it and wait bill_cap", p.owner, o.get("key").getAsString(), lotCap.lot(),
							lotCap.region(), over);
					}
				}
			}
		}
	}

	/** (T0m) A reconcile refund: what came back out of the target's paid record, and how it was credited. */
	record AtStart(Map<String, Integer> back, StockLedger.Credit credit) {
	}

	/**
	 * (slice T0, the GPT check of the merge with main v0.77.0) A reconcile's unkeyed refund at start (a lost cell's cost, a swap's old block):
	 * taken from the target's paid record and credited as OVF credits a keyed refund, all of it, past capacity if need be, nothing dropped.
	 * The reconcile's book reaches the disk only after the world (saveWithWorld): a dropped overflow saved with the chunks would survive a
	 * failed ledger write and a crash, and the unchanged book would refund it again at the next start. In the stock, it is booked with the
	 * book, once.
	 */
	static AtStart refundAtStart(Pile p, String id, Map<String, Integer> cost, long placedAt, int cap) {
		Map<String, Integer> back = cost.isEmpty() ? Map.of() : p.ledger.fromPaid(id, cost, placedAt);
		return new AtStart(back, back.isEmpty() ? StockLedger.Credit.NONE : p.ledger.giveBack(back, cap, Stockpiles::maxStack, true));
	}

	/** (slice T0) A reconcile's charge of an ahead cell's unit at start: a filled bucket's empty one enters the stock past capacity, never dropped. */
	static boolean consumeAtStart(Pile p, String item, int n, int cap, Map<String, Integer> over) {
		return p.ledger.consume(item, n, cap, Stockpiles::maxStack, over, true);
	}

	/**
	 * (J2, RL6) The old blocks' cost of the ahead cells that are a construction delta's swaps, as {@link Builder}'s refundSwap counts it (a
	 * swap cell, its old block known, not free), less a cell a player placed (its PT record: the reconcile leaves it uncharged and gives
	 * nothing back for it either).
	 */
	static Map<String, Integer> swapOldCost(ServerLevel level, Builder.Run r, java.util.BitSet ahead, java.util.BitSet free) {
		Map<String, Integer> out = new TreeMap<>();
		if (r.old == null) {
			return out;
		}
		for (int i = ahead.nextSetBit(0); i >= 0; i = ahead.nextSetBit(i + 1)) {
			if (Builder.swapRefunds(r, i, free) && dev.larattalabs.architect.placed.Placed.record(level, r.pos(i)) == null) {
				Cells.cost(r.old[i]).forEach(c -> out.merge(c.item(), c.count(), Integer::sum));
			}
		}
		return out;
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
	/**
	 * (DR2, P1-1) A repair's durability barrier: the world's chunks flushed and known durable (SS's check), then the ledger, as
	 * {@link #saveWithWorld}; with the ledger off (its load failed) the chunks alone, still checked. Throws when the save is refused (a chunk
	 * write not durable, TEST refuseSave). Server thread.
	 */
	static void durableBarrier(MinecraftServer srv) {
		if (!srv.isSameThread()) {
			throw new IllegalStateException("Stockpiles: a repair's save runs on the server thread");
		}
		String off = savingOff(srv);
		if (off != null) {
			// (DR2 fix, P1-2) saveAllChunks skips a level with noSave (/save-off) unless forced, and RegionDurability tracks only the writes
			// attempted: the barrier would pass over chunks still dirty in memory. Never forced (an op's backup window): refused
			throw new IllegalStateException(off);
		}
		if (!loadFailed) {
			// (v0.79.0 release review P1) T0's barrier: players, then chunks (a swallowed serialization failure is an owed save, not a
			// durable write), then the ledger confirmed; anything short of OK refuses the repair before it releases anything
			DurableBarrier.Result r = barrier(srv);
			if (!r.ok()) {
				throw new IllegalStateException("Stockpiles: the world was not saved: " + r.outcome() + " " + r.reason());
			}
			return;
		}
		if (testRefuseSave) {
			throw new IllegalStateException("Stockpiles: the world was not saved: chunk writes not durable [TEST: dev.stockpile.ps refuseSave]");
		}
		explicitSave = true;
		boolean wasTiming = SaveTiming.explicit;
		SaveTiming.explicit = true;
		try {
			srv.saveAllChunks(true, true, false);
		} finally {
			explicitSave = false;
			SaveTiming.explicit = wasTiming;
		}
		String skipped = SaveEvidence.chunksRefusal(srv); // (SOFF) its own save wrote every level
		if (skipped != null) {
			throw new IllegalStateException("Stockpiles: the world was not saved: " + skipped);
		}
		RegionDurability.retryOwed();
		java.util.List<String> undurable = RegionDurability.undurable("chunk", "entities");
		if (!undurable.isEmpty()) {
			throw new IllegalStateException("Stockpiles: the world was not saved: chunk writes not durable " + undurable);
		}
		java.util.List<String> owed = DurableBarrier.owedSaves(); // (v0.79.0 review P1) a swallowed chunk or player save failure
		if (!owed.isEmpty()) {
			throw new IllegalStateException("Stockpiles: the world was not saved: owed saves " + owed);
		}
	}

	/**
	 * (DR2 fix, P1-2) Why the world's chunks can't be saved now (a level with saving off, {@code /save-off}), or null. A save then writes
	 * nothing of that level, yet reports no undurable write.
	 */
	static @Nullable String savingOff(MinecraftServer srv) {
		return savingOffMessage(levelsSavingOff(srv));
	}

	/** (slice SOFF) The levels with saving off ({@code /save-off}, {@code noSave}), by dimension id. */
	static List<String> levelsSavingOff(MinecraftServer srv) {
		List<String> off = new ArrayList<>();
		for (ServerLevel l : srv.getAllLevels()) {
			if (l.noSave()) {
				off.add(l.dimension().identifier().toString());
			}
		}
		return off;
	}

	/**
	 * (slice SOFF, pure) A save's refusal over the levels with saving off, or null: none off, or the save {@code forced} (saveAllChunks then
	 * writes them too: /save-all). Names the dimensions and says /save-on.
	 */
	static @Nullable String savingOffRefusal(List<String> levelsOff, boolean forced, String what, String then) {
		if (forced || levelsOff.isEmpty()) {
			return null;
		}
		return "saving is off (/save-off) in " + String.join(", ", levelsOff) + ": " + what + "; /save-on, then " + then;
	}

	/** (slice SOFF, pure) Whether a refusal is logged: the first over a set of levels, and again only when the set changes. */
	static boolean savingOffLogs(@Nullable String lastLogged, String levelsNow) {
		return !levelsNow.equals(lastLogged);
	}

	/** (slice SOFF) The levels the last logged saving-off refusal named; null while saving is on. Server thread. */
	private static @Nullable String savingOffLast;
	/** (slice SOFF) Scopes save()'s flag check to a world save whose evidence showed every level written (a forced /save-all included). */
	private static boolean evidencedSave;
	/** (slice SOFF) The last incoherent world save's reason logged (once per change). */
	private static @Nullable String lastIncoherent;
	/** (slice SOFF, dev) ledger saves refused because a level had saving off. */
	static volatile int savingOffRefusals;

	/**
	 * (slice SOFF) The ledger save {@code what}'s refusal while a level has saving off (unless {@code forced}): the ledger stays pending
	 * (unsaved) and the refusal is logged once per change of the levels off, never per periodic save. Null when it may save (then a
	 * refusal logged earlier is closed with one line).
	 */
	static @Nullable String savingOffCheck(MinecraftServer srv, boolean forced, String what) {
		List<String> off = levelsSavingOff(srv);
		String msg = savingOffRefusal(off, forced, what + " did not write the stockpile ledger (the world's chunks are not being saved, so it would be"
			+ " ahead of them)", "it is saved with the world");
		if (msg == null) {
			if (off.isEmpty() && savingOffLast != null) {
				Architect.LOGGER.info("Stockpiles: saving is on again (it was off in {}); the ledger is saved with the world", savingOffLast);
				savingOffLast = null;
			}
			return null;
		}
		savingOffRefusals++;
		String levels = String.join(", ", off);
		if (savingOffLogs(savingOffLast, levels)) {
			savingOffLast = levels;
			Architect.LOGGER.warn("Stockpiles: {} (logged once until saving is on)", msg);
		}
		return msg;
	}

	/** (pure) {@link #savingOff}'s message over the levels with saving off. */
	static @Nullable String savingOffMessage(List<String> levelsOff) {
		return levelsOff.isEmpty() ? null : "saving is off (/save-off) in " + String.join(", ", levelsOff)
			+ ": the world can't be saved, so a repair can't be made durable; /save-on, then repair";
	}

	/**
	 * (T2b last round P1 1) {@link #saveWithWorld}, refused too when the stockpiles failed to load this session (that save writes nothing and
	 * returns): for a record the caller needs durable before it goes on (a removal's settle stash). Throws IllegalStateException.
	 */
	static void saveWithWorldConfirmed(MinecraftServer srv) {
		if (loadFailed || dir == null) {
			refusedSave();
			throw new IllegalStateException("Stockpiles: the ledger can't be saved: " + (loadFailed ? FILE + " failed to load this session" : "no world"));
		}
		saveWithWorld(srv);
	}

	static void saveWithWorld(MinecraftServer srv) {
		boolean quiet = quietSave;
		quietSave = false;
		if (testRefuseSave && !quiet) {
			// (DR-S, TEST dev.stockpile.ps refuseSave) as SS refuses an explicit save whose chunk writes are not durable: nothing written
			throw new IllegalStateException("Stockpiles: the ledger was not saved: chunk writes not durable [TEST: dev.stockpile.ps refuseSave]");
		}
		if (loadFailed) {
			refusedSave();
			return; // (PS, F6) nothing of the stockpiles is written this session
		}
		if (srv != null) {
			// (slice SOFF) saveAllChunks skips a level with saving off (/save-off) and RegionDurability sees no write for it, so the ledger would
			// be published over chunks not on disk: refused before anything is written (the players too), as an undurable write is; the
			// periodic save quietly, an explicit one by throwing (its caller keeps its intent: the ledger stays pending)
			String off = savingOffCheck(srv, false, quiet ? "the periodic save" : "a save with the world");
			if (off != null) {
				if (quiet) {
					return;
				}
				throw new IllegalStateException("Stockpiles: " + off);
			}
		}
		long t0 = System.nanoTime();
		boolean timed = srv != null && srv.isSameThread() && !SaveTiming.on();
		if (timed) {
			SaveTiming.start();
		}
		if (srv != null && srv.isSameThread()) {
			// (HF) the players first: a ledger save that booked a deposit (items out of an inventory) or a dissolve or withdraw (items into one)
			// is never on disk ahead of player.dat, so a crash after it neither dupes nor loses those items. saveAllChunks never saves players
			// (26.3: level.dat keeps only the singleplayer host's UUID; every player, the host too, is in playerdata/<uuid>.dat).
			long p0 = System.nanoTime();
			SaveTiming.at(SaveTiming.PLAYERS);
			srv.getPlayerList().saveAll();
			SaveTiming.at(SaveTiming.OTHER);
			double pms = (System.nanoTime() - p0) / 1e6;
			WorldJournal.kill("HF1"); // (J1, TEST) HF's window: the players on disk, the chunks and the ledger not
			playerSaves++;
			lastPlayerSaveMs = pms;
			maxPlayerSaveMs = Math.max(maxPlayerSaveMs, pms);
			// (HF, N3) then the chunks, flushed (BEFORE_SAVE runs at saveAllChunks' head: it is skipped here), then the ledger: it is never on
			// disk ahead of the world's chunks either
			boolean wasExplicit = explicitSave(true);
			boolean wasTiming = SaveTiming.explicit;
			SaveTiming.explicit = true; // (SS) ChunkSaveWaitMixin's scope: Architect's own flushed saves
			try {
				srv.saveAllChunks(true, true, false);
			} finally {
				explicitSave(wasExplicit); // (slice T0 review P2-10) restored, never reset: a nested save keeps the outer one's scope
				SaveTiming.explicit = wasTiming;
			}
			// (slice SOFF, review finding 4) its own save wrote every level (recorded while it ran): else nothing is published
			String skipped = SaveEvidence.chunksRefusal(srv);
			if (skipped != null) {
				savingOffRefusals++;
				SaveEvidence.log(quiet ? "the periodic save" : "a save with the world", skipped);
				if (timed) {
					SaveTiming.stop();
				}
				if (quiet) {
					return;
				}
				throw new IllegalStateException("Stockpiles: the ledger was not saved: " + skipped);
			}
			// (SS) every chunk and entity write a successful force covered (RegionDurability): else the ledger is not published
			RegionDurability.retryOwed(); // (SS) an owed path reopened and forced first: a recovered disk clears it
			java.util.List<String> undurable = RegionDurability.undurable("chunk", "entities");
			if (!undurable.isEmpty()) {
				refuseUndurable(quiet ? "the periodic save" : "a save with the world", undurable);
				if (timed) {
					logTiming((quiet ? "periodic" : caller()) + " REFUSED", t0, SaveTiming.stop());
				}
				if (quiet) {
					return; // retried at the next periodic save; the ledger stays pending (unsaved)
				}
				throw new IllegalStateException("Stockpiles: the ledger was not saved: chunk writes not durable " + undurable);
			}
			if (inCreditSave && "CS1".equals(WorldJournal.armed())) {
				// (J2, TEST kill point CS1) a crash inside a credit's save: the players and the chunks (the restore) on disk, the ledger not
				Architect.LOGGER.error("Stockpiles: kill point CS1: a credit's save flushed its chunks, halting before the ledger write (dev.journal.killAt)");
				Runtime.getRuntime().halt(7);
			}
			if (Fills.haltBeforeLedger()) {
				// (M5 FK, TEST kill point FK3) a crash inside the commit: the players and the chunks are on disk, the ledger is not
				Architect.LOGGER.error("Stockpiles: kill point FK3: the chunks flushed, halting before the ledger write (dev.journal.killAt)");
				Runtime.getRuntime().halt(7);
			}
		}
		boolean confirmed = save();
		if (!confirmed && !quiet) {
			// (T2b last round P1 1) a ledger write not confirmed (REFUSED or IN_DOUBT, an owed player or chunk save): an explicit save with the
			// world throws as a chunk write not durable does, so no caller treats it as saved (the ledger stays pending; the next save writes it)
			if (timed) {
				logTiming(caller() + " REFUSED", t0, SaveTiming.stop());
			}
			throw new IllegalStateException("Stockpiles: the ledger was not saved: its write was not confirmed");
		}
		double ms = (System.nanoTime() - t0) / 1e6;
		worldSaves++;
		lastWorldSaveMs = ms;
		maxWorldSaveMs = Math.max(maxWorldSaveMs, ms);
		if (!quiet || TRACE_SAVES) {
			Architect.LOGGER.info("Stockpiles: saved with the world's chunks in {} ms{}", String.format(java.util.Locale.ROOT, "%.1f", ms), quiet ? " (periodic)" : "");
		}
		if (timed) {
			String parts = SaveTiming.stop();
			if (!quiet || TRACE_SAVES || ms >= TIMING_LOG_MS) {
				logTiming(quiet ? "periodic" : caller(), t0, parts);
			}
		}
	}

	/** (SS, dev) ledger saves refused because a chunk or entity write was not known durable. */
	static volatile int durabilityRefusals;

	/** (SS) A ledger write refused: a chunk write not durable (a force that failed, a close that owes). Logged at ERROR; the ledger stays pending. */
	private static void refuseUndurable(String what, java.util.List<String> undurable) {
		durabilityRefusals++;
		unsaved = true;
		Architect.LOGGER.error("Stockpiles: {} did not write the ledger: {} region file(s) not durable ({}); it is written at the next save whose forces"
			+ " succeed", what, undurable.size(), undurable.size() > 8 ? undurable.subList(0, 8) + " ..." : undurable);
	}

	/** (SS) A save with the world logs its parts at or above this (ms), and every one not periodic. */
	static final double TIMING_LOG_MS = 50;

	/** (SS) The save's parts, one line: "SS save: <why> total <ms> | players .. | chunks .. | io .. | ...". */
	private static void logTiming(String why, long t0, String parts) {
		double ms = (System.nanoTime() - t0) / 1e6;
		Architect.LOGGER.info("SS save: {} total {} ms | {}{}", why, String.format(java.util.Locale.ROOT, "%.1f", ms), parts, testNoPeriodic ? " | noPeriodic" : "");
	}

	/** (SS) The first method outside the save helpers that asked for this save (Class.method), for the timing line. */
	private static String caller() {
		return StackWalker.getInstance().walk(f -> f.map(x -> x.getClassName().substring(x.getClassName().lastIndexOf('.') + 1) + "." + x.getMethodName())
			.filter(n -> !n.startsWith("Stockpiles.saveWithWorld") && !n.startsWith("Stockpiles.saveCredit") && !n.startsWith("Stockpiles.caller")
				&& !n.startsWith("Stockpiles.lambda$caller"))
			.findFirst().orElse("?"));
	}

	/**
	 * (J1, HF's window) The save after a move out of the stock into a player's inventory (a Take, a dissolve to the player): the ledger
	 * first, then the players, then the chunks flushed. Its caller saves with the world first when anything else was pending
	 * ({@code unsaved}), so this save holds only that move. A crash between the ledger and the players then loses the move (the ledger let
	 * the items go, the saved player never got them) instead of duping it (saveWithWorld's order: the player saved with them, the ledger
	 * still holding them). Server thread; off it, the ledger alone.
	 */
	static void saveLedgerFirst(MinecraftServer srv) {
		saveLedgerFirst(srv, () -> {
		});
	}

	/**
	 * The ledger first, durably; then {@code between} (T0 review 4 P1-2: a payout's moves into the world, crates taken, items dropped: only
	 * once its debit is on disk); then the players and the chunks. False when the ledger was not durably written: nothing after it ran.
	 */
	static boolean saveLedgerFirst(MinecraftServer srv, Runnable between) {
		if (loadFailed) {
			refusedSave();
			return false;
		}
		long l0 = System.nanoTime();
		boolean timed = srv != null && srv.isSameThread() && !SaveTiming.on();
		if (timed) {
			SaveTiming.start();
		}
		if (!save()) {
			// (T0 review 3 finding 2) the ledger is not durably on disk (held over an owed save, refused, in doubt): no player or chunk save
			// follows that could put the paid items on disk ahead of it
			if (timed) {
				SaveTiming.stop();
			}
			Architect.LOGGER.error("Stockpiles: a payout's ledger save did not complete; its players and chunks are not saved ahead of it");
			return false;
		}
		between.run();
		if (srv == null || !srv.isSameThread()) {
			return true;
		}
		WorldJournal.kill("LF1"); // (TEST) the ledger on disk, the players not
		long t0 = System.nanoTime();
		SaveTiming.at(SaveTiming.PLAYERS);
		srv.getPlayerList().saveAll();
		SaveTiming.at(SaveTiming.OTHER);
		double pms = (System.nanoTime() - t0) / 1e6;
		playerSaves++;
		lastPlayerSaveMs = pms;
		maxPlayerSaveMs = Math.max(maxPlayerSaveMs, pms);
		boolean wasExplicit = explicitSave(true);
		boolean wasTiming = SaveTiming.explicit;
		SaveTiming.explicit = true; // (SS) ChunkSaveWaitMixin's scope
		try {
			srv.saveAllChunks(true, true, false);
		} finally {
			explicitSave(wasExplicit); // restored, never reset
			SaveTiming.explicit = wasTiming;
		}
		String skipped = SaveEvidence.chunksRefusal(srv);
		if (skipped != null) {
			// (SOFF) payouts are held while saving is off (SaveHold); a level turned off inside this save is reported, the debit is on disk
			Architect.LOGGER.error("Stockpiles: a payout's world save after its ledger: {}", skipped);
		}
		double ms = (System.nanoTime() - t0) / 1e6;
		ledgerFirstSaves++;
		lastLedgerFirstMs = ms;
		worldSaves++; // a save with the world too, in the other order
		lastWorldSaveMs = ms;
		maxWorldSaveMs = Math.max(maxWorldSaveMs, ms);
		Architect.LOGGER.info("Stockpiles: saved the ledger first, then the players and the world's chunks, in {} ms", String.format(java.util.Locale.ROOT,
			"%.1f", ms));
		if (timed) {
			logTiming("ledger first (" + caller() + ")", l0, SaveTiming.stop());
		}
		return true;
	}

	/** (J1, dev) the ledger-first saves this session and the last one's players + chunks time (ms). */
	static volatile int ledgerFirstSaves;
	static volatile double lastLedgerFirstMs;

	/**
	 * The ledger written (forced, through its DurableFile). True only when it is durably on disk now: a hold (a refused load, an owed save),
	 * a REFUSED write and an IN_DOUBT one all answer false and leave the ledger pending (T0 review 3 finding 2: IN_DOUBT is never "saved").
	 * True too when there is nothing to write (no stockpile ever).
	 */
	/** (slice T4b fix round, TEST dev.stockpile.ps failLedgerOnly) The next n ledger writes fail (the chunks flush; the queue file is untouched). */
	static final java.util.concurrent.atomic.AtomicInteger TEST_FAIL_LEDGER = new java.util.concurrent.atomic.AtomicInteger();

	static boolean save() {
		Path d = dir;
		if (d == null) {
			return false;
		}
		if (TEST_FAIL_LEDGER.get() > 0 && TEST_FAIL_LEDGER.getAndDecrement() > 0) {
			Architect.LOGGER.warn("Stockpiles: TEST failLedgerOnly: this ledger write fails");
			return false;
		}
		if (loadFailed) {
			refusedSave();
			return false; // (PS, F6) the unreadable file is never overwritten (with an empty registry or anything else)
		}
		java.util.List<String> owed = DurableBarrier.owedSaves();
		if (!owed.isEmpty()) {
			// (slice T0 review 2 finding 1) a player or chunk save is owed: no ledger is published over it (an autosave, a save with the world,
			// the stop's save), so its credits never reach the disk ahead of what they came from; the ledger stays pending
			refuseUndurable("a ledger save", owed);
			return false;
		}
		MinecraftServer sv = SERVER;
		if (sv != null && savingOffCheck(sv, evidencedSave, "a ledger save") != null) {
			return false; // (slice SOFF) saveLedgerFirst's and compensate's write too: never over a level with saving off (unless forced)
		}
		if (sv != null && sv.isSameThread()) {
			try {
				long t0 = System.nanoTime();
				SaveTiming.at(SaveTiming.BOOKS);
				int n = refreshBooks(sv);
				SaveTiming.at(SaveTiming.OTHER);
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
			if (PILES.isEmpty() && OwedLedger.isEmpty() && CrateSettle.durableEmpty() && !Files.exists(f)) {
				return true; // a world that never had a stockpile keeps no file (0.17.0 worlds load unchanged)
			}
			SaveTiming.at(SaveTiming.WRITE);
			// (slice T0 review P1-7) through the ledger's DurableFile: its store id and generation stay in the file. (T0 review 2 finding 6)
			// forced like the barrier's write: an unforced replacement could leave a torn file over an acknowledged generation. Cost: one file
			// and one folder force per ordinary save (the barrier's ledger step measured p50 8 ms on this machine)
			DurableFile df = ledger(f);
			DurableFile.Result put = df.write(toJson(), df.request());
			SaveTiming.at(SaveTiming.OTHER);
			if (!put.ok()) {
				unsaved = true; // REFUSED or IN_DOUBT: not saved; the next save writes it again
				throw new IOException("the ledger's write was " + put.outcome() + ": " + put.reason());
			}
			ledgerDebt = null; // durably on disk: memory and the file agree again
			saves++;
			unsaved = false;
			lastSaveTick = ticks;
			if (TRACE_SAVES) {
				Architect.LOGGER.info("Stockpiles saved ({} stockpile(s), save #{})", PILES.size(), saves);
			}
			return true;
		} catch (IOException e) {
			Architect.LOGGER.warn("Could not save {}", f, e);
			return false;
		}
	}

	/** (slice T0) The ledger's durable file (its generations persisted in it), made for the world's dir on first use. */
	private static @Nullable DurableFile ledgerFile;

	/**
	 * (slice T0) The ledger's one DurableFile for {@code f}: every ledger write (the barrier's and the ordinary save's) goes through it, so the
	 * store id and generation are never dropped. Made at load ({@link #loadFrom}) and forgotten when the world stops.
	 */
	static DurableFile ledger(Path f) {
		DurableFile df = ledgerFile;
		if (df == null || !df.file().equals(f)) {
			df = new DurableFile("stockpiles", f);
			ledgerFile = df;
		}
		return df;
	}

	/** (slice T0) The ledger's DurableFile of the world loaded now, or null (dev, units). */
	static @Nullable DurableFile ledgerFile() {
		return ledgerFile;
	}

	/** (slice T1) The ledger's DurableFile, for a txn's retirement await ({@code {id, gen}} from a completed barrier), or null. */
	public static @Nullable DurableFile ledgerDurable() {
		return ledgerFile;
	}

	/** (slice T1, dev.txn.conservation) {@link #audit}'s parts for the txn conservation report. Server thread. */
	public static JsonObject auditParts(MinecraftServer srv, ServerPlayer player, @Nullable String owner, JsonObject req) {
		return audit(srv, player, owner, req);
	}

	/**
	 * (slice T0) Sets the explicit-save flag the world-save callback reads (the barrier writes the ledger itself) and answers the one it
	 * replaces, so a caller restores it (review P2-10: a nested save never clears an outer one's). Server thread.
	 */
	static boolean explicitSave(boolean on) {
		boolean was = explicitSave;
		explicitSave = on;
		return was;
	}

	/**
	 * (slice T0, docs/TXN-DESIGN.md §3.1) The world barrier: players, then chunks, then the ledger through {@link DurableFile}; refused under
	 * {@code /save-off}, after a failed load or on any failed step ({@link DurableBarrier}). Server thread.
	 */
	public static DurableBarrier.Result barrier(MinecraftServer srv) {
		return DurableBarrier.run(srv);
	}

	/**
	 * (slice T0) The ledger written as a confirmed snapshot ({@link DurableFile}: temp, force, rename, folder force, its generation in the
	 * file), the cell books refreshed first as {@link #save} does. No file is made for a world that never had a stockpile (OK, generation 0).
	 */
	static DurableFile.Result writeConfirmed(MinecraftServer srv) {
		if (TEST_FAIL_LEDGER.get() > 0 && TEST_FAIL_LEDGER.getAndDecrement() > 0) {
			Architect.LOGGER.warn("Stockpiles: TEST failLedgerOnly: this ledger write fails");
			return new DurableFile.Result(DurableFile.Outcome.REFUSED, 0, "TEST failLedgerOnly");
		}
		Path d = dir;
		if (d == null) {
			return new DurableFile.Result(DurableFile.Outcome.REFUSED, 0, "no world loaded");
		}
		if (loadFailed) {
			return new DurableFile.Result(DurableFile.Outcome.REFUSED, 0, "the ledger failed to load this session");
		}
		Path f = d.resolve(FILE);
		if (PILES.isEmpty() && OwedLedger.isEmpty() && CrateSettle.durableEmpty() && !Files.exists(f)) {
			return new DurableFile.Result(DurableFile.Outcome.OK, 0, null);
		}
		try {
			refreshBooks(srv);
		} catch (RuntimeException e) {
			Architect.LOGGER.error("Stockpiles: the targets' cell books could not be refreshed; the last ones are written", e);
		}
		DurableFile df = ledger(f);
		DurableFile.Result r = df.write(toJson(), df.request());
		if (r.ok()) {
			ledgerDebt = null;
			saves++;
			unsaved = false;
			lastSaveTick = ticks;
		}
		return r;
	}

	/** Logs every save (dev: ARCHITECT_TRACE_STOCKPILE=1; the gate's clean-stop check reads it). */
	static final boolean TRACE_SAVES = System.getenv("ARCHITECT_TRACE_STOCKPILE") != null;

	private static void load(MinecraftServer server) {
		SERVER = server;
		RegionDurability.worldOpened(server.getWorldPath(LevelResource.ROOT)); // (SS) only this world's region files count
		ChunkDebt.worldClosed(); // (slice T0) nothing of an earlier world is owed in this one
		Path playerDir = server.getWorldPath(LevelResource.PLAYER_DATA_DIR);
		PlayerSaves.worldOpened((id, snapshot) -> { // (slice T0, TXN item 5) an owed offline player's kept snapshot, written as vanilla writes it
			Files.createDirectories(playerDir);
			Path tmp = Files.createTempFile(playerDir, id + "-", ".dat");
			net.minecraft.nbt.NbtIo.writeCompressed((net.minecraft.nbt.CompoundTag) snapshot, tmp);
			return net.minecraft.util.Util.safeReplaceOrMoveFile(playerDir.resolve(id + ".dat"), tmp, playerDir.resolve(id + ".dat_old"), false);
		});
		loadFrom(server.getWorldPath(LevelResource.ROOT).resolve("architect"));
		forgetEarlyRuns(server);
		Sites.crateCheckAfterStockpiles(server); // (chore LT) the crate-less sites' crate check, now that it can see which a stockpile feeds
		CrateSettle.sweepLater(server); // (T2b last round P1 2, 3) the durable settle stashes no job or pending record carries: settled or forgotten
	}

	/**
	 * (LIFT-S-1 review P1) The runs made at this start before the stockpiles loaded (the Sites check makes and caches every construction
	 * site's run in an earlier SERVER_STARTED listener) were made with no pile: {@link #attachPaid} gave them no paid cells, so a paid soil
	 * cell vanilla changed since counted unbuilt (blocked for ever; after an unclean stop the reconcile gave it back as lost while it stood).
	 * Every stockpile target's cached run is dropped here, so it is made again from the loaded stores before the reconcile, the waits, the
	 * books or the feed read it; nothing but the Sites check's rescan has touched them yet. A site's is made again at once and rescanned with
	 * its chunks loaded, as the Sites check did; a road's (made lazily) on its next use. Server thread.
	 */
	static void forgetEarlyRuns(MinecraftServer srv) {
		for (Pile p : PILES.values()) {
			ServerLevel level = Sites.levelOf(srv, p.dimension);
			for (Object t : bookTargets(p)) {
				if (t instanceof Site s) {
					Builder.forgetRun(s.id());
					Builder.Run r = level == null || s.construction() == null ? null : Builder.run(srv, s);
					if (r != null) {
						r.rescan(level, true);
						r.newlyCount = 0;
						r.resend = false;
					}
				} else {
					RoadBuilder.forgetRun(((Infra) t).id());
				}
			}
		}
	}

	/** (PS) The registry from {@code <d>/stockpiles.json} (the world's architect dir); the save guard set when it can't be read. Tests call it. */
	static void loadFrom(Path d) {
		dir = d;
		PILES.clear();
		OwedLedger.clear();
		DURABLE_WB.clear();
		CrateSettle.durableRead(null);
		DURABLE_WB_GEN = 0;
		nextId = 1;
		loadFailed = false;
		loadFailedWhy = null;
		refusedLogged = false;
		Path f = dir.resolve(FILE);
		ledgerFile = null; // (slice T0 review P1-7) nothing of another session's or world's acknowledgements carries over
		ledgerDebt = null;
		if (!Files.isRegularFile(f)) {
			ledger(f);
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
			return;
		}
		DurableFile lf = ledger(f); // its store id and generation read back, the generation confirmed (forced again) before it counts as written
		DURABLE_WB_GEN = lf.installedGen(); // (T2b fix round, GPT P1-4) the loaded generation: DURABLE_WB counts only once it is confirmed
	}

	/** (slice T2b fix round) The generation of the file DURABLE_WB was read from (0: none). */
	static long DURABLE_WB_GEN;

	/**
	 * (slice T2b fix round, GPT P1-4) Whether the loaded ledger's write-back keys may prune receipts: only once the generation they came from is
	 * confirmed (its re-force returned), never while it is in doubt (a power loss could still lose it).
	 */
	static boolean durableWbConfirmed() {
		DurableFile l = ledgerFile;
		return l != null && pruneConfirmed(l.writtenGen(), DURABLE_WB_GEN, l.inDoubt() > 0);
	}

	/** (pure) A loaded generation {@code loaded} is confirmed when the file's written (acknowledged) generation reached it, nothing in doubt. */
	static boolean pruneConfirmed(long written, long loaded, boolean inDoubt) {
		return loaded > 0 && written >= loaded && !inDoubt;
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
		DURABLE_WB.clear(); // (slice T2b, the receipt-leak P2) the write-back keys this file credits (used once its generation is confirmed)
		for (Pile p : PILES.values()) {
			p.ledger.creditedKeys().stream().filter(k -> k.startsWith("wb:")).forEach(DURABLE_WB::add);
		}
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
		OwedLedger.readInto(root.get("owed"));
		CrateSettle.durableRead(root.get("crateSettles"));
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

	/**
	 * (slice T2b) The custody write-back keys credited in the ledger file this session loaded (durable: a receipt under one of them is stale
	 * and is dropped when a write-back next visits its chunk). Never the in-memory credited set, which a crash can still lose.
	 */
	static final java.util.Set<String> DURABLE_WB = new java.util.HashSet<>();

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
