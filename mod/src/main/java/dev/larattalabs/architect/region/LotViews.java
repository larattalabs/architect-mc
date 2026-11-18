package dev.larattalabs.architect.region;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import dev.larattalabs.architect.api.BuildStatus;
import dev.larattalabs.architect.api.LotState;
import dev.larattalabs.architect.api.RegionState;
import dev.larattalabs.architect.apiimpl.StatusViews;
import dev.larattalabs.architect.apiimpl.Views;
import dev.larattalabs.architect.batch.QBatch;
import dev.larattalabs.architect.batch.QItem;
import dev.larattalabs.architect.site.Batches;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import net.minecraft.server.MinecraftServer;
import net.minecraft.world.level.levelgen.structure.BoundingBox;
import org.jspecify.annotations.Nullable;

/**
 * (8b BS) A region's {@link LotState}s with their box and {@link BuildStatus}: a pad planned; a queued lot its batch item's status (its typed
 * wait); a placed lot its site's; a removed lot removed; a failed one failed; every lot of a removing region removing. The boxes come from
 * the effective IR (pads too), cached per region and head revision. Server thread. Internal.
 */
public final class LotViews {
	private LotViews() {
	}

	/** The boxes per region, keyed by region id, head rid and IR sha. */
	private static final Map<String, Map<String, BoundingBox>> BOXES = new ConcurrentHashMap<>();

	static List<LotState> lots(RegionsImpl.Live l, @Nullable MinecraftServer server) {
		RegionRec r = l.rec();
		Map<String, BoundingBox> boxes = boxes(l);
		boolean removing = r.state == RegionState.REMOVING;
		Map<String, QItem> items = removing ? Map.of() : lotItems(r);
		List<LotState> out = new ArrayList<>();
		r.lots.forEach((id, ls) -> {
			int rev = Revisions.lotRevision(ls);
			out.add(new LotState(id, ls.siteId, ls.state, rev, boxes.get(id), status(id, ls, rev, removing, items, server)));
		});
		return out;
	}

	/** One lot's status (see the class). */
	static BuildStatus status(String id, RegionRec.Lot ls, int rev, boolean removing, Map<String, QItem> items, @Nullable MinecraftServer server) {
		if (removing) {
			return BuildStatus.of(BuildStatus.REMOVING, rev);
		}
		if ("placed".equals(ls.state) && ls.siteId != null && server != null) {
			BuildStatus st = Views.targetStatus(server, ls.siteId);
			if (st != null) {
				return st;
			}
		}
		if ("queued".equals(ls.state)) {
			QItem i = items.get("lot:" + id);
			if (i != null) {
				return StatusViews.item(i.key, i.status.name(), i.reason, i.siteId, i.ext);
			}
		}
		return BuildStatus.ofLotState(ls.state, rev);
	}

	/** The region's lot items by key, over its batch and its revisions' batches. */
	static Map<String, QItem> lotItems(RegionRec r) {
		Map<String, QItem> out = new HashMap<>();
		List<String> bids = new ArrayList<>();
		bids.add(r.batchId);
		for (var rv : r.revisions) {
			if (rv.batchId != null && !bids.contains(rv.batchId)) {
				bids.add(rv.batchId);
			}
		}
		for (String bid : bids) {
			QBatch b = bid == null ? null : Batches.get(bid);
			if (b != null) {
				for (QItem i : b.items) {
					if (i.key.startsWith("lot:")) {
						out.put(i.key, i);
					}
				}
			}
		}
		return out;
	}

	/** Every lot's box in the effective IR (cached per head). */
	static Map<String, BoundingBox> boxes(RegionsImpl.Live l) {
		RegionRec r = l.rec();
		String k = r.id + "#" + r.headRid + "#" + r.irSha;
		Map<String, BoundingBox> b = BOXES.get(k);
		if (b != null) {
			return b;
		}
		JsonObject ir;
		try {
			ir = Revisions.effective(l);
		} catch (RuntimeException e) {
			ir = l.ir().json();
		}
		b = boxesOf(ir);
		BOXES.keySet().removeIf(x -> x.startsWith(r.id + "#"));
		BOXES.put(k, b);
		return b;
	}

	/** The lots' boxes of an IR JSON ({@code lots[].box {minX..maxZ}}). Pure. */
	public static Map<String, BoundingBox> boxesOf(JsonObject ir) {
		Map<String, BoundingBox> out = new LinkedHashMap<>();
		if (ir.get("lots") instanceof JsonArray a) {
			for (JsonElement e : a) {
				if (e instanceof JsonObject lo && lo.get("id") != null && lo.get("box") instanceof JsonObject bx) {
					try {
						out.put(lo.get("id").getAsString(), new BoundingBox(bx.get("minX").getAsInt(), bx.get("minY").getAsInt(), bx.get("minZ").getAsInt(), bx.get(
							"maxX").getAsInt(), bx.get("maxY").getAsInt(), bx.get("maxZ").getAsInt()));
					} catch (RuntimeException bad) {
						// a malformed box: no box for that lot
					}
				}
			}
		}
		return out;
	}
}
