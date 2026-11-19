package dev.larattalabs.architect.site;

import com.google.gson.JsonObject;
import dev.larattalabs.architect.Architect;
import dev.larattalabs.architect.api.Reason;
import java.util.ArrayList;
import java.util.List;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerLifecycleEvents;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerTickEvents;
import net.minecraft.server.MinecraftServer;
import org.jspecify.annotations.Nullable;

/**
 * (slice SOFF) While any level has saving off ({@code /save-off}, {@code noSave}), Architect admits no operation that changes the stockpile
 * ledger or moves paid items: the world's chunks can't be saved with the ledger, so nothing is started and then refused. Held: crate inserts
 * (every ingress, every dimension: the ledger is shared), payouts, crate and stockpile changes, construction deltas, and the job ticks
 * (placements, removals and restores, feeding and fills, roads, repairs, revisions and region actions); the start's reconcile is deferred.
 * <p>
 * The hold starts as soon as a level is seen with saving off and ends only once saving is on in every level <b>and</b> a confirmed save
 * barrier ({@link Stockpiles#durableBarrier}: players, chunks flushed and durable, then the ledger) has passed: a flag turning back on never
 * releases (or finalizes) anything by itself. Vanilla's {@code /save-off} ({@code setAutoSave(false)}) first runs that barrier when the
 * ledger has pending changes, so an operation admitted just before it is on disk before saving stops. Server thread.
 */
public final class SaveHold {
	private SaveHold() {
	}

	enum State {
		OPEN, HELD
	}

	private static State state = State.OPEN;
	private static @Nullable String heldOver;
	private static @Nullable String lastFailure;
	private static long ticks, nextTry;
	private static final List<Deferred> DEFERRED = new ArrayList<>();
	/** (dev) holds begun, releases, release barriers refused, operations refused or parked while held. */
	static volatile int holds, releases, releaseFailures, refused;
	/** (dev) the barriers run at /save-off and the ones that did not pass. */
	static volatile int savingOffBarriers, savingOffBarrierFailures;

	private record Deferred(String what, Runnable run) {
	}

	public static void init() {
		ServerTickEvents.START_SERVER_TICK.register(SaveHold::tick);
		ServerLifecycleEvents.SERVER_STOPPED.register(s -> {
			testOff = false;
			state = State.OPEN;
			heldOver = null;
			lastFailure = null;
			ticks = 0;
			nextTry = 0;
			DEFERRED.clear();
		});
	}

	/** (pure) The next state: held while any level has saving off; released only by a passed barrier with saving on everywhere. */
	static State next(State s, boolean anyOff, boolean barrierPassed) {
		if (anyOff) {
			return State.HELD;
		}
		return s == State.HELD && !barrierPassed ? State.HELD : State.OPEN;
	}

	/** (pure) A held operation's refusal: names the levels with saving off and says /save-on; or the barrier it waits for. */
	static String message(List<String> levelsOff, @Nullable String waitingFor) {
		if (!levelsOff.isEmpty()) {
			return "saving is off (/save-off) in " + String.join(", ", levelsOff) + ": Architect holds stockpile and build changes while the world"
				+ " can't be saved with them; /save-on, then try again";
		}
		return "saving was off (/save-off): Architect holds stockpile and build changes until a confirmed world save passes" + (waitingFor == null
			? "" : " (" + waitingFor + ")") + "; try again shortly";
	}

	static void tick(MinecraftServer srv) {
		ticks++;
		SaveEvidence.tickStart();
		List<String> off = Stockpiles.levelsSavingOff(srv);
		if (!off.isEmpty()) {
			hold(off);
			return;
		}
		if (state == State.HELD && ticks >= nextTry) {
			release(srv);
		}
	}

	private static void hold(List<String> off) {
		if (state == State.OPEN) {
			state = State.HELD;
			holds++;
			heldOver = String.join(", ", off);
			Architect.LOGGER.warn("Architect: saving is off (/save-off) in {}: stockpile and build changes are held until saving is on and a"
				+ " confirmed save passes{}", heldOver, Stockpiles.unsaved ? "; the ledger has changes not yet on disk (saving was turned off"
				+ " without /save-off's save first)" : "");
		}
	}

	private static void release(MinecraftServer srv) {
		String why = null;
		try {
			Stockpiles.durableBarrier(srv);
		} catch (RuntimeException e) {
			why = e.getMessage();
		}
		if (why != null) {
			releaseFailures++;
			nextTry = ticks + 100;
			if (!why.equals(lastFailure)) {
				Architect.LOGGER.warn("Architect: saving is on again, but the confirmed save did not pass ({}); held, retried every 5 s", why);
			}
			lastFailure = why;
			return;
		}
		state = State.OPEN;
		releases++;
		Architect.LOGGER.info("Architect: saving is on again and a confirmed save passed (it was off in {}): held changes resume", heldOver);
		heldOver = null;
		lastFailure = null;
		List<Deferred> run = new ArrayList<>(DEFERRED);
		DEFERRED.clear();
		for (Deferred d : run) {
			try {
				d.run().run();
			} catch (RuntimeException e) {
				Architect.LOGGER.error("Architect: {} (deferred while saving was off) failed", d.what(), e);
			}
		}
	}

	/** (TEST, dev.stockpile.ps saveHold) the hold off: rows that measure a crash's drift under /save-off (rs-crash item 11) as before SOFF. */
	static volatile boolean testOff;

	/** Whether an operation that changes the ledger or moves paid items may start now (no level with saving off, no hold pending). */
	public static boolean admits(@Nullable MinecraftServer srv) {
		if (srv == null || testOff) {
			return true;
		}
		List<String> off = Stockpiles.levelsSavingOff(srv);
		if (!off.isEmpty()) {
			hold(off);
		}
		return state == State.OPEN;
	}

	/**
	 * Whether the job ticks may run: admitted, or no stockpile ledger exists (with none, a job's items are all on the world's side: a crate's
	 * own ledger, drops, containers, saved or not with their chunks; creative placements under /save-off run as before).
	 */
	public static boolean jobsAdmitted(@Nullable MinecraftServer srv) {
		return admits(srv) || Stockpiles.all().isEmpty();
	}

	/** Why an operation is held now, or null. */
	public static @Nullable String refusal(@Nullable MinecraftServer srv) {
		if (admits(srv)) {
			return null;
		}
		refused++;
		return message(Stockpiles.levelsSavingOff(srv), lastFailure);
	}

	/** Throws the hold's refusal (NOT_ALLOWED) before anything changes. */
	public static void require(@Nullable MinecraftServer srv) throws Sites.SiteException {
		String r = refusal(srv);
		if (r != null) {
			throw new Sites.SiteException(Reason.NOT_ALLOWED, r);
		}
	}

	/** Runs {@code r} now when admitted, else once the hold is released (before the held jobs resume). */
	static void whenAdmitted(MinecraftServer srv, String what, Runnable r) {
		if (admits(srv)) {
			r.run();
			return;
		}
		DEFERRED.add(new Deferred(what, r));
		Architect.LOGGER.warn("Architect: {} deferred: saving is off; it runs once saving is on and a confirmed save passes", what);
	}

	/**
	 * (SaveEvidenceServerMixin, vanilla's {@code setAutoSave(false)}: /save-off) Before the levels stop saving: pending ledger changes made
	 * durable with the players and the chunks, so an operation admitted just before /save-off is on disk before the hold.
	 */
	public static void beforeSavingOff(MinecraftServer srv) {
		if (state != State.OPEN || !srv.isSameThread() || !Stockpiles.unsaved || !Stockpiles.levelsSavingOff(srv).isEmpty()) {
			return;
		}
		savingOffBarriers++;
		SaveTestHooks.inSavingOffBarrier = true; // (SOFF2, TEST) the depositInSavingOffBarrier hook's window
		try {
			Stockpiles.durableBarrier(srv);
			Architect.LOGGER.info("Architect: /save-off: the stockpile ledger's pending changes saved with the players and the chunks first");
		} catch (RuntimeException e) {
			savingOffBarrierFailures++;
			Architect.LOGGER.error("Architect: /save-off: the pending stockpile changes could not be saved first ({}); they stay pending", e.getMessage());
		} finally {
			SaveTestHooks.inSavingOffBarrier = false;
		}
	}

	static JsonObject json() {
		JsonObject o = new JsonObject();
		o.addProperty("state", state.name());
		o.addProperty("heldOver", heldOver);
		o.addProperty("lastFailure", lastFailure);
		o.addProperty("holds", holds);
		o.addProperty("releases", releases);
		o.addProperty("releaseFailures", releaseFailures);
		o.addProperty("refused", refused);
		o.addProperty("deferred", DEFERRED.size());
		o.addProperty("savingOffBarriers", savingOffBarriers);
		o.addProperty("savingOffBarrierFailures", savingOffBarrierFailures);
		o.addProperty("testOff", testOff);
		return o;
	}
}
