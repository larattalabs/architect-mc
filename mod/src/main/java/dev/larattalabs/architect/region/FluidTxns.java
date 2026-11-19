package dev.larattalabs.architect.region;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import dev.larattalabs.architect.Architect;
import dev.larattalabs.architect.journal.WorldJournal;
import dev.larattalabs.architect.site.DurableFile;
import dev.larattalabs.architect.site.Stockpiles;
import dev.larattalabs.architect.txn.Effect;
import dev.larattalabs.architect.txn.EffectClass;
import dev.larattalabs.architect.txn.KillPoints;
import dev.larattalabs.architect.txn.Probe;
import dev.larattalabs.architect.txn.TestMove;
import dev.larattalabs.architect.txn.TxnCore;
import dev.larattalabs.architect.txn.TxnEntry;
import dev.larattalabs.architect.txn.TxnKind;
import dev.larattalabs.architect.txn.TxnServer;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.level.chunk.LevelChunk;
import org.jspecify.annotations.Nullable;

/**
 * (slice 8cTb, CONTRACT "Phase 8cT" §2) A region's fluids on the txn layer: the survival charge ({@code region.charge}: the keyed debit
 * (L), then the region record's charge with the bodies it paid for (R)) and the removal's drain ({@code fluid.drain}: the keyed scoop (L)
 * with its amounts planned once, the drain's world writes (W, a receipt in every chunk the record may write), the record's
 * {@code drained} with a fresh settle bound (R)). Both decide commit at persist: nothing is ever rolled back, everything rolls forward
 * from the entry. The settle wait, the stray pass and {@code done} stay the record's own steps after the drain retires (its writes are
 * then on disk: the barrier covered them).
 */
public final class FluidTxns {
	private FluidTxns() {
	}

	public static final String CHARGE = "region.charge";
	public static final String DRAIN = "fluid.drain";

	/** Registers both kinds (TxnServer, at load). */
	public static void register(TxnCore c) {
		c.register(CHARGE_KIND);
		c.register(DRAIN_KIND);
	}

	/** The resource a fluids record's txns hold: {@code fluid:<region>#rv<rid>} (never shown: a hold's where is its chunk). */
	static String resource(RegionsImpl.Live l) {
		return "fluid:" + l.rec().id + "#rv" + l.rid();
	}

	/** The record's identity across a restart: the region, its creation and the revision. */
	static String recKey(RegionsImpl.Live l) {
		return l.rec().id + "@" + l.rec().createdAt + "#rv" + l.rid();
	}

	/**
	 * (8cTb) The removal drain's dedupe key: a Remove asked again joins the open drain (Steward's re-askers). {@code reason}: {@code removal}
	 * (a removal's first drain), {@code legacy} (a record drained before 8cT, or a done saved before the barrier: drained again).
	 */
	public static String drainKey(RegionsImpl.Live l, String reason) {
		return "fluid-drain:" + recKey(l) + "/" + reason;
	}

	/** (8cTb) The open drain txn of a record (any reason), or null. */
	static @Nullable TxnEntry openDrain(RegionsImpl.Live l) {
		String r = resource(l);
		for (TxnEntry t : TxnServer.core().open()) {
			if (DRAIN.equals(t.kind) && t.resources.contains(r)) {
				return t;
			}
		}
		return null;
	}

	/** (N3) The scoop's ledger key: the region's for its own record (unchanged), {@code #rv<rid>} added for a revision's. */
	static String scoopKey(RegionsImpl.Live l) {
		return "region:" + l.rec().id + "@" + l.rec().createdAt + ":fluids" + (l.rid() == 0 ? "" : "#rv" + l.rid());
	}

	static RegionsImpl.@Nullable Live live(String region, int rid) {
		RegionsImpl.Live base = RegionsImpl.live(region);
		if (base == null || rid == 0) {
			return base;
		}
		RegionsImpl.Live l = Revisions.liveFor(base, Revisions.stageName(rid, RegionFluids.STAGE));
		return l != null && l.rid() == rid ? l : null;
	}

	/** An open txn of {@code kind} under {@code key}, or null. */
	static @Nullable TxnEntry open(String kind, String key) {
		for (TxnEntry t : TxnServer.core().open()) {
			if (kind.equals(t.kind) && key.equals(t.key)) {
				return t;
			}
		}
		return null;
	}

	/** Whether a charge txn under the region's charge key is open (the legacy settlement leaves it to the txn). */
	public static boolean chargeOpen(RegionsImpl.Live l) {
		return open(CHARGE, RegionFluids.chargeKey(l)) != null;
	}

	/** A step's kill point: registered as {@code TX:<kind>:<step>} (recovery's {@code TX:recover:...}), halting when armed. */
	static void step(TxnEntry t, String step) {
		KillPoints.step(t.kind, !t.live(), step);
	}

	static int rid(Effect e) {
		return e.data().get("rid").getAsInt();
	}

	static String region(Effect e) {
		return e.data().get("region").getAsString();
	}

	// ------------------------------------------------------------------ the outcome a caller reads

	/** How a txn step left its caller: done (go on), wait (it runs; the caller waits), held (with its where), refused (with why). */
	public record Step(Kind kind, @Nullable String detail) {
		public enum Kind {
			DONE, WAIT, HELD, REFUSED
		}

		static Step done() {
			return new Step(Kind.DONE, null);
		}

		static Step waiting() {
			return new Step(Kind.WAIT, null);
		}
	}

	/** The outcome of an attempt that began (or found) an entry: done once it retired, else held with its where, else waiting. */
	static Step after(TxnEntry t) {
		if (!TxnServer.core().open().contains(t)) {
			return Step.done();
		}
		if (t.held() != null) {
			return new Step(Step.Kind.HELD, "held(decided) " + t.id + ": " + (t.heldAt() != null ? t.heldAt() : t.held()));
		}
		return Step.waiting();
	}

	// ------------------------------------------------------------------ region.charge

	/**
	 * (8cTb, B) A survival region's fluids charge as a txn, planned at the gate once the stock suffices: e0 L the keyed debit, e1 R the
	 * region record's {@code charged}, {@code chargedRid}, {@code chargedBodies}, {@code chargedAt} and {@code chargeTxn} (durably). A crash
	 * between them replays e1 from the entry, the bodies included (the legacy settlement from the ledger never runs for it).
	 */
	public static Step charge(MinecraftServer s, RegionsImpl.Live l, Map<String, Integer> items, JsonArray bodies, long now) {
		String key = RegionFluids.chargeKey(l);
		TxnCore c = TxnServer.core();
		TxnCore.Started st = c.begin(CHARGE, key, List.of("charge:" + key), null);
		switch (st.status()) {
			case ATTACHED -> {
				return after(st.entry());
			}
			case REPLAYED -> {
				return Step.done();
			}
			case HELD -> {
				return new Step(Step.Kind.HELD, st.detail());
			}
			case UNAVAILABLE -> {
				return new Step(Step.Kind.REFUSED, "txn_journal: " + st.detail());
			}
			default -> {
			}
		}
		TxnEntry t = st.entry();
		c.plan(t, Effect.of("pile.charge", EffectClass.L).items(items).data("owner", String.valueOf(l.rec().owner)).data("key", key).data("rid", l.rid()));
		JsonObject it = new JsonObject();
		new TreeMap<>(items).forEach(it::addProperty);
		c.plan(t, Effect.of("region.charged", EffectClass.R).data("region", l.rec().id).data("rid", l.rid()).data("items", it).data("bodies", bodies)
			.data("at", now));
		DurableFile.Outcome p = c.persist(t);
		if (p == DurableFile.Outcome.REFUSED) {
			return new Step(Step.Kind.REFUSED, "txn_journal: the charge's intent could not be written");
		}
		if (p == DurableFile.Outcome.OK) {
			c.drive(t);
		}
		return after(t);
	}

	static final TxnKind.Adapter PILE_CHARGE = new TxnKind.Adapter() {
		@Override
		public Probe probe(TxnEntry t, Effect e) {
			var pile = Stockpiles.get(e.data().get("owner").getAsString());
			if (pile == null) {
				return Probe.UNKNOWN;
			}
			return pile.ledger().charged(e.data().get("key").getAsString()) != null ? Probe.APPLIED : Probe.ABSENT;
		}

		@Override
		public void apply(TxnEntry t, Effect e) {
			MinecraftServer s = TxnServer.server();
			if (s == null || !Stockpiles.charge(s, e.data().get("owner").getAsString(), e.items(), e.data().get("key").getAsString(), e.data().get("rid")
				.getAsInt())) {
				throw new IllegalStateException("the stockpile no longer holds " + e.items());
			}
			WorldJournal.kill("FLc"); // (8cTa's point) the keyed charge on disk, the region record not updated yet
		}

		@Override
		public void compensate(TxnEntry t, Effect e) {
			throw new IllegalStateException("a charge is never compensated (decided at persist)");
		}

		@Override
		public String where(TxnEntry t, Effect e) {
			return "stockpile " + e.data().get("owner").getAsString();
		}
	};

	static final TxnKind.Adapter REGION_CHARGED = new TxnKind.Adapter() {
		@Override
		public Probe probe(TxnEntry t, Effect e) {
			RegionsImpl.Live l = live(region(e), 0);
			if (l == null) {
				return Probe.UNKNOWN;
			}
			JsonElement x = l.rec().survival.get("chargeTxn");
			return x != null && x.isJsonPrimitive() && t.id.equals(x.getAsString()) && l.rec().survival.has(RegionFluids.CHARGED_BODIES) ? Probe.APPLIED
				: Probe.ABSENT;
		}

		@Override
		public void apply(TxnEntry t, Effect e) {
			RegionsImpl.Live l = live(region(e), 0);
			if (l == null) {
				throw new IllegalStateException("region " + region(e) + " is not loaded");
			}
			JsonObject sv = l.rec().survival;
			sv.add("charged", e.data().getAsJsonObject("items").deepCopy());
			sv.addProperty(dev.larattalabs.architect.site.BillCaps.CHARGED_RID, rid(e));
			sv.add(RegionFluids.CHARGED_BODIES, e.data().getAsJsonArray("bodies").deepCopy());
			if (!sv.has("chargedAt")) {
				sv.addProperty("chargedAt", e.data().get("at").getAsLong());
			}
			sv.addProperty("chargeTxn", t.id);
			if (!RegionsImpl.saveRec(l)) {
				throw new IllegalStateException("the region record could not be saved");
			}
		}

		@Override
		public void compensate(TxnEntry t, Effect e) {
			throw new IllegalStateException("never compensated");
		}

		@Override
		public String where(TxnEntry t, Effect e) {
			return "region " + region(e);
		}
	};

	static final TxnKind CHARGE_KIND = new TxnKind() {
		@Override
		public String name() {
			return CHARGE;
		}

		@Override
		public int kv() {
			return 1;
		}

		@Override
		public TxnKind.@Nullable Adapter adapter(Effect e) {
			return switch (e.op()) {
				case "pile.charge" -> PILE_CHARGE;
				case "region.charged" -> REGION_CHARGED;
				default -> null;
			};
		}
	};

	// ------------------------------------------------------------------ fluid.drain (the removal)

	/**
	 * (8cTb) The removal's drain of one record as a txn (begun, attached to, or found retired): the scoop's amounts planned now, while the
	 * sources stand (per cell, {@link RegionFluids#scoopPlan}); the chunks every drain write may touch; the bound. {@code flowing}: a river
	 * region's drain (its sources only: the flow dies, the stray pass follows). DONE once the txn retired (its writes durable, the record
	 * {@code drained} with a fresh bound); a Remove asked again joins it (the same key).
	 */
	static Step removalDrain(MinecraftServer s, ServerLevel level, RegionsImpl.Live l, RegionFluids.Regional st, String group, boolean flowing) {
		String key = drainKey(l, st.removal == null || "draining".equals(st.removal) ? "removal" : "legacy");
		TxnCore c = TxnServer.core();
		TxnCore.Started started = c.begin(DRAIN, key, List.of(resource(l)), null);
		switch (started.status()) {
			case ATTACHED -> {
				return after(started.entry());
			}
			case REPLAYED -> {
				st.drainTxn = started.done().id(); // committed and retired: its R wrote drained (a record read before it is caught up here)
				return Step.done();
			}
			case HELD -> {
				return new Step(Step.Kind.HELD, started.detail());
			}
			case UNAVAILABLE -> {
				return new Step(Step.Kind.REFUSED, "txn_journal: " + started.detail());
			}
			default -> {
			}
		}
		TxnEntry t = started.entry();
		if (l.rec().survival()) {
			int[] sc = RegionFluids.scoopPlan(level, l, st, group);
			if (sc[0] > 0 || sc[1] > 0) {
				c.plan(t, Effect.of("pile.scoop", EffectClass.L).data("owner", String.valueOf(l.rec().owner)).data("key", scoopKey(l)).data("lava", sc[0])
					.data("grates", sc[1]));
			}
		}
		JsonArray chunks = new JsonArray();
		for (long ck : RegionFluids.drainChunks(st)) {
			JsonArray a = new JsonArray();
			a.add((int) (ck >> 32));
			a.add((int) ck);
			chunks.add(a);
		}
		int bound = st.bodies.stream().mapToInt(b -> b.settleTicks).max().orElse(0);
		c.plan(t, Effect.of("fluid.drain", EffectClass.W).data("region", l.rec().id).data("rid", l.rid()).data("group", group).data("dim", l.rec().dimension)
			.data("chunks", chunks).data("bound", bound).data("flowing", flowing ? 1 : 0));
		c.plan(t, Effect.of("fluid.drained", EffectClass.R).data("region", l.rec().id).data("rid", l.rid()).data("flowing", flowing ? 1 : 0));
		st.removal = st.removal == null ? "draining" : st.removal; // in memory: the removal began (drainStarted); the intent is its record
		DurableFile.Outcome p = c.persist(t);
		if (p == DurableFile.Outcome.REFUSED) {
			return new Step(Step.Kind.REFUSED, "txn_journal: the drain's intent could not be written");
		}
		WorldJournal.kill("FL3d"); // (DF's point, an alias) the removal's record durable (the intent), nothing drained yet
		if (p == DurableFile.Outcome.OK) {
			c.drive(t);
		}
		return after(t);
	}

	static final TxnKind.Adapter PILE_SCOOP = new TxnKind.Adapter() {
		@Override
		public Probe probe(TxnEntry t, Effect e) {
			var pile = Stockpiles.get(e.data().get("owner").getAsString());
			if (pile == null) {
				return Probe.APPLIED; // no pile: the scoop has nowhere to go (as Stockpiles.scoop: nothing)
			}
			return pile.ledger().credited(e.data().get("key").getAsString()) ? Probe.APPLIED : Probe.ABSENT;
		}

		@Override
		public void apply(TxnEntry t, Effect e) {
			MinecraftServer s = TxnServer.server();
			if (s == null) {
				throw new IllegalStateException("no server");
			}
			Stockpiles.scoop(s, e.data().get("owner").getAsString(), e.data().get("key").getAsString(), e.data().get("lava").getAsInt(), e.data().get("grates")
				.getAsInt());
		}

		@Override
		public void compensate(TxnEntry t, Effect e) {
			throw new IllegalStateException("never compensated");
		}

		@Override
		public String where(TxnEntry t, Effect e) {
			return "stockpile " + e.data().get("owner").getAsString();
		}
	};

	static @Nullable ServerLevel level(Effect e) {
		MinecraftServer s = TxnServer.server();
		return s == null ? null : dev.larattalabs.architect.site.Sites.levelOf(s, e.data().get("dim").getAsString());
	}

	static List<long[]> chunksOf(Effect e) {
		List<long[]> out = new ArrayList<>();
		for (JsonElement x : e.data().getAsJsonArray("chunks")) {
			JsonArray a = x.getAsJsonArray();
			out.add(new long[] {a.get(0).getAsInt(), a.get(1).getAsInt()});
		}
		return out;
	}

	static final TxnKind.Adapter FLUID_DRAIN = new TxnKind.Adapter() {
		@Override
		public Probe probe(TxnEntry t, Effect e) {
			ServerLevel level = level(e);
			if (level == null) {
				return Probe.UNKNOWN;
			}
			String k = e.key(t.id);
			for (long[] c : chunksOf(e)) {
				LevelChunk ch = level.getChunkSource().getChunkNow((int) c[0], (int) c[1]);
				if (ch == null && !t.live()) {
					ch = level.getChunk((int) c[0], (int) c[1]); // recovery loads its chunks (bounded by the record's watch sets)
				}
				if (ch == null) {
					return Probe.UNKNOWN;
				}
				if (!TestMove.receiptsOf(ch).contains(k)) {
					return Probe.ABSENT;
				}
			}
			return Probe.APPLIED;
		}

		@Override
		public void apply(TxnEntry t, Effect e) {
			ServerLevel level = level(e);
			RegionsImpl.Live l = live(region(e), rid(e));
			RegionFluids.Regional st = l == null ? null : RegionFluids.of(l);
			if (level == null || l == null || st == null) {
				throw new IllegalStateException("region " + region(e) + " (rv " + rid(e) + ") is not loaded");
			}
			List<LevelChunk> chunks = new ArrayList<>();
			for (long[] c : chunksOf(e)) {
				chunks.add(level.getChunk((int) c[0], (int) c[1])); // loaded first: every write and receipt lands
			}
			int n = RegionFluids.removalDrainWrites(level, l, st, e.data().get("group").getAsString(), e.data().get("flowing").getAsInt() == 1);
			// (F) every drain, a first one or a replay, starts a fresh settle bound from now
			st.until = level.getGameTime() + e.data().get("bound").getAsInt();
			st.redrained = true;
			step(t, "drain"); // the drain written, no receipt yet (Steward's row: TX:fluid.drain:drain+save)
			String k = e.key(t.id);
			for (LevelChunk ch : chunks) {
				if (!TestMove.receiptsOf(ch).contains(k)) {
					TestMove.addReceiptTo(ch, k); // the same tick as the writes: one chunk save holds both
				}
			}
			Architect.LOGGER.info("Region {}: removal drain {} wrote {} fluid cell(s){}", l.rec().id, t.id, n, t.live() ? "" : " (replayed)");
		}

		@Override
		public void compensate(TxnEntry t, Effect e) {
			throw new IllegalStateException("never compensated");
		}

		@Override
		public String where(TxnEntry t, Effect e) {
			ServerLevel level = level(e);
			for (long[] c : chunksOf(e)) {
				LevelChunk ch = level == null ? null : level.getChunkSource().getChunkNow((int) c[0], (int) c[1]);
				if (ch == null || !TestMove.receiptsOf(ch).contains(e.key(t.id))) {
					return "chunk " + c[0] + "," + c[1];
				}
			}
			return "region " + region(e);
		}
	};

	static final TxnKind.Adapter FLUID_DRAINED = new TxnKind.Adapter() {
		@Override
		public Probe probe(TxnEntry t, Effect e) {
			RegionsImpl.Live l = live(region(e), rid(e));
			RegionFluids.Regional st = l == null ? null : RegionFluids.of(l);
			if (st == null) {
				return Probe.UNKNOWN;
			}
			return t.id.equals(st.drainTxnOnDisk) ? Probe.APPLIED : Probe.ABSENT;
		}

		@Override
		public void apply(TxnEntry t, Effect e) {
			RegionsImpl.Live l = live(region(e), rid(e));
			RegionFluids.Regional st = l == null ? null : RegionFluids.of(l);
			if (st == null) {
				throw new IllegalStateException("region " + region(e) + " is not loaded");
			}
			String was = st.removal;
			String wasPhase = st.removalPhase;
			st.removal = "drained";
			if (e.data().get("flowing").getAsInt() == 1) {
				st.removalPhase = "draining";
			}
			st.drainTxn = t.id;
			if (!RegionFluids.save(l, st)) {
				st.removal = was;
				st.removalPhase = wasPhase;
				throw new IllegalStateException("the fluids record could not be saved");
			}
			st.drainTxnOnDisk = t.id;
		}

		@Override
		public void compensate(TxnEntry t, Effect e) {
			throw new IllegalStateException("never compensated");
		}

		@Override
		public String where(TxnEntry t, Effect e) {
			return "region " + region(e);
		}
	};

	static final TxnKind DRAIN_KIND = new TxnKind() {
		@Override
		public String name() {
			return DRAIN;
		}

		@Override
		public int kv() {
			return 1;
		}

		@Override
		public TxnKind.@Nullable Adapter adapter(Effect e) {
			return switch (e.op()) {
				case "pile.scoop" -> PILE_SCOOP;
				case "fluid.drain" -> FLUID_DRAIN;
				case "fluid.drained" -> FLUID_DRAINED;
				default -> null;
			};
		}
	};

}
