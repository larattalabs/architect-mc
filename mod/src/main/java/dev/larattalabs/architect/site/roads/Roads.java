package dev.larattalabs.architect.site.roads;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import dev.larattalabs.architect.api.Reason;
import dev.larattalabs.architect.journal.Journal;
import dev.larattalabs.architect.journal.Journal.Value;
import dev.larattalabs.architect.journal.JournalStore;
import dev.larattalabs.architect.journal.SectionCells;
import dev.larattalabs.architect.journal.Sections;
import dev.larattalabs.architect.journal.WorldJournal;
import dev.larattalabs.architect.placement.Anchors;
import java.io.IOException;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import net.minecraft.core.BlockPos;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.resources.Identifier;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.SlabBlock;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.block.state.properties.SlabType;
import org.jspecify.annotations.Nullable;

/**
 * Roads as sites (docs/CONTRACT.md phase 4e "Roads as sites"): a road request planned against the world and the journal
 * ({@link RoadPlan}): a road skips every cell a {@code site} or {@code road} entry owns, and layers over {@code cells} entries
 * (Steward's review, MUST 1). Pure planning glue; the writes are {@code site.InfraJob}, the removal {@code site.Sites}.
 * Server thread.
 */
public final class Roads {
	private Roads() {
	}

	/** A road planned: its plan, the cells it changes (positions and values) and its box; or a refusal. */
	public record Planned(RoadPlan.Plan plan, long[] positions, Value[] values, Anchors.@Nullable Bounds box, @Nullable String refusal,
		@Nullable Reason reason, List<String> notes, List<String> layeredOver) {
		public boolean ok() {
			return refusal == null;
		}
	}

	/**
	 * Plans a road: {@code xs/ys/zs} waypoints, {@code width}, {@code surface}/{@code slab} (null: automatic), lanterns, decks.
	 * {@code owner}/{@code force}: a cell site of another owner under the road refuses {@code OVERLAP_OWNED} unless forced.
	 */
	public static Planned plan(ServerLevel level, int[] xs, int[] ys, int[] zs, int width, @Nullable String surface, @Nullable String slab, boolean lanterns,
		boolean decks, @Nullable String owner, boolean force, java.util.function.Function<String, @Nullable String> ownerOf,
		java.util.function.BiFunction<String, Journal.Status, @Nullable String> busy) {
		String dim = level.dimension().identifier().toString();
		JournalStore js = WorldJournal.storeOrNull();
		Map<Long, String> ownedCache = new HashMap<>();
		Map<String, Integer> layered = new LinkedHashMap<>();
		RoadPlan.Owned owned = (x, y, z) -> {
			long p = Journal.pos(x, y, z);
			if (ownedCache.containsKey(p)) {
				return ownedCache.get(p);
			}
			String o = ownerAt(js, dim, p, layered);
			ownedCache.put(p, o);
			return o;
		};
		RoadPlan.Plan plan = RoadPlan.plan(xs, ys, zs, width, lanterns, decks, new RoadTerrain(level), owned);
		if (plan.refused()) {
			Reason r = Reason.OTHER;
			try {
				r = Reason.valueOf(plan.reason());
			} catch (IllegalArgumentException e) {
				// OTHER
			}
			return new Planned(plan, new long[0], new Value[0], null, plan.refusal(), r, List.of(), List.of());
		}
		BlockState surf = state(surface);
		BlockState sl = state(slab);
		if (sl != null && sl.hasProperty(SlabBlock.TYPE)) {
			sl = sl.setValue(SlabBlock.TYPE, SlabType.BOTTOM);
		}
		Map<Long, Value> cells = new LinkedHashMap<>();
		for (RoadPlan.Op o : plan.ops()) {
			BlockState s = switch (o.block()) {
				case AIR -> Blocks.AIR.defaultBlockState();
				case DIRT_PATH, GRAVEL, PACKED_MUD -> surf != null ? surf : blockOf(o.block().id);
				case PATH_SLAB, STONE_SLAB -> sl != null ? sl : blockOf(o.block().id).setValue(SlabBlock.TYPE, SlabType.BOTTOM);
				case DECK -> blockOf(o.block().id).setValue(SlabBlock.TYPE, SlabType.BOTTOM);
				default -> blockOf(o.block().id);
			};
			cells.put(Journal.pos(o.x(), o.y(), o.z()), WorldJournal.value(s));
		}
		// cell sites under the road: the owner rule and busy entries
		for (String site : layered.keySet()) {
			String o = ownerOf.apply(site);
			if (!force && !java.util.Objects.equals(o, owner)) {
				return new Planned(plan, new long[0], new Value[0], null, "the road runs over cell site " + site + ", owned by " + (o == null ? "the player"
					: o) + "; it needs force", Reason.OVERLAP_OWNED, List.of(), List.of());
			}
			String b = busy.apply(site, Journal.Status.ACTIVE);
			if (b != null) {
				return new Planned(plan, new long[0], new Value[0], null, "the road runs over cell site " + site + ", which " + b, Reason.OVERLAP_BUSY, List.of(),
					List.of());
			}
		}
		long[] pos = new long[cells.size()];
		Value[] vals = new Value[cells.size()];
		int i = 0;
		int[] bb = {Integer.MAX_VALUE, Integer.MAX_VALUE, Integer.MAX_VALUE, Integer.MIN_VALUE, Integer.MIN_VALUE, Integer.MIN_VALUE};
		for (var e : cells.entrySet()) {
			pos[i] = e.getKey();
			vals[i] = e.getValue();
			i++;
			int x = Journal.x(e.getKey());
			int y = Journal.y(e.getKey());
			int z = Journal.z(e.getKey());
			bb[0] = Math.min(bb[0], x);
			bb[1] = Math.min(bb[1], y);
			bb[2] = Math.min(bb[2], z);
			bb[3] = Math.max(bb[3], x);
			bb[4] = Math.max(bb[4], y);
			bb[5] = Math.max(bb[5], z);
		}
		Anchors.Bounds box = pos.length == 0 ? null : new Anchors.Bounds(bb[0], bb[1], bb[2], bb[3], bb[4], bb[5]);
		List<String> notes = new ArrayList<>(plan.notes());
		layered.forEach((site, n) -> notes.add("on top of cell site " + site + " (" + n + " cells)"));
		if (pos.length == 0) {
			return new Planned(plan, pos, vals, null, "the road changes no cell (every column is another site's or blocked)", Reason.OTHER, notes,
				List.copyOf(layered.keySet()));
		}
		return new Planned(plan, pos, vals, box, null, null, notes, List.copyOf(layered.keySet()));
	}

	/** The site whose entry owns {@code pos} when it is a site, crate or road (the road leaves it alone); cell sites are noted in {@code layered}. */
	private static @Nullable String ownerAt(@Nullable JournalStore js, String dim, long pos, Map<String, Integer> layered) {
		if (js == null) {
			return null;
		}
		long key = Sections.key(pos);
		int idx = Sections.index(pos);
		String top = null;
		long topLayer = Long.MIN_VALUE;
		String topKind = null;
		for (String id : js.inSection(dim, key)) {
			JournalStore.Meta m = js.meta(id);
			if (m == null || !m.active() || m.kind().equals(WorldJournal.LEAVES)) {
				continue;
			}
			try {
				SectionCells sc = js.section(id, key);
				int k = sc == null ? -1 : sc.find(idx);
				if (k >= 0 && sc.layer(k) >= topLayer) {
					topLayer = sc.layer(k);
					top = m.site();
					topKind = m.kind();
				}
			} catch (IOException e) {
				return id;
			}
		}
		if (top == null) {
			return null;
		}
		if (topKind.equals(WorldJournal.SITE) || topKind.equals(WorldJournal.DELTA) || topKind.equals(WorldJournal.ROAD) || topKind.equals(WorldJournal.CRATE)) {
			return top;
		}
		layered.merge(top, 1, Integer::sum);
		return null;
	}

	private static @Nullable BlockState state(@Nullable String id) {
		if (id == null || id.isBlank()) {
			return null;
		}
		Identifier key = Identifier.tryParse(id);
		Block b = key == null ? null : BuiltInRegistries.BLOCK.getOptional(key).orElse(null);
		if (b == null || b == Blocks.AIR) {
			throw new IllegalArgumentException("not a block: " + id);
		}
		return b.defaultBlockState();
	}

	private static BlockState blockOf(String id) {
		return BuiltInRegistries.BLOCK.getValue(Identifier.parse(id)).defaultBlockState();
	}

	/** A road record's spec: what made it and its walkway (x, feet, z triples; the handover reads it). */
	public static JsonObject spec(int[] xs, int[] ys, int[] zs, int width, @Nullable String surface, @Nullable String slab, boolean lanterns, boolean decks,
		RoadPlan.Plan plan) {
		JsonObject o = new JsonObject();
		JsonArray pts = new JsonArray();
		for (int i = 0; i < xs.length; i++) {
			JsonArray p = new JsonArray();
			p.add(xs[i]);
			p.add(ys[i]);
			p.add(zs[i]);
			pts.add(p);
		}
		o.add("points", pts);
		o.addProperty("width", width);
		if (surface != null) {
			o.addProperty("surface", surface);
		}
		if (slab != null) {
			o.addProperty("slab", slab);
		}
		o.addProperty("lanterns", lanterns);
		o.addProperty("shallowDecks", decks);
		o.addProperty("policy", "CELL");
		JsonArray walk = new JsonArray();
		for (RoadPlan.Cell c : plan.cells()) {
			walk.add(c.x());
			walk.add(c.feetY());
			walk.add(c.z());
		}
		o.add("walk", walk);
		return o;
	}

	/** A road record's walkway (x, feet, z triples). */
	public static int[] walk(JsonObject spec) {
		if (!spec.has("walk")) {
			return new int[0];
		}
		JsonArray a = spec.getAsJsonArray("walk");
		int[] out = new int[a.size()];
		for (int i = 0; i < out.length; i++) {
			out[i] = a.get(i).getAsInt();
		}
		return out;
	}

	/**
	 * AgentCraft's {@code Road.handover}: which of a removed road's changed cells another standing road runs on (in or beside a
	 * column of its walkway, from 2 below its feet to 3 above). The nearest road takes a cell, then the newest. Returns
	 * position -> road id.
	 */
	public static Map<Long, String> handover(List<Long> changed, Map<String, int[]> walks, Map<String, Long> created) {
		Map<Long, List<Object[]>> columns = new HashMap<>();
		walks.forEach((id, w) -> {
			for (int i = 0; i + 2 < w.length; i += 3) {
				columns.computeIfAbsent(col(w[i], w[i + 2]), k -> new ArrayList<>()).add(new Object[] {id, w[i + 1]});
			}
		});
		Map<Long, String> out = new LinkedHashMap<>();
		if (columns.isEmpty()) {
			return out;
		}
		for (long p : changed) {
			int x = Journal.x(p);
			int y = Journal.y(p);
			int z = Journal.z(p);
			String best = null;
			int bestD = Integer.MAX_VALUE;
			for (int dx = -1; dx <= 1; dx++) {
				for (int dz = -1; dz <= 1; dz++) {
					List<Object[]> at = columns.get(col(x + dx, z + dz));
					if (at == null) {
						continue;
					}
					for (Object[] w : at) {
						int feet = (Integer) w[1];
						if (y < feet - 2 || y > feet + 3) {
							continue;
						}
						String q = (String) w[0];
						int d = dx * dx + dz * dz;
						if (best == null || d < bestD || d == bestD && (created.getOrDefault(q, 0L) > created.getOrDefault(best, 0L)
							|| created.getOrDefault(q, 0L).equals(created.getOrDefault(best, 0L)) && q.compareTo(best) < 0)) {
							best = q;
							bestD = d;
						}
					}
				}
			}
			if (best != null) {
				out.put(p, best);
			}
		}
		return out;
	}

	private static long col(int x, int z) {
		return ((long) x << 32) ^ (z & 0xFFFFFFFFL);
	}

	/** The road's surface and slab cells near a box (the approach's ROAD flag): positions whose road {@code after} is not air. */
	public static it.unimi.dsi.fastutil.longs.LongOpenHashSet roadCells(String dim, Anchors.Bounds area) {
		it.unimi.dsi.fastutil.longs.LongOpenHashSet out = new it.unimi.dsi.fastutil.longs.LongOpenHashSet();
		JournalStore js = WorldJournal.storeOrNull();
		if (js == null) {
			return out;
		}
		for (long k : WorldJournal.sectionsOf(area)) {
			for (String id : js.inSection(dim, k)) {
				JournalStore.Meta m = js.meta(id);
				if (m == null || !m.active() || !m.kind().equals(WorldJournal.ROAD)) {
					continue;
				}
				try {
					SectionCells sc = js.section(id, k);
					if (sc == null) {
						continue;
					}
					for (int i = 0; i < sc.size(); i++) {
						Value a = sc.after(i);
						if (a == null) {
							continue;
						}
						String n = a.name();
						if (!n.equals("minecraft:air") && !n.equals("minecraft:oak_fence") && !n.equals("minecraft:lantern")) {
							out.add(sc.pos(i));
						}
					}
				} catch (IOException e) {
					// unreadable: not a road cell for the approach
				}
			}
		}
		// phase 6a: the walk-surface cells of region paths (stairs, bridge decks, graded roads) count as road surface
		for (dev.larattalabs.architect.site.Infra in : dev.larattalabs.architect.site.Infras.all()) {
			if (!in.dimension().equals(dim) || in.placing() || !in.kind().equals(dev.larattalabs.architect.site.Infra.CELLS + dev.larattalabs.architect.site
				.RegionKinds.PATH) || in.spec() == null || !in.spec().has("walk") || !intersects(in.box(), area)) {
				continue;
			}
			for (long q : dev.larattalabs.architect.site.RegionKinds.walk(in.spec().get("walk").getAsString())) {
				if (area.contains(BlockPos.getX(q), BlockPos.getY(q), BlockPos.getZ(q))) {
					out.add(q);
				}
			}
		}
		return out;
	}

	private static boolean intersects(Anchors.Bounds a, Anchors.Bounds b) {
		return a.minX() <= b.maxX() && b.minX() <= a.maxX() && a.minY() <= b.maxY() && b.minY() <= a.maxY() && a.minZ() <= b.maxZ() && b.minZ() <= a.maxZ();
	}

	/** A position as a BlockPos (helper). */
	static BlockPos at(long p) {
		return BlockPos.of(p);
	}
}
