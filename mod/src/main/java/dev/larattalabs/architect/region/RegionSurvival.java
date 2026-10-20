package dev.larattalabs.architect.region;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import dev.larattalabs.architect.survival.SurvivalWorld;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import net.minecraft.server.MinecraftServer;
import net.minecraft.world.level.GameType;
import org.jspecify.annotations.Nullable;

/**
 * (6c RS, docs/CONTRACT.md "Phase 6c slice RS" §3) Regions in survival: the mode (the world's: the survival toggle on in a world whose
 * default game type is not creative), and what a survival IR's {@code survival} member says (its target groups, its creative-only
 * blocks, its paid and held cells over the plan survey). Pure but for the mode.
 */
public final class RegionSurvival {
	private RegionSurvival() {
	}

	/** Whether regions plan, check and realise in survival in this world (mode by world, S-RS-5). */
	public static boolean on(@Nullable MinecraftServer s) {
		return SurvivalWorld.on() && s != null && s.getDefaultGameType() != GameType.CREATIVE;
	}

	/** Whether an IR was planned in survival (it has the {@code survival} member). */
	public static boolean planned(@Nullable JsonObject ir) {
		return ir != null && ir.get("survival") instanceof JsonObject;
	}

	/** A survival IR's target groups, in index order (ARTL v2's group indexes); empty for a creative IR. */
	public static List<String> groups(@Nullable JsonObject ir) {
		List<String> out = new ArrayList<>();
		if (ir != null && ir.get("survival") instanceof JsonObject sv && sv.get("groups") instanceof JsonArray a) {
			for (JsonElement e : a) {
				out.add(e.getAsString());
			}
		}
		return out;
	}

	/** A survival IR's creative-only blocks per group ({@code survival.creativeOnly}: the realise refuses CREATIVE_ONLY_BLOCK). */
	public static Map<String, Map<String, Integer>> creativeOnly(@Nullable JsonObject ir) {
		Map<String, Map<String, Integer>> out = new TreeMap<>();
		if (ir != null && ir.get("survival") instanceof JsonObject sv && sv.get("creativeOnly") instanceof JsonObject co) {
			for (var g : co.entrySet()) {
				Map<String, Integer> b = new TreeMap<>();
				g.getValue().getAsJsonObject().entrySet().forEach(e -> b.put(e.getKey(), e.getValue().getAsInt()));
				out.put(g.getKey(), b);
			}
		}
		return out;
	}

	/** A survival IR's cells over the plan survey, summed: {free, held, paid}. */
	public static long[] cells(@Nullable JsonObject ir) {
		long[] out = new long[3];
		if (ir != null && ir.get("survival") instanceof JsonObject sv && sv.get("cells") instanceof JsonObject c) {
			for (var g : c.entrySet()) {
				JsonObject o = g.getValue().getAsJsonObject();
				out[0] += o.has("free") ? o.get("free").getAsLong() : 0;
				out[1] += o.has("held") ? o.get("held").getAsLong() : 0;
				out[2] += o.has("paid") ? o.get("paid").getAsLong() : 0;
			}
		}
		return out;
	}

	/** Whether a survival region builds anything from a stockpile: a paid or held cell, a lot with an entry, or a 4e road. */
	public static boolean buildsFromStock(JsonObject ir, boolean boundLots) {
		long[] c = cells(ir);
		return c[1] > 0 || c[2] > 0 || boundLots || ir.get("roads") instanceof JsonArray r && !r.isEmpty();
	}

	/** The fluid ops' charged cells: one lava bucket per lava source cell, one iron bars per grate cell (§7.3). */
	public static Map<String, Integer> fluidCharge(JsonObject ir) {
		Map<String, Integer> out = new TreeMap<>();
		if (!(ir.get("parts") instanceof JsonArray parts)) {
			return out;
		}
		for (JsonElement pe : parts) {
			if (!(pe.getAsJsonObject().get("ops") instanceof JsonArray ops)) {
				continue;
			}
			for (JsonElement oe : ops) {
				JsonObject o = oe.getAsJsonObject();
				if (!"fluid".equals(RegionsImpl.str(o, "op", ""))) {
					continue;
				}
				if ("lava".equals(RegionsImpl.str(o, "fluid", "water"))) {
					out.merge("minecraft:lava_bucket", (int) runCells(o.get("cells")), Integer::sum);
				}
				long g = runCells(o.get("grate"));
				if (g > 0) {
					out.merge("minecraft:iron_bars", (int) g, Integer::sum);
				}
			}
		}
		return out;
	}

	/** The cells of column runs [[x, z, y0, y1], ...]. */
	static long runCells(@Nullable JsonElement e) {
		long n = 0;
		if (e instanceof JsonArray a) {
			for (JsonElement r : a) {
				if (r instanceof JsonArray q && q.size() == 4) {
					n += q.get(3).getAsLong() - q.get(2).getAsLong() + 1;
				}
			}
		}
		return n;
	}
}
