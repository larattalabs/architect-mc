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
	public static final String WRITE = "fluid.write";

	/** Registers both kinds (TxnServer, at load). */
	public static void register(TxnCore c) {
		c.register(CHARGE_KIND);
		c.register(DRAIN_KIND);
		c.register(WRITE_KIND);
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
		return after(TxnServer.core(), t);
	}

	/** {@link #after(TxnEntry)} over a given core (a unit's). */
	static Step after(TxnCore core, TxnEntry t) {
		if (t.decision() != null && t.decision().isAbort()) {
			// (8cTb review P1-1) an aborted attempt (a refused prepare barrier) applied nothing: never reported as done; the caller tries again
			return new Step(Step.Kind.REFUSED, "aborted " + t.id + (t.result().has("refused") ? ": " + t.result().get("refused").getAsString() : ""));
		}
		if (!core.open().contains(t) || t.phase() == dev.larattalabs.architect.txn.Phase.EFFECTS_DONE || t.phase()
			== dev.larattalabs.architect.txn.Phase.RETIRING && t.decision() != null && !t.decision().isAbort()) {
			return Step.done(); // (8cTc) every effect applied and the barrier covered them: its retirement only waits for the stores' acknowledgements
		}
		if (t.held() != null) {
			return new Step(Step.Kind.HELD, "held(decided) " + t.id + ": " + where(t));
		}
		return Step.waiting();
	}

	/** (Steward's ask) A hold's where in words: {@code chunk x,z}, else "the region's water record"; never the raw {@code fluid:} resource. */
	static String where(TxnEntry t) {
		String w = t.heldAt();
		if (w != null && w.startsWith("chunk ")) {
			return w;
		}
		return "the region's water record";
	}

	/** (Steward's ask) A begin's {@code held(other) tx-<n>: <resource>} with the resource worded. */
	static @Nullable String worded(@Nullable String detail) {
		return detail == null ? null : detail.replaceAll("fluid:[^ ;,)]+", "the region's water record").replaceAll("charge:[^ ;,)]+", "the region's charge");
	}

	/** (8cTc, Steward's ask) An open fluid txn of the region (any record) that is held, as {@code held(other) tx-<n>: <where>}, else null. */
	public static @Nullable String heldAny(String regionId, @Nullable String kind) {
		String pre = "fluid:" + regionId + "#rv";
		for (TxnEntry t : TxnServer.core().open()) {
			if ((kind == null ? t.kind.startsWith("fluid.") : kind.equals(t.kind)) && t.held() != null && t.resources.stream().anyMatch(r -> r.startsWith(pre))) {
				return "held(other) " + t.id + ": " + where(t);
			}
		}
		return null;
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
				return new Step(Step.Kind.HELD, worded(st.detail()));
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
			JsonObject was = sv.deepCopy();
			sv.add("charged", e.data().getAsJsonObject("items").deepCopy());
			sv.addProperty(dev.larattalabs.architect.site.BillCaps.CHARGED_RID, rid(e));
			sv.add(RegionFluids.CHARGED_BODIES, e.data().getAsJsonArray("bodies").deepCopy());
			if (!sv.has("chargedAt")) {
				sv.addProperty("chargedAt", e.data().get("at").getAsLong());
			}
			sv.addProperty("chargeTxn", t.id);
			if (!RegionsImpl.saveRec(l)) {
				// (8cTb review P1-2) the probe reads the record: a refused save leaves it as it was, so the next drive saves it again
				for (String k : List.copyOf(sv.keySet())) {
					sv.remove(k);
				}
				was.entrySet().forEach(x -> sv.add(x.getKey(), x.getValue()));
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
				return new Step(Step.Kind.HELD, worded(started.detail()));
			}
			case UNAVAILABLE -> {
				return new Step(Step.Kind.REFUSED, "txn_journal: " + started.detail());
			}
			default -> {
			}
		}
		TxnEntry t = started.entry();
		int[] sc = null;
		if (l.rec().survival()) {
			try {
				sc = RegionFluids.scoopPlan(level, l, st, group);
			} catch (IllegalStateException ex) {
				// (8cTb review P2-8) a journal section that can't be read: wait for it, never guess the refund
				return new Step(Step.Kind.WAIT, ex.getMessage());
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
		c.plan(t, Effect.of("fluid.drained", EffectClass.R).data("region", l.rec().id).data("rid", l.rid()).data("flowing", flowing ? 1 : 0).data("bound",
			bound));
		// (8cTb review P1-3) the scoop after the drain's writes and its record: what it refunds no longer stands to be harvested
		if (sc != null && (sc[0] > 0 || sc[1] > 0)) {
			Effect.Builder sb = Effect.of("pile.scoop", EffectClass.L).data("owner", String.valueOf(l.rec().owner)).data("key", scoopKey(l)).data("lava", sc[0])
				.data("grates", sc[1]).data("region", l.rec().id).data("rid", l.rid());
			if (l.rid() > 0) {
				sb.data("legacyKey", "region:" + l.rec().id + "@" + l.rec().createdAt + ":fluids"); // (P1-4) a revision's scoop before 8cT
			}
			c.plan(t, sb);
		}
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
			boolean legacy = e.data().has("legacyKey") && pile.ledger().credited(e.data().get("legacyKey").getAsString());
			return legacy || pile.ledger().credited(e.data().get("key").getAsString()) ? Probe.APPLIED : Probe.ABSENT;
		}

		@Override
		public void apply(TxnEntry t, Effect e) {
			MinecraftServer s = TxnServer.server();
			if (s == null) {
				throw new IllegalStateException("no server");
			}
			int lava = e.data().get("lava").getAsInt(), grates = e.data().get("grates").getAsInt();
			// (8cTb review P1-3) never more than the drain this session saw standing or never written (a source taken while the txn waited)
			RegionsImpl.Live l = e.data().has("region") ? live(region(e), rid(e)) : null;
			RegionFluids.Regional st = l == null ? null : RegionFluids.of(l);
			if (st != null && st.scoopSeen != null) {
				lava = Math.min(lava, st.scoopSeen[0]);
				grates = Math.min(grates, st.scoopSeen[1]);
			}
			Stockpiles.scoop(s, e.data().get("owner").getAsString(), e.data().get("key").getAsString(), lava, grates);
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
				if (ch == null) {
					ch = level.getChunk((int) c[0], (int) c[1]); // (8cTb review P1-3) loaded, never UNKNOWN: bounded by the record's watch sets
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
			if (l.rec().survival()) {
				try {
					st.scoopSeen = RegionFluids.scoopPlan(level, l, st, e.data().get("group").getAsString()); // before the writes
				} catch (IllegalStateException ex) {
					st.scoopSeen = null; // (the planned amounts stand)
				}
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
			long wasUntil = st.until;
			ServerLevel lv = l.level(TxnServer.server());
			if (lv != null && e.data().has("bound")) {
				st.until = lv.getGameTime() + e.data().get("bound").getAsInt(); // (8cTb review P2-7) the fresh bound saved with drained, even after a replay
			}
			if (!RegionFluids.save(l, st)) {
				st.until = wasUntil;
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
				case "fluid.escape" -> FLUID_ESCAPE;
				case "fluid.escaped" -> FLUID_ESCAPED;
				case "fluid.lotdrain" -> FLUID_LOTDRAIN;
				case "fluid.lotdrained" -> FLUID_LOTDRAINED;
				default -> null;
			};
		}
	};


	// ------------------------------------------------------------------ (8cTc) generic W and R adapters over a record

	/** A W effect's world writes on a record (loaded, its chunks loaded); returns the cells written. */
	interface WRun {
		int run(TxnEntry t, Effect e, ServerLevel level, RegionsImpl.Live l, RegionFluids.Regional st);
	}

	/** An R effect over a record: whether it is on the record now, and its write (durable, or it throws and leaves memory as it was). */
	interface RRun {
		boolean applied(TxnEntry t, Effect e, RegionFluids.Regional st);

		void run(TxnEntry t, Effect e, RegionsImpl.Live l, RegionFluids.Regional st);
	}

	/** The chunks every write of the record may touch, for an effect's data. */
	static JsonArray chunksJson(RegionFluids.Regional st) {
		JsonArray chunks = new JsonArray();
		for (long ck : RegionFluids.drainChunks(st)) {
			JsonArray a = new JsonArray();
			a.add((int) (ck >> 32));
			a.add((int) ck);
			chunks.add(a);
		}
		return chunks;
	}

	/** A W adapter: probe = this effect's receipt in every chunk; apply = the writes, the kill point {@code step}, then the receipts. */
	static TxnKind.Adapter w(String stepName, WRun run) {
		return new TxnKind.Adapter() {
			@Override
			public Probe probe(TxnEntry t, Effect e) {
				return FLUID_DRAIN.probe(t, e);
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
					chunks.add(level.getChunk((int) c[0], (int) c[1]));
				}
				run.run(t, e, level, l, st);
				step(t, stepName);
				String k = e.key(t.id);
				for (LevelChunk ch : chunks) {
					if (!TestMove.receiptsOf(ch).contains(k)) {
						TestMove.addReceiptTo(ch, k);
					}
				}
			}

			@Override
			public void compensate(TxnEntry t, Effect e) {
				throw new IllegalStateException("never compensated");
			}

			@Override
			public String where(TxnEntry t, Effect e) {
				return FLUID_DRAIN.where(t, e);
			}
		};
	}

	static TxnKind.Adapter r(RRun run) {
		return new TxnKind.Adapter() {
			@Override
			public Probe probe(TxnEntry t, Effect e) {
				RegionsImpl.Live l = live(region(e), rid(e));
				RegionFluids.Regional st = l == null ? null : RegionFluids.of(l);
				return st == null ? Probe.UNKNOWN : run.applied(t, e, st) ? Probe.APPLIED : Probe.ABSENT;
			}

			@Override
			public void apply(TxnEntry t, Effect e) {
				RegionsImpl.Live l = live(region(e), rid(e));
				RegionFluids.Regional st = l == null ? null : RegionFluids.of(l);
				if (st == null) {
					throw new IllegalStateException("region " + region(e) + " is not loaded");
				}
				run.run(t, e, l, st);
			}

			@Override
			public void compensate(TxnEntry t, Effect e) {
				throw new IllegalStateException("never compensated");
			}

			@Override
			public String where(TxnEntry t, Effect e) {
				return "the region's water record";
			}
		};
	}

	static List<String> ids(Effect e) {
		List<String> out = new ArrayList<>();
		e.data().getAsJsonArray("bodies").forEach(x -> out.add(x.getAsString()));
		return out;
	}

	static JsonArray idsJson(List<String> ids) {
		JsonArray a = new JsonArray();
		ids.forEach(a::add);
		return a;
	}

	/** Begins (or finds) one record txn: plans {@code w} then {@code r} over the record's chunks; persists; drives. */
	static Step record(String kind, String key, RegionsImpl.Live l, RegionFluids.Regional st, Effect.Builder w, Effect.Builder r,
		java.util.function.Consumer<TxnEntry> attached) {
		TxnCore c = TxnServer.core();
		TxnCore.Started started = c.begin(kind, key, List.of(resource(l)), null);
		switch (started.status()) {
			case ATTACHED -> {
				attached.accept(started.entry());
				return after(started.entry());
			}
			case REPLAYED -> {
				return Step.done();
			}
			case HELD -> {
				return new Step(Step.Kind.HELD, worded(started.detail()));
			}
			case UNAVAILABLE -> {
				return new Step(Step.Kind.REFUSED, "txn_journal: " + started.detail());
			}
			default -> {
			}
		}
		TxnEntry t = started.entry();
		c.plan(t, w.data("region", l.rec().id).data("rid", l.rid()).data("dim", l.rec().dimension).data("chunks", chunksJson(st)));
		c.plan(t, r.data("region", l.rec().id).data("rid", l.rid()));
		DurableFile.Outcome p = c.persist(t);
		if (p == DurableFile.Outcome.REFUSED) {
			return new Step(Step.Kind.REFUSED, "txn_journal: the intent could not be written");
		}
		if (p == DurableFile.Outcome.OK) {
			c.drive(t);
		}
		return after(t);
	}

	// ------------------------------------------------------------------ fluid.write (N1: the tiles are markers; the txn writes the cells)

	/**
	 * (8cTc) One wave's write as a txn: the bodies due now (an H region: every pending one) written by {@link RegionFluids#writeBody}
	 * (only into air or what the body wrote) and forced (W, a receipt in every chunk; kill point {@code TX:fluid.write:place}, after the writes
	 * and before the receipts), then the bodies {@code written} with {@code writeTxn} and, the last wave, the phase {@code settling} (R), the
	 * barrier. A start replays it from the entry; its receipts are the per-cell evidence the scoop reads (A's write side).
	 */
	static Step write(RegionsImpl.Live l, RegionFluids.Regional st, List<String> due, boolean last) {
		String key = "fluid-write:" + recKey(l) + "/" + String.join(",", due);
		return record(WRITE, key, l, st, Effect.of("fluid.place", EffectClass.W).data("bodies", idsJson(due)), Effect.of("fluid.written", EffectClass.R).data(
			"bodies", idsJson(due)).data("last", last ? 1 : 0), t -> {
			});
	}

	static final TxnKind.Adapter FLUID_PLACE = w("place", (t, e, level, l, st) -> {
		int n = 0;
		for (String id : ids(e)) {
			RegionFluids.Body b = st.body(id);
			if (b != null) {
				RegionFluids.writeBody(level, b);
				n += RegionFluids.forceBody(level, b);
			}
		}
		st.forcedAt = st.forcedAt < 0 ? level.getGameTime() : st.forcedAt;
		return n;
	});

	static final TxnKind.Adapter FLUID_WRITTEN = r(new RRun() {
		@Override
		public boolean applied(TxnEntry t, Effect e, RegionFluids.Regional st) {
			for (String id : ids(e)) {
				RegionFluids.BodyState bs = st.states.get(id);
				if (bs != null && !t.id.equals(bs.writeTxn)) {
					return false;
				}
			}
			return true;
		}

		@Override
		public void run(TxnEntry t, Effect e, RegionsImpl.Live l, RegionFluids.Regional st) {
			ServerLevel level = l.level(TxnServer.server());
			long now = level == null ? 0L : level.getGameTime();
			Map<String, Object[]> was = new java.util.HashMap<>();
			for (String id : ids(e)) {
				RegionFluids.BodyState bs = st.states.get(id);
				RegionFluids.Body b = st.body(id);
				if (bs == null || b == null) {
					continue;
				}
				was.put(id, new Object[] {bs.state, bs.writtenAt, bs.sources, bs.spill, bs.writeTxn});
				if ("pending".equals(bs.state)) {
					bs.state = "written";
				}
				bs.writtenAt = bs.writtenAt < 0 ? now : bs.writtenAt;
				bs.sources = b.cells.length;
				bs.spill = b.spill.length;
				bs.writeTxn = t.id;
			}
			String phase = st.phase;
			if (e.data().get("last").getAsInt() == 1) {
				st.phase = "settling";
			}
			if (!RegionFluids.save(l, st)) {
				st.phase = phase;
				was.forEach((id, w) -> {
					RegionFluids.BodyState bs = st.states.get(id);
					bs.state = (String) w[0];
					bs.writtenAt = (Long) w[1];
					bs.sources = (Integer) w[2];
					bs.spill = (Integer) w[3];
					bs.writeTxn = (String) w[4];
				});
				throw new IllegalStateException("the fluids record could not be saved");
			}
		}
	});

	static final TxnKind WRITE_KIND = new TxnKind() {
		@Override
		public String name() {
			return WRITE;
		}

		@Override
		public int kv() {
			return 1;
		}

		@Override
		public TxnKind.@Nullable Adapter adapter(Effect e) {
			return switch (e.op()) {
				case "fluid.place" -> FLUID_PLACE;
				case "fluid.written" -> FLUID_WRITTEN;
				default -> null;
			};
		}
	};

	// ------------------------------------------------------------------ fluid.drain: escape, unsettled (and their upstream closure)

	/**
	 * (8cTc, E) A census tick's escape or unsettled drain as a txn: the body (and its upstream closure, upstream first) drained (W, kill point
	 * {@code TX:fluid.drain:drain}), then the record saved with them drained and {@code drainTxn} (R; FLe after it), the barrier. A start
	 * finds it open and drains again: the record never says drained over sources a crash brought back.
	 */
	static Step escape(RegionsImpl.Live l, RegionFluids.Regional st, RegionFluids.Body b, String why, String typed, List<long[]> at) {
		JsonArray cells = new JsonArray();
		for (long[] c : at) {
			JsonArray a = new JsonArray();
			a.add(c[0]);
			a.add(c[1]);
			a.add(c[2]);
			cells.add(a);
		}
		String key = "fluid-drain:" + recKey(l) + "/" + why + ":" + b.id;
		return record(DRAIN, key, l, st, Effect.of("fluid.escape", EffectClass.W).data("body", b.id).data("why", why).data("typed", typed).data("at", cells), Effect.of(
			"fluid.escaped", EffectClass.R).data("body", b.id), t -> {
			});
	}

	static final TxnKind.Adapter FLUID_ESCAPE = w("drain", (t, e, level, l, st) -> {
		RegionFluids.Body b = st.body(e.data().get("body").getAsString());
		if (b == null) {
			return 0;
		}
		List<long[]> at = new ArrayList<>();
		for (JsonElement x : e.data().getAsJsonArray("at")) {
			JsonArray a = x.getAsJsonArray();
			at.add(new long[] {a.get(0).getAsLong(), a.get(1).getAsLong(), a.get(2).getAsLong()});
		}
		RegionFluids.BodyState bs = st.states.get(b.id);
		RegionFluids.escape(level, l, st, b, bs, e.data().get("why").getAsString(), at);
		bs.why = e.data().get("typed").getAsString();
		return at.size();
	});

	static final TxnKind.Adapter FLUID_ESCAPED = r(new RRun() {
		@Override
		public boolean applied(TxnEntry t, Effect e, RegionFluids.Regional st) {
			RegionFluids.BodyState bs = st.states.get(e.data().get("body").getAsString());
			return bs != null && t.id.equals(bs.drainTxn);
		}

		@Override
		public void run(TxnEntry t, Effect e, RegionsImpl.Live l, RegionFluids.Regional st) {
			RegionFluids.BodyState bs = st.states.get(e.data().get("body").getAsString());
			String was = bs.drainTxn;
			bs.drainTxn = t.id;
			if (st.states.values().stream().allMatch(RegionFluids.BodyState::ended)) {
				st.phase = "done";
			}
			if (!RegionFluids.save(l, st)) {
				bs.drainTxn = was;
				throw new IllegalStateException("the fluids record could not be saved");
			}
			RegionFluids.report(l, st);
			WorldJournal.kill("FLe"); // (8cTa's point) the escape drain's record saved, its writes not yet covered by the barrier
		}
	});

	// ------------------------------------------------------------------ fluid.drain: a lot's irrigation sources (IRR, D)

	/**
	 * (8cTc, D) A lot removal's drain as a txn: the lot's bodies marked removed and drained (W, kill point {@code TX:fluid.drain:drain};
	 * FL6d after the writes), then {@code lotRemoved}, {@code lotDrained} and {@code drainTxn} saved (R), the barrier. A body recorded
	 * {@code lotRemoved} without a drain txn (DF's and main's records) is drained again: the legacy lot conversion.
	 */
	static Step lot(RegionsImpl.Live l, RegionFluids.Regional st, String lotId, List<String> bodies) {
		String key = "fluid-drain:" + recKey(l) + "/lot:" + lotId;
		return record(DRAIN, key, l, st, Effect.of("fluid.lotdrain", EffectClass.W).data("lot", lotId).data("group", String.valueOf(l.rec().groupId)).data(
			"bodies", idsJson(bodies)), Effect.of("fluid.lotdrained", EffectClass.R).data("lot", lotId).data("bodies", idsJson(bodies)), t -> {
			});
	}

	static final TxnKind.Adapter FLUID_LOTDRAIN = w("drain", (t, e, level, l, st) -> {
		int n = RegionFluids.lotDrainWrites(level, l, st, e.data().get("lot").getAsString(), ids(e));
		WorldJournal.kill("FL6d"); // (DF round 3's point, an alias) the lot's sources drained, the record not saved yet
		return n;
	});

	static final TxnKind.Adapter FLUID_LOTDRAINED = r(new RRun() {
		@Override
		public boolean applied(TxnEntry t, Effect e, RegionFluids.Regional st) {
			for (String id : ids(e)) {
				RegionFluids.BodyState bs = st.states.get(id);
				if (bs != null && !(t.id.equals(bs.drainTxn) && bs.lotRemoved)) {
					return false;
				}
			}
			return true;
		}

		@Override
		public void run(TxnEntry t, Effect e, RegionsImpl.Live l, RegionFluids.Regional st) {
			String lotId = e.data().get("lot").getAsString();
			Map<String, Object[]> was = new java.util.HashMap<>();
			for (String id : ids(e)) {
				RegionFluids.BodyState bs = st.states.get(id);
				if (bs == null) {
					continue;
				}
				was.put(id, new Object[] {bs.state, bs.reason, bs.lotRemoved, bs.lotDrained, bs.drainTxn});
				bs.state = "drained";
				bs.reason = "lot removed: " + lotId + " (its sources leave with it, S-IRR-4)";
				bs.lotRemoved = true;
				bs.lotDrained = true;
				bs.drainTxn = t.id;
				bs.at.clear();
			}
			if (!RegionFluids.save(l, st)) {
				was.forEach((id, w) -> {
					RegionFluids.BodyState bs = st.states.get(id);
					bs.state = (String) w[0];
					bs.reason = (String) w[1];
					bs.lotRemoved = (Boolean) w[2];
					bs.lotDrained = (Boolean) w[3];
					bs.drainTxn = (String) w[4];
				});
				throw new IllegalStateException("the fluids record could not be saved");
			}
		}
	});

}
