package dev.larattalabs.architect.region;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import org.jspecify.annotations.Nullable;

/**
 * What the region ghost (docs/CONTRACT.md phase 6b §3.5) needs of a plan: its tiles up to a stage (both sets), the claim, the lot
 * boxes, the bounds of the ops of floating parts (the floating tint: preview tiles carry no part id, so a cell inside such an op's
 * bounds is tinted floating), the ground y for the far outline and the verdict line. Pure (from the IR and the plan's answer).
 *
 * @param lots {minX, minY, minZ, maxX, maxY, maxZ} per lot (the pad's top row below floorY included)
 * @param floating {minX, minY, minZ, maxX, maxY, maxZ} per op of a floating part
 */
public record GhostPlan(String planId, String irSha, int[] claim, @Nullable String stage, List<String> tiles, List<int[]> lots, List<int[]> floating,
	int groundY, String verdict) {

	public static GhostPlan of(String planId, String irSha, Ir ir, @Nullable String stage, @Nullable JsonObject planned) {
		Set<String> keys = new LinkedHashSet<>();
		for (String st : ir.stages()) {
			keys.addAll(ir.terrainTiles().getOrDefault(st, List.of()));
			keys.addAll(ir.pathTiles().getOrDefault(st, List.of()));
			if (st.equals(stage)) {
				break;
			}
		}
		List<int[]> lots = new ArrayList<>();
		for (Ir.Lot l : ir.lots()) {
			int[] b = l.box();
			lots.add(new int[] {b[0], l.floorY() - 1, b[2], b[3], b[4], b[5]});
		}
		JsonObject j = ir.json();
		Set<String> floatingParts = new LinkedHashSet<>();
		if (j.get("floating") instanceof JsonArray fa) {
			for (JsonElement e : fa) {
				if (e instanceof JsonObject f && f.get("parts") instanceof JsonArray ps) {
					ps.forEach(p -> floatingParts.add(p.getAsString()));
				}
			}
		}
		List<int[]> floating = new ArrayList<>();
		if (j.get("parts") instanceof JsonArray parts) {
			for (JsonElement e : parts) {
				if (!(e instanceof JsonObject p)) {
					continue;
				}
				boolean fl = p.has("floating") && p.get("floating").isJsonPrimitive() && p.get("floating").getAsBoolean() || p.has("id") && floatingParts
					.contains(p.get("id").getAsString());
				if (!fl || !(p.get("ops") instanceof JsonArray ops)) {
					continue;
				}
				for (JsonElement oe : ops) {
					if (oe instanceof JsonObject op && op.get("bounds") instanceof JsonObject b) {
						floating.add(new int[] {b.get("minX").getAsInt(), b.get("minY").getAsInt(), b.get("minZ").getAsInt(), b.get("maxX").getAsInt(), b.get(
							"maxY").getAsInt(), b.get("maxZ").getAsInt()});
					}
				}
			}
		}
		int[] entrance = ir.anchors().get("entrance");
		int groundY = entrance != null ? entrance[1] : (ir.claim()[1] + ir.claim()[4]) / 2;
		long[] bu = ir.budget();
		String report = Wire6b.summary(planned == null ? null : Wire6b.report(planned.get("report")));
		String verdict = "checker " + report + " · budget " + bu[0] + " cells (" + bu[2] + " added, " + bu[1] + " removed)";
		return new GhostPlan(planId, irSha, ir.claim().clone(), stage, List.copyOf(keys), lots, floating, groundY, verdict);
	}

	/** The plan's tiles whose 64x64 columns come within {@code r} blocks of (x, z). */
	public List<String> tilesNear(int x, int z, int r) {
		List<String> out = new ArrayList<>();
		for (String k : tiles) {
			int[] t = Ir.tile(k);
			int x0 = Heights.TILE * t[0];
			int z0 = Heights.TILE * t[1];
			int dx = x < x0 ? x0 - x : x > x0 + Heights.TILE - 1 ? x - (x0 + Heights.TILE - 1) : 0;
			int dz = z < z0 ? z0 - z : z > z0 + Heights.TILE - 1 ? z - (z0 + Heights.TILE - 1) : 0;
			if (dx <= r && dz <= r) {
				out.add(k);
			}
		}
		return out;
	}

	/** The tint kind of a cell: 0 added, 1 removed, 2 path (walk), 3 lot, 4 floating. Pure. */
	public int kind(int x, int y, int z, boolean air, boolean walk) {
		if (air) {
			return 1;
		}
		for (int[] b : lots) {
			if (in(b, x, y, z)) {
				return 3;
			}
		}
		for (int[] b : floating) {
			if (in(b, x, y, z)) {
				return 4;
			}
		}
		return walk ? 2 : 0;
	}

	static boolean in(int[] b, int x, int y, int z) {
		return x >= b[0] && x <= b[3] && y >= b[1] && y <= b[4] && z >= b[2] && z <= b[5];
	}
}
