package dev.larattalabs.architect.client.dev;

import com.google.gson.JsonObject;
import dev.larattalabs.architect.client.world.ServerTasks;
import dev.larattalabs.architect.site.Stockpiles;

/**
 * Phase 6c slice Y1 DevBridge hooks (docs/DEVBRIDGE.md; CONTRACT Y, C24): the stockpile through {@link Stockpiles#dev}, as the
 * client's player (its dimension, its inventory). Every answer carries {@code stockpile} (the stockpile's state) and, for a
 * refusal, {@code refused: {reason, message}}.
 */
public final class StockpileDev {
	private StockpileDev() {
	}

	private static void op(String name, String op, String doc) {
		DevBridge.register(name, 60_000, doc, (req, mc) -> {
			JsonObject r = req.deepCopy();
			return DevBridge.onClient(mc, () -> ServerTasks.callAsPlayer((level, player) -> Stockpiles.dev(level.getServer(), player, op, r)))
				.thenCompose(x -> x);
		});
	}

	/** (slice T3b) Polls until the txn {@code a.pendingTxn} is no longer open (every 500 ms, about 280 s at most), then the stockpile's state. */
	private static java.util.concurrent.CompletableFuture<JsonObject> waitRetired(net.minecraft.client.Minecraft mc, JsonObject a, JsonObject req, int n) {
		String id = a.get("pendingTxn").getAsString();
		return java.util.concurrent.CompletableFuture.supplyAsync(() -> null, java.util.concurrent.CompletableFuture.delayedExecutor(500,
			java.util.concurrent.TimeUnit.MILLISECONDS)).thenCompose(v -> DevBridge.onClient(mc, () -> ServerTasks.callAsPlayer((level, player) -> {
				boolean open = dev.larattalabs.architect.txn.TxnServer.core().get(id) != null;
				JsonObject o = a.deepCopy();
				o.addProperty("retired", !open);
				if (!open) {
					o.add("stockpile", Stockpiles.dev(level.getServer(), player, "state", req).get("stockpile"));
				}
				return o;
			})).thenCompose(x -> x)).thenCompose(o -> o.get("retired").getAsBoolean() || n >= 560 ? java.util.concurrent.CompletableFuture.completedFuture(o)
				: waitRetired(mc, a, req, n + 1));
	}

	public static void init() {
		op("dev.stockpile.create", "create", "{owner, crates: [[x,y,z]...], dimension?} - (6c Y1) Sites.createStockpile: idempotent per owner, adds the "
			+ "named crates");
		op("dev.stockpile.addcrate", "addcrate", "{owner, pos: [x,y,z], dimension?} - (6c Y1) Sites.addStockpileCrate");
		op("dev.stockpile.removecrate", "removecrate", "{owner, pos: [x,y,z], force?: false} - (6c Y1) Sites.removeStockpileCrate -> removed, dropped, "
			+ "refusal, ended");
		op("dev.stockpile.state", "state", "{owner} - (6c Y1) the stockpile: crates, missingCrates, capacity and used stacks, stock, outstanding, "
			+ "credit, reserved, the ledger (delivered, returned, consumed, withdrawn, dropped, refundOverflow), identity, feed order, per target");
		op("dev.stockpile.order", "order", "{owner, ids?: [...]} - (6c Y1) Sites.setFeedOrder when ids are given; the order in stockpile.feedOrder");
		op("dev.stockpile.withdraw", "withdraw", "{owner, items: {item: n}} - (6c Y1) Sites.withdraw into the player's inventory (credit only)");
		// (slice T3b) one pile.adopt txn: -> joined, deferred {crate: reason}, txn; decided then held (a dev.txn.pauseAt pause, a refused barrier):
		// heldDecided and pendingTxn, and the answer waits until that txn retires (up to the call's timeout), then carries the stockpile after it
		DevBridge.register("dev.stockpile.adopt", 300_000, "{owner} - (6c Y1; slice T3b) Sites.adoptCratesResult through the pile.adopt txn -> joined, "
			+ "deferred {crate: reason}, txn; a decided-then-held adoption answers once its txn retires (heldDecided, pendingTxn)", (req, mc) -> {
				JsonObject r = req.deepCopy();
				return DevBridge.onClient(mc, () -> ServerTasks.callAsPlayer((level, player) -> Stockpiles.dev(level.getServer(), player, "adopt", r)))
					.thenCompose(x -> x).thenCompose(a -> a.has("pendingTxn") && !a.get("pendingTxn").isJsonNull() ? waitRetired(mc, a, r, 0)
						: java.util.concurrent.CompletableFuture.completedFuture(a));
			});
		op("dev.stockpile.dissolve", "dissolve", "{owner, toPlayer?: false} - (6c Y1) Sites.dissolveStockpile (to the player, else dropped at a crate) "
			+ "-> out, ledgerAtEnd");
		op("dev.stockpile.audit", "audit", "{owner, min?: [x,y,z], max?: [x,y,z]} - (6c Y1) the conservation parts per item: stock, paidStanding "
			+ "(and per target), retaken (XL: given back as a later target wrote over a paid cell), legacyCrateStock, entities and containers in the box, the player's inventory, gameTime");
		op("dev.stockpile.pause", "pause", "{site, paused?: true} - (6c Y1; C29: Sites.pause's path) pause or resume a construction site or road (as the crate screen's Pause)");
		op("dev.stockpile.tickets", "tickets", "{pos: [x,y,z]} - (6c Y1) the vanilla tickets on that chunk (loading and simulation) and whether it is loaded");
		op("dev.stockpile.saved", "saved", "{} - (6c Y1) <world>/architect/stockpiles.json as saved now, and the save count this session; (PS) the "
			+ "periodic saves (count, last, max, median ms), unsaved, loadFailed (and why), the format this build writes");
		op("dev.stockpile.save", "save", "{} - (S-M5-19) a save barrier: Stockpiles.saveWithWorld on the server thread (the players, the chunks flushed, then "
			+ "<world>/architect/stockpiles.json); answers when the file is written -> written, path, bytes, saves (a world with no stockpile keeps "
			+ "no file: written false, why); fails when stockpiles.json failed to load this session or the write failed");
		op("dev.stockpile.ss", "ss", "{probe?: bool} - (SS) TEST: probe: the region-file durability cases with the mixins applied (first open, clean flush, "
			+ "write then flush, a failed force retried, a failed close then a reopen, an oversized chunk, the device barrier, a dirty imposter, an "
			+ "earlier save's writes forced before the ledger); else the force, skip and barrier counters and the files not durable now");
		op("dev.stockpile.ps", "ps", "{noPeriodic?: bool, joinSave?: bool, noCreditSave?: bool, refuseSave?: bool, resetPeriodic?: bool} - (PS) TEST: the before-the-fix cases ((DR-S) refuseSave: every explicit save with the world refused as SS refuses it): the "
			+ "periodic ledger save off (RL: with the save when a target joins the feed, unless joinSave: true); a finished undo's refund not "
			+ "saved at its credit; reset the periodic save counters");
		// (HF) a crash with nothing saved, at a moment the driver picks (no journal kill point on the deposit path): the server thread halts the
		// JVM after the work queued before it; no answer comes back (poll dev.state until inWorld is false)
		DevBridge.register("dev.stockpile.barrier", 600_000, "{run?: bool, reps?: n, failPlayerReplace?: n, failChunkWrite?: n, forgive?: bool} - (slice T0) "
			+ "Stockpiles.barrier(): players, chunks, the ledger through DurableFile (run: true runs one now; reps: n runs n and answers bench "
			+ "{total, players, chunks, ledger: {p50, p90, max}}; failPlayerReplace / failChunkWrite: TEST, the next n player replaces or region writes "
			+ "fail; forgive: operator, every owed player and chunk save's loss accepted, stale ones too) -> {runs, playerSaveFailures, last: {outcome, reason, ledgerGen, playersMs, chunksMs, ledgerMs}, players: {owed, ..}, chunks: "
			+ "{owed, failed, paid, resubmitted, served}, ledger: {id, writtenGen, installedGen, inDoubt}}",
			(req, mc) -> ServerTasks.callOnServer(s -> dev.larattalabs.architect.site.DurableBarrier.dev(s, req)));
		DevBridge.register("dev.stockpile.halt", 10_000, "{mode?: now|autosave} - (HF) TEST: halts the JVM on the server thread at once (no shutdown "
			+ "hooks, nothing saved): a crash; no answer. (RL) mode autosave: the chunks saved first as an autosave saves them (no flush: their writes "
			+ "may still be queued at the halt), then the halt", (req, mc) -> DevBridge.onClient(mc, () -> ServerTasks.callAsPlayer((level, player) -> {
				if (req.has("mode") && "autosave".equals(req.get("mode").getAsString())) {
					level.getServer().saveAllChunks(true, false, false);
				}
				dev.larattalabs.architect.Architect.LOGGER.error("dev.stockpile.halt: halting the JVM (nothing saved)");
				Runtime.getRuntime().halt(7);
				return new JsonObject();
			})).thenCompose(x -> x));
	}
}
