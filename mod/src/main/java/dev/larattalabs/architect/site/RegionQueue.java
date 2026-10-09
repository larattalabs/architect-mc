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
		com.google.gson.JsonObject ext = new com.google.gson.JsonObject();
		ext.addProperty(RegionItems.EXT_REGION, region);
		var first = r.points().get(0);
		QItem q = new QItem(key, stage, after, "road", Sites.dimensionId(level), first.getX(), first.getY(), first.getZ(), 0, r.force(), ext, null, false,
			false);
		q.itemKind = "road";
		q.spec = InfraSpec.road(r);
		return q;
	}
}
