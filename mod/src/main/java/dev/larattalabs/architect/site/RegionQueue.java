package dev.larattalabs.architect.site;

import dev.larattalabs.architect.api.RoadRequest;
import dev.larattalabs.architect.batch.QItem;
import dev.larattalabs.architect.placement.Blueprint;
import java.util.List;
import net.minecraft.server.level.ServerLevel;

/** Queue items a region builds besides its tiles (phase 6a): its ground roads (4e roads) and the chunk need of its lots. */
public final class RegionQueue {
	private RegionQueue() {
	}

	/** The chunks a lot's building item tickets ({@code Batches.itemChunks}). */
	public static int itemChunks(QItem i, Blueprint bp) {
		return Batches.itemChunks(i, bp).size();
	}

	/** A region's ground road as a 4e road item. */
	public static QItem roadItem(ServerLevel level, String region, String key, String stage, List<String> after, RoadRequest r) {
		return roadItem(level, region, key, stage, after, r, false, false);
	}

	/** (6c RS) With the region's flags: {@code construction} (a survival region: a construction road), {@code survivalAtQueue} (the toggle). */
	public static QItem roadItem(ServerLevel level, String region, String key, String stage, List<String> after, RoadRequest r, boolean construction,
		boolean survivalAtQueue) {
		com.google.gson.JsonObject ext = new com.google.gson.JsonObject();
		ext.addProperty(RegionItems.EXT_REGION, region);
		var first = r.points().get(0);
		QItem q = new QItem(key, stage, after, "road", Sites.dimensionId(level), first.getX(), first.getY(), first.getZ(), 0, r.force(), ext, null, construction,
			survivalAtQueue);
		q.itemKind = "road";
		q.spec = InfraSpec.road(r);
		return q;
	}

	/**
	 * (6c D3, §3.4) A reach plan's hold item: a cell site of kind {@code architect:hold} (CELL, LAYER, no condition) over the town-held cells
	 * of its contact columns, each written as the block standing there, so it journals them as this region's (before = after).
	 */
	public static QItem holdItem(ServerLevel level, String region, String key, String stage, List<dev.larattalabs.architect.api.CellWrite> cells,
		@org.jspecify.annotations.Nullable String owner) {
		return holdItem(level, region, key, stage, List.of(), cells, owner, "architect:hold", dev.larattalabs.architect.api.Policy.CELL);
	}

	/**
	 * (7a GM-a) A region cell site of kind {@code kind} (LAYER, no condition) after {@code after}: its cells written as given and
	 * journaled as this region's with {@code policy} (a gatehouse's gate mechanism, {@code architect:mechanism}, is BOX: its undo
	 * restores every cell whatever a lever, a piston or the sensor did to it since, CONTRACT GM §7 items 3-4).
	 */
	public static QItem holdItem(ServerLevel level, String region, String key, String stage, List<String> after, List<dev.larattalabs.architect.api.CellWrite> cells,
		@org.jspecify.annotations.Nullable String owner, String kind, dev.larattalabs.architect.api.Policy policy) {
		com.google.gson.JsonObject ext = new com.google.gson.JsonObject();
		ext.addProperty(RegionItems.EXT_REGION, region);
		var first = cells.get(0).pos();
		// ((7a GM-a2) a gate mechanism is queued with the world's survival toggle as it stands, so a survival region's INSTANT cells item is
		// never failed as "switched on after it was queued" (MUST 3): it is the region's own write, held and charged by MechCharges)
		boolean mech = "architect:mechanism".equals(kind);
		QItem q = new QItem(key, stage, after, "cells", Sites.dimensionId(level), first.getX(), first.getY(), first.getZ(), 0, false, ext, null, false,
			mech && dev.larattalabs.architect.survival.SurvivalWorld.on());
		q.itemKind = "cells";
		q.spec = InfraSpec.cells(new dev.larattalabs.architect.api.CellsRequest(level, kind, policy, cells,
			false, dev.larattalabs.architect.api.OverlapPolicy.LAYER, dev.larattalabs.architect.api.Mode.INSTANT, owner, new com.google.gson.JsonObject(), null,
			false));
		q.layer = true;
		return q;
	}
}
