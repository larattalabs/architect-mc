package dev.larattalabs.architect.region;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import dev.larattalabs.architect.api.BesideJoin;
import dev.larattalabs.architect.api.BesideVerdict;
import dev.larattalabs.architect.api.Reason;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import org.jspecify.annotations.Nullable;

/** (6c D3, §7) A dry beside check's verdict from the plan it ran (its IR) or the way it failed. */
final class BesideVerdicts {
	private BesideVerdicts() {
	}

	/** The kit's named word and its bracketed kind at the head of a plan failure: "NO_JOIN: [route] ..." gives "NO_JOIN [route]". */
	private static final Pattern CODE = Pattern.compile("(?:^|: )(NO_JOIN|NO_ROOM|NO_EDGE|PROTECTED|OVERLAP(?:_OWNED|_BUSY)?|KEEP_OUT): (\\[[a-z]+\\])?");

	static @Nullable String code(@Nullable Reason reason, String message) {
		Matcher m = CODE.matcher(message);
		if (m.find()) {
			return m.group(1) + (m.group(2) != null ? " " + m.group(2) : "");
		}
		return reason == Reason.PROTECTED || reason == Reason.OVERLAP ? reason.name() : null;
	}

	static BesideVerdict failed(@Nullable Reason reason, String message, long t0) {
		return new BesideVerdict(false, reason, code(reason, message), message, null, null, (System.nanoTime() - t0) / 1_000_000);
	}

	/** The plan fits: its join (from the IR's graph, reach and land) and its land. */
	static BesideVerdict fits(String town, JsonObject ir, int @Nullable [] townClaim, @Nullable JsonObject townIr, String note, long t0) {
		JsonObject land = DistrictLand.of(ir, townClaim, null);
		JsonObject ext = null, jnode = null;
		if (ir.get("graph") instanceof JsonObject g) {
			if (g.get("edges") instanceof JsonArray es) {
				for (JsonElement e : es) {
					if ("join_external".equals(BesideReach.str(e.getAsJsonObject(), "id"))) {
						ext = e.getAsJsonObject();
					}
				}
			}
			if (ext != null && g.get("nodes") instanceof JsonArray ns) {
				String from = String.valueOf(BesideReach.str(ext, "from")).split("\\.")[0];
				for (JsonElement n : ns) {
					if (from.equals(BesideReach.str(n.getAsJsonObject(), "id"))) {
						jnode = n.getAsJsonObject();
					}
				}
			}
		}
		BesideJoin join = null;
		if (ext != null) {
			JsonObject jx = ext.get("junction") instanceof JsonObject j ? j : null;
			// (7a GJ, §9: BesideJoin gains nothing) through a gate: the join's junction is the gate junction's `then` (an end or a side); the
			// gate is in the IR and the land (`via`)
			if (jx != null && "gate".equals(BesideReach.str(jx, "kind")) && jx.get("then") instanceof JsonObject th) {
				jx = th;
			}
			String kind = jx == null ? "end" : String.valueOf(BesideReach.str(jx, "kind"));
			String step = ir.has("reach") ? "reach" : "seam";
			String to = String.valueOf(BesideReach.str(ext, "to"));
			String target = to.contains(":") ? to.substring(to.indexOf(':') + 1) : to;
			String node = "side".equals(kind) ? null : target.split("\\.")[0];
			String road = "side".equals(kind) ? target : roadOf(townIr, node);
			JsonArray at = jx != null && jx.get("at") instanceof JsonArray a ? a : jnode != null && jnode.get("at") instanceof JsonArray a2 ? a2 : null;
			BlockPos pos = at == null ? BlockPos.ZERO : new BlockPos(at.get(0).getAsInt(), at.get(1).getAsInt(), at.get(2).getAsInt());
			Direction facing = facingOf(jnode, jx);
			int cells = 0, inside = 0;
			if (land != null && land.get("parts") instanceof JsonArray ps) {
				for (JsonElement p : ps) {
					JsonObject o = p.getAsJsonObject();
					if ("join".equals(BesideReach.str(o, "kind"))) {
						cells = o.get("cells").getAsInt();
						inside = o.get("insideCells").getAsInt();
					}
				}
			}
			join = new BesideJoin(town, kind, step, road == null ? "" : road, node, pos, facing, cells, inside);
		}
		return new BesideVerdict(true, null, null, "fits" + note, join, land, (System.nanoTime() - t0) / 1_000_000);
	}

	/** The street road a town node's edges lie on (the first street edge's path), or null. */
	private static @Nullable String roadOf(@Nullable JsonObject townIr, @Nullable String node) {
		if (townIr == null || node == null || !(townIr.get("graph") instanceof JsonObject g) || !(g.get("edges") instanceof JsonArray es)) {
			return null;
		}
		for (JsonElement e : es) {
			JsonObject o = e.getAsJsonObject();
			if (o.has("external")) {
				continue;
			}
			String f = String.valueOf(BesideReach.str(o, "from")).split("\\.")[0], t = String.valueOf(BesideReach.str(o, "to")).split("\\.")[0];
			if ((node.equals(f) || node.equals(t)) && BesideReach.isStreetId(BesideReach.str(o, "path"))) {
				return BesideReach.str(o, "path");
			}
		}
		return null;
	}

	/** The join's facing at its junction: a side's from its letter (away from the street), else the join node's port facing. */
	private static Direction facingOf(@Nullable JsonObject jnode, @Nullable JsonObject jx) {
		if (jx != null && "side".equals(BesideReach.str(jx, "kind"))) {
			String s = String.valueOf(BesideReach.str(jx, "side"));
			return switch (s) {
				case "n" -> Direction.NORTH;
				case "s" -> Direction.SOUTH;
				case "e" -> Direction.EAST;
				default -> Direction.WEST;
			};
		}
		if (jnode != null && jnode.get("ports") instanceof JsonArray ps && !ps.isEmpty() && ps.get(0) instanceof JsonObject p0) {
			Direction d = Direction.byName(String.valueOf(BesideReach.str(p0, "facing")));
			if (d != null && d.getAxis().isHorizontal()) {
				return d;
			}
		}
		return Direction.NORTH;
	}
}
