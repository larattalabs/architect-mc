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
			+ "(and per target), legacyCrateStock, entities and containers in the box, the player's inventory, gameTime");
		op("dev.stockpile.pause", "pause", "{site, paused?: true} - (6c Y1) pause or resume a construction site (as the crate screen's Pause)");
		op("dev.stockpile.saved", "saved", "{} - (6c Y1) <world>/architect/stockpiles.json as saved now, and the save count this session");
	}
}
