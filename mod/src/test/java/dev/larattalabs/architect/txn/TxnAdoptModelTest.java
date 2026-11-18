package dev.larattalabs.architect.txn;

import static dev.larattalabs.architect.txn.TxnCrashModel.obj;
import static dev.larattalabs.architect.txn.TxnCrashModelTest.begin;
import static dev.larattalabs.architect.txn.TxnCrashModelTest.fx;
import static dev.larattalabs.architect.txn.TxnCrashModelTest.it;
import static dev.larattalabs.architect.txn.TxnCrashModelTest.run;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonObject;
import dev.larattalabs.architect.site.DurableFile.Outcome;
import dev.larattalabs.architect.txn.TxnCrashModel.Naive;
import dev.larattalabs.architect.txn.TxnCrashModel.Result;
import dev.larattalabs.architect.txn.TxnCrashModel.Scenario;
import dev.larattalabs.architect.txn.TxnCrashModel.Store;
import dev.larattalabs.architect.txn.TxnCrashModel.World;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

/**
 * (slice T3a, the T3 design §1 and §4 case 5) Adoption in the crash model. {@code pile.adopt} as the design plans it (kv 1, decider txn, null
 * key): the crate's take (B, prepare, its receipt in the crate chunk), B1, PREPARED_DONE, the decision; then the ledger's credit (L, keyed
 * {@code adopt:<crateOwner>@<pos>}; the whole crate stock, past capacity: Noah's decision 1, no owed entry), the crate cell's restore (W),
 * the record's clear (R). The model drives the production {@link TxnCore} through the model adapters, so it shows the protocol green; the
 * two legacy kinds are the code as it stands, red:
 * <ul>
 * <li>{@code adopt-main} ({@link Naive#ADOPT_MAIN}): main's {@code Stockpiles.adopt}: the ledger joined, the overflow dropped as entities and
 * the cell restored in memory, SAC1, {@code saveWithWorld} (chunks, then the ledger), the records cleared, SAC2; at start
 * {@code repairJoinedCrates}.</li>
 * <li>{@code adopt-ADP} ({@link Naive#ADOPT_ADP}): a67b9331: the credit (and the overflow's drop) saved first, a failed or IN_DOUBT save
 * rolled back in memory only ({@code restoreLedger}), then the take; at start {@code finishTakes} drains whatever a credited crate holds.</li>
 * </ul>
 * No runtime change: T3b builds the kind (after T2b's crate hold and {@code crate.take}) and these turn into its regression.
 */
class TxnAdoptModelTest {
	final TxnCrashModel m = new TxnCrashModel();

	static final String KEY = "adopt:s4@77";
	static final int STOCK = 12;

	static {
		// main's start: repairJoinedCrates (a record naming a credited crate loses its reference; no item moves)
		TxnCrashModel.RESOLVERS.put(Naive.ADOPT_MAIN, w -> clearRecordIfCredited(w));
		// ADP's start: finishTakes, the drain-all: a credited crate that still stands is emptied and restored, whatever it holds now
		TxnCrashModel.RESOLVERS.put(Naive.ADOPT_ADP, w -> {
			Store c = w.store("chunk:C");
			if (TxnCrashModel.has(w.store("ledger").mem, "receipts", KEY) && !c.mem.has("restored")) {
				JsonObject s = c.edit();
				TxnCrashModel.restoreChunk(s);
				c.set(s);
				w.notes.add("adp-finishTakes");
			}
			clearRecordIfCredited(w);
		});
	}

	static void clearRecordIfCredited(World w) {
		Store sites = w.store("sites");
		if (TxnCrashModel.has(w.store("ledger").mem, "receipts", KEY) && sites.mem.getAsJsonObject("records").has("site:s4")) {
			dropRecord(sites);
		}
	}

	static void dropRecord(Store sites) {
		JsonObject s = sites.edit();
		s.getAsJsonObject("records").remove("site:s4");
		sites.set(s);
		sites.save();
	}

	/** An adoption scenario: a crate of {@code stock} planks in chunk C (a pile with room for {@code room}); E is the drop chunk. */
	static Scenario adopt(int stock, int room) {
		return new Scenario() {
			@Override
			public void setup(World w) {
				w.add("chunk:C", true, false, obj("items", it("planks", stock)));
				w.add("chunk:E", true, false, obj());
				w.add("ledger", false, true, obj());
				w.add("sites", false, true, obj("records", obj("site:s4", obj("crate", "C"))));
			}

			@Override
			public void op(World w) {
				switch (w.naive) {
					case ADOPT_MAIN -> main(w, stock, room);
					case ADOPT_ADP -> adp(w, stock, room);
					default -> pileAdopt(w, stock);
				}
			}

			@Override
			public List<String> check(World w, Map<String, Long> baseline) {
				List<String> v = new ArrayList<>();
				if (!TxnCrashModel.items(w.store("chunk:E").mem, "items").isEmpty()) {
					v.add("overflow left as item entities: " + w.store("chunk:E").mem.get("items"));
				}
				String o = outcome(w, stock);
				if (o.startsWith("torn")) {
					v.add(o);
				}
				return v;
			}
		};
	}

	/** pile.adopt: every amount planned (R-7), the take the one prepare effect; overflow booked into the stock past capacity. */
	static void pileAdopt(World w, int stock) {
		TxnEntry t = begin(w, "pile.adopt", null, "pile:A", "crate:C", "site:s4");
		w.core.plan(t, fx("take", EffectClass.B, "chunk:C", it("planks", stock), "crate", Effect.TRANSIT).prepare());
		w.core.plan(t, fx("credit", EffectClass.L, "ledger", it("planks", stock), Effect.TRANSIT, "stock").data("key", KEY));
		w.core.plan(t, fx("restore", EffectClass.W, "chunk:C", Map.of(), "", ""));
		w.core.plan(t, Effect.of("drop", EffectClass.R).data("store", "sites").data("id", "site:s4"));
		run(w, t);
	}

	/** main 1107-1213 (SAD): what fits joins the stock, the rest drops beside the pile, the cell restored, all in memory; SAC1; saved; SAC2. */
	static void main(World w, int stock, int room) {
		int fit = Math.min(stock, room);
		Store l = w.store("ledger");
		JsonObject ls = l.edit();
		TxnCrashModel.addItems(ls, "stock", it("planks", fit), +1);
		TxnCrashModel.put(ls, "receipts", KEY);
		l.set(ls);
		Store c = w.store("chunk:C");
		JsonObject cs = c.edit();
		TxnCrashModel.addItems(cs, "items", it("planks", stock), -1);
		TxnCrashModel.restoreChunk(cs);
		c.set(cs);
		if (stock > fit) {
			Store e = w.store("chunk:E");
			JsonObject es = e.edit();
			TxnCrashModel.addItems(es, "items", it("planks", stock - fit), +1);
			e.set(es);
		}
		w.kill("SAC1");
		w.barrier(); // saveWithWorld: the chunks, then the ledger
		dropRecord(w.store("sites"));
		w.kill("SAC2");
		w.barrier();
	}

	/** a67b9331: the credit (and the drop) saved first; refused or IN_DOUBT -> restoreLedger in memory, nothing more; then the take. */
	static void adp(World w, int stock, int room) {
		int fit = Math.min(stock, room);
		Store l = w.store("ledger");
		JsonObject before = l.edit();
		JsonObject ls = l.edit();
		TxnCrashModel.addItems(ls, "stock", it("planks", fit), +1);
		TxnCrashModel.put(ls, "receipts", KEY);
		l.set(ls);
		if (stock > fit) {
			Store e = w.store("chunk:E");
			JsonObject es = e.edit();
			TxnCrashModel.addItems(es, "items", it("planks", stock - fit), +1);
			e.set(es);
		}
		w.kill("ADP1");
		TxnEnv.Barrier b = w.barrier();
		if (!b.ok() || l.inDoubt()) {
			l.mem = before; // restoreLedger: the in-memory rollback (the disk may hold the credit)
			w.notes.add("adp-restoreLedger");
			return;
		}
		w.kill("ADP2");
		Store c = w.store("chunk:C");
		JsonObject cs = c.edit();
		TxnCrashModel.addItems(cs, "items", it("planks", stock), -1);
		TxnCrashModel.restoreChunk(cs);
		c.set(cs);
		w.kill("ADP3");
		w.barrier();
		dropRecord(w.store("sites"));
		w.kill("SAC2");
	}

	/** back: the crate holds its stock, no key, the record kept; forward: credited, the cell restored, the record cleared; else torn. */
	static String outcome(World w, int stock) {
		Map<String, Integer> crate = TxnCrashModel.items(w.store("chunk:C").mem, "items");
		boolean key = TxnCrashModel.has(w.store("ledger").mem, "receipts", KEY);
		int inStock = TxnCrashModel.items(w.store("ledger").mem, "stock").getOrDefault("planks", 0);
		boolean restored = w.store("chunk:C").mem.has("restored");
		boolean record = w.store("sites").mem.getAsJsonObject("records").has("site:s4");
		if (crate.getOrDefault("planks", 0) == stock && !key && !restored && record && inStock == 0) {
			return "back";
		}
		if (crate.isEmpty() && key && restored && !record && inStock == stock) {
			return "forward";
		}
		return "torn: crate " + crate + ", key " + key + ", stock " + inStock + ", restored " + restored + ", record " + record;
	}

	static void line(String s) {
		System.out.println("TXN-ADOPT " + s);
	}

	Result explore(String name, Scenario sc, Naive naive, int depth) {
		Result r = m.explore(sc, naive, depth);
		line((r.clean() ? "GREEN " : "RED   ") + name + " [" + naive + "] " + r.schedules() + " schedules" + (r.clean() ? "" : ", " + r.violations().size()
			+ " violation(s); first: " + r.violations().get(0)));
		return r;
	}

	// ------------------------------------------------------------------ the recovery rows: back through PREPARED_DONE, forward from the decision

	@Test
	void everyKillPointRecoversBackThroughPreparedDoneAndForwardFromTheDecision() {
		Scenario sc = adopt(STOCK, 64);
		World clean = m.run(sc, Naive.NONE, Integer.MAX_VALUE);
		assertEquals("forward", outcome(clean, STOCK), "the uncrashed adoption");
		int points = clean.kills;
		Map<String, String> rows = new LinkedHashMap<>();
		List<String> wrong = new ArrayList<>();
		boolean decided = false;
		for (int c = 1; c <= points; c++) {
			World w = m.run(sc, Naive.NONE, c);
			String at = w.crashedAt;
			decided |= at.endsWith(":decided");
			String want = decided ? "forward" : "back";
			List<int[]> picks = TxnCrashModel.picks(w, TxnCrashModel.EXHAUSTIVE);
			java.util.Set<String> got = new java.util.TreeSet<>();
			for (int[] pick : picks) {
				World r = w.restart(pick);
				r.settle();
				String o = outcome(r, STOCK);
				got.add(o);
				if (!o.equals(want) || !r.core.open().isEmpty()) {
					wrong.add(at + " pick " + java.util.Arrays.toString(pick) + ": " + o + " (want " + want + ", open " + r.core.open().size() + ")");
				}
			}
			rows.put(at, String.join("|", got) + " x" + picks.size());
		}
		rows.forEach((k, v) -> line("row " + k + " -> " + v));
		assertTrue(rows.keySet().stream().anyMatch(k -> k.endsWith(":prepared")), "PREPARED_DONE is a traced point: " + rows.keySet());
		assertTrue(rows.keySet().stream().anyMatch(k -> k.endsWith(":decided")), "the decision is a traced point: " + rows.keySet());
		assertTrue(wrong.isEmpty(), wrong.size() + " wrong row(s), e.g. " + wrong.subList(0, Math.min(5, wrong.size())));
	}

	// ------------------------------------------------------------------ exhaustive: pile.adopt green, the legacy kinds red

	@Test
	void pileAdoptIsExactlyOnceAtEveryCrashAndVersionAndAdoptMainIsNot() {
		Result red = explore("adopt", adopt(STOCK, 64), Naive.ADOPT_MAIN, 2);
		assertFalse(red.clean(), "adopt-main must be found failing first (SAC1 with the restored crate chunk on disk, the ledger not)");
		Result green = explore("adopt", adopt(STOCK, 64), Naive.NONE, 2);
		assertTrue(green.clean(), green.violations().toString());
	}

	@Test
	void overflowEntersTheStockPastCapacityAndNeitherLegacyDropSurvivesACrash() {
		// 80 planks, room for 64: main and ADP drop 16 as entities (the entity chunk can reach the disk without the ledger: 2x)
		Scenario sc = adopt(80, 64);
		Result main = explore("adopt overflow", sc, Naive.ADOPT_MAIN, 1);
		assertTrue(main.violations().stream().anyMatch(v -> v.what().startsWith("conservation")), "adopt-main overflow mints or loses: " + main.violations());
		Result adp = explore("adopt overflow", sc, Naive.ADOPT_ADP, 1);
		assertTrue(adp.violations().stream().anyMatch(v -> v.what().startsWith("conservation")), "adopt-ADP overflow (P1-1) mints: " + adp.violations());
		Result green = explore("adopt overflow", sc, Naive.NONE, 2);
		assertTrue(green.clean(), green.violations().toString());
	}

	// ------------------------------------------------------------------ ADP P1-2: an IN_DOUBT credit, then a delivery into the crate

	@Test
	void anInDoubtCreditThenADeliveryNeverDrainsTheDeliveryAndTheTxnHoldsTheCrate() {
		for (Naive naive : List.of(Naive.ADOPT_ADP, Naive.NONE)) {
			World w = m.fresh(new Scenario() {
				@Override
				public void setup(World x) {
					adopt(STOCK, 64).setup(x);
					x.add("player:P", true, false, obj("inv", it("planks", 5)));
					x.add("txn", false, true, obj());
				}

				@Override
				public void op(World x) {
				}
			}, naive);
			Map<String, Long> baseline = TxnCrashModel.total(w);
			List<String> v = new ArrayList<>();
			if (naive == Naive.ADOPT_ADP) {
				w.store("ledger").doubtWrites = 1; // the credit's rename done, its folder force failed
				adp(w, STOCK, 64);
				assertTrue(w.notes.contains("adp-restoreLedger"), "ADP rolled the credit back in memory");
			} else {
				w.store("txn").doubtAt = 3; // intent, prepared, then the decision: renamed, its folder force failed
				pileAdopt(w, STOCK);
				assertFalse(w.core.open().isEmpty(), "the txn holds on an IN_DOUBT decision, never compensated");
			}
			// a player's delivery of 5 planks into the crate (a hopper, the feed's draw, Insert from inventory)
			TxnCore.Started d = w.core.begin("move", null, List.of("crate:C", "player:P"), null);
			if (d.status() == TxnCore.Begin.NEW) {
				deliver(w);
			} else if (naive == Naive.ADOPT_ADP) {
				v.add("ADP: the delivery was refused (" + d.status() + "): the model's precondition broke");
			}
			if (naive == Naive.NONE && d.status() != TxnCore.Begin.HELD) {
				v.add("the delivery into an adopting crate was not refused held(other): " + d.status());
			}
			// an autosave of the chunks and players (not the ledger), then the process stops; the restart's re-force of txn.json fails once
			w.store("chunk:C").save();
			w.store("player:P").save();
			w.store("txn").confirmFails = 1;
			World r = w.restart(new int[w.stores.size()]);
			if (naive == Naive.NONE) {
				TxnCore.Started d2 = r.core.begin("move", null, List.of("crate:C", "player:P"), null);
				if (!r.core.open().isEmpty() && d2.status() != TxnCore.Begin.HELD) {
					v.add("after the restart the held adoption did not refuse the delivery: " + d2.status());
				}
			}
			r.settle();
			v.addAll(TxnCrashModelTest.conserve(r, baseline));
			if (!r.core.open().isEmpty()) {
				v.add("liveness: " + r.core.state().get("open"));
			}
			line((v.isEmpty() ? "GREEN " : "RED   ") + "in-doubt credit then delivery [" + naive + "] scripted" + (v.isEmpty() ? "" : ": " + v));
			assertEquals(naive == Naive.NONE, v.isEmpty(), v.toString());
		}
	}

	static void deliver(World w) {
		Store p = w.store("player:P");
		JsonObject ps = p.edit();
		TxnCrashModel.addItems(ps, "inv", it("planks", 5), -1);
		p.set(ps);
		Store c = w.store("chunk:C");
		JsonObject cs = c.edit();
		TxnCrashModel.addItems(cs, "items", it("planks", 5), +1);
		c.set(cs);
	}

	// ------------------------------------------------------------------ the intent refused (JOURNAL_UNAVAILABLE): nothing touched

	@Test
	void aRefusedIntentTouchesNothing() {
		World w = m.fresh(adopt(STOCK, 64), Naive.NONE);
		w.add("txn", false, true, obj());
		w.store("txn").failWrites = 1;
		TxnEntry t = begin(w, "pile.adopt", null, "pile:A", "crate:C", "site:s4");
		w.core.plan(t, fx("take", EffectClass.B, "chunk:C", it("planks", STOCK), "crate", Effect.TRANSIT).prepare());
		assertEquals(Outcome.REFUSED, w.core.persist(t));
		w.settle();
		assertEquals("back", outcome(w, STOCK));
		line("GREEN intent refused [NONE] scripted: nothing touched, open " + w.core.open().size());
	}
}
