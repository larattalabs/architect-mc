package dev.larattalabs.architect.region;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonPrimitive;
import dev.larattalabs.architect.placement.GhostModel;
import it.unimi.dsi.fastutil.longs.Long2IntOpenHashMap;
import it.unimi.dsi.fastutil.longs.LongOpenHashSet;
import java.util.ArrayList;
import java.util.List;
import net.minecraft.commands.arguments.blocks.BlockStateParser;
import net.minecraft.core.BlockPos;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.world.level.block.state.BlockState;
import org.jspecify.annotations.Nullable;

/**
 * (7a GM-a, docs/CONTRACT.md "Slice GM" §5, §7, §15) A gatehouse lot's gate mechanism at bind: the IR lot's {@code mechanismWrite}
 * ({@code {palette, base: [x, y, z, i, ...], rungs: [{roof, sensor, beside, cells}]}}, the kit's {@code gmGate.mjs gmRecord}), the
 * sensor's rung picked from the bound design, and the cells the realise writes (one region cells item after the lot, journaled as the
 * region's; the design never writes them: {@link dev.larattalabs.architect.site.LotMask#EXT_MECHANISM}).
 *
 * <p><b>The bind rule (§15 item 2):</b> rung R's sensor cell is the design's roof row over the sensor column when the design, fitted
 * as the realise fits it, has a block at one of the two roof cells beside the sensor across the passage ({@code beside}) and none in the
 * sensor's column above it; the lowest such rung wins. The world above the lot's box is the plan's (K3's pad keeps 40 clear over its
 * floor), so it is not read. No rung: the gate is levers-only (§15 item 3): the base alone, no sensor block, deviation
 * {@code mechanism.sensor}. Pure but for the state parse.
 */
public final class GateMech {
	private GateMech() {
	}

	/** The IR lot member the kit writes. */
	public static final String IR_WRITE = "mechanismWrite";
	/** The lot site's and the region's report key: {@code {kind?, roof, sensor, deviation?}}. */
	public static final String EXT_REPORT = "architect_mc:gateMechanism";
	/** The deviation a gate with no sky-exposed rung notes (§2a "No sky cell", §15 item 3). */
	public static final String DEVIATION_SENSOR = "mechanism.sensor";

	/**
	 * The chosen write.
	 *
	 * @param positions the packed positions written (the mask)
	 * @param states the state per written cell, in write order with {@code positions}
	 * @param roof the sensor's roof row (world y), or null (levers-only)
	 * @param sensor the sensor's cell {@code [x, y, z]}, or null
	 */
	public record Plan(long[] positions, BlockState[] states, @Nullable Integer roof, int @Nullable [] sensor, int filled, java.util.SortedMap<String, Integer> bill) {
		public Plan(long[] positions, BlockState[] states, @Nullable Integer roof, int @Nullable [] sensor) {
			this(positions, states, roof, sensor, 0, billOf(states));
		}

		public boolean leversOnly() {
			return sensor == null;
		}

		/** (7a GM-a2) The bill's report value {@code {item: n}}, items in code-point order. */
		public JsonObject billJson() {
			JsonObject o = new JsonObject();
			bill.forEach(o::addProperty);
			return o;
		}

		/** The report: {@code {roof, sensor}} or {@code {deviation: mechanism.sensor}}. */
		public JsonObject report(@Nullable String kind) {
			JsonObject o = new JsonObject();
			if (kind != null) {
				o.addProperty("kind", kind);
			}
			o.addProperty("cells", positions.length);
			// ((7a GM-a2, §16 items 1 and 3) the exact bill at bind, and the roof cells it fills)
			o.add("bom", billJson());
			if (filled > 0) {
				o.addProperty("fill", filled);
			}
			if (sensor != null) {
				o.addProperty("roof", roof);
				JsonArray a = new JsonArray();
				for (int v : sensor) {
					a.add(v);
				}
				o.add("sensor", a);
			} else {
				o.addProperty("deviation", DEVIATION_SENSOR);
			}
			return o;
		}

		/** The mask's ext value {@code {cells: [flat runs]}} (one run per cell: the mask reads runs). */
		public JsonObject maskExt() {
			JsonArray flat = new JsonArray();
			for (long p : positions) {
				flat.add(BlockPos.getX(p));
				flat.add(BlockPos.getZ(p));
				flat.add(BlockPos.getY(p));
				flat.add(BlockPos.getY(p));
			}
			JsonObject o = new JsonObject();
			o.add("cells", flat);
			return o;
		}
	}

	/**
	 * (7a GM-a2, §16 item 1) What written states cost in survival (C26's rules, {@code Cells.cost}: a piston head and a moving piston nothing,
	 * a wall torch its standing item, air nothing), summed per item.
	 */
	public static java.util.SortedMap<String, Integer> billOf(BlockState[] states) {
		return dev.larattalabs.architect.site.MechCharges.billOf(states);
	}

	/** The IR lot's write data, or null (no mechanism). */
	public static @Nullable JsonObject writeOf(Ir ir, String lotId) {
		if (ir.json().get("lots") instanceof JsonArray lots) {
			for (JsonElement e : lots) {
				if (e instanceof JsonObject lo && lo.get("id") instanceof JsonPrimitive id && lotId.equals(id.getAsString())) {
					return lo.get(IR_WRITE) instanceof JsonObject w && w.get("base") instanceof JsonArray ? w : null;
				}
			}
		}
		return null;
	}

	/**
	 * (GM-b, CONTRACT GM §17 item 4) The IR's K1 swing gates' write data ({@code gateMechanisms: [{gate, wall, kind, stage, palette, base}]},
	 * the kit's {@code k1SwingRecord}), each with a base; empty when the plan has none.
	 */
	public static List<JsonObject> gateWrites(Ir ir) {
		List<JsonObject> out = new ArrayList<>();
		if (ir.json().get("gateMechanisms") instanceof JsonArray a) {
			for (JsonElement e : a) {
				if (e instanceof JsonObject o && o.get("gate") instanceof JsonPrimitive && o.get("base") instanceof JsonArray) {
					out.add(o);
				}
			}
		}
		return out;
	}

	/** (GM-b) A K1 swing gate's report: {@code {kind, wall, cells, bom}} (no rung, no sensor: a swing is not day-driven). */
	public static JsonObject gateReport(JsonObject write, Plan gm) {
		JsonObject o = new JsonObject();
		o.addProperty("kind", write.get("kind") instanceof JsonPrimitive k ? k.getAsString() : "swing");
		if (write.get("wall") instanceof JsonPrimitive w) {
			o.addProperty("wall", w.getAsString());
		}
		o.addProperty("cells", gm.positions().length);
		o.add("bom", gm.billJson());
		return o;
	}

	/** The IR lot's mechanism kind ({@code onWall.passage.mechanism.kind}), or null. */
	public static @Nullable String kindOf(Ir ir, String lotId) {
		if (ir.json().get("lots") instanceof JsonArray lots) {
			for (JsonElement e : lots) {
				if (e instanceof JsonObject lo && lo.get("id") instanceof JsonPrimitive id && lotId.equals(id.getAsString()) && lo.get("onWall") instanceof JsonObject w
					&& w.get("passage") instanceof JsonObject p && p.get("mechanism") instanceof JsonObject m && m.get("kind") instanceof JsonPrimitive k) {
					return k.getAsString();
				}
			}
		}
		return null;
	}

	/**
	 * The design's occupancy, fitted: per column (packed x, z) its highest non-air block's y, and the set of non-air positions. {@code m}
	 * and {@code states} as {@link WallLotCheck#placed}. Null grid: an empty design.
	 */
	record Design(LongOpenHashSet solid, Long2IntOpenHashMap top) {
		static Design of(@Nullable GhostModel m, @Nullable BlockState[] states, int ox, int oy, int oz) {
			LongOpenHashSet solid = new LongOpenHashSet();
			Long2IntOpenHashMap top = new Long2IntOpenHashMap();
			top.defaultReturnValue(Integer.MIN_VALUE);
			if (m != null && states != null) {
				for (int i = 0; i < m.count(); i++) {
					if (states[i].isAir()) {
						continue;
					}
					int x = ox + m.x(i), y = oy + m.y(i), z = oz + m.z(i);
					solid.add(BlockPos.asLong(x, y, z));
					long col = BlockPos.asLong(x, 0, z);
					if (y > top.get(col)) {
						top.put(col, y);
					}
				}
			}
			return new Design(solid, top);
		}
	}

	/** The rung index the bind rule picks over a fitted design, or -1 (levers-only). Pure. */
	static int pickRung(JsonObject write, Design d) {
		if (!(write.get("rungs") instanceof JsonArray rungs)) {
			return -1;
		}
		for (int i = 0; i < rungs.size(); i++) {
			if (!(rungs.get(i) instanceof JsonObject g) || !(g.get("sensor") instanceof JsonArray s) || s.size() != 3 || !(g.get("beside") instanceof JsonArray b)) {
				continue;
			}
			int x = s.get(0).getAsInt(), y = s.get(1).getAsInt(), z = s.get(2).getAsInt();
			boolean roofBeside = false;
			for (int k = 0; k + 2 < b.size(); k += 3) {
				if (d.solid().contains(BlockPos.asLong(b.get(k).getAsInt(), b.get(k + 1).getAsInt(), b.get(k + 2).getAsInt()))) {
					roofBeside = true;
				}
			}
			boolean sky = d.top().get(BlockPos.asLong(x, 0, z)) <= y;
			if (roofBeside && sky) {
				return i;
			}
		}
		return -1;
	}

	/**
	 * The cells to write for a bound design (fitted: {@code m}, {@code states} at {@code ox, oy, oz}): the base, then the picked rung's
	 * cells (none when levers-only). A cell listed twice keeps its last state. Unparseable states are skipped (never throws on the IR).
	 */
	public static Plan plan(JsonObject write, @Nullable GhostModel m, @Nullable BlockState @Nullable [] states, int ox, int oy, int oz) {
		return planOver(write, Design.of(m, states, ox, oy, oz));
	}

	/** {@link #plan} over a design's occupancy. Pure but for the state parse. */
	static Plan planOver(JsonObject write, Design d) {
		int rung = pickRung(write, d);
		List<BlockState> pal = palette(write);
		java.util.LinkedHashMap<Long, BlockState> out = new java.util.LinkedHashMap<>();
		add(write.getAsJsonArray("base"), pal, out);
		Integer roof = null;
		int[] sensor = null;
		if (rung >= 0) {
			JsonObject g = write.getAsJsonArray("rungs").get(rung).getAsJsonObject();
			add(g.getAsJsonArray("cells"), pal, out);
			JsonArray s = g.getAsJsonArray("sensor");
			sensor = new int[] {s.get(0).getAsInt(), s.get(1).getAsInt(), s.get(2).getAsInt()};
			roof = sensor[1];
		}
		int filled = rung >= 0 ? fill(write, d, pal, roof, out) : 0;
		long[] pos = new long[out.size()];
		BlockState[] st = new BlockState[out.size()];
		int i = 0;
		for (var en : out.entrySet()) {
			pos[i] = en.getKey();
			st[i++] = en.getValue();
		}
		return new Plan(pos, st, roof, sensor, filled, billOf(st));
	}

	/**
	 * (7a GM-a2, CONTRACT GM §16 item 3, as built) The roof fill: every rung cell the picked rung does not write, at or above the bound roof
	 * row, that the design left empty and that has a design block beside it across the passage (the roof course it is a hole in, the bind
	 * rule's {@code beside} test) gets the structure block ({@code fill}, the palette's), after the rest. A cell with nothing of the design
	 * beside it (above a flat roof, open sky) stays as the design left it: the fill closes holes, it never adds a bump. Returns how many.
	 */
	static int fill(JsonObject write, Design d, List<BlockState> pal, int roof, java.util.Map<Long, BlockState> out) {
		if (!(write.get("fill") instanceof JsonPrimitive fp) || !(write.get("rungs") instanceof JsonArray rungs) || rungs.isEmpty()) {
			return 0;
		}
		int fi = fp.getAsInt();
		BlockState fs = fi >= 0 && fi < pal.size() ? pal.get(fi) : null;
		if (fs == null || !(rungs.get(0) instanceof JsonObject g0) || !(g0.get("beside") instanceof JsonArray b) || b.size() != 6) {
			return 0;
		}
		// the across-passage step from the beside cells (sensor - du, sensor + du)
		int dx = (b.get(3).getAsInt() - b.get(0).getAsInt()) / 2, dy = (b.get(4).getAsInt() - b.get(1).getAsInt()) / 2, dz = (b.get(5).getAsInt() - b.get(2)
			.getAsInt()) / 2;
		java.util.TreeSet<Long> cand = new java.util.TreeSet<>();
		for (JsonElement ge : rungs) {
			if (ge instanceof JsonObject g && g.get("cells") instanceof JsonArray flat) {
				for (int i = 0; i + 3 < flat.size(); i += 4) {
					int x = flat.get(i).getAsInt(), y = flat.get(i + 1).getAsInt(), z = flat.get(i + 2).getAsInt();
					long p = BlockPos.asLong(x, y, z);
					if (y >= roof && !out.containsKey(p) && !d.solid().contains(p) && (d.solid().contains(BlockPos.asLong(x + dx, y + dy, z + dz)) || d.solid()
						.contains(BlockPos.asLong(x - dx, y - dy, z - dz)))) {
						cand.add(p);
					}
				}
			}
		}
		for (long p : cand) {
			out.put(p, fs);
		}
		return cand.size();
	}

	private static List<BlockState> palette(JsonObject write) {
		List<BlockState> out = new ArrayList<>();
		if (write.get("palette") instanceof JsonArray a) {
			for (JsonElement e : a) {
				BlockState s = null;
				try {
					s = BlockStateParser.parseForBlock(BuiltInRegistries.BLOCK, e.getAsString(), false).blockState();
				} catch (Exception ex) {
					s = null;
				}
				out.add(s);
			}
		}
		return out;
	}

	private static void add(@Nullable JsonArray flat, List<BlockState> pal, java.util.Map<Long, BlockState> out) {
		if (flat == null) {
			return;
		}
		for (int i = 0; i + 3 < flat.size(); i += 4) {
			int k = flat.get(i + 3).getAsInt();
			BlockState s = k >= 0 && k < pal.size() ? pal.get(k) : null;
			if (s == null) {
				continue;
			}
			long p = BlockPos.asLong(flat.get(i).getAsInt(), flat.get(i + 1).getAsInt(), flat.get(i + 2).getAsInt());
			out.remove(p);
			out.put(p, s);
		}
	}
}
