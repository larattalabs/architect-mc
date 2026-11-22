package dev.larattalabs.architect.site;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonObject;
import dev.larattalabs.architect.api.OwedPart;
import dev.larattalabs.architect.api.RemoveResult;
import dev.larattalabs.architect.txn.CrateTxn;
import dev.larattalabs.architect.txn.Effect;
import dev.larattalabs.architect.txn.EffectClass;
import dev.larattalabs.architect.txn.RemovalTxn;
import dev.larattalabs.architect.txn.TxnCore;
import dev.larattalabs.architect.txn.TxnEntry;
import dev.larattalabs.architect.txn.TxnKind;
import java.lang.reflect.Method;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import net.minecraft.SharedConstants;
import net.minecraft.server.Bootstrap;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * (REL-v0910 fix round, P2-1; row RELF-owed-parts) Ported from the release reviewer's {@code Rel0910ApiProbe}. A group's {@code removal.group}
 * txn owes a member's player blocks (2 sponges to {@code p}) in an O effect. Red at 68d2b065: the group's future maps through the eight-argument
 * {@code RemoveResult} (owed keys, no owed parts), {@code Groups.Removed} has no parts to carry, and a revision undo's aggregate keeps refund
 * and counts only. The rule now: every group, stage, region and revision result carries its owed parts, built by the one rule the aggregate
 * snapshot uses (an O effect's applied amount), so the future, the REMOVAL_FINISHED and {@code removalResult} agree.
 */
class RelFixOwedPartsTest {
	static final String GKEY = "group:g1@u1";
	static final String OKEY = "player:" + GKEY + "/m:p";

	@TempDir
	Path tmp;

	@BeforeAll
	static void boot() {
		SharedConstants.tryDetectVersion();
		Bootstrap.bootStrap();
	}

	@BeforeEach
	void setUp() throws Exception {
		Stockpiles.loadFrom(Files.createDirectories(tmp.resolve("world")));
		OwnerRemovals.read(null, null);
	}

	@AfterEach
	void reset() {
		OwnerRemovals.read(null, null);
	}

	static TxnKind groupKind() {
		return new TxnKind() {
			@Override
			public String name() {
				return RemovalTxn.GROUP;
			}

			@Override
			public int kv() {
				return 1;
			}

			@Override
			public Adapter adapter(Effect e) {
				return new Adapter() {
					@Override
					public dev.larattalabs.architect.txn.Probe probe(TxnEntry t, Effect f) {
						return dev.larattalabs.architect.txn.Probe.ABSENT;
					}

					@Override
					public void apply(TxnEntry t, Effect f) {
					}

					@Override
					public void compensate(TxnEntry t, Effect f) {
					}
				};
			}
		};
	}

	/** The group's txn with one applied player_blocks OWE (its amount recorded with its marker, as CrateTxn's OWE apply records it). */
	static TxnEntry owingTxn() {
		TxnCore c = new TxnCore(new RelFixOwnAttemptTest.Env()).register(groupKind());
		c.load(null, null);
		TxnEntry t = c.begin(RemovalTxn.GROUP, GKEY, List.of(), "o").entry();
		Effect f = c.plan(t, Effect.of(CrateTxn.OWE, EffectClass.O).items(Map.of("minecraft:sponge", 2)).data("key", OKEY).data("recipient", "p").data(
			"reason", OwedLedger.PLAYER_BLOCKS).data("site", "m").member("m"));
		OwedLedger.owe(new OwedLedger.Entry(OKEY, "p", "minecraft:overworld", 1, 65, 1, Map.of("minecraft:sponge", 2), OwedLedger.PLAYER_BLOCKS, 0, 0, "m",
			null), f.key(t.id));
		return t;
	}

	static Groups.Removal removal(TxnEntry t) {
		Groups.Removal r = new Groups.Removal("g1", null, null, false);
		r.undo = "u1";
		r.gtx = t;
		return r;
	}

	static Groups.Removed given() {
		return new Groups.Removed(true, List.of(), Map.of(), 3, Map.of(), List.of(), 0, null, List.of(OKEY));
	}

	@SuppressWarnings("unchecked")
	static List<JsonObject> partsOf(Groups.Removed r) throws Exception {
		Method m = null;
		try {
			m = Groups.Removed.class.getMethod("owedParts");
		} catch (NoSuchMethodException e) {
			// red: a group's result has no owed parts at all
		}
		assertNotNull(m, "RELF-owed-parts: Groups.Removed carries its owed parts");
		return (List<JsonObject>) m.invoke(r);
	}

	static Groups.Removed withParts(Groups.Removal r, Groups.Removed given) throws Exception {
		Method m = null;
		try {
			m = Groups.class.getDeclaredMethod("withOwedParts", Groups.Removal.class, Groups.Removed.class);
			m.setAccessible(true);
		} catch (NoSuchMethodException e) {
			// red: a group's end reports owed keys only
		}
		assertNotNull(m, "RELF-owed-parts: a group's end attaches its owed parts (Groups.withOwedParts)");
		return (Groups.Removed) m.invoke(null, r, given);
	}

	static void onePart(List<OwedPart> parts, String where) {
		assertEquals(1, parts.size(), "RELF-owed-parts: " + where + " carries the owed part");
		OwedPart p = parts.get(0);
		assertEquals(OKEY, p.key(), where + ": its key");
		assertEquals("p", p.recipient(), "RELF-owed-parts: " + where + ": its recipient");
		assertEquals(OwedLedger.PLAYER_BLOCKS, p.reason(), where + ": its reason");
		assertEquals(Map.of(net.minecraft.world.item.Items.SPONGE, 2), p.items(), "RELF-owed-parts: " + where + ": its amount");
	}

	@Test
	void theGroupsFutureCarriesItsOwedPartsAsItsSnapshotDoes() throws Exception {
		System.out.println("ROW RELF-owed-parts (unit)");
		TxnEntry t = owingTxn();
		Groups.Removal r = removal(t);
		Groups.Removed before = withParts(r, given()); // its txn not snapshotted yet: from its applied O effects
		System.out.println("ROW RELF-owed-parts: the end's parts before the snapshot: " + partsOf(before));
		JsonObject payload = new JsonObject();
		payload.addProperty("group", "g1");
		OwnerRemovals.groupSnapshot(t, GKEY, RemovalTxn.amounts(t), payload);
		JsonObject snap = OwnerRemovals.result("owner", GKEY);
		assertNotNull(snap, "fixture: the aggregate snapshot");
		Groups.Removed after = withParts(r, given());
		assertEquals(snap.getAsJsonArray("owedParts").asList(), List.<com.google.gson.JsonElement>copyOf(partsOf(after)),
			"RELF-owed-parts: the end's parts are the snapshot's");
		assertEquals(partsOf(before), partsOf(after), "RELF-owed-parts: the same parts before and after the snapshot (one rule)");
		Method result = Class.forName("dev.larattalabs.architect.apiimpl.SitesImpl").getDeclaredMethod("result", Groups.Removed.class);
		result.setAccessible(true);
		RemoveResult future = (RemoveResult) result.invoke(null, after);
		System.out.println("ROW RELF-owed-parts: the group's future: owed " + future.owed() + ", owedParts " + future.owedParts());
		assertEquals(List.of(OKEY), future.owed(), "its owed key");
		onePart(future.owedParts(), "the group's (and a region's) future");
		RemoveResult event = dev.larattalabs.architect.apiimpl.Views.resultOf(snap);
		assertEquals(event.owedParts(), future.owedParts(), "RELF-owed-parts: the future and the REMOVAL_FINISHED report the same parts");
		// the event of a removal with no txn (ApiEvents.removalFinished(group, ...)) maps the same way
		Method ev = null;
		for (Method m : dev.larattalabs.architect.apiimpl.ApiEvents.class.getDeclaredMethods()) {
			if (m.getName().equals("resultOf") && m.getParameterCount() == 1 && m.getParameterTypes()[0] == Groups.Removed.class) {
				ev = m;
			}
		}
		assertNotNull(ev, "RELF-owed-parts: one mapper from a group's result to the API's (ApiEvents.resultOf)");
		onePart(((RemoveResult) ev.invoke(null, after)).owedParts(), "a group's REMOVAL_FINISHED with no txn");
	}

	@Test
	void aRevisionUndosAggregateKeepsEachStagesOwedKeysAndParts() throws Exception {
		System.out.println("ROW RELF-owed-parts-revision (unit)");
		Groups.Removed stage = withParts(removal(owingTxn()), given());
		Class<?> rv = Class.forName("dev.larattalabs.architect.region.Revisions");
		Method add = null, out = null;
		for (Method m : rv.getDeclaredMethods()) {
			if (m.getName().equals("addStageResult")) {
				add = m;
			}
			if (m.getName().equals("undoResult")) {
				out = m;
			}
		}
		assertNotNull(add, "RELF-owed-parts: a revision undo adds each stage's result to its aggregate (Revisions.addStageResult)");
		assertNotNull(out, "RELF-owed-parts: and answers from it (Revisions.undoResult)");
		add.setAccessible(true);
		out.setAccessible(true);
		JsonObject agg = new JsonObject();
		add.invoke(null, agg, stage);
		JsonObject saved = com.google.gson.JsonParser.parseString(agg.toString()).getAsJsonObject(); // the undo manifest, as read back
		RemoveResult res = (RemoveResult) out.invoke(null, saved);
		System.out.println("ROW RELF-owed-parts-revision: the revision undo's result: owed " + res.owed() + ", owedParts " + res.owedParts());
		assertEquals(List.of(OKEY), res.owed(), "RELF-owed-parts: the revision undo's owed keys");
		onePart(res.owedParts(), "a revision undo's future");
		assertEquals(3, res.restored(), "its counts as before");
		RemoveResult old = (RemoveResult) out.invoke(null, new JsonObject());
		assertTrue(old.owed().isEmpty() && old.owedParts().isEmpty(), "an undo manifest saved before reads with none");
	}

	/**
	 * (row RELF-owed-parts-awaited) A stage the revision undo started answers held(decided) (or resumes after a restart: no future reaches the
	 * driver) and finishes by itself; the driver then sees it UNDONE. Red before: it was skipped ("undone already") and the undo's result left
	 * its owed keys and parts out. Now the manifest records the stages it awaits, and such a stage joins from its durable stage snapshot, once.
	 */
	@Test
	void aStageThatFinishedByItselfJoinsTheRevisionUndosResultOnce() throws Exception {
		System.out.println("ROW RELF-owed-parts-awaited (unit)");
		TxnEntry t = owingTxn();
		JsonObject payload = new JsonObject();
		payload.addProperty("group", "g1");
		payload.addProperty("stage", "rv1:a");
		OwnerRemovals.groupSnapshot(t, GKEY, RemovalTxn.amounts(t), payload);
		JsonObject snap = OwnerRemovals.result("stage", "g1/rv1:a");
		assertNotNull(snap, "fixture: the stage's snapshot");
		Class<?> rv = Class.forName("dev.larattalabs.architect.region.Revisions");
		Method await = null, merge = null, out = null;
		for (Method m : rv.getDeclaredMethods()) {
			if (m.getName().equals("awaitStage")) {
				await = m;
			}
			if (m.getName().equals("mergeAwaited")) {
				merge = m;
			}
			if (m.getName().equals("undoResult")) {
				out = m;
			}
		}
		assertNotNull(await, "RELF-owed-parts-awaited: the undo manifest records the stages it awaits (Revisions.awaitStage)");
		assertNotNull(merge, "RELF-owed-parts-awaited: a stage that finished by itself joins from its snapshot (Revisions.mergeAwaited)");
		await.setAccessible(true);
		merge.setAccessible(true);
		out.setAccessible(true);
		JsonObject op = new JsonObject();
		op.add("result", new JsonObject());
		await.invoke(null, op, "rv1:a");
		op = com.google.gson.JsonParser.parseString(op.toString()).getAsJsonObject(); // a restart: the manifest as read back
		assertTrue((boolean) merge.invoke(null, op, "rv1:a", snap), "RELF-owed-parts-awaited: merged once");
		assertTrue(!(boolean) merge.invoke(null, op, "rv1:a", snap), "RELF-owed-parts-awaited: never twice");
		RemoveResult res = (RemoveResult) out.invoke(null, op.getAsJsonObject("result"));
		System.out.println("ROW RELF-owed-parts-awaited: the revision undo's result: owed " + res.owed() + ", owedParts " + res.owedParts());
		onePart(res.owedParts(), "a revision undo whose stage finished by itself");
		assertTrue(!(boolean) merge.invoke(null, new JsonObject(), "rv1:a", snap), "a stage this undo never started is not merged");
	}
}
