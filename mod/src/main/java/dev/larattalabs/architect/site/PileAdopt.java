package dev.larattalabs.architect.site;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import dev.larattalabs.architect.Architect;
import dev.larattalabs.architect.api.Reason;
import dev.larattalabs.architect.journal.JournalStore;
import dev.larattalabs.architect.journal.WorldJournal;
import dev.larattalabs.architect.survival.CrateBlockEntity;
import dev.larattalabs.architect.survival.Ledger;
import dev.larattalabs.architect.txn.CrateTxn;
import dev.larattalabs.architect.txn.Effect;
import dev.larattalabs.architect.txn.EffectClass;
import dev.larattalabs.architect.txn.Holds;
import dev.larattalabs.architect.txn.Probe;
import dev.larattalabs.architect.txn.TxnCore;
import dev.larattalabs.architect.txn.TxnEntry;
import dev.larattalabs.architect.txn.TxnKind;
import dev.larattalabs.architect.txn.TxnServer;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.concurrent.TimeUnit;
import net.minecraft.core.BlockPos;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import org.jspecify.annotations.Nullable;

/**
 * (slice T3b, the T3 design §1-§3 with Noah's decisions 1-6) Adoption as the txn kind {@code pile.adopt} (kv 1, decider txn, null key: a
 * later call may find new crates, so a committed result never replays; dedupe is per crate, by its ledger key
 * {@code adopt:<crateOwner>@<pos>}). One txn per {@code adoptCrates} call (decision 6).
 *
 * <p><b>Plan</b> ({@link AdoptPlan}, R-1): each candidate crate's fate is read once. JOIN (it reads as its owner's, its key not credited);
 * GONE (DFG: its cell read, no crate there, nothing credited: nothing to take, its targets are freed); DEFER (unreadable, retagged, its cell
 * not read, or its paid record would read more unloaded chunks than {@link #CHUNK_BOUND}: left out of the plan and the resources). The
 * resources ({@code pile:<owner>}, {@code crate:<dim>@x,y,z}, {@code site:}/{@code road:}/{@code group:} per record naming one) are taken
 * before any amount is read; the chunks a shared crate's paid records read are loaded under them (decision 4). Every amount (the crate's
 * stock, delivered, placed, the paid records by target, the cell's snapshot, the feed-order additions) is copied into the intent, so
 * recovery never reads a crate or a record (R-7).
 *
 * <p><b>Effects</b>, in plan order: {@code crate.take} per JOIN crate with stock (B, prepare: {@link CrateTxn#take}); the decision; then
 * {@code ledger.adopt} per JOIN crate (L: delivered, placed and the paid records booked, the stock-in past capacity: decision 1, no owed
 * entry and nothing dropped; marker: the adoption key credited), {@code ledger.order} (L: the joined building targets appended in placement
 * order; marker {@code txn:<tx-n>/<i>} credited in the same ledger write), {@code crate.restore} per JOIN and GONE cell (W:
 * {@link CrateTxn#restore}), {@code journal.release} (R: the crate's journal kind released, confirmed; probe: no active kind left), and
 * {@code record.clear} per group, site and road (R: its crate reference cleared; probe: the record names no crate at that cell).
 *
 * <p><b>Kill points</b>: the core's {@code TX:pile.adopt:*}; the legacy {@code SAC1} (the takes applied, nothing saved) and {@code SAC2}
 * (the first record cleared) are aliases of the forward path's points ({@link TxnKind#alias}). A crash before the decision rolls back
 * (decision 2: PREPARED_DONE too); one after rolls forward. Server thread.
 */
public final class PileAdopt {
	private PileAdopt() {
	}

	public static final String NAME = "pile.adopt";
	/** (decision 3) The quarantined entry that holds a legacy FINISH crate for ops (no kind of this name: it stays quarantined). */
	public static final String FINISH_HELD = "pile.adopt.finish";
	static final String CREDIT = "ledger.adopt", ORDER = "ledger.order", RELEASE = "journal.release", CLEAR = "record.clear";
	/** (decision 4) At most this many unloaded chunks are loaded for the paid records of one call; a crate past it is deferred whole. */
	public static final int CHUNK_BOUND = 64;

	/**
	 * What one call did: the crate keys joined (JOIN and GONE), those deferred with their stable reason ({@code unreadable}, {@code retagged},
	 * {@code not a crate}, {@code chunks unloaded}; a legacy credited crate that still stands: {@code held for ops}), and the txn's id (null
	 * when there was nothing to adopt).
	 */
	public record Result(String owner, List<String> joined, Map<String, String> deferred, @Nullable String txnId) {
	}

	// ------------------------------------------------------------------ the adapters

	static Stockpiles.@Nullable Pile pile(Effect e) {
		return Stockpiles.get(e.data().get("owner").getAsString());
	}

	static Map<String, Integer> counts(@Nullable JsonElement o) {
		Map<String, Integer> m = new TreeMap<>();
		if (o instanceof JsonObject j) {
			j.entrySet().forEach(x -> m.put(x.getKey(), x.getValue().getAsInt()));
		}
		return m;
	}

	static JsonObject json(Map<String, Integer> m) {
		JsonObject o = new JsonObject();
		new TreeMap<>(m).forEach(o::addProperty);
		return o;
	}

	/** {@code ledger.adopt}: the crate's whole ledger joins the pile's, keyed; the stock past capacity (decision 1). */
	static final TxnKind.Adapter CREDIT_ADAPTER = new TxnKind.Adapter() {
		@Override
		public Probe probe(TxnEntry t, Effect e) {
			Stockpiles.Pile p = TxnServer.storesLoaded() ? pile(e) : null;
			if (p == null) {
				return Probe.UNKNOWN; // the stockpiles load after the recovery slot: held until the first tick (never read as ABSENT)
			}
			return p.ledger.credited(e.data().get("key").getAsString()) ? Probe.APPLIED : Probe.ABSENT;
		}

		@Override
		public void apply(TxnEntry t, Effect e) {
			Stockpiles.Pile p = pile(e);
			if (p == null) {
				throw new IllegalStateException("no stockpile " + e.data().get("owner").getAsString());
			}
			Map<String, Map<String, Integer>> byTarget = new LinkedHashMap<>();
			if (e.data().get("byTarget") instanceof JsonObject b) {
				b.entrySet().forEach(x -> byTarget.put(x.getKey(), counts(x.getValue())));
			}
			p.ledger.adopt(e.data().get("key").getAsString(), counts(e.data().get("delivered")), counts(e.data().get("placed")), byTarget, Integer.MAX_VALUE,
				Stockpiles::maxStack); // (decision 1) never drops: what is over capacity stays in the stock until it fits
			Stockpiles.changed(p);
		}

		@Override
		public void compensate(TxnEntry t, Effect e) {
			throw new IllegalStateException("a credit is never a prepare effect");
		}

		@Override
		public @Nullable String invalid(Effect e) {
			return !e.data().has("owner") || !e.data().has("key") ? "owner and key are required" : null;
		}

		@Override
		public String where(TxnEntry t, Effect e) {
			return "pile:" + e.data().get("owner").getAsString();
		}
	};

	/** {@code ledger.order}: the joined building targets appended to the feed order, marked in the same ledger write. */
	static final TxnKind.Adapter ORDER_ADAPTER = new TxnKind.Adapter() {
		String marker(TxnEntry t, Effect e) {
			return "txn:" + e.key(t.id);
		}

		@Override
		public Probe probe(TxnEntry t, Effect e) {
			Stockpiles.Pile p = TxnServer.storesLoaded() ? pile(e) : null;
			return p == null ? Probe.UNKNOWN : p.ledger.credited(marker(t, e)) ? Probe.APPLIED : Probe.ABSENT;
		}

		@Override
		public void apply(TxnEntry t, Effect e) {
			Stockpiles.Pile p = pile(e);
			if (p == null) {
				throw new IllegalStateException("no stockpile " + e.data().get("owner").getAsString());
			}
			for (JsonElement id : e.data().getAsJsonArray("ids")) {
				if (!p.order.contains(id.getAsString())) {
					p.order.add(id.getAsString());
				}
			}
			p.ledger.credit(marker(t, e), Map.of(), Integer.MAX_VALUE, Stockpiles::maxStack); // the marker: nothing credited
			Stockpiles.changed(p);
		}

		@Override
		public void compensate(TxnEntry t, Effect e) {
			throw new IllegalStateException("a feed-order append is never a prepare effect");
		}

		@Override
		public @Nullable String invalid(Effect e) {
			return !e.data().has("owner") || !(e.data().get("ids") instanceof JsonArray) ? "owner and ids are required" : null;
		}

		@Override
		public String where(TxnEntry t, Effect e) {
			return "pile:" + e.data().get("owner").getAsString();
		}
	};

	/** {@code journal.release}: the crate's journal kind released and confirmed (after its cell's W). Probe: no active crate entry left. */
	static final TxnKind.Adapter RELEASE_ADAPTER = new TxnKind.Adapter() {
		@Override
		public Probe probe(TxnEntry t, Effect e) {
			if (!TxnServer.storesLoaded() || WorldJournal.storeOrNull() == null) {
				return Probe.UNKNOWN;
			}
			return SiteJournal.idsOf(e.data().get("crateOwner").getAsString(), WorldJournal.CRATE).isEmpty() ? Probe.APPLIED : Probe.ABSENT;
		}

		@Override
		public void apply(TxnEntry t, Effect e) {
			JournalStore s = WorldJournal.storeOrNull();
			if (s == null) {
				throw new IllegalStateException("the world journal is not open");
			}
			String owner = e.data().get("crateOwner").getAsString();
			JournalStore.Txn jt = s.begin().label("release:" + owner + ":" + WorldJournal.CRATE + " (" + e.key(t.id) + ")");
			SiteJournal.idsOf(owner, WorldJournal.CRATE).forEach(jt::release);
			if (jt.isEmpty()) {
				return;
			}
			try {
				s.submit(jt).get(30, TimeUnit.SECONDS); // confirmed before the next effect: the barrier does not cover the journal
			} catch (Exception x) {
				throw new IllegalStateException("the journal release did not commit: " + x);
			}
		}

		@Override
		public void compensate(TxnEntry t, Effect e) {
			throw new IllegalStateException("a release is never a prepare effect");
		}

		@Override
		public @Nullable String invalid(Effect e) {
			return e.data().has("crateOwner") ? null : "crateOwner is required";
		}

		@Override
		public String where(TxnEntry t, Effect e) {
			return "journal " + e.data().get("crateOwner").getAsString();
		}
	};

	/** {@code record.clear}: a group's, site's or road's crate reference cleared. Probe: the record names no crate at that cell (or is gone). */
	static final TxnKind.Adapter CLEAR_ADAPTER = new TxnKind.Adapter() {
		Construction.@Nullable Crate named(Effect e) {
			String id = e.data().get("id").getAsString();
			return switch (e.data().get("kind").getAsString()) {
				case "group" -> {
					SiteGroupRec g = Sites.group(id);
					yield g == null ? null : g.crate();
				}
				case "road" -> {
					Infra i = Infras.get(id);
					yield i == null || i.construction() == null ? null : i.construction().crate();
				}
				default -> {
					Site s = Sites.get(id);
					yield s == null || s.construction() == null ? null : s.construction().crate();
				}
			};
		}

		boolean at(Construction.Crate c, Effect e) {
			JsonArray p = e.data().getAsJsonArray("pos");
			return c.x() == p.get(0).getAsInt() && c.y() == p.get(1).getAsInt() && c.z() == p.get(2).getAsInt();
		}

		@Override
		public Probe probe(TxnEntry t, Effect e) {
			if (!TxnServer.storesLoaded()) {
				return Probe.UNKNOWN; // the records load in SERVER_STARTED's default phase: never read as cleared before
			}
			Construction.Crate c = named(e);
			return c != null && at(c, e) ? Probe.ABSENT : Probe.APPLIED;
		}

		@Override
		public void apply(TxnEntry t, Effect e) {
			MinecraftServer srv = TxnServer.server();
			if (srv == null) {
				throw new IllegalStateException("no server");
			}
			String id = e.data().get("id").getAsString();
			switch (e.data().get("kind").getAsString()) {
				case "group" -> {
					SiteGroupRec g = Sites.group(id);
					if (g != null) {
						Sites.putGroup(srv, g.withCrate(null));
					}
				}
				case "road" -> {
					Infra i = Infras.get(id);
					if (i != null && i.construction() != null) {
						Infras.put(srv, i.withConstruction(i.construction().withCrate(null)));
					}
				}
				default -> {
					Site s = Sites.get(id);
					if (s != null && s.construction() != null) {
						Sites.replace(srv, s.withConstruction(s.construction().withCrate(null)));
						Builder.forgetRun(id);
					}
				}
			}
		}

		@Override
		public void compensate(TxnEntry t, Effect e) {
			throw new IllegalStateException("a record clear is never a prepare effect");
		}

		@Override
		public @Nullable String invalid(Effect e) {
			return !e.data().has("kind") || !e.data().has("id") || !(e.data().get("pos") instanceof JsonArray a) || a.size() != 3
				? "kind, id and pos are required" : null;
		}

		@Override
		public String where(TxnEntry t, Effect e) {
			return e.data().get("kind").getAsString() + ":" + e.data().get("id").getAsString();
		}
	};

	public static final TxnKind KIND = new TxnKind() {
		@Override
		public String name() {
			return NAME;
		}

		@Override
		public int kv() {
			return 1;
		}

		@Override
		public TxnKind.@Nullable Adapter adapter(Effect e) {
			return switch (e.op()) {
				case CrateTxn.TAKE -> CrateTxn.ADAPTER;
				case CrateTxn.RESTORE -> CrateTxn.RESTORE_ADAPTER;
				case CREDIT -> CREDIT_ADAPTER;
				case ORDER -> ORDER_ADAPTER;
				case RELEASE -> RELEASE_ADAPTER;
				case CLEAR -> CLEAR_ADAPTER;
				default -> null;
			};
		}

		@Override
		public @Nullable String alias(TxnEntry t, String step) {
			int lastTake = -1, firstClear = -1;
			for (Effect e : t.effects()) {
				if (e.prepare()) {
					lastTake = e.i();
				}
				if (firstClear < 0 && e.op().equals(CLEAR)) {
					firstClear = e.i();
				}
			}
			// SAC1: the crates taken in memory, nothing saved (no take: the same moment, after the prepare barrier)
			if (lastTake >= 0 ? step.equals("apply:" + lastTake) : step.equals("prepared")) {
				return "SAC1";
			}
			// SAC2: the first record cleared, the rest not yet
			return firstClear >= 0 && step.equals("apply:" + firstClear) ? "SAC2" : null;
		}

		@Override
		public JsonObject result(TxnEntry t) {
			JsonObject r = new JsonObject();
			JsonArray keys = new JsonArray();
			t.effects().stream().filter(e -> e.op().equals(CREDIT)).forEach(e -> keys.add(e.data().get("key").getAsString()));
			r.add("credited", keys);
			return r;
		}
	};

	// ------------------------------------------------------------------ adoptCrates

	static long chunkKey(int cx, int cz) {
		return (long) cx << 32 | cz & 0xFFFFFFFFL;
	}

	static int chunkX(long k) {
		return (int) (k >> 32);
	}

	static int chunkZ(long k) {
		return (int) k;
	}

	/** One fed target of a crate: its record's kind and id, whether it builds, and its run's chunks (for the paid rescan). */
	private record Fed(String kind, String id, boolean building, Object rec) {
	}

	/** {@code adoptCrates} as one {@code pile.adopt} txn (see the class). Server thread. */
	static Result adopt(MinecraftServer srv, String owner) throws Sites.SiteException {
		Stockpiles.Pile p = Stockpiles.get(owner);
		if (p == null) {
			throw new Sites.SiteException(Reason.NOT_ALLOWED, owner + " has no stockpile (createStockpile first)");
		}
		ServerLevel level = Sites.levelOf(srv, p.dimension);
		if (level == null) {
			throw new Sites.SiteException(Reason.NOT_LOADED, p.dimension + " is not loaded");
		}
		if (!srv.isSameThread()) {
			throw new Sites.SiteException(Reason.NOT_ALLOWED, "adoptCrates runs on the server thread"); // (ADP) off it no block entity reads
		}
		// the candidates (ADP's selection): a building target's crate, a BUILT one's whose crate block still stands (a shared crate), one
		// whose crate this ledger joined before; a construction road on its group's crate, BUILT ones included (their paid records keyed)
		Map<String, Construction.Crate> crates = new LinkedHashMap<>();
		List<Site> sites = new ArrayList<>();
		for (Site s : Sites.all()) {
			Construction.Crate sc = s.construction() == null ? null : s.construction().crate();
			if (sc != null && owner.equals(s.owner()) && p.dimension.equals(s.dimension()) && (s.building() || Stockpiles.crateBlockAt(level, new BlockPos(sc
				.x(), sc.y(), sc.z())) || Stockpiles.joinedBefore(p, s))) {
				sites.add(s);
				crates.putIfAbsent(Builder.crateOwner(s), sc);
			}
		}
		List<Infra> roads = new ArrayList<>();
		for (Infra i : Infras.all()) {
			Construction.Crate ic = i.construction() == null ? null : i.construction().crate();
			if (ic != null && i.group() != null && owner.equals(i.owner()) && p.dimension.equals(i.dimension()) && (i.building() || Stockpiles.crateBlockAt(
				level, new BlockPos(ic.x(), ic.y(), ic.z())) || Stockpiles.namesJoined(p.ledger::credited, i.id(), i.group(), ic.x(), ic.y(), ic.z()))) {
				roads.add(i);
				crates.putIfAbsent(SiteGroupRec.CRATE_PREFIX + i.group(), ic);
			}
		}
		// what each crate's cell holds (read once), the records naming it, and the chunks its paid records read (a shared crate only)
		List<AdoptPlan.CrateRead> reads = new ArrayList<>();
		Map<String, List<String>> records = new LinkedHashMap<>();
		Map<String, List<Fed>> fedBy = new LinkedHashMap<>();
		Map<String, List<Long>> paidChunks = new LinkedHashMap<>();
		for (var e : crates.entrySet()) {
			Construction.Crate c = e.getValue();
			BlockPos cp = new BlockPos(c.x(), c.y(), c.z());
			var be = level.getBlockEntity(cp); // on the server thread: loads its chunk
			boolean known = level.isLoaded(cp);
			CrateBlockEntity cb = be instanceof CrateBlockEntity x ? x : null;
			boolean block = cb != null || level.getBlockState(cp).is(dev.larattalabs.architect.survival.CrateBlocks.CRATE);
			reads.add(new AdoptPlan.CrateRead(e.getKey(), p.dimension, cp.getX(), cp.getY(), cp.getZ(), cp.asLong(), block, cb != null, cb == null ? null : cb
				.siteId(), cb != null, known));
			List<Fed> fed = new ArrayList<>();
			for (Site s : sites) {
				if (e.getKey().equals(Builder.crateOwner(s))) {
					fed.add(new Fed("site", s.id(), s.building(), s));
				}
			}
			for (Infra i : roads) {
				if (e.getKey().equals(SiteGroupRec.CRATE_PREFIX + i.group())) {
					fed.add(new Fed("road", i.id(), i.building(), i));
				}
			}
			fed.sort(java.util.Comparator.comparingLong(f -> Stockpiles.placedAt(f.rec())));
			fedBy.put(e.getKey(), fed);
			List<String> res = new ArrayList<>();
			if (e.getKey().startsWith(SiteGroupRec.CRATE_PREFIX)) {
				res.add("group:" + e.getKey().substring(SiteGroupRec.CRATE_PREFIX.length()));
			}
			fed.forEach(f -> res.add(f.kind() + ":" + f.id()));
			records.put(e.getKey(), res);
			if (fed.size() > 1) {
				Set<Long> ch = new LinkedHashSet<>();
				for (Fed f : fed) {
					Builder.Run r = f.rec() instanceof Site s ? Builder.run(srv, s) : RoadBuilder.run(srv, (Infra) f.rec());
					for (int q = 0; r != null && q < r.size(); q++) {
						BlockPos at = r.pos(q);
						ch.add(chunkKey(at.getX() >> 4, at.getZ() >> 4));
					}
				}
				paidChunks.put(e.getKey(), List.copyOf(ch));
			}
		}
		AdoptPlan.Plan plan = AdoptPlan.plan(owner, reads, p.ledger::credited, paidChunks, c -> level.hasChunk(chunkX(c), chunkZ(c)),
			CHUNK_BOUND, records);
		Map<String, String> deferred = new LinkedHashMap<>();
		plan.deferred().forEach((k, v) -> deferred.put(k, v.wire));
		for (String k : plan.finish()) {
			// (decision 3) a legacy A-model save: credited, its crate still standing. Never drained, never credited twice: its crate and the
			// records naming it are held by a quarantined txn entry (kind pile.adopt.finish), indefinitely, for ops
			deferred.put(k, "held for ops");
			AdoptPlan.CrateRead r = reads.stream().filter(x -> x.key().equals(k)).findFirst().orElseThrow();
			List<String> res = new ArrayList<>();
			res.add(r.resource());
			res.addAll(records.getOrDefault(k, List.of()));
			if (TxnServer.heldWhy(r.resource()) == null) {
				String id = TxnServer.core().holdForOps(FINISH_HELD, res, "legacy adoptCrates FINISH: " + r.adoptKey() + " is credited and its crate stands at "
					+ r.x() + "," + r.y() + "," + r.z());
				Architect.LOGGER.warn("Stockpile {}: crate {} was credited by an earlier adoptCrates that stopped before taking it; held for ops ({}): never "
					+ "drained or credited again", owner, k, id);
			}
		}
		plan.deferred().forEach((k, v) -> Architect.LOGGER.warn("Stockpile {}: crate {} not adopted ({}): it stays as it is (its stock, its journal entry, "
			+ "its targets' references); a later adoptCrates retries it", owner, k, v.wire));
		List<AdoptPlan.CrateRead> moved = new ArrayList<>(plan.join());
		moved.addAll(plan.gone());
		if (moved.isEmpty()) {
			WorldJournal.kill("SAC1"); // (the legacy points, kept: nothing to adopt, nothing changed)
			WorldJournal.kill("SAC2");
			return new Result(owner, List.of(), deferred, null);
		}
		// begin: every resource held before any amount is read
		TxnCore core = TxnServer.core();
		TxnCore.Started st = core.begin(NAME, null, plan.resources(), owner);
		if (st.status() == TxnCore.Begin.UNAVAILABLE) {
			throw new Sites.SiteException(Reason.JOURNAL_UNAVAILABLE, "txn.json failed to load this session (" + st.detail() + "); nothing adopted",
				"txn_journal");
		}
		if (st.status() != TxnCore.Begin.NEW || st.entry() == null) {
			String why = st.detail() == null ? "held(other)" : st.detail();
			throw new Sites.SiteException(Reason.SITE_BUSY, why, "held(other)");
		}
		TxnEntry t = st.entry();
		// (decision 4) the paid records' chunks loaded under the holds (within the bound: the plan deferred a crate past it)
		for (long c : plan.load()) {
			level.getChunk(chunkX(c), chunkZ(c));
		}
		List<Effect.Builder> credits = new ArrayList<>();
		for (AdoptPlan.CrateRead r : plan.join()) {
			BlockPos cp = new BlockPos(r.x(), r.y(), r.z());
			CrateBlockEntity be = (CrateBlockEntity) level.getBlockEntity(cp);
			Ledger l = java.util.Objects.requireNonNull(be).ledger();
			Map<String, Integer> stock = new TreeMap<>(l.heldStock()); // held by this txn now: the raw count (stock() hides held stock)
			Map<String, Map<String, Integer>> byTarget = Stockpiles.adoptedPaid(srv, level, r.key(), sites, roads, l.placed());
			if (!stock.isEmpty()) {
				core.plan(t, CrateTxn.take(p.dimension, cp, stock));
			}
			JsonObject bt = new JsonObject();
			byTarget.forEach((k, m) -> bt.add(k, json(m)));
			credits.add(Effect.of(CREDIT, EffectClass.L).items(stock).move(Effect.TRANSIT, "stock").data("owner", owner).data("key", r.adoptKey()).data(
				"delivered", json(l.delivered())).data("placed", json(l.placed())).data("byTarget", bt));
		}
		credits.forEach(b -> core.plan(t, b));
		// the building targets that join the feed, at the end, in placement order (a BUILT one is fully paid: it joins no feed)
		List<Object> joining = new ArrayList<>();
		for (AdoptPlan.CrateRead r : moved) {
			for (Fed f : fedBy.getOrDefault(r.key(), List.of())) {
				if (f.building()) {
					joining.add(f.rec());
				}
			}
		}
		joining.sort(java.util.Comparator.comparingLong(Stockpiles::placedAt));
		JsonArray ids = new JsonArray();
		joining.stream().map(Stockpiles::idOf).filter(id -> !p.order.contains(id)).distinct().forEach(ids::add);
		if (!ids.isEmpty()) {
			core.plan(t, Effect.of(ORDER, EffectClass.L).data("owner", owner).data("ids", ids));
		}
		for (AdoptPlan.CrateRead r : moved) {
			Construction.Crate c = crates.get(r.key());
			if (plan.join().contains(r)) {
				// (T2b's crate.restore: its probe reads a cell that is no longer a crate as restored, so a GONE cell is never written over:
				// whatever stands there now stays; only its journal kind is released)
				core.plan(t, CrateTxn.restore(p.dimension, new BlockPos(c.x(), c.y(), c.z()), c.snapshotState(), c.snapshotNbt()));
			}
			core.plan(t, Effect.of(RELEASE, EffectClass.R).data("crateOwner", r.key()));
		}
		for (AdoptPlan.CrateRead r : moved) {
			JsonArray pos = new JsonArray();
			pos.add(r.x());
			pos.add(r.y());
			pos.add(r.z());
			if (r.key().startsWith(SiteGroupRec.CRATE_PREFIX)) {
				core.plan(t, Effect.of(CLEAR, EffectClass.R).data("kind", "group").data("id", r.key().substring(SiteGroupRec.CRATE_PREFIX.length())).data("pos",
					pos.deepCopy()));
			}
			for (Fed f : fedBy.getOrDefault(r.key(), List.of())) {
				core.plan(t, Effect.of(CLEAR, EffectClass.R).data("kind", f.kind()).data("id", f.id()).data("pos", pos.deepCopy()));
			}
		}
		var o = core.persist(t);
		if (o == DurableFile.Outcome.REFUSED) {
			throw new Sites.SiteException(Reason.JOURNAL_UNAVAILABLE, "txn.json: the intent's write was refused; nothing adopted", "txn_journal");
		}
		TxnCore.Status s = core.drive(t);
		List<String> joined = moved.stream().map(AdoptPlan.CrateRead::key).toList();
		if (core.get(t.id) != null && (s == TxnCore.Status.HELD || t.held() != null)) {
			// decided (or in doubt), then held: it finishes later (an UNKNOWN probe, an IN_DOUBT write, a refused barrier, a dev pause)
			throw new Sites.SiteException(Reason.SITE_BUSY, Holds.decided(t) + (t.held() == null ? "" : " (" + t.held() + ")"), "held(decided)");
		}
		if (t.decision() != null && t.decision().isAbort()) {
			String why = t.result().has("refused") ? t.result().get("refused").getAsString() : "aborted";
			throw new Sites.SiteException(Reason.NOT_ALLOWED, "adoptCrates: " + why + "; nothing adopted");
		}
		Architect.LOGGER.info("Stockpile {}: adopted {} crate(s) in {} ({} site(s), {} road(s)){}", owner, joined.size(), t.id, sites.size(), roads.size(),
			deferred.isEmpty() ? "" : "; deferred " + deferred);
		return new Result(owner, joined, deferred, t.id);
	}
}
