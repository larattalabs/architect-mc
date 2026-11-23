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
import net.minecraft.core.BlockPos;
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
	/** (slice T5F, §4.7) The adoption of a record built before T5F. */
	public static final String ADOPT = "fluid.adopt";

	/**
	 * (slice T5Fa) TEST, DevBridge {@code dev.fluid.holdChunk}: while non-null ({@code {x, z}}), a removal drain's W apply throws (the txn holds)
	 * when it reaches that chunk: on the 8cT drain inside its seen loop (the chunks before it already carry their seen receipts), on T5F at
	 * that chunk's own (body, chunk) W. {@link #holdChunkBefore} answers the chunks done before the throw. Default null: off.
	 */
	public static volatile int @Nullable [] holdChunk;
	/** (slice T5Fa) TEST: the chunks ({@code "x,z"}) whose drain evidence was saved before the last {@link #holdChunk} throw, in order. */
	public static final java.util.List<String> holdChunkBefore = new java.util.concurrent.CopyOnWriteArrayList<>();

	/** (slice T5Fa) TEST seam: throws when {@code ch} is the held chunk (see {@link #holdChunk}). */
	static void holdAt(LevelChunk ch, java.util.List<String> before) {
		int[] h = holdChunk;
		if (h != null && ch.getPos().x() == h[0] && ch.getPos().z() == h[1]) {
			holdChunkBefore.clear();
			holdChunkBefore.addAll(before);
			throw new IllegalStateException("TEST: dev.fluid.holdChunk " + h[0] + "," + h[1]);
		}
	}

	/** Registers both kinds (TxnServer, at load). */
	public static void register(TxnCore c) {
		FluidTestFlags.applyAtLoad(); // (T5Fa TEST, dev environments only) holds armed before a crash row's restart
		c.register(CHARGE_KIND);
		c.register(DRAIN_KIND);
		c.register(WRITE_KIND);
		c.register(ADOPT_KIND); // (slice T5F)
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
		Step adopted = adoptFirst(l, st); // (slice T5F, §4.7) a record built before T5F is adopted first (its scoop reads the marks)
		if (adopted != null) {
			return adopted;
		}
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
			// (8cT last round, #2) at most what the drain saw, summed from the seen receipts its W saved with its writes
			Effect w = t.effects().stream().filter(x -> "fluid.drain".equals(x.op())).findFirst().orElse(null);
			ServerLevel level = w == null ? null : level(w);
			if (w != null && level != null) {
				int sl = 0, sg = 0;
				for (long[] c : chunksOf(w)) {
					int[] seen = seenOf(level.getChunk((int) c[0], (int) c[1]), w.key(t.id));
					if (seen == null) {
						throw new IllegalStateException("chunk " + c[0] + "," + c[1] + " has no seen receipt of the drain");
					}
					sl += seen[0];
					sg += seen[1];
				}
				lava = Math.min(lava, sl);
				grates = Math.min(grates, sg);
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

	/** (8cT last round, #2) A chunk's seen receipt for a drain's W ({@code <key>@seen=<lava>,<grates>}), or null. */
	static int @Nullable [] seenOf(LevelChunk ch, String key) {
		String pre = key + "@seen=";
		for (String r : TestMove.receiptsOf(ch)) {
			if (r.startsWith(pre)) {
				String[] a = r.substring(pre.length()).split(",");
				return new int[] {Integer.parseInt(a[0]), Integer.parseInt(a[1])};
			}
		}
		return null;
	}

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
				if (!TestMove.hasReceipt(ch, k)) { // (slice T5F) exact, or with its fields (tx-<n>/<i>;op=..)
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
			if (RegionFluids.holdDrain) {
				throw new IllegalStateException("TEST: dev.fluid.hold drain"); // (8cT last round) the drain held until released
			}
			List<LevelChunk> chunks = new ArrayList<>();
			for (long[] c : chunksOf(e)) {
				chunks.add(level.getChunk((int) c[0], (int) c[1])); // loaded first: every write and receipt lands
			}
			String k0 = e.key(t.id);
			if (l.rec().survival()) {
				// (8cT last round, #2) what the drain sees, per chunk, saved with that chunk before its first write: a chunk whose drain writes reached
				// disk carries what it saw; a chunk whose snapshot was lost is seen again as it stands (a scan that can't read the journal holds)
				String group = e.data().get("group").getAsString();
				List<String> seenBefore = new ArrayList<>();
				for (LevelChunk ch : chunks) {
					holdAt(ch, seenBefore); // (T5Fa TEST) dev.fluid.holdChunk: the chunks before it keep their seen receipts
					seenBefore.add(ch.getPos().x() + "," + ch.getPos().z());
					if (seenOf(ch, k0) == null) {
						int cx = ch.getPos().x(), cz = ch.getPos().z();
						int[] seen = RegionFluids.scoopPlan(level, l, st, group, p -> BlockPos.getX(p) >> 4 == cx && BlockPos.getZ(p) >> 4 == cz);
						TestMove.addReceiptTo(ch, k0 + "@seen=" + seen[0] + "," + seen[1]);
					}
				}
			}
			if (!l.rec().survival()) {
				for (LevelChunk ch : chunks) {
					holdAt(ch, List.of()); // (T5Fa TEST) dev.fluid.holdChunk, a creative record's drain (no seen loop)
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
				case "fluid.hold" -> FLUID_HOLD;
				case "fluid.held" -> FLUID_HELD;
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
		Step a = adoptFirst(l, st); // (slice T5F, §4.7) a record built before T5F is adopted first
		if (a != null) {
			return a;
		}
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

	// ------------------------------------------------------------------ fluid.write (slice T5F, §4.2: clear, place and force Ws per chunk)

	/**
	 * (slice T5F, §4.2) One wave's write as a txn, decided at its persist and always rolled forward:
	 * <ul>
	 * <li>{@code fluid.clear} (an ordered course's first wave only): one W per chunk holding a waiting water body of {@code clear}, which
	 * writes back what the tiles wrote of it ({@code WROTE -> CLEARED});</li>
	 * <li>{@code fluid.place}: one W per (body, chunk), which writes the body's cells by §3.3 and marks them {@code WROTE(R)};</li>
	 * <li>{@code fluid.force}: one W per (body, chunk) receiving a tick, after every place W, which schedules {@code forceBody}'s ticks in
	 * that chunk (I6: physics in W, so a chunk whose snapshot is lost gets its writes and its ticks back together, P2-b);</li>
	 * <li>the core's effects barrier, then the R {@code fluid.written}: the bodies written, {@code writeTxn}, and the phase {@code settling}
	 * on the last wave. No physics in the R (I7).</li>
	 * </ul>
	 * Each W adds its receipt ({@code tx-<n>/<i>;op=..;t=..}) in the same apply, tick and chunk as its mutations (I3); its probe reads its
	 * own chunk's receipt only (I4). Kill points {@code TX:fluid.write:clear|place|force} after the first such W and its receipt
	 * ({@code place} logs "reached (k of n)" over the place Ws).
	 */
	static Step write(RegionsImpl.Live l, RegionFluids.Regional st, List<String> due, boolean last, List<String> clear) {
		Step a = adoptFirst(l, st);
		if (a != null) {
			return a;
		}
		String key = "fluid-write:" + recKey(l) + "/" + String.join(",", due);
		TxnCore c = TxnServer.core();
		TxnCore.Started started = c.begin(WRITE, key, List.of(resource(l)), null);
		switch (started.status()) {
			case ATTACHED -> {
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
		java.util.TreeSet<Long> clearChunks = new java.util.TreeSet<>();
		for (String id : clear) {
			RegionFluids.Body b = st.body(id);
			if (b != null) {
				for (long ck : RegionFluids.cellChunks(b)) {
					clearChunks.add(ck);
				}
			}
		}
		for (long ck : clearChunks) {
			c.plan(t, wEffect("fluid.clear", l, ck).data("bodies", idsJson(clear)));
		}
		for (String id : due) {
			RegionFluids.Body b = st.body(id);
			if (b != null) {
				for (long ck : RegionFluids.cellChunks(b)) {
					c.plan(t, wEffect("fluid.place", l, ck).data("body", id));
				}
			}
		}
		for (String id : due) {
			RegionFluids.Body b = st.body(id);
			if (b != null) {
				for (long ck : RegionFluids.forceChunks(b)) {
					c.plan(t, wEffect("fluid.force", l, ck).data("body", id));
				}
			}
		}
		c.plan(t, Effect.of("fluid.written", EffectClass.R).data("bodies", idsJson(due)).data("last", last ? 1 : 0).data("region", l.rec().id).data("rid", l
			.rid()).data("v", 2)); // (fix round, P1-3) T5F's written: no physics (an 8cT-era written, without v, replays with its own adapter)
		DurableFile.Outcome p = c.persist(t);
		if (p == DurableFile.Outcome.REFUSED) {
			return new Step(Step.Kind.REFUSED, "txn_journal: the intent could not be written");
		}
		if (p == DurableFile.Outcome.OK) {
			c.drive(t);
		}
		return after(t);
	}

	/** (slice T5F) A W effect of one chunk of record {@code l}. */
	static Effect.Builder wEffect(String op, RegionsImpl.Live l, long ck) {
		JsonArray one = new JsonArray();
		JsonArray a = new JsonArray();
		a.add((int) (ck >> 32));
		a.add((int) ck);
		one.add(a);
		return Effect.of(op, EffectClass.W).data("region", l.rec().id).data("rid", l.rid()).data("dim", l.rec().dimension).data("group", String.valueOf(l
			.rec().groupId)).data("chunks", one);
	}

	/** (slice T5F) A per-chunk W's run: its writes in its one chunk; returns the receipt's fields (beyond {@code op} and {@code t}). */
	interface ChunkRun {
		Map<String, Object> run(TxnEntry t, Effect e, FluidWorld w, RegionsImpl.Live l, RegionFluids.Regional st, int cx, int cz);
	}

	/** (slice T5F fix round, P2-7, TEST) The world a per-chunk W reads and writes in a unit; null: the effect's level. */
	static volatile java.util.function.@Nullable Function<Effect, FluidWorld> testWorld;

	static @Nullable FluidWorld worldOf(Effect e) {
		var tw = testWorld;
		if (tw != null) {
			return tw.apply(e);
		}
		ServerLevel level = level(e);
		return level == null ? null : FluidWorld.of(level);
	}

	/**
	 * (slice T5F, I3, I4) A per-chunk W adapter: probe = this effect's receipt in its own chunk (exact or with fields); apply = the writes,
	 * then the receipt {@code tx-<n>/<i>;op=<op>;t=<gameTime>;..} in the same tick and chunk, then the kill point {@code step} (between
	 * effects: a {@code +save} never saves a half-applied chunk, I9).
	 */
	static TxnKind.Adapter chunkW(String op, String stepName, ChunkRun run) {
		return new TxnKind.Adapter() {
			@Override
			public Probe probe(TxnEntry t, Effect e) {
				FluidWorld w = worldOf(e);
				long[] c = chunksOf(e).get(0);
				return w == null ? Probe.UNKNOWN : w.hasReceipt((int) c[0], (int) c[1], e.key(t.id)) ? Probe.APPLIED : Probe.ABSENT;
			}

			@Override
			public void apply(TxnEntry t, Effect e) {
				FluidWorld w = worldOf(e);
				RegionsImpl.Live l = live(region(e), rid(e));
				RegionFluids.Regional st = l == null ? null : RegionFluids.of(l);
				if (w == null || l == null || st == null) {
					throw new IllegalStateException("region " + region(e) + " (rv " + rid(e) + ") is not loaded");
				}
				long[] c = chunksOf(e).get(0);
				int cx = (int) c[0], cz = (int) c[1];
				Map<String, Object> f = new java.util.LinkedHashMap<>();
				f.put("op", op.substring("fluid.".length()));
				f.put("t", w.gameTime());
				f.putAll(run.run(t, e, w, l, st, cx, cz));
				String k = e.key(t.id);
				if (!w.hasReceipt(cx, cz, k)) {
					w.addReceipt(cx, cz, dev.larattalabs.architect.txn.Receipts.of(k, f));
				}
				if ("fluid.place".equals(op)) {
					int n = 0, kk = 0;
					for (Effect x : t.effects()) {
						if ("fluid.place".equals(x.op())) {
							n++;
							kk += x.i() <= e.i() ? 1 : 0;
						}
					}
					KillPoints.step(t.kind, !t.live(), stepName, kk, n); // (Steward's S1, Q3) "reached (k of n)" over the place Ws
				} else {
					step(t, stepName);
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

	/** (slice T5F) The body ids a write W names: {@code body} (T5F), else {@code bodies}. */
	static List<String> bodiesOf(Effect e) {
		if (e.data().has("body")) {
			return List.of(e.data().get("body").getAsString());
		}
		return ids(e);
	}

	/** (slice T5F, §4.2) {@code fluid.clear}: the waiting water bodies' tile-written cells in this chunk cleared ({@code WROTE -> CLEARED}). */
	static final TxnKind.Adapter FLUID_CLEAR = chunkW("fluid.clear", "clear", (t, e, w, l, st, cx, cz) -> {
		int n = 0;
		String rec = recKey(l);
		for (String id : bodiesOf(e)) {
			RegionFluids.Body b = st.body(id);
			RegionFluids.BodyState bs = st.states.get(id);
			if (b != null && bs != null) {
				n += RegionFluids.clearBody(w, b, bs, rec, cx, cz);
			}
		}
		if (n > 0) {
			Architect.LOGGER.info("Region {}: {} body cell(s) written by the stage's tiles cleared in chunk {},{} until their bodies are due", l.rec().id, n,
				cx, cz);
		}
		return Map.of("n", n);
	});

	/** (slice T5F, §4.2, §3.3) {@code fluid.place}: one body's cells in this chunk written where §3.3 writes them, marked WROTE(R). */
	static final TxnKind.Adapter FLUID_PLACE = chunkW("fluid.place", "place", (t, e, w, l, st, cx, cz) -> {
		int n = 0, h = 0;
		String rec = recKey(l);
		for (String id : bodiesOf(e)) {
			RegionFluids.Body b = st.body(id);
			if (b != null) {
				int[] r = RegionFluids.placeBody(w, b, rec, cx, cz);
				n += r[0];
				h += r[1];
			}
		}
		Map<String, Object> f = new java.util.LinkedHashMap<>();
		f.put("n", n);
		f.put("h", h);
		return f;
	});

	/** (slice T5F, I6) {@code fluid.force}: one body's forced ticks in this chunk (its cells', and its outside neighbours' here). */
	static final TxnKind.Adapter FLUID_FORCE = chunkW("fluid.force", "force", (t, e, w, l, st, cx, cz) -> {
		int n = 0;
		for (String id : bodiesOf(e)) {
			RegionFluids.Body b = st.body(id);
			if (b != null) {
				n += RegionFluids.forceBodyIn(w, b, cx, cz);
				RegionFluids.BodyState bs = st.states.get(id);
				if (bs != null) {
					bs.forcedAt = Math.max(bs.forcedAt, w.gameTime()); // (fix round, P2-6) a replayed force restarts its settle bound
				}
			}
		}
		if (st.forcedAt < 0 || !t.live()) {
			st.forcedAt = w.gameTime(); // (in memory; a replay's forced pass moves it: the settle counts from the ticks it scheduled, §4.4)
		}
		Map<String, Object> f = new java.util.LinkedHashMap<>();
		f.put("n", n);
		f.put("b", String.join(",", bodiesOf(e))); // (round 2, P2-c) whose ticks: the census reads the latest force time back from here
		return f;
	});

	static final RRun WRITTEN_RUN = new RRun() {
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
			// (slice T5F, I6/I7) no physics here: the force Ws scheduled the ticks, each with its chunk; forcedAt is the latest force W's time
			long forcedWas = st.forcedAt;
			if (st.forcedAt < 0) {
				st.forcedAt = now;
			}
			String phase = st.phase;
			if (e.data().get("last").getAsInt() == 1) {
				st.phase = "settling";
			}
			if (!RegionFluids.save(l, st)) {
				st.phase = phase;
				st.forcedAt = forcedWas;
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
			step(t, "written"); // (§4.2's point) the R durable, the txn not EFFECTS_DONE yet
		}
	};

	static final TxnKind.Adapter FLUID_WRITTEN = r(WRITTEN_RUN);

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
			// (fix round, P1-3) an entry planned before T5F (8cT's: a place naming its bodies, a written without v) replays with 8cT's adapters
			return switch (e.op()) {
				case "fluid.clear" -> FLUID_CLEAR;
				case "fluid.place" -> e.data().has("body") ? FLUID_PLACE : LegacyV1.PLACE;
				case "fluid.force" -> FLUID_FORCE;
				case "fluid.written" -> e.data().has("v") ? FLUID_WRITTEN : LegacyV1.WRITTEN;
				default -> null;
			};
		}
	};

	// ------------------------------------------------------------------ fluid.adopt (slice T5F, §4.7: a record built before T5F)

	/**
	 * (slice T5F, §4.7) Whether record {@code l}'s cells carry provenance; if not (a record saved before T5F), its adoption txn is begun (or
	 * found) and the caller waits: null once adopted (go on), else the adoption's step. Every write and drain of a record asks this first.
	 */
	static @Nullable Step adoptFirst(RegionsImpl.Live l, RegionFluids.Regional st) {
		if (st.prov) {
			return null;
		}
		Step a = adopt(l, st);
		if (a.kind() == Step.Kind.DONE && st.prov) {
			return null;
		}
		return a.kind() == Step.Kind.DONE ? Step.waiting() : a;
	}

	/**
	 * (slice T5F, §4.7, Noah's N2) A legacy record's adoption, once: one W per (body, chunk) marks {@code WROTE(R)} every body cell where
	 * our fluid (ice, bars, decor) stands now, or that an ACTIVE journal entry of the record's group wrote (harvested, or lost at a main-era
	 * K4: never refilled, refunds 0); any other cell stays unmarked (written, or refunded when paid). Receipt {@code op=adopt;n=<marked>}.
	 * Then the R {@code fluid.adopted} saves {@code prov}. The one place the journal is read for a fluid cell, where no co-located
	 * evidence exists. Begun after txn recovery (the tick); an open txn on the record's resource holds it until that one retires.
	 */
	static Step adopt(RegionsImpl.Live l, RegionFluids.Regional st) {
		String key = "fluid-adopt:" + recKey(l);
		TxnCore c = TxnServer.core();
		TxnCore.Started started = c.begin(ADOPT, key, List.of(resource(l)), null);
		switch (started.status()) {
			case ATTACHED -> {
				return after(started.entry());
			}
			case REPLAYED -> {
				st.prov = true; // (its R saved prov; a record read before it is caught up here)
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
		for (RegionFluids.Body b : st.bodies) {
			for (long ck : RegionFluids.cellChunks(b)) {
				c.plan(t, wEffect("fluid.adopt", l, ck).data("body", b.id));
			}
		}
		c.plan(t, Effect.of("fluid.adopted", EffectClass.R).data("region", l.rec().id).data("rid", l.rid()));
		DurableFile.Outcome p = c.persist(t);
		if (p == DurableFile.Outcome.REFUSED) {
			return new Step(Step.Kind.REFUSED, "txn_journal: the adoption's intent could not be written");
		}
		Architect.LOGGER.info("Region {}: its water record (rv {}) was saved before fluid provenance: adopting its cells ({})", l.rec().id, l.rid(), t.id);
		if (p == DurableFile.Outcome.OK) {
			c.drive(t);
		}
		return after(t);
	}

	/** (slice T5F fix round, P2-7, TEST) The adoption's journal evidence in a unit; null: the world journal's ({@link TileEntries}). */
	static volatile java.util.function.@Nullable Function<Effect, AdoptEvidence> testEvidence;

	/** (N2 b) The block an ACTIVE journal entry wrote in cell {@code p} (its after state's block), or null: none. */
	interface AdoptEvidence {
		net.minecraft.world.level.block.@Nullable Block after(long p);
	}

	static final TxnKind.Adapter FLUID_ADOPT = chunkW("fluid.adopt", "adopt", (t, e, w, l, st, cx, cz) -> {
		RegionFluids.Body b = st.body(e.data().get("body").getAsString());
		if (b == null) {
			return Map.of("n", 0);
		}
		String rec = recKey(l);
		var marks = w.marks(cx, cz, rec);
		var te = testEvidence;
		AdoptEvidence je = te != null ? te.apply(e) : new TileEntries(l.rec().dimension, e.data().get("group").getAsString(), RegionFluids.stageOf(l))::after;
		int n = 0;
		for (long p : b.cells) {
			if (!RegionFluids.inChunk(p, cx, cz)) {
				continue;
			}
			int idx = w.index(p);
			if (marks.containsKey(idx)) {
				continue;
			}
			net.minecraft.world.level.block.state.BlockState now = w.get(p);
			boolean stands = RegionFluids.ownStillOurs(b, p, now);
			// (fix round, P2-5) the evidence is the record's own fluids tile writing the body's own block there (never an air carve)
			FluidProv.Mark m = FluidProv.adopt(stands, !stands && je.after(p) == RegionFluids.expectedBlock(b, p));
			if (m != null) {
				marks.put(idx, m);
				n++;
			}
		}
		if (n > 0) {
			w.putMarks(cx, cz, rec, marks);
		}
		return Map.of("n", n);
	});

	static final TxnKind.Adapter FLUID_ADOPTED = r(new RRun() {
		@Override
		public boolean applied(TxnEntry t, Effect e, RegionFluids.Regional st) {
			return st.prov;
		}

		@Override
		public void run(TxnEntry t, Effect e, RegionsImpl.Live l, RegionFluids.Regional st) {
			st.prov = true;
			if (!RegionFluids.save(l, st)) {
				st.prov = false;
				throw new IllegalStateException("the fluids record could not be saved");
			}
			Architect.LOGGER.info("Region {}: its water record (rv {}) adopted ({})", l.rec().id, l.rid(), t.id);
			step(t, "adopted");
		}
	});

	static final TxnKind ADOPT_KIND = new TxnKind() {
		@Override
		public String name() {
			return ADOPT;
		}

		@Override
		public int kv() {
			return 1;
		}

		@Override
		public TxnKind.@Nullable Adapter adapter(Effect e) {
			return switch (e.op()) {
				case "fluid.adopt" -> FLUID_ADOPT;
				case "fluid.adopted" -> FLUID_ADOPTED;
				default -> null;
			};
		}
	};

	/**
	 * (slice T5F fix round, P1-3) 8cT's {@code fluid.write} adapters, kept only for entries planned before T5F (recovered after the upgrade,
	 * before the record's adoption, which waits for them on the record's resource): its place writes the due bodies' open cells in its
	 * chunks except a lava or grate cell an ACTIVE entry of the record's fluids tiles wrote (8cT's journal rule), and its written forces every
	 * body (the physics 8cT put in the R). New plans never use them.
	 */
	static final class LegacyV1 {
		private LegacyV1() {
		}

		static final TxnKind.Adapter PLACE = w("place", (t, e, level, l, st) -> {
			TileEntries jw = new TileEntries(l.rec().dimension, e.data().get("group").getAsString(), RegionFluids.stageOf(l));
			FluidWorld fw = FluidWorld.of(level);
			int n = 0;
			for (long[] c : chunksOf(e)) {
				for (String id : ids(e)) {
					RegionFluids.Body b = st.body(id);
					if (b != null) {
						n += RegionFluids.writeBodyV1(fw, b, (int) c[0], (int) c[1], p -> b.lava && jw.after(p) == net.minecraft.world.level.block.Blocks.LAVA
							|| b.gratePos(p) && jw.after(p) == net.minecraft.world.level.block.Blocks.IRON_BARS);
					}
				}
			}
			return n;
		});

		static final TxnKind.Adapter WRITTEN = r(new RRun() {
			@Override
			public boolean applied(TxnEntry t, Effect e, RegionFluids.Regional st) {
				return WRITTEN_RUN.applied(t, e, st);
			}

			@Override
			public void run(TxnEntry t, Effect e, RegionsImpl.Live l, RegionFluids.Regional st) {
				ServerLevel level = l.level(TxnServer.server());
				if (level != null) {
					FluidWorld fw = FluidWorld.of(level);
					for (String id : ids(e)) {
						RegionFluids.Body b = st.body(id);
						if (b != null) {
							for (long ck : RegionFluids.forceChunks(b)) {
								RegionFluids.forceBodyIn(fw, b, (int) (ck >> 32), (int) ck); // 8cT's forced tick, every chunk, in the R
							}
						}
					}
				}
				WRITTEN_RUN.run(t, e, l, st);
			}
		});
	}

	/**
	 * (slice T5F, N2(b), adoption only) Per section, the cells an ACTIVE journal entry of the group wrote (any block): the one read of the
	 * journal for a fluid cell, at adoption. An unreadable section throws: the adoption holds, never guesses.
	 */
	static final class TileEntries {
		private final String dim;
		private final String group;
		private final String stage;
		private final it.unimi.dsi.fastutil.longs.Long2ObjectOpenHashMap<it.unimi.dsi.fastutil.longs.Long2ObjectOpenHashMap<net.minecraft.world.level.block.Block>> bySection =
			new it.unimi.dsi.fastutil.longs.Long2ObjectOpenHashMap<>();

		/** (fix round, P2-5) Only the ACTIVE entries of the group's sites that are tiles of the record's fluids stage {@code stage}. */
		TileEntries(String dim, String group, String stage) {
			this.dim = dim;
			this.group = group;
			this.stage = stage;
		}

		/** A journal entry's site's region tile ({@code stage|set|key}, its infra record's {@code architect_mc:tile}), else null. */
		static @Nullable String tileOf(String siteId) {
			var in = dev.larattalabs.architect.site.Infras.get(siteId);
			if (in == null) {
				in = dev.larattalabs.architect.site.Infras.pending(siteId);
			}
			if (in == null || !(in.ext().get(dev.larattalabs.architect.site.RegionItems.EXT_TILE) instanceof JsonElement t) || !t.isJsonPrimitive()) {
				return null;
			}
			return t.getAsString();
		}

		/**
		 * (round 2) Whether an entry is adoption evidence: of the record's group ({@code wantGroup}), ACTIVE, and a tile of the record's own
		 * fluids stage {@code stage} ({@code tile}: its {@code stage|set|key}). Pure.
		 */
		static boolean evidence(@Nullable String group, String wantGroup, boolean active, @Nullable String tile, String stage) {
			return wantGroup.equals(group) && active && tile != null && stage.equals(tile.split("\\|", -1)[0]);
		}

		net.minecraft.world.level.block.@Nullable Block after(long pos) {
			long key = dev.larattalabs.architect.journal.Sections.key(pos);
			var m = bySection.get(key);
			if (m == null) {
				m = new it.unimi.dsi.fastutil.longs.Long2ObjectOpenHashMap<>();
				try {
					var store = WorldJournal.store();
					for (var en : WorldJournal.activeSlices(dim, key)) {
						var meta = store.meta(en.id());
						if (meta == null || !evidence(meta.group(), group, en.status() == dev.larattalabs.architect.journal.Journal.Status.ACTIVE, tileOf(meta
							.site()), stage)) {
							continue;
						}
						for (var c : en.cells()) {
							if (c.after() != null) {
								m.putIfAbsent(c.pos(), WorldJournal.state(c.after()).getBlock());
							}
						}
					}
				} catch (java.io.IOException | RuntimeException ex) {
					throw new IllegalStateException("the journal could not be read for section " + key + " (" + ex + "): the adoption waits for it");
				}
				bySection.put(key, m);
			}
			return m.get(pos);
		}
	}

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
			"fluid.escaped", EffectClass.R).data("body", b.id).data("why", why).data("typed", typed).data("at", cells), t -> {
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
			RegionFluids.Body b = st.body(e.data().get("body").getAsString());
			ServerLevel level = l.level(TxnServer.server());
			if (b != null && level != null && e.data().has("why")) {
				// (8cT last round, P2) the outcome rebuilt from the entry (a start that found the W's receipts skipped its writes and lost their
				// state): the body and its upstream closure drained with their reasons, the typed why, the escaped cells
				List<long[]> at = new ArrayList<>();
				for (JsonElement x : e.data().getAsJsonArray("at")) {
					JsonArray a = x.getAsJsonArray();
					at.add(new long[] {a.get(0).getAsLong(), a.get(1).getAsLong(), a.get(2).getAsLong()});
				}
				RegionFluids.escape(level, l, st, b, bs, e.data().get("why").getAsString(), at, false);
				bs.why = e.data().get("typed").getAsString();
			}
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
		if (RegionFluids.holdDrain) {
			throw new IllegalStateException("TEST: dev.fluid.hold drain");
		}
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
			RegionFluids.report(l, st); // (a replay retried by the core's tick reports the rows too)
		}
	});


	// ------------------------------------------------------------------ (8cT last round, #4) a held or rechecked body's drain

	/**
	 * (8cT last round, #4) A body held by the emission check (at its wave or forced tick) or failing the recheck after a stop: what the tiles
	 * wrote of it (and of its pending upstream closure) drained (W, kill point {@code TX:fluid.drain:drain}), then the body recorded drained
	 * (uncontained, its why and reason, the cells) with its upstream closure held (R), the barrier. A start replays it.
	 */
	static Step hold(RegionsImpl.Live l, RegionFluids.Regional st, RegionFluids.Body b, String typed, String reason, List<long[]> at) {
		JsonArray cells = new JsonArray();
		for (long[] c : at) {
			JsonArray a = new JsonArray();
			a.add(c[0]);
			a.add(c[1]);
			a.add(c[2]);
			cells.add(a);
		}
		String key = "fluid-drain:" + recKey(l) + "/held:" + b.id;
		return record(DRAIN, key, l, st, Effect.of("fluid.hold", EffectClass.W).data("body", b.id), Effect.of("fluid.held", EffectClass.R).data("body", b.id)
			.data("why", typed).data("reason", reason).data("at", cells), t -> {
			});
	}

	static final TxnKind.Adapter FLUID_HOLD = w("drain", (t, e, level, l, st) -> {
		RegionFluids.Body b = st.body(e.data().get("body").getAsString());
		if (b == null) {
			return 0;
		}
		RegionFluids.BodyState bs = st.states.get(b.id);
		int n = bs.before.isEmpty() ? 0 : RegionFluids.drain(level, st, b, bs, false, st.othersOf(b));
		for (RegionFluids.Body u : RegionFluids.upstreamOf(st, b)) {
			RegionFluids.BodyState us = st.states.get(u.id);
			if (!us.before.isEmpty() && !"settled".equals(us.state) && !"written".equals(us.state)) {
				n += RegionFluids.drain(level, st, u, us, false, st.othersOf(u)); // its tile-written cells (a pending reach)
			}
		}
		return n;
	});

	static final TxnKind.Adapter FLUID_HELD = r(new RRun() {
		@Override
		public boolean applied(TxnEntry t, Effect e, RegionFluids.Regional st) {
			RegionFluids.BodyState bs = st.states.get(e.data().get("body").getAsString());
			return bs != null && t.id.equals(bs.drainTxn);
		}

		@Override
		public void run(TxnEntry t, Effect e, RegionsImpl.Live l, RegionFluids.Regional st) {
			RegionFluids.Body b = st.body(e.data().get("body").getAsString());
			RegionFluids.BodyState bs = b == null ? null : st.states.get(b.id);
			if (bs == null) {
				return;
			}
			bs.state = "drained";
			bs.uncontained = true;
			bs.why = e.data().get("why").getAsString();
			bs.reason = e.data().get("reason").getAsString();
			bs.at.clear();
			for (JsonElement x : e.data().getAsJsonArray("at")) {
				JsonArray a = x.getAsJsonArray();
				bs.at.add(new long[] {a.get(0).getAsLong(), a.get(1).getAsLong(), a.get(2).getAsLong()});
			}
			RegionFluids.holdUpstream(l, st, b);
			bs.drainTxn = t.id;
			if (!RegionFluids.save(l, st)) {
				bs.drainTxn = null; // (the probe reads drainTxn: the next drive saves again)
				throw new IllegalStateException("the fluids record could not be saved");
			}
			RegionFluids.report(l, st);
		}
	});

}
