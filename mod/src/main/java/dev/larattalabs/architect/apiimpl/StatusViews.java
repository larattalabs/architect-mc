package dev.larattalabs.architect.apiimpl;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonPrimitive;
import dev.larattalabs.architect.api.BesideNote;
import dev.larattalabs.architect.api.BuildStatus;
import dev.larattalabs.architect.api.ItemCount;
import dev.larattalabs.architect.api.RegionLand;
import java.util.ArrayList;
import java.util.List;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.resources.Identifier;
import net.minecraft.world.item.Item;
import org.jspecify.annotations.Nullable;

/**
 * (8b BS) The typed homes of the ext keys Steward reads ({@code architect_mc:part}, {@code :lot}, {@code :revision.rid}, {@code :region},
 * {@code :waitsFor}, {@code :beside}, {@code :land}) and a batch item's {@link BuildStatus}. Pure over the JSON. Internal.
 */
public final class StatusViews {
	public static final String EXT_PART = "architect_mc:part";
	public static final String EXT_LOT = "architect_mc:lot";
	public static final String EXT_REVISION = "architect_mc:revision";
	public static final String EXT_REGION = "architect_mc:region";
	public static final String EXT_WAITS_FOR = "architect_mc:waitsFor";
	public static final String EXT_BESIDE = "architect_mc:beside";
	public static final String EXT_LAND = "architect_mc:land";

	private StatusViews() {
	}

	public static @Nullable String str(@Nullable JsonObject o, String k) {
		return o != null && o.get(k) instanceof JsonPrimitive p ? p.getAsString() : null;
	}

	/** The ext's {@code architect_mc:revision.rid}, else 0. */
	public static int rid(@Nullable JsonObject ext) {
		return ext != null && ext.get(EXT_REVISION) instanceof JsonObject rv && rv.get("rid") instanceof JsonPrimitive r && r.isNumber() ? r.getAsInt() : 0;
	}

	/** The part an ext names: {@code architect_mc:part}, else its wait's {@code part}; else null. */
	public static @Nullable String part(@Nullable JsonObject ext) {
		String p = str(ext, EXT_PART);
		return p != null ? p : ext != null && ext.get(EXT_WAITS_FOR) instanceof JsonObject w ? str(w, "part") : null;
	}

	/**
	 * A batch item's status (pure): {@code status} its QItem status name, {@code reason} its typed Reason name (or null), {@code ext} its
	 * merged ext with its typed wait. A placed item is built, a failed one failed, a placing one placing, a waiting one waits for its
	 * typed wait's subject, a queued one is planned. {@code since} is 0 (an item's wait keeps no tick).
	 */
	public static BuildStatus item(String itemKey, String status, @Nullable String reason, @Nullable String siteId, @Nullable JsonObject ext) {
		int rev = rid(ext);
		switch (status) {
			case "PLACED":
				return BuildStatus.of(BuildStatus.BUILT, rev);
			case "FAILED": {
				String r = "failed:" + (reason == null ? "OTHER" : reason);
				return new BuildStatus(BuildStatus.FAILED, r, null, List.of(), 0, 0L, BuildStatus.sayOf(BuildStatus.FAILED, r), rev, null);
			}
			case "PLACING":
				return BuildStatus.of(BuildStatus.PLACING, rev);
			case "WAITING":
				break;
			default:
				return BuildStatus.of(BuildStatus.PLANNED, rev);
		}
		JsonObject w = ext != null && ext.get(EXT_WAITS_FOR) instanceof JsonObject o ? o : null;
		String self = siteId != null ? siteId : itemKey;
		String kind = str(w, "kind");
		String why;
		String on;
		List<ItemCount> needs = List.of();
		int more = 0;
		if (w != null && "terrain".equals(kind)) {
			why = BuildStatus.TERRAIN;
			on = str(w, "part");
		} else if (w != null && BuildStatus.BILL_CAP.equals(kind)) {
			why = BuildStatus.BILL_CAP;
			on = self;
		} else if (w != null && "bill".equals(kind)) {
			why = BuildStatus.MATERIALS;
			on = self;
		} else if (w != null && str(w, "target") != null) {
			why = BuildStatus.STAGE;
			on = str(w, "target");
		} else {
			why = switch (reason == null ? "" : reason) {
				case "PLAYER_IN_BOX" -> BuildStatus.PLAYER_IN_BOX;
				case "NOT_LOADED" -> BuildStatus.NOT_LOADED;
				case "BILL_CAP" -> BuildStatus.BILL_CAP;
				default -> BuildStatus.OCCUPIED; // OCCUPIED, and any other temporary blocker of a queued item's box
			};
			on = BuildStatus.BILL_CAP.equals(why) ? self : null;
		}
		if (w != null && w.get("missing") instanceof JsonObject m) {
			List<ItemCount> its = new ArrayList<>();
			for (var e : m.entrySet()) {
				int n = e.getValue() instanceof JsonPrimitive p && p.isNumber() ? p.getAsInt() : 0;
				Item item = n <= 0 ? null : BuiltInRegistries.ITEM.getOptional(Identifier.tryParse(e.getKey())).orElse(null);
				if (item == null || its.size() >= 8) {
					more += Math.max(0, n);
				} else {
					its.add(new ItemCount(item, n));
				}
			}
			needs = its;
		}
		return new BuildStatus(BuildStatus.WAITING, why, on, needs, more, 0L, BuildStatus.sayOf(BuildStatus.WAITING, why), rev, BuildStatus.BILL_CAP.equals(why)
			? "region" : null);
	}

	/** The typed {@code architect_mc:beside} note, or null. */
	public static @Nullable BesideNote beside(@Nullable JsonObject ext) {
		if (ext == null || !(ext.get(EXT_BESIDE) instanceof JsonObject b) || str(b, "region") == null) {
			return null;
		}
		boolean dangling = b.get("dangling") instanceof JsonPrimitive d && d.isBoolean() && d.getAsBoolean();
		return new BesideNote(str(b, "region"), dangling, str(b, "gateRemoved"));
	}

	/** The typed {@code architect_mc:land}, or null (a malformed run is left out). */
	public static @Nullable RegionLand land(@Nullable JsonObject ext) {
		if (ext == null || !(ext.get(EXT_LAND) instanceof JsonObject l)) {
			return null;
		}
		int v = l.get("v") instanceof JsonPrimitive p && p.isNumber() ? p.getAsInt() : 1;
		Long removed = l.get("standingRemoved") instanceof JsonPrimitive p && p.isNumber() ? p.getAsLong() : null;
		return new RegionLand(v, runs(l, "outside"), runs(l, "inside"), removed);
	}

	private static List<RegionLand.Run> runs(JsonObject l, String k) {
		List<RegionLand.Run> out = new ArrayList<>();
		if (l.get(k) instanceof JsonObject o && o.get("runs") instanceof JsonArray a) {
			for (JsonElement e : a) {
				if (e instanceof JsonArray r && r.size() == 4 && r.get(1).getAsInt() == r.get(3).getAsInt()) {
					int x0 = r.get(0).getAsInt(), x1 = r.get(2).getAsInt();
					out.add(new RegionLand.Run(r.get(1).getAsInt(), Math.min(x0, x1), Math.max(x0, x1)));
				}
			}
		}
		return out;
	}
}
