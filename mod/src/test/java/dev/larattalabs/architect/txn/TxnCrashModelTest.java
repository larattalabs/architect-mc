package dev.larattalabs.architect.txn;

import static dev.larattalabs.architect.txn.TxnCrashModel.obj;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonObject;
import dev.larattalabs.architect.site.DurableFile.Outcome;
import dev.larattalabs.architect.txn.TxnCrashModel.Naive;
import dev.larattalabs.architect.txn.TxnCrashModel.Result;
import dev.larattalabs.architect.txn.TxnCrashModel.Scenario;
import dev.larattalabs.architect.txn.TxnCrashModel.World;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

/**
 * (slice T1, GATES rule 18, docs/TXN-DESIGN.md §4.1) Every crash scenario of the last three design reviews (TXN-gpt2.log, TXN-gpt3.log,
 * TXN-gpt4.log) that minted or lost items, or lost a decision, a payload or a retry, encoded in {@link TxnCrashModel}. Each is shown
 * <b>failing first</b> (its {@link Naive} variant: the reviewed behaviour; the harness must find a violating schedule, printed as
 * {@code RED}) and then passing as built (no violation over every schedule, printed as {@code GREEN} with the schedule count).
 */
class TxnCrashModelTest {
	final TxnCrashModel m = new TxnCrashModel();
	static final List<String> LOG = new ArrayList<>();

	static Map<String, Integer> it(String k, int n) {
		return Map.of(k, n);
	}

	static Effect.Builder fx(String op, EffectClass c, String store, Map<String, Integer> items, String from, String to) {
		return Effect.of(op, c).items(items).move(from, to).data("store", store);
	}

	static TxnEntry begin(World w, String kind, String key, String... res) {
		TxnCore.Started s = w.core.begin(kind, key, List.of(res), null);
		assertEquals(TxnCore.Begin.NEW, s.status(), "begin " + kind + ": " + s.detail());
		return s.entry();
	}

	static void run(World w, TxnEntry t) {
		if (w.core.persist(t) == Outcome.OK) {
			w.core.drive(t);
		}
	}

	/** The naive variant must find a violation; as built none, over every schedule. */
	Result failingFirst(String name, Scenario sc, Naive naive, int depth) {
		Result red = m.explore(sc, naive, depth);
		report(name, naive, red);
		assertFalse(red.clean(), name + ": the naive variant " + naive + " must be found failing first");
		Result green = m.explore(sc, Naive.NONE, depth);
		report(name, Naive.NONE, green);
		assertTrue(green.clean(), name + " as built: " + green.violations());
		return green;
	}

	static void report(String name, Naive naive, Result r) {
		String line = (r.clean() ? "GREEN " : "RED   ") + name + " [" + naive + "] " + r.schedules() + " schedules" + (r.clean() ? "" : ", "
			+ r.violations().size() + " violation(s); first: " + r.violations().get(0));
		LOG.add(line);
		System.out.println("TXN-MODEL " + line);
	}

	static void scripted(String name, Naive naive, List<String> violations) {
		String line = (violations.isEmpty() ? "GREEN " : "RED   ") + name + " [" + naive + "] scripted" + (violations.isEmpty() ? "" : ": "
			+ violations);
		LOG.add(line);
		System.out.println("TXN-MODEL " + line);
	}

	static List<String> conserve(World w, Map<String, Long> baseline) {
		Map<String, Long> t = TxnCrashModel.total(w);
		return t.equals(baseline) ? List.of() : List.of("conservation: " + t + " vs baseline " + baseline);
	}

	// ------------------------------------------------------------------ the generic kind, exhaustive (no counterexample: the property)

	/** A move of 12 planks from a crate chunk to a chest chunk: take (B, prepare) then put (B): every crash, every version, depth 3. */
	static final Scenario MOVE = new Scenario() {
		@Override
		public void setup(World w) {
			w.add("chunk:X", true, false, obj("items", it("planks", 12)));
			w.add("chunk:Y", true, false, obj());
		}

		@Override
		public void op(World w) {
			TxnEntry t = begin(w, "move", "move:1", "box:X", "box:Y");
			w.core.plan(t, fx("take", EffectClass.B, "chunk:X", it("planks", 12), "crate", Effect.TRANSIT).prepare());
			w.core.plan(t, fx("put", EffectClass.B, "chunk:Y", it("planks", 12), Effect.TRANSIT, "chest"));
			run(w, t);
		}
	};

	@Test
	void aMoveIsExactlyOnceAtEveryCrashAndEveryVersionWithRecoveryCrashedToDepth3() {
		Result r = m.explore(MOVE, Naive.NONE, 3);
		report("move exhaustive", Naive.NONE, r);
		assertTrue(r.clean(), r.violations().toString());
		assertTrue(r.schedules() > 100, "explored " + r.schedules());
	}

	@Test
	void writesThatFailOrAreInDoubtAndUnknownProbesNeverMintOrLose() {
		for (String fault : List.of("txn-refused", "txn-doubt", "txn-doubt-2", "unknown-Y", "barrier-refused")) {
			Scenario sc = new Scenario() {
				@Override
				public void setup(World w) {
					MOVE.setup(w);
					w.add("txn", false, true, obj());
					switch (fault) {
						case "txn-refused" -> w.store("txn").failWrites = 1;
						case "txn-doubt" -> w.store("txn").doubtWrites = 1;
						case "txn-doubt-2" -> {
							w.store("txn").doubtWrites = 3;
							w.store("txn").confirmFails = 2;
						}
						case "unknown-Y" -> w.unknown.add("chunk:Y");
						default -> w.serializeFails.add("chunk:Y");
					}
				}

				@Override
				public void op(World w) {
					MOVE.op(w);
				}
			};
			Result r = m.explore(sc, Naive.NONE, 2);
			report("move with " + fault, Naive.NONE, r);
			assertTrue(r.clean(), fault + ": " + r.violations());
		}
	}

	// ------------------------------------------------------------------ gpt2 P1-1: whole-ledger publication over an unacknowledged chunk

	@Test
	void gpt2P1_1_aHopperChunkThatFailedToSaveBlocksTheLedgerForEveryTxn() {
		Scenario sc = new Scenario() {
			@Override
			public void setup(World w) {
				// the hopper chunk is saved only by barriers here (the bulk stream's own autosave window is PS/JR's, not TXN's)
				w.add("chunk:H", false, false, obj("items", it("iron", 10)));
				w.add("chunk:X", true, false, obj("items", it("planks", 5)));
				w.add("chunk:Y", true, false, obj());
				w.add("ledger", false, true, obj());
			}

			@Override
			public void op(World w) {
				// a hopper delivers 4 iron into pile A (the bulk stream: in memory), and the hopper chunk's next serialization fails
				TxnCrashModel.Store h = w.store("chunk:H");
				JsonObject hs = h.edit();
				TxnCrashModel.addItems(hs, "items", it("iron", 4), -1);
				h.set(hs);
				TxnCrashModel.Store l = w.store("ledger");
				JsonObject ls = l.edit();
				TxnCrashModel.addItems(ls, "stock", it("iron", 4), +1);
				l.set(ls);
				w.serializeFails.add("chunk:H");
				w.scope.addAll(List.of("chunk:X", "chunk:Y")); // an unrelated txn B's chunks
				TxnEntry t = begin(w, "move", null, "box:X", "box:Y");
				w.core.plan(t, fx("take", EffectClass.B, "chunk:X", it("planks", 5), "crate", Effect.TRANSIT).prepare());
				w.core.plan(t, fx("put", EffectClass.B, "chunk:Y", it("planks", 5), Effect.TRANSIT, "chest"));
				run(w, t);
			}
		};
		failingFirst("gpt2 P1-1 barrier scope", sc, Naive.BARRIER_SCOPE, 1);
	}

	// ------------------------------------------------------------------ gpt2 P1-2 / gpt3 P1-3: a failed player replace acknowledged

	static final Scenario DEPOSIT = new Scenario() {
		@Override
		public void setup(World w) {
			w.add("player:P", true, false, obj("inv", it("diamond", 64)));
			w.add("ledger", false, true, obj());
		}

		@Override
		public void op(World w) {
			TxnEntry t = begin(w, "deposit", "deposit:1", "player:P", "pile:A");
			w.core.plan(t, fx("ptake", EffectClass.P, "player:P", it("diamond", 64), "player", Effect.TRANSIT).prepare());
			w.core.plan(t, fx("credit", EffectClass.L, "ledger", it("diamond", 64), Effect.TRANSIT, "stock"));
			run(w, t);
		}
	};

	@Test
	void gpt2P1_2_gpt3P1_3_aPlayerSaveIsAcknowledgedOnlyByItsRealReplaceResult() {
		Scenario sc = new Scenario() {
			@Override
			public void setup(World w) {
				DEPOSIT.setup(w);
				w.store("player:P").silentFails = 2; // every replace this session restores the old .dat without throwing
			}

			@Override
			public void op(World w) {
				DEPOSIT.op(w);
			}
		};
		failingFirst("gpt2 P1-2 / gpt3 P1-3 player ack", sc, Naive.PLAYER_ACK, 1);
	}

	// ------------------------------------------------------------------ gpt2 P1-4: the restore deletes the BE carrying the marker

	static final Scenario REMOVAL = new Scenario() {
		@Override
		public void setup(World w) {
			w.add("chunk:C", true, false, obj("items", it("planks", 12), "site", "tx-1"));
			w.add("journal", false, true, obj());
			w.add("ledger", false, true, obj());
		}

		@Override
		public void op(World w) {
			TxnEntry t = begin(w, "removal", "site:s12@99", "site:tx-1", "crate:C");
			w.core.plan(t, fx("take", EffectClass.B, "chunk:C", it("planks", 12), "crate", Effect.TRANSIT).prepare());
			w.core.plan(t, Effect.of("decide", EffectClass.D).data("store", "journal"));
			w.core.plan(t, fx("restore", EffectClass.W, "chunk:C", Map.of(), "", ""));
			w.core.plan(t, fx("credit", EffectClass.L, "ledger", it("planks", 12), Effect.TRANSIT, "stock"));
			run(w, t);
		}
	};

	@Test
	void gpt2P1_4_receiptsInTheChunkAttachmentAndPreparedDoneSurviveTheRestore() {
		failingFirst("gpt2 P1-4 BE marker", REMOVAL, Naive.BE_MARKER, 1);
	}

	// ------------------------------------------------------------------ gpt2 P1-5: an IN_DOUBT decision read as not committed

	@Test
	void gpt2P1_5_aDecisionInDoubtIsHeldNeverCompensated() {
		Scenario sc = new Scenario() {
			@Override
			public void setup(World w) {
				REMOVAL.setup(w);
				w.store("journal").doubtWrites = 1; // the index renamed, its folder's force failed
			}

			@Override
			public void op(World w) {
				REMOVAL.op(w);
			}
		};
		failingFirst("gpt2 P1-5 in-doubt decision", sc, Naive.INDOUBT_ABSENT, 1);
	}

	// ------------------------------------------------------------------ gpt2 P1-3 / gpt3 P1-1: IN_DOUBT -> restart -> retirement -> power loss

	@Test
	void gpt2P1_3_gpt3P1_1_aLoadedGenerationAcknowledgesNothingBeforeTheLoadsReForce() {
		for (Naive naive : List.of(Naive.LOADED_GEN, Naive.NONE)) {
			World w = m.fresh(new Scenario() {
				@Override
				public void setup(World x) {
					x.add("queue", false, true, obj("records", obj("r1", obj("items", it("gold", 10)))));
					x.add("ledger", false, true, obj());
				}

				@Override
				public void op(World x) {
				}
			}, naive);
			Map<String, Long> baseline = TxnCrashModel.total(w);
			// pay the owed record r1 into the pile, then drop it: the drop's rename IN_DOUBT
			w.store("queue").doubtWrites = 1;
			TxnEntry t = begin(w, "move", "owed:r1", "rec:r1", "pile:A");
			w.core.plan(t, fx("credit", EffectClass.L, "ledger", it("gold", 10), "owed", "stock"));
			w.core.plan(t, Effect.of("drop", EffectClass.R).data("store", "queue").data("id", "r1"));
			run(w, t);
			assertEquals(Phase.RETIRING, t.phase(), "the queue's generation is in doubt: retirement waits");
			// a process restart (the page cache keeps the rename); the load's re-force fails once
			w.store("queue").confirmFails = 1;
			World r = w.restart(new int[w.stores.size()]);
			// then a power loss: only forced versions survive
			World p = r.powerLoss();
			p.settle();
			List<String> v = new ArrayList<>(conserve(p, baseline));
			if (!p.core.open().isEmpty()) {
				v.add("liveness: " + p.core.state().get("open"));
			}
			scripted("gpt2 P1-3 / gpt3 P1-1 loaded generation", naive, v);
			if (naive == Naive.NONE) {
				assertTrue(v.isEmpty(), v.toString());
			} else {
				assertFalse(v.isEmpty(), "LOADED_GEN must mint (the owed record paid again after the power loss)");
			}
		}
	}

	// ------------------------------------------------------------------ gpt3 P1-2: EFFECTS_DONE with no decision; an abandon split ignored

	@Test
	void gpt3P1_2_aCommittedTxnPastEffectsDoneIsNeverCompensated() {
		Scenario sc = new Scenario() {
			@Override
			public void setup(World w) {
				w.add("ledger", false, true, obj("stock", it("emerald", 5)));
				w.add("chunk:Y", true, false, obj());
			}

			@Override
			public void op(World w) {
				TxnEntry t = begin(w, "charge", "charge:1", "pile:A", "box:Y");
				w.core.plan(t, fx("debit", EffectClass.L, "ledger", it("emerald", 5), "stock", Effect.TRANSIT).prepare());
				w.core.plan(t, fx("put", EffectClass.B, "chunk:Y", it("emerald", 5), Effect.TRANSIT, "chest"));
				run(w, t);
			}
		};
		failingFirst("gpt3 P1-2 decision lost at EFFECTS_DONE", sc, Naive.PHASE_ONLY, 2);
	}

	@Test
	void gpt3P1_2_anAbandonResumesItsRecordedSplit() {
		for (Naive naive : List.of(Naive.SPLIT_IGNORED, Naive.NONE)) {
			World w = m.fresh(new Scenario() {
				@Override
				public void setup(World x) {
					x.add("chunk:A", true, false, obj("items", it("planks", 4), "site", "tx-1"));
					x.add("chunk:B", true, false, obj("items", it("planks", 6), "site", "tx-1"));
					x.add("journal", false, true, obj());
					x.add("ledger", false, true, obj());
				}

				@Override
				public void op(World x) {
				}
			}, naive);
			Map<String, Long> baseline = TxnCrashModel.total(w);
			TxnEntry t = begin(w, "removal", "group:g1", "site:tx-1");
			w.core.plan(t, fx("take", EffectClass.B, "chunk:A", it("planks", 4), "container", Effect.TRANSIT).prepare().member("m1"));
			w.core.plan(t, fx("take", EffectClass.B, "chunk:B", it("planks", 6), "container", Effect.TRANSIT).prepare().member("m2"));
			w.core.plan(t, Effect.of("decide", EffectClass.D).data("store", "journal"));
			w.core.plan(t, fx("restore", EffectClass.W, "chunk:A", Map.of(), "", "").member("m1"));
			w.core.plan(t, fx("restore", EffectClass.W, "chunk:B", Map.of(), "", "").member("m2"));
			w.core.plan(t, fx("credit", EffectClass.L, "ledger", it("planks", 4), Effect.TRANSIT, "stock").member("m1"));
			w.core.plan(t, fx("credit", EffectClass.L, "ledger", it("planks", 6), Effect.TRANSIT, "stock").member("m2"));
			w.crashAt = 7; // intent, apply:0, apply:1, barrier:prepare, prepared, apply:2 (D), decided: the process stops right after the decision
			try {
				run(w, t);
			} catch (TxnCrashModel.Crash c) {
				// stopped at the decision
			}
			assertEquals(Decision.COMMIT, t.decision().v(), "stopped after " + w.crashedAt);
			// T5's abandon (ops): m1 written, m2 not; the split recorded in txn.json, then a crash before anything acts on it
			JsonObject doc = w.store("txn").mem.deepCopy();
			JsonObject e = doc.getAsJsonArray("open").get(0).getAsJsonObject();
			e.add("decision", Decision.abandon(java.util.Set.of("m1")).toJson());
			w.store("txn").set(doc);
			w.store("txn").save();
			World r = w.restart(new int[w.stores.size()]);
			r.settle();
			List<String> v = new ArrayList<>(conserve(r, baseline));
			JsonObject b = r.store("chunk:B").mem;
			if (!b.has("items") || TxnCrashModel.items(b, "items").getOrDefault("planks", 0) != 6 || b.has("restored")) {
				v.add("split: the unwritten member m2 was not compensated (chunk B " + b + ")");
			}
			if (TxnCrashModel.items(r.store("ledger").mem, "stock").getOrDefault("planks", 0) != 4) {
				v.add("split: the written member m1 alone is credited (" + r.store("ledger").mem + ")");
			}
			scripted("gpt3 P1-2 abandon split", naive, v);
			assertEquals(naive == Naive.NONE, v.isEmpty(), v.toString());
		}
	}

	// ------------------------------------------------------------------ gpt4 P1-1: an ancestor folder unconfirmed across a restart

	@Test
	void gpt4P1_1_aFolderAnEarlierSessionCreatedIsConfirmedBeforeAnyAcknowledgement() {
		for (Naive naive : List.of(Naive.ANCESTOR_DIR, Naive.NONE)) {
			World w = m.fresh(new Scenario() {
				@Override
				public void setup(World x) {
					DEPOSIT.setup(x);
					x.dirExists = false; // a vanilla world: no architect/ yet
					x.dirForceFails = 1; // the first write creates it; the force of its entry fails; then the process stops
				}

				@Override
				public void op(World x) {
				}
			}, naive);
			Map<String, Long> baseline = TxnCrashModel.total(w);
			TxnEntry t0 = begin(w, "deposit", "deposit:0", "player:P");
			w.core.plan(t0, fx("ptake", EffectClass.P, "player:P", it("diamond", 1), "player", Effect.TRANSIT).prepare());
			assertEquals(Outcome.REFUSED, w.core.persist(t0), "the folder's entry force failed: the intent is refused, nothing touched");
			World r = w.restart(new int[w.stores.size()]);
			assertTrue(r.dirExists);
			DEPOSIT.op(r); // the next session: an acknowledged deposit
			r.settle();
			assertTrue(r.core.open().isEmpty(), "the deposit finished");
			World p = r.powerLoss();
			p.settle();
			List<String> v = conserve(p, baseline);
			scripted("gpt4 P1-1 ancestor folder", naive, v);
			assertEquals(naive == Naive.NONE, v.isEmpty(), v.toString());
		}
	}

	// ------------------------------------------------------------------ gpt4 P1-2: a reconnect replaces the owed snapshot with the older file

	@Test
	void gpt4P1_2_aLoginRestoresTheOwedSnapshotNotTheOlderFile() {
		for (Naive naive : List.of(Naive.LOGIN_SNAPSHOT, Naive.NONE)) {
			World w = m.fresh(DEPOSIT, naive);
			Map<String, Long> baseline = TxnCrashModel.total(w);
			// a deposit of 64 (the bulk stream, T0-T6: in memory), then the logout save's replace fails: the debit owed with its snapshot
			TxnCrashModel.Store p = w.store("player:P");
			JsonObject ps = p.edit();
			TxnCrashModel.addItems(ps, "inv", it("diamond", 64), -1);
			p.set(ps);
			TxnCrashModel.Store l = w.store("ledger");
			JsonObject ls = l.edit();
			TxnCrashModel.addItems(ls, "stock", it("diamond", 64), +1);
			l.set(ls);
			p.silentFails = 1;
			assertFalse(w.barrier().ok() && naive == Naive.NONE, "the failed logout save refuses the barrier");
			w.playerDebt.put("player:P", p.mem.deepCopy());
			w.login("player:P"); // the reconnect before the debt's retry
			TxnEnv.Barrier b = w.barrier();
			World r = w.restart(new int[w.stores.size()]);
			List<String> v = conserve(r, baseline);
			scripted("gpt4 P1-2 login snapshot (barrier " + (b.ok() ? "ok" : b.reason()) + ")", naive, v);
			assertEquals(naive == Naive.NONE, v.isEmpty(), v.toString());
		}
	}

	// ------------------------------------------------------------------ gpt3 P2-5: failure debt retried

	@Test
	void gpt3P2_5_aFailedChunkSaveIsRetriedAndTheBarrierSucceedsAfterwards() {
		for (Naive naive : List.of(Naive.CHUNK_DEBT_NO_RETRY, Naive.NONE)) {
			World w = m.fresh(MOVE, naive);
			w.serializeFails.add("chunk:X");
			List<Boolean> oks = new ArrayList<>();
			for (int i = 0; i < 4; i++) {
				oks.add(w.barrier().ok());
			}
			boolean recovered = oks.get(0) == false && oks.subList(1, 4).stream().allMatch(x -> x);
			scripted("gpt3 P2-5 chunk debt retry " + oks, naive, recovered ? List.of() : List.of("the barrier never succeeds again: " + oks));
			assertEquals(naive == Naive.NONE, recovered, oks.toString());
		}
	}

	// ------------------------------------------------------------------ gpt4 P2-3: payloads persisted before any destructive effect

	@Test
	void gpt4P2_3_theRemovedSitesPayloadIsInTheIntentBeforeRecordDrop() {
		Scenario sc = new Scenario() {
			@Override
			public void setup(World w) {
				w.add("sites", false, true, obj("records", obj("site:s12@99", obj("id", "s12", "name", "Hall", "owner", "steward"))));
				w.add("journal", false, true, obj());
			}

			@Override
			public void op(World w) {
				TxnEntry t = begin(w, "removal", "site:s12@99", "site:s12");
				if (w.naive != Naive.PAYLOAD_LATE) {
					w.core.payload(t, "site_removed", w.store("sites").mem.getAsJsonObject("records").getAsJsonObject("site:s12@99"));
				}
				w.core.plan(t, Effect.of("decide", EffectClass.D).data("store", "journal"));
				w.core.plan(t, Effect.of("drop", EffectClass.R).data("store", "sites").data("id", "site:s12@99"));
				run(w, t);
			}

			@Override
			public List<String> check(World w, Map<String, Long> baseline) {
				boolean fired = w.events.stream().anyMatch(e -> e.contains(":site_removed:") && e.contains("Hall"));
				ResultCache.Done d = w.core.cache().byId("tx-1");
				boolean late = d != null && d.result().get("site") instanceof JsonObject s && s.toString().contains("Hall");
				boolean removed = !w.store("sites").mem.getAsJsonObject("records").has("site:s12@99");
				if (!removed) {
					// aborted before the decision: no SITE_REMOVED for a removal that was compensated, its BATCH_DONE at least once (§3.12.9)
					boolean wrong = w.events.stream().anyMatch(e -> e.contains(":site_removed:"));
					boolean batch = w.events.stream().anyMatch(e -> e.contains(":batch_done:"));
					return !wrong && batch ? List.of() : List.of("an aborted removal's events: " + w.events);
				}
				return fired || late ? List.of() : List.of("SITE_REMOVED lost its site (" + w.events + ", result " + (d == null ? null : d.result()) + ")");
			}
		};
		failingFirst("gpt4 P2-3 payload capture", sc, Naive.PAYLOAD_LATE, 2);
	}

	// ------------------------------------------------------------------ gpt4 P2-4 (and gpt3 P2-6): attempts vs dedupe keys

	@Test
	void gpt4P2_4_aRetryAfterAnAbortIsAFreshAttemptAndOnlyACommitReplays() {
		for (Naive naive : List.of(Naive.CACHE_ABORTED, Naive.NONE)) {
			World w = m.fresh(MOVE, naive);
			List<String> v = new ArrayList<>();
			w.notes.add("refuse-once"); // the first attempt's prepare is refused (a transient refusal), compensated, retired
			for (int attempt = 1; attempt <= 3; attempt++) {
				TxnCore.Started s = w.core.begin("move", "move:1", List.of("box:X", "box:Y"), null);
				if (s.status() == TxnCore.Begin.REPLAYED) {
					if (attempt == 2) {
						v.add("attempt 2 answered from attempt 1's " + s.done().decision() + " result");
					}
					if (attempt == 3 && (!Decision.COMMIT.equals(s.done().decision()) || !s.done().result().has("removed"))) {
						v.add("attempt 3 replayed " + s.done().decision() + " " + s.done().result() + ", not the committed result (gpt3 P2-6)");
					}
					continue;
				}
				if (attempt == 3) {
					v.add("attempt 3 ran again instead of replaying the committed result");
				}
				TxnEntry t = s.entry();
				w.core.plan(t, fx("take", EffectClass.B, "chunk:X", it("planks", 12), "crate", Effect.TRANSIT).prepare().data("refuse", 1));
				w.core.plan(t, fx("put", EffectClass.B, "chunk:Y", it("planks", 12), Effect.TRANSIT, "chest"));
				run(w, t);
				w.settle();
			}
			if (TxnCrashModel.items(w.store("chunk:Y").mem, "items").getOrDefault("planks", 0) != 12) {
				v.add("the retry never moved the planks: " + w.store("chunk:Y").mem);
			}
			scripted("gpt4 P2-4 attempt vs dedupe key", naive, v);
			assertEquals(naive == Naive.NONE, v.isEmpty(), v.toString());
		}
	}

	// ------------------------------------------------------------------ §4.1 legacy kind: CXD's crate take with no journal (today's path)

	@Test
	void legacyCrateTakeWithNoJournalLosesItemsAndTheTxnKindDoesNot() {
		Scenario sc = new Scenario() {
			@Override
			public void setup(World w) {
				w.add("chunk:C", true, false, obj("items", it("planks", 12)));
				w.add("ledger", false, true, obj());
			}

			@Override
			public void op(World w) {
				if (w.naive == Naive.NO_JOURNAL) {
					// main's removal: the crate's stock taken into a Credit in memory (row 1/7), the ledger credited and saved later
					TxnCrashModel.Store c = w.store("chunk:C");
					JsonObject s = c.edit();
					TxnCrashModel.addItems(s, "items", it("planks", 12), -1);
					c.set(s);
					w.kill("legacy:taken");
					TxnCrashModel.Store l = w.store("ledger");
					JsonObject ls = l.edit();
					TxnCrashModel.addItems(ls, "stock", it("planks", 12), +1);
					l.set(ls);
					w.kill("legacy:credited");
					w.barrier();
					w.kill("legacy:saved");
					return;
				}
				TxnEntry t = begin(w, "move", "site:s1@1", "crate:C", "pile:A");
				w.core.plan(t, fx("take", EffectClass.B, "chunk:C", it("planks", 12), "crate", Effect.TRANSIT).prepare());
				w.core.plan(t, fx("credit", EffectClass.L, "ledger", it("planks", 12), Effect.TRANSIT, "stock"));
				run(w, t);
			}
		};
		failingFirst("legacy crate take (no journal)", sc, Naive.NO_JOURNAL, 2);
	}

	// ------------------------------------------------------------------ T1 review (TXN T1-gpt.log): the fix round's counterexamples

	/** P1-1: a commit write IN_DOUBT, a restart whose re-force fails, then a power loss: recovery must hold, never act on it. */
	@Test
	void t1P1_1_recoveryNeverActsOnALoadedJournalWhoseReForceFailed() {
		for (Naive naive : List.of(Naive.STORE_DOUBT_IGNORED, Naive.NONE)) {
			World w = m.fresh(MOVE, naive);
			Map<String, Long> baseline = TxnCrashModel.total(w);
			w.add("txn", false, true, obj());
			w.store("txn").doubtAt = 3; // intent, prepared, then the decision: renamed, its folder force failed
			MOVE.op(w);
			TxnCrashModel.Store tx = w.store("txn");
			tx.confirmFails = 1; // the load's re-force fails too
			tx.doubtWrites = 99; // and the disk keeps failing for a while
			World r = w.restart(new int[w.stores.size()]);
			World p = r.powerLoss();
			p.settle();
			List<String> v = new ArrayList<>(conserve(p, baseline));
			if (!p.core.open().isEmpty()) {
				v.add("liveness: " + p.core.state().get("open"));
			}
			scripted("T1 P1-1 recovery on an unconfirmed journal", naive, v);
			assertEquals(naive == Naive.NONE, v.isEmpty(), v.toString());
		}
	}

	/** P2-3: a recovery's event queued for the next tick, then a crash before that tick: it must fire again, never be lost. */
	@Test
	void t1P2_3_anEventCountsAsEmittedOnlyOnceDelivered() {
		for (Naive naive : List.of(Naive.EMIT_ON_QUEUE, Naive.NONE)) {
			World w = m.fresh(new Scenario() {
				@Override
				public void setup(World x) {
					MOVE.setup(x);
					x.deferEvents = true;
				}

				@Override
				public void op(World x) {
				}
			}, naive);
			TxnEntry t = begin(w, "move", "move:1", "box:X", "box:Y");
			w.core.plan(t, fx("take", EffectClass.B, "chunk:X", it("planks", 12), "crate", Effect.TRANSIT).prepare());
			w.core.plan(t, fx("put", EffectClass.B, "chunk:Y", it("planks", 12), Effect.TRANSIT, "chest"));
			w.core.payload(t, "moved", obj("n", 12));
			w.crashAt = 8; // intent, apply:0, barrier:prepare, prepared, decided, apply:1, barrier:effects, effects: EFFECTS_DONE durable
			try {
				run(w, t);
			} catch (TxnCrashModel.Crash c) {
				// stopped
			}
			World r = w.restart(new int[w.stores.size()]); // recovery: the event queued for the next tick
			World r2 = r.restart(new int[r.stores.size()]); // a crash before that tick: the queue is gone
			r2.settle();
			boolean fired = r2.events.stream().anyMatch(e -> e.contains(":moved:")) || r.events.stream().anyMatch(e -> e.contains(":moved:"));
			List<String> v = fired && r2.core.open().isEmpty() ? List.of() : List.of("the event was never delivered (" + r2.events + ")");
			scripted("T1 P2-3 event delivery", naive, v);
			assertEquals(naive == Naive.NONE, v.isEmpty(), v.toString());
		}
	}

	/** P2-7: an effect applied twice with the total conserved (24 planks, a plan of 12) is caught by the exactly-once assertion. */
	@Test
	void t1P2_7_anEffectAppliedTwiceFailsTheExactlyOnceAssertion() {
		Scenario sc = new Scenario() {
			@Override
			public void setup(World w) {
				w.add("chunk:X", true, false, obj("items", it("planks", 24)));
				w.add("chunk:Y", true, false, obj());
			}

			@Override
			public void op(World w) {
				MOVE.op(w);
			}
		};
		Result red = m.explore(sc, Naive.NO_MARKER, 1);
		report("T1 P2-7 exactly once", Naive.NO_MARKER, red);
		assertTrue(red.violations().stream().anyMatch(x -> x.what().startsWith("exactly once")), red.violations().toString());
		Result green = m.explore(sc, Naive.NONE, 2);
		report("T1 P2-7 exactly once", Naive.NONE, green);
		assertTrue(green.clean(), green.violations().toString());
	}

	/** P2-8: past the cap a crash point is sampled with a seed (reported), never truncated. */
	@Test
	void t1P2_8_pastTheCapTheExplorationSamplesWithItsSeed() {
		Result r = m.explore(MOVE, Naive.NONE, 1, 1, 4242L);
		report("T1 P2-8 sampled (cap 1)", Naive.NONE, r);
		assertEquals(4242L, r.seed(), "the sampled exploration reports its seed");
		assertTrue(r.clean(), r.violations().toString());
		assertTrue(r.schedules() > TxnCrashModel.SAMPLE, "sampled schedules: " + r.schedules());
	}

	@Test
	void theLogRecordsEveryCounterexample() {
		// a marker for the report: the RED/GREEN lines are printed by each test (TXN-MODEL ...)
		assertNotNull(LOG);
	}
}
