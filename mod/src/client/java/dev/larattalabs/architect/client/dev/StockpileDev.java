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
		op("dev.stockpile.adopt", "adopt", "{owner} - (6c Y1) Sites.adoptCrates");
		op("dev.stockpile.dissolve", "dissolve", "{owner, toPlayer?: false} - (6c Y1) Sites.dissolveStockpile (to the player, else dropped at a crate) "
			+ "-> out, ledgerAtEnd");
		op("dev.stockpile.audit", "audit", "{owner, min?: [x,y,z], max?: [x,y,z]} - (6c Y1) the conservation parts per item: stock, paidStanding "
			+ "(and per target), retaken (XL: given back as a later target wrote over a paid cell), legacyCrateStock, entities and containers in the box, the player's inventory, gameTime");
		op("dev.stockpile.pause", "pause", "{site, paused?: true} - (6c Y1; C29: Sites.pause's path) pause or resume a construction site or road (as the crate screen's Pause)");
		op("dev.stockpile.tickets", "tickets", "{pos: [x,y,z]} - (6c Y1) the vanilla tickets on that chunk (loading and simulation) and whether it is loaded");
		op("dev.stockpile.saved", "saved", "{} - (6c Y1) <world>/architect/stockpiles.json as saved now, and the save count this session; (PS) the "
			+ "periodic saves (count, last, max, median ms), unsaved, loadFailed (and why), the format this build writes");
		op("dev.stockpile.ps", "ps", "{noPeriodic?: bool, joinSave?: bool, noCreditSave?: bool, resetPeriodic?: bool} - (PS) TEST: the before-the-fix cases: the "
			+ "periodic ledger save off (RL: with the save when a target joins the feed, unless joinSave: true); a finished undo's refund not "
			+ "saved at its credit; reset the periodic save counters");
		// (HF) a crash with nothing saved, at a moment the driver picks (no journal kill point on the deposit path): the server thread halts the
		// JVM after the work queued before it; no answer comes back (poll dev.state until inWorld is false)
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
