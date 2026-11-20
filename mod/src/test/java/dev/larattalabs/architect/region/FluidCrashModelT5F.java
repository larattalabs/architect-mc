package dev.larattalabs.architect.region;

import java.util.ArrayList;
import java.util.EnumSet;
import java.util.HashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * (slice T5Fa, CONTRACT T5F §7.1) The per-kind crash model of a region's paid fluid body: the participants are each chunk (its cells, its
 * {@code architect_mc:fluid_prov} marks, its receipts and its scheduled ticks: one versioned snapshot, I1), the journal (the tile entry's
 * ACTIVE), the ledger, fluids.json and txn.json (durable when written). An adversary harvests or dispenses between any two persisted
 * versions and during holds.
 *
 * <p>The lifecycle is T5F's: the fluids tile writes the cells (N1: the tiles keep writing), {@code fluid.write} (a place W and a force W per
 * chunk, the barrier, the R), the removal's {@code fluid.drain} (one W per chunk counting {@code l} and {@code u} into its receipt, the barrier,
 * the R) and {@code region.scoop} as its own txn after the drain's EFFECTS_DONE, summed from the durable receipts; the settle deadline from
 * the receipts' {@code t}.
 *
 * <p>{@link #explore} crashes at every step boundary, picks every combination of the chunks' persisted versions (a barrier forces all of them;
 * the files are durable at once), lets the adversary act once (none, a harvest of any standing cell, a dispense into any open cell), restarts
 * later and recovers (open txns redone effect by effect by their probes, then the rest of the lifecycle); every boundary is also tried as a
 * hold (no crash: the adversary acts, the run continues). Then the checks: conservation of lava units (ledger + the player + lava standing ==
 * the start), never refilled (Architect never writes a cell after the player harvested it), the forced ticks of every written chunk, the
 * settle deadline after the last drain write that survived, and the removal complete.
 *
 * <p>Each {@link Naive} switch puts one of 8cT's reviewed behaviours back (8cT-final-dc814bb1.log; CONTRACT T5F §0), so each is shown red,
 * and NONE green. This is a model of the design, not of the code: {@code FluidCrashModelT5FTest} binds each switch to a marker in the runtime.
 */
final class FluidCrashModelT5F {
	/** 8cT's broken behaviours (CONTRACT T5F §0, §7.1) and NONE (T5F as designed). */
	enum Naive {
		NONE,
		/** P1-1: the journal's ACTIVE is the write evidence (the place W skips every cell the tile entry claims, whatever the chunk holds). */
		ACTIVE_AS_PROOF,
		/** P1-2a: the drain's counts ({@code @seen}) written into every chunk before its writes, in the first apply; the scoop sums them. */
		SEEN_AHEAD,
		/** P1-2b: one W over every chunk (its probe ABSENT if any chunk lacks the receipt, its apply redoes them all; 8cT's ownership). */
		AGGREGATE_W,
		/** P1-2c: the scoop's L in the drain txn, applied (the ledger saved at once) before the barrier covers the drain's chunks. */
		L_BEFORE_BARRIER,
		/** P2-a: no provenance for the body's fluid: the place W writes every open cell. */
		WATER_REFILL,
		/** P2-b: the forced ticks scheduled by the R ({@code fluid.written}), not by a W in each chunk. */
		FORCE_IN_R,
		/** F: the settle deadline read from fluids.json's stored {@code until}, not from the receipts' {@code t}. */
		STORED_UNTIL
	}

	static final int CHUNKS = 2;
	static final int CELLS = 2;
	static final int PAID = CHUNKS * CELLS;
	static final int BOUND = 10;
	static final int RESTART_GAP = 100;
	/** The player's own lava at the start (a bucket to dispense). */
	static final int PLAYER0 = 1;

	static final int AIR = 0;
	/** Our fluid: a lava source the body wrote. */
	static final int OURS = 1;
	/** A lava source someone else put there (a dispenser, a player). */
	static final int FOREIGN = 2;

	/** One chunk's snapshot: cells, marks (WROTE of R), receipts (op -> {l, u, t}), forced ticks, the last drain write's time. */
	static final class Ch {
		int[] cell = new int[CELLS];
		boolean[] mark = new boolean[CELLS];
		Map<String, long[]> rec = new HashMap<>();
		boolean ticks;
		long drainedAt = -1;

		Ch copy() {
			Ch c = new Ch();
			c.cell = cell.clone();
			c.mark = mark.clone();
			rec.forEach((k, v) -> c.rec.put(k, v.clone()));
			c.ticks = ticks;
			c.drainedAt = drainedAt;
			return c;
		}
	}

	/** The durable files (journal, ledger, fluids.json, txn.json) and the player: durable as soon as written. */
	static final class Files {
		boolean active;
		int ledger;
		boolean credited;
		boolean written;
		boolean drained;
		long until = -1;
		boolean scooped;
		Set<String> persisted = new LinkedHashSet<>();
		Set<String> done = new LinkedHashSet<>();
		int scoopAmount = -1;
		int player = PLAYER0;
		boolean[][] taken = new boolean[CHUNKS][CELLS];

		Files copy() {
			Files f = new Files();
			f.active = active;
			f.ledger = ledger;
			f.credited = credited;
			f.written = written;
			f.drained = drained;
			f.until = until;
			f.scooped = scooped;
			f.persisted = new LinkedHashSet<>(persisted);
			f.done = new LinkedHashSet<>(done);
			f.scoopAmount = scoopAmount;
			f.player = player;
			f.taken = new boolean[CHUNKS][];
			for (int c = 0; c < CHUNKS; c++) {
				f.taken[c] = taken[c].clone();
			}
			return f;
		}
	}

	static final class S {
		Ch[] live = new Ch[CHUNKS];
		Files f = new Files();
		long time;
		final List<String> violations = new ArrayList<>();

		S() {
			for (int c = 0; c < CHUNKS; c++) {
				live[c] = new Ch();
			}
		}
	}

	/** Thrown at the crash boundary. */
	static final class Crash extends RuntimeException {
		Crash() {
			super(null, null, false, false);
		}
	}

	/** The adversary's one action. */
	record Adv(String what, int c, int i) {
		static final Adv NONE = new Adv("none", -1, -1);
	}

	/** One straight run's boundaries: after each, the chunks' copies (for the persisted-version choice) and the files. */
	static final class Run {
		final int crashAt;
		final boolean hold;
		final Adv adv;
		int n;
		int lastBarrier = -1;
		final List<Ch[]> history = new ArrayList<>();
		final List<Files> files = new ArrayList<>();
		final S s;

		Run(S s, int crashAt, boolean hold, Adv adv) {
			this.s = s;
			this.crashAt = crashAt;
			this.hold = hold;
			this.adv = adv;
		}

		/** A step boundary (a kill point: between effects, never inside an apply, I9). */
		void b(boolean barrier) {
			s.time++;
			if (barrier) {
				lastBarrier = n;
			}
			Ch[] h = new Ch[CHUNKS];
			for (int c = 0; c < CHUNKS; c++) {
				h[c] = s.live[c].copy();
			}
			history.add(h);
			files.add(s.f.copy());
			if (n == crashAt) {
				n++;
				if (hold) {
					act(s, adv, s.live);
				} else {
					throw new Crash();
				}
				return;
			}
			n++;
		}
	}

	private final Set<Naive> design;

	FluidCrashModelT5F(Set<Naive> design) {
		this.design = design.isEmpty() ? EnumSet.of(Naive.NONE) : EnumSet.copyOf(design);
	}

	boolean on(Naive n) {
		return design.contains(n);
	}

	static void act(S s, Adv a, Ch[] world) {
		// a harvest of a tile still PLACING (its rollback re-plans the cell) is outside T5F (§1 Out: the tile's own journal window, T4/T6):
		// the adversary harvests once the tile entry is ACTIVE
		if (a.what().equals("harvest") && s.f.active && world[a.c()].cell[a.i()] == OURS) {
			world[a.c()].cell[a.i()] = AIR;
			s.f.player++;
			s.f.taken[a.c()][a.i()] = true;
		} else if (a.what().equals("dispense") && world[a.c()].cell[a.i()] == AIR && s.f.player > 0) {
			world[a.c()].cell[a.i()] = FOREIGN;
			s.f.player--;
		}
	}

	// ------------------------------------------------------------------ the lifecycle (a live run, and the recovery after a crash)

	interface Eff {
		boolean applied(S s);

		void apply(S s, Run r);
	}

	record Txn(String name, List<Eff> effects) {
	}

	void lifecycle(S s, Run r) {
		// the fluids tile (N1): a PLACING entry rolls back and re-plans; ACTIVE once its cells are written
		if (!s.f.active) {
			for (int c = 0; c < CHUNKS; c++) {
				for (int i = 0; i < CELLS; i++) {
					if (s.live[c].cell[i] == OURS && !s.f.taken[c][i]) {
						s.live[c].cell[i] = AIR;
					}
					s.live[c].mark[i] = false;
				}
			}
			for (int c = 0; c < CHUNKS; c++) {
				for (int i = 0; i < CELLS; i++) {
					if (s.live[c].cell[i] == AIR && !s.f.taken[c][i]) {
						s.live[c].cell[i] = OURS;
						s.live[c].mark[i] = !on(Naive.ACTIVE_AS_PROOF) && !on(Naive.WATER_REFILL); // (I1) the mark in the same tick and chunk
					}
				}
				r.b(false);
			}
			s.f.active = true;
			r.b(false);
		}
		txn(s, r, writeTxn());
		if (!s.f.done.contains("write-checked")) {
			for (int c = 0; c < CHUNKS; c++) {
				boolean has = false;
				for (int i = 0; i < CELLS; i++) {
					has |= s.live[c].cell[i] == OURS;
				}
				if (has && !s.live[c].ticks) {
					s.violations.add("physics: chunk " + c + " written with no forced tick (P2-b)");
				}
			}
			s.f.done.add("write-checked");
		}
		txn(s, r, drainTxn());
		if (!on(Naive.L_BEFORE_BARRIER)) {
			txn(s, r, scoopTxn());
		}
	}

	/** Begins (persist), or redoes an open, txn: every effect whose probe is ABSENT, the barrier, EFFECTS_DONE. */
	void txn(S s, Run r, Txn t) {
		if (s.f.done.contains(t.name())) {
			return;
		}
		if (!s.f.persisted.contains(t.name())) {
			if (t.name().equals("scoop")) {
				s.f.scoopAmount = scoopFromReceipts(s); // (I5) summed from the durable receipts, persisted with the intent
			}
			s.f.persisted.add(t.name());
			r.b(false);
		}
		for (Eff e : t.effects()) {
			if (!e.applied(s)) {
				e.apply(s, r);
				r.b(false);
			}
		}
		r.b(true); // core's barrier:effects: every chunk saved
		s.f.done.add(t.name());
		r.b(false);
	}

	Txn writeTxn() {
		List<Eff> es = new ArrayList<>();
		for (int c0 = 0; c0 < CHUNKS; c0++) {
			int c = c0;
			es.add(new Eff() {
				public boolean applied(S s) {
					return s.live[c].rec.containsKey("place");
				}

				public void apply(S s, Run r) {
					Ch ch = s.live[c];
					for (int i = 0; i < CELLS; i++) {
						boolean write;
						if (on(Naive.WATER_REFILL)) {
							write = ch.cell[i] == AIR;
						} else if (on(Naive.ACTIVE_AS_PROOF)) {
							write = !s.f.active && ch.cell[i] == AIR; // the journal says the tile wrote it: never written again
						} else {
							write = !ch.mark[i] && ch.cell[i] == AIR; // §3.3: no mark and open
						}
						if (write) {
							if (s.f.taken[c][i]) {
								s.violations.add("refill: Architect wrote chunk " + c + " cell " + i + " after the player harvested it (P2-a)");
							}
							ch.cell[i] = OURS;
							ch.mark[i] = !on(Naive.ACTIVE_AS_PROOF) && !on(Naive.WATER_REFILL);
						}
					}
					ch.rec.put("place", new long[] {0, 0, s.time}); // (I3) the receipt in the same apply
				}
			});
		}
		if (!on(Naive.FORCE_IN_R)) {
			for (int c0 = 0; c0 < CHUNKS; c0++) {
				int c = c0;
				es.add(new Eff() {
					public boolean applied(S s) {
						return s.live[c].rec.containsKey("force");
					}

					public void apply(S s, Run r) {
						s.live[c].ticks = true; // (I6) the ticks in the chunk's own W
						s.live[c].rec.put("force", new long[] {0, 0, s.time});
					}
				});
			}
		}
		es.add(new Eff() {
			public boolean applied(S s) {
				return s.f.written;
			}

			public void apply(S s, Run r) {
				if (on(Naive.FORCE_IN_R)) {
					for (Ch ch : s.live) {
						ch.ticks = true;
					}
				}
				s.f.written = true;
			}
		});
		return new Txn("write", es);
	}

	Txn drainTxn() {
		List<Eff> es = new ArrayList<>();
		if (on(Naive.AGGREGATE_W)) {
			es.add(new Eff() {
				public boolean applied(S s) {
					for (Ch ch : s.live) {
						if (!ch.rec.containsKey("drain")) {
							return false;
						}
					}
					return true;
				}

				public void apply(S s, Run r) {
					for (Ch ch : s.live) {
						long[] seen = ch.rec.get("drain");
						int l = 0;
						for (int i = 0; i < CELLS; i++) {
							if (ch.cell[i] != AIR) { // 8cT's ownStillOurs: a lava source in a body cell
								l++;
								ch.cell[i] = AIR;
							}
							ch.mark[i] = false;
						}
						ch.drainedAt = s.time;
						if (seen == null) {
							ch.rec.put("drain", new long[] {l, 0, s.time}); // a receipt-present chunk keeps its count, and is drained again
						}
					}
				}
			});
		} else {
			if (on(Naive.SEEN_AHEAD)) {
				es.add(new Eff() {
					public boolean applied(S s) {
						for (Ch ch : s.live) {
							if (!ch.rec.containsKey("seen")) {
								return false;
							}
						}
						return true;
					}

					public void apply(S s, Run r) {
						for (Ch ch : s.live) {
							if (!ch.rec.containsKey("seen")) {
								int l = 0, u = 0;
								for (int i = 0; i < CELLS; i++) {
									l += ch.cell[i] == OURS && ch.mark[i] ? 1 : 0;
									u += !ch.mark[i] && ch.cell[i] == AIR ? 1 : 0;
								}
								ch.rec.put("seen", new long[] {l, u, s.time}); // the counts ahead of the writes, in every chunk
							}
						}
						// (8cT) the same apply writes on, but a hold, FL5+save or a crash can come between: the next boundary is that window
					}
				});
			}
			for (int c0 = 0; c0 < CHUNKS; c0++) {
				int c = c0;
				es.add(new Eff() {
					public boolean applied(S s) {
						return s.live[c].rec.containsKey("drain");
					}

					public void apply(S s, Run r) {
						Ch ch = s.live[c];
						int l = 0, u = 0;
						for (int i = 0; i < CELLS; i++) {
							if (ch.mark[i] && ch.cell[i] == OURS) { // (I8) WROTE and ours
								l++;
								ch.cell[i] = AIR;
							} else if (!ch.mark[i] && ch.cell[i] != FOREIGN && ch.cell[i] != OURS) {
								u++; // paid, no mark: never delivered (§3.3 rows 1-2)
							} else if (!ch.mark[i] && ch.cell[i] == FOREIGN) {
								u++; // never delivered; the foreign source is not ours to take
							} else if (!ch.mark[i] && ch.cell[i] == OURS) {
								u++; // (8cT naive switches only: an unmarked write) refunded as undelivered, left standing
							}
							ch.mark[i] = false;
						}
						ch.drainedAt = s.time;
						ch.rec.put("drain", new long[] {l, u, s.time}); // (I3) counted in the same apply as the writes
					}
				});
			}
		}
		if (on(Naive.L_BEFORE_BARRIER)) {
			es.add(new Eff() {
				public boolean applied(S s) {
					return s.f.credited;
				}

				public void apply(S s, Run r) {
					s.f.ledger += scoopFromReceipts(s); // the ledger saved at once, the drain's chunks not yet covered
					s.f.credited = true;
				}
			});
		}
		es.add(new Eff() {
			public boolean applied(S s) {
				return s.f.drained;
			}

			public void apply(S s, Run r) {
				s.f.drained = true;
				if (on(Naive.STORED_UNTIL)) {
					s.f.until = s.time + BOUND;
				}
			}
		});
		return new Txn("drain", es);
	}

	Txn scoopTxn() {
		List<Eff> es = new ArrayList<>();
		es.add(new Eff() {
			public boolean applied(S s) {
				return s.f.credited;
			}

			public void apply(S s, Run r) {
				s.f.ledger += s.f.scoopAmount; // the intent's amount, never recounted
				s.f.credited = true;
			}
		});
		es.add(new Eff() {
			public boolean applied(S s) {
				return s.f.scooped;
			}

			public void apply(S s, Run r) {
				s.f.scooped = true;
			}
		});
		return new Txn("scoop", es);
	}

	int scoopFromReceipts(S s) {
		int sum = 0;
		for (Ch ch : s.live) {
			long[] x = on(Naive.SEEN_AHEAD) ? ch.rec.get("seen") : ch.rec.get("drain");
			if (x != null) {
				sum += (int) (x[0] + x[1]);
			}
		}
		return sum;
	}

	long deadline(S s) {
		if (on(Naive.STORED_UNTIL)) {
			return s.f.until;
		}
		long t = -1;
		for (Ch ch : s.live) {
			long[] x = ch.rec.get("drain");
			if (x != null) {
				t = Math.max(t, x[2]);
			}
		}
		return t + BOUND;
	}

	// ------------------------------------------------------------------ the checks and the exploration

	void check(S s) {
		int lava = 0;
		long lastDrain = -1;
		for (Ch ch : s.live) {
			for (int i = 0; i < CELLS; i++) {
				lava += ch.cell[i] != AIR ? 1 : 0;
				if (ch.cell[i] == OURS) {
					s.violations.add("removal: our source still stands");
				}
			}
			lastDrain = Math.max(lastDrain, ch.drainedAt);
		}
		int total = s.f.ledger + s.f.player + lava;
		if (total != PAID + PLAYER0) {
			s.violations.add("conservation: ledger " + s.f.ledger + " + player " + s.f.player + " + standing " + lava + " = " + total + ", want " + (PAID
				+ PLAYER0));
		}
		long dl = deadline(s);
		if (dl < lastDrain + BOUND) {
			s.violations.add("deadline " + dl + " before the last drain write " + lastDrain + " + bound (F)");
		}
	}

	/** One schedule's violations: a crash (or, with hold, a hold) at boundary k, the chunks' persisted boundaries, the adversary. */
	List<String> one(int k, boolean hold, int[] saved, Adv adv) {
		S s = new S();
		Run r = new Run(s, k, hold, adv);
		try {
			lifecycle(s, r);
		} catch (Crash c) {
			for (int ch = 0; ch < CHUNKS; ch++) {
				int j = saved[ch];
				if (j < r.lastBarrier) {
					return null; // not a reachable state: the barrier saved every chunk at lastBarrier
				}
				s.live[ch] = j < 0 ? new Ch() : r.history.get(j)[ch].copy();
			}
			s.f = r.files.get(k).copy();
			s.time += RESTART_GAP;
			act(s, adv, s.live);
			lifecycle(s, new Run(s, -1, false, Adv.NONE));
		}
		check(s);
		return s.violations;
	}

	/** Every schedule; answers the first counterexample of each violation kind (empty: none). */
	Map<String, String> explore() {
		int n = boundaries();
		Map<String, String> bad = new HashMap<>();
		List<Adv> advs = new ArrayList<>();
		advs.add(Adv.NONE);
		for (int c = 0; c < CHUNKS; c++) {
			for (int i = 0; i < CELLS; i++) {
				advs.add(new Adv("harvest", c, i));
				advs.add(new Adv("dispense", c, i));
			}
		}
		for (int k = 0; k < n; k++) {
			for (Adv a : advs) {
				record(bad, one(k, true, null, a), "hold at " + k + ", " + a);
				for (int j0 = -1; j0 <= k; j0++) {
					for (int j1 = -1; j1 <= k; j1++) {
						record(bad, one(k, false, new int[] {j0, j1}, a), "crash at " + k + " (chunk 0 saved at " + j0 + ", chunk 1 at " + j1 + "), " + a);
					}
				}
			}
		}
		record(bad, one(-1, false, null, Adv.NONE), "no crash");
		return bad;
	}

	private static void record(Map<String, String> bad, List<String> v, String how) {
		if (v == null) {
			return;
		}
		for (String x : v) {
			bad.putIfAbsent(x.replaceAll("[0-9]+", "#"), x + " [" + how + "]");
		}
	}

	/** The straight run's boundary count. */
	int boundaries() {
		S s = new S();
		Run r = new Run(s, -1, false, Adv.NONE);
		lifecycle(s, r);
		return r.n;
	}
}
