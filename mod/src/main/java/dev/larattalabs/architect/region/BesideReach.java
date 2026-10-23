package dev.larattalabs.architect.region;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import dev.larattalabs.architect.journal.Journal;
import dev.larattalabs.architect.journal.JournalStore;
import dev.larattalabs.architect.journal.SectionCells;
import dev.larattalabs.architect.journal.Sections;
import dev.larattalabs.architect.journal.WorldJournal;
import dev.larattalabs.architect.site.Infra;
import dev.larattalabs.architect.site.Infras;
import java.io.IOException;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.TreeSet;
import java.util.regex.Pattern;
import net.minecraft.core.SectionPos;
import org.jspecify.annotations.Nullable;

/**
 * (6c D3, docs/CONTRACT.md "Phase 6c slice D3" §2.4, §5.1, and the coordinator's deviation of 2026-10-23) The reach inputs of a district
 * plan beside a standing town, the mod's half; kit/lib/region/beside.mjs {@code besideStanding} and kit/test/d3-helpers.mjs are the kit's.
 * <ul>
 * <li>{@link #standing}: the town's whole-claim footprint, its streets, its bodies' hard and watch columns, its lamp spots and its props'
 * columns, from its IR (the kit's {@code besideStanding}, equal on every fixture: {@code BesideReachTest}).</li>
 * <li>{@link #held}: the columns any active journal entry holds over an area (guard leaves excluded), by owner: {@code runs} (all),
 * {@code town} (held only by the standing region's group), {@code terrain} (held only by its terrain-set tiles of stages that hold no
 * {@code props} part: its pads and ground). The district's own group never counts (the realise re-check, §4.4).</li>
 * </ul>
 * Columns travel as row runs {@code [x0, z, x1, z]} (z, then x).
 */
public final class BesideReach {
	private BesideReach() {
	}

	private static final Pattern STREET = Pattern.compile("(^|_)street_|^(route_)?st_");

	/** A road id or graph edge path that names a street (§3.1). */
	public static boolean isStreetId(@Nullable String id) {
		return id != null && STREET.matcher(id).find();
	}

	// ------------------------------------------------------------------ column sets as row runs

	/** A column set: z -> xs. */
	public static final class Cols {
		final TreeMap<Integer, TreeSet<Integer>> rows = new TreeMap<>();

		public void add(int x, int z) {
			rows.computeIfAbsent(z, k -> new TreeSet<>()).add(x);
		}

		public boolean has(int x, int z) {
			TreeSet<Integer> r = rows.get(z);
			return r != null && r.contains(x);
		}

		public int size() {
			int n = 0;
			for (TreeSet<Integer> r : rows.values()) {
				n += r.size();
			}
			return n;
		}

		public boolean isEmpty() {
			return rows.isEmpty();
		}

		public void addRuns(@Nullable JsonArray runs) {
			if (runs == null) {
				return;
			}
			for (JsonElement e : runs) {
				JsonArray q = e.getAsJsonArray();
				for (int z = q.get(1).getAsInt(); z <= q.get(3).getAsInt(); z++) {
					for (int x = q.get(0).getAsInt(); x <= q.get(2).getAsInt(); x++) {
						add(x, z);
					}
				}
			}
		}

		public void addRect(int x0, int z0, int x1, int z1) {
			for (int z = z0; z <= z1; z++) {
				for (int x = x0; x <= x1; x++) {
					add(x, z);
				}
			}
		}

		/** The row runs [x0, z, x1, z], z then x. */
		public JsonArray runs() {
			JsonArray out = new JsonArray();
			for (Map.Entry<Integer, TreeSet<Integer>> row : rows.entrySet()) {
				int z = row.getKey();
				Integer s = null, last = null;
				for (int x : row.getValue()) {
					if (s == null) {
						s = x;
					} else if (x != last + 1) {
						out.add(run(s, z, last));
						s = x;
					}
					last = x;
				}
				if (s != null) {
					out.add(run(s, z, last));
				}
			}
			return out;
		}

		/** [x0, z0, x1, z1] or null when empty. */
		public int @Nullable [] rect() {
			if (rows.isEmpty()) {
				return null;
			}
			int x0 = Integer.MAX_VALUE, x1 = Integer.MIN_VALUE;
			for (TreeSet<Integer> r : rows.values()) {
				x0 = Math.min(x0, r.first());
				x1 = Math.max(x1, r.last());
			}
			return new int[] {x0, rows.firstKey(), x1, rows.lastKey()};
		}

		public void forEach(java.util.function.BiConsumer<Integer, Integer> f) {
			rows.forEach((z, xs) -> xs.forEach(x -> f.accept(x, z)));
		}

		private static JsonArray run(int x0, int z, int x1) {
			JsonArray a = new JsonArray();
			a.add(x0);
			a.add(z);
			a.add(x1);
			a.add(z);
			return a;
		}
	}

	public static Cols colsOf(@Nullable JsonArray runs) {
		Cols c = new Cols();
		c.addRuns(runs);
		return c;
	}

	// ------------------------------------------------------------------ the standing data (besideStanding)

	/** The standing data the reach step reads (the kit's {@code besideStanding}). */
	public static JsonObject standing(String id, int[] claim, JsonObject ir) {
		JsonObject o = new JsonObject();
		o.addProperty("id", id);
		o.add("claim", arr(claim));
		JsonObject fp = new JsonObject();
		JsonArray lots = new JsonArray(), keep = new JsonArray();
		for (BesideCheck.Piece p : BesideCheck.footprint(ir)) {
			if ("lot".equals(p.kind())) {
				lots.add(arr(p.rect()));
			} else {
				JsonObject k = new JsonObject();
				k.addProperty("kind", p.kind());
				k.addProperty("id", p.id());
				k.add("rect", arr(p.rect()));
				keep.add(k);
			}
		}
		// the kit's order: lots, then roads, paths, ways (BesideCheck.footprint keeps lots, roads, paths, ways)
		fp.add("lots", lots);
		fp.add("keep", keep);
		o.add("footprint", fp);
		JsonArray streets = new JsonArray();
		if (ir.get("roads") instanceof JsonArray roads) {
			for (JsonElement e : roads) {
				JsonObject r = e.getAsJsonObject();
				boolean flagged = r.get("ext") instanceof JsonObject ext && ext.has(RegionsImpl.STREET_EXT);
				String rid = str(r, "id");
				if (!flagged && !isStreetId(rid)) {
					continue;
				}
				JsonObject s = new JsonObject();
				s.addProperty("id", rid);
				s.addProperty("width", r.has("width") ? r.get("width").getAsInt() : 3);
				JsonArray pts = new JsonArray();
				for (JsonElement pe : r.getAsJsonArray("points")) {
					JsonArray p = pe.getAsJsonArray();
					JsonArray q = new JsonArray();
					q.add(p.get(0).getAsInt());
					q.add(p.get(1).getAsInt());
					q.add(p.get(2).getAsInt());
					pts.add(q);
				}
				s.add("points", pts);
				s.addProperty("flagged", flagged);
				streets.add(s);
			}
		}
		o.add("streets", streets);
		// the bodies: every fluid op's hard sets (cells, ice, shell, lining, grate, spill, decor, natural joins) and its watch set
		Cols hard = new Cols(), watch = new Cols();
		JsonArray list = new JsonArray();
		Cols lamps = new Cols(), props = new Cols();
		Map<String, int[]> lights = new java.util.LinkedHashMap<>();
		if (ir.get("parts") instanceof JsonArray parts) {
			for (JsonElement pe : parts) {
				JsonObject p = pe.getAsJsonObject();
				String pid = str(p, "id");
				boolean isProps = pid != null && pid.matches("^props(_.*)?$");
				boolean isLamp = isProps && (pid.contains("lamp") || pid.contains("apron"));
				if (!(p.get("ops") instanceof JsonArray ops)) {
					continue;
				}
				for (JsonElement oe : ops) {
					JsonObject op = oe.getAsJsonObject();
					if ("fluid".equals(str(op, "op"))) {
						Cols bh = new Cols(), bw = new Cols();
						for (String k : new String[] {"cells", "ice", "shell", "lining", "grate", "spill", "decor"}) {
							fluidCols(op.get(k), bh);
						}
						if (op.get("joins") instanceof JsonArray js) {
							JsonArray nat = new JsonArray();
							js.forEach(j -> {
								if (j.isJsonArray()) {
									nat.add(j);
								}
							});
							fluidCols(nat, bh);
						}
						fluidCols(op.get("watch"), bw);
						bh.forEach(hard::add);
						bw.forEach(watch::add);
						JsonObject b = new JsonObject();
						b.addProperty("id", str(op, "id"));
						b.add("hard", bh.runs());
						b.add("watch", bw.runs());
						list.add(b);
					}
					if (isProps) {
						opCols(op, props);
						if (isLamp) {
							opCols(op, lamps);
							if ("columns".equals(str(op, "op")) && op.get("cols") instanceof JsonArray cols && op.get("materials") instanceof JsonArray mats) {
								for (int i = 0; i + 4 < cols.size(); i += 5) {
									int mi = cols.get(i + 4).getAsInt();
									int lv = mi >= 0 && mi < mats.size() ? lightLevelOf(mats.get(mi).getAsString()) : 0;
									if (lv > 0) {
										int x = cols.get(i).getAsInt(), y = cols.get(i + 3).getAsInt(), z = cols.get(i + 1).getAsInt();
										lights.put(x + "," + y + "," + z, new int[] {x, y, z, lv});
									}
								}
							}
						}
					}
				}
			}
		}
		// the 4e lanterns of the roads (light.mjs roadLights, both sides listed)
		if (ir.get("roads") instanceof JsonArray roads) {
			for (JsonElement e : roads) {
				JsonObject r = e.getAsJsonObject();
				if (!(r.get("lanterns") instanceof JsonElement l && l.isJsonPrimitive() && l.getAsBoolean())) {
					continue;
				}
				List<int[]> pts = new ArrayList<>();
				for (JsonElement pe : r.getAsJsonArray("points")) {
					JsonArray p = pe.getAsJsonArray();
					pts.add(new int[] {p.get(0).getAsInt(), p.get(2).getAsInt()});
				}
				List<int[]> cells = centreCells(pts);
				int w = r.has("width") ? r.get("width").getAsInt() : 3;
				int lo = -((w - 1) / 2), hi = w / 2;
				double every = 12, first = 6;
				if (r.get("lamp") instanceof JsonObject lamp) {
					every = lamp.get("every").getAsDouble();
					first = lamp.get("first").getAsDouble();
				}
				double since = every - first;
				for (int i = 1; i < cells.size() - 1; i++) {
					since += 1;
					if (since + 1e-9 < every) {
						continue;
					}
					int[] c = cells.get(i), n = cells.get(i + 1);
					int dx = Integer.signum(n[0] - c[0]), dz = Integer.signum(n[1] - c[1]);
					for (int side : new int[] {hi + 1, lo - 1}) {
						lamps.add(c[0] - side * dz, c[1] + side * dx);
					}
					since = 0;
				}
			}
		}
		JsonObject bodies = new JsonObject();
		bodies.add("hard", hard.runs());
		bodies.add("watch", watch.runs());
		bodies.add("list", list);
		o.add("bodies", bodies);
		o.add("lamps", lamps.runs());
		o.add("props", props.runs());
		List<int[]> ls = new ArrayList<>(lights.values());
		ls.sort((a, b) -> a[0] != b[0] ? Integer.compare(a[0], b[0]) : a[2] != b[2] ? Integer.compare(a[2], b[2]) : Integer.compare(a[1], b[1]));
		JsonArray la = new JsonArray();
		ls.forEach(q -> la.add(arr(q)));
		o.add("lights", la);
		return o;
	}

	/** A block state's light level as the lamps write them (the kit's lightLevelOf). */
	static int lightLevelOf(String state) {
		String id = state.replaceAll("\\[.*$", "");
		if (id.matches(".*soul_(lantern|torch|campfire)$")) {
			return 10;
		}
		if (id.matches("(.*:)?(lantern|glowstone|sea_lantern|shroomlight|jack_o_lantern|beacon|ochre_froglight|verdant_froglight|pearlescent_froglight|campfire|redstone_lamp)$")) {
			return 15;
		}
		if (id.matches("(.*:)?(torch|wall_torch|end_rod)$")) {
			return 14;
		}
		return 0;
	}

	private static void fluidCols(@Nullable JsonElement runs, Cols into) {
		if (!(runs instanceof JsonArray a)) {
			return;
		}
		for (JsonElement e : a) {
			if (e instanceof JsonArray q && q.size() == 4) {
				into.add(q.get(0).getAsInt(), q.get(1).getAsInt());
			}
		}
	}

	static void opCols(JsonObject op, Cols into) {
		if ("columns".equals(str(op, "op")) && op.get("cols") instanceof JsonArray cols) {
			for (int i = 0; i + 4 < cols.size(); i += 5) {
				into.add(cols.get(i).getAsInt(), cols.get(i + 1).getAsInt());
			}
		} else if (op.get("bounds") instanceof JsonObject b && b.get("minX") instanceof JsonElement mx && mx.isJsonPrimitive()) {
			into.addRect(b.get("minX").getAsInt(), b.get("minZ").getAsInt(), b.get("maxX").getAsInt(), b.get("maxZ").getAsInt());
		}
	}

	/** lib/region/geom.mjs centreCells (integer points): the 4-connected line of each segment (x first on a tie). [x, z] each. */
	static List<int[]> centreCells(List<int[]> pts) {
		List<int[]> out = new ArrayList<>();
		for (int s = 0; s + 1 < pts.size(); s++) {
			int x0 = pts.get(s)[0], z0 = pts.get(s)[1], x1 = pts.get(s + 1)[0], z1 = pts.get(s + 1)[1];
			int dx = Math.abs(x1 - x0), dz = Math.abs(z1 - z0), sx = x1 > x0 ? 1 : -1, sz = z1 > z0 ? 1 : -1;
			int x = x0, z = z0, ix = 0, iz = 0;
			if (s == 0) {
				out.add(new int[] {x, z});
			}
			while (ix < dx || iz < dz) {
				long tx = (1L + 2L * ix) * dz, tz = (1L + 2L * iz) * dx;
				if (iz >= dz || ix < dx && tx <= tz) {
					x += sx;
					ix++;
				} else {
					z += sz;
					iz++;
				}
				out.add(new int[] {x, z});
			}
		}
		return out;
	}

	// ------------------------------------------------------------------ the held columns (from the journal)

	/** The stages of an IR that hold a {@code props} part (a terrain tile of such a stage may hold a lamp or a prop). */
	public static Set<String> propsStages(JsonObject ir) {
		Set<String> out = new HashSet<>();
		if (ir.get("parts") instanceof JsonArray parts) {
			for (JsonElement e : parts) {
				JsonObject p = e.getAsJsonObject();
				String id = str(p, "id");
				if (id != null && id.matches("^props(_.*)?$") && p.get("stage") instanceof JsonElement st) {
					out.add(st.getAsString());
				}
			}
		}
		return out;
	}

	/**
	 * The held columns over {@code area} [x0, z0, x1, z1] in {@code dimension}: every column holding a cell of an active journal entry
	 * (PLACING counts; guard leaves never), but {@code exceptGroup}'s. {@code town}: the columns only {@code townGroup}'s entries hold;
	 * {@code terrain}: of those, the ones only its terrain tiles of stages outside {@code propsStages} hold. Server thread.
	 */
	public static JsonObject held(String dimension, int[] area, @Nullable String townGroup, Set<String> propsStages, @Nullable String exceptGroup)
		throws IOException {
		return scan(dimension, area, townGroup, propsStages, exceptGroup).json();
	}

	/** One scan of the held columns: per column its owner bits (1 another's, 2 the town's terrain, 4 the town's other) and a site holding it. */
	public record Held(Map<Long, Integer> cls, Map<Long, String> site) {
		public static long key(int x, int z) {
			return ((long) x << 32) | (z & 0xffffffffL);
		}

		public int at(int x, int z) {
			return cls.getOrDefault(key(x, z), 0);
		}

		public @Nullable String siteAt(int x, int z) {
			return site.get(key(x, z));
		}

		public JsonObject json() {
			Cols all = new Cols(), town = new Cols(), terrain = new Cols();
			for (Map.Entry<Long, Integer> e : cls.entrySet()) {
				int x = (int) (e.getKey() >> 32), z = (int) (long) e.getKey();
				int c = e.getValue();
				all.add(x, z);
				if ((c & 1) == 0) {
					town.add(x, z);
					if (c == 2) {
						terrain.add(x, z);
					}
				}
			}
			JsonObject out = new JsonObject();
			out.add("runs", all.runs());
			out.add("town", town.runs());
			out.add("terrain", terrain.runs());
			return out;
		}
	}

	/** {@link #held}'s scan. Server thread. */
	public static Held scan(String dimension, int[] area, @Nullable String townGroup, Set<String> propsStages, @Nullable String exceptGroup)
		throws IOException {
		Map<Long, Integer> cls = new HashMap<>();
		Map<Long, String> sites = new HashMap<>();
		JournalStore store = WorldJournal.storeOrNull();
		if (store == null) {
			return new Held(cls, sites);
		}
		int[] box = {area[0], Integer.MIN_VALUE / 2, area[1], area[2], Integer.MAX_VALUE / 2, area[3]};
		List<JournalStore.Meta> metas = store.find(mm -> mm.active() && !WorldJournal.LEAVES.equals(mm.kind()) && mm.intersects(dimension, box));
		metas.sort(java.util.Comparator.comparing(JournalStore.Meta::id));
		for (JournalStore.Meta m : metas) {
			if (exceptGroup != null && exceptGroup.equals(m.group())) {
				continue;
			}
			int bit;
			if (townGroup != null && townGroup.equals(m.group())) {
				bit = terrainTile(m.site(), propsStages) ? 2 : 4;
			} else {
				bit = 1;
			}
			for (long key : m.sections()) {
				int sx = SectionPos.x(key), sz = SectionPos.z(key);
				if (sx * 16 + 15 < area[0] || sx * 16 > area[2] || sz * 16 + 15 < area[1] || sz * 16 > area[3]) {
					continue;
				}
				SectionCells sc = store.section(m.id(), key);
				if (sc == null) {
					continue;
				}
				for (int k = 0; k < sc.size(); k++) {
					long p = sc.pos(k);
					int x = Journal.x(p), z = Journal.z(p);
					if (x < area[0] || x > area[2] || z < area[1] || z > area[3]) {
						continue;
					}
					long ck = Held.key(x, z);
					cls.merge(ck, bit, (a, b) -> a | b);
					if (bit == 1) {
						sites.put(ck, m.site()); // another site's names the column first
					} else {
						sites.putIfAbsent(ck, m.site());
					}
				}
			}
		}
		return new Held(cls, sites);
	}

	/**
	 * (6c D3, §3.4) Every cell {@code townGroup}'s active entries hold in {@code cols} (any y), each with the block its top town cell says
	 * stands there (that cell's after). Server thread.
	 */
	public static void townCells(String dimension, Cols cols, @Nullable String townGroup, Map<Long, net.minecraft.world.level.block.state.BlockState> out)
		throws IOException {
		JournalStore store = WorldJournal.storeOrNull();
		int[] rect = cols.rect();
		if (store == null || townGroup == null || rect == null) {
			return;
		}
		int[] box = {rect[0], Integer.MIN_VALUE / 2, rect[1], rect[2], Integer.MAX_VALUE / 2, rect[3]};
		Map<Long, long[]> layer = new HashMap<>();
		for (JournalStore.Meta m : store.find(mm -> mm.active() && !WorldJournal.LEAVES.equals(mm.kind()) && townGroup.equals(mm.group()) && mm.intersects(
			dimension, box))) {
			for (long key : m.sections()) {
				int sx = SectionPos.x(key), sz = SectionPos.z(key);
				if (sx * 16 + 15 < rect[0] || sx * 16 > rect[2] || sz * 16 + 15 < rect[1] || sz * 16 > rect[3]) {
					continue;
				}
				SectionCells sc = store.section(m.id(), key);
				if (sc == null) {
					continue;
				}
				for (int k = 0; k < sc.size(); k++) {
					long p = sc.pos(k);
					if (!cols.has(Journal.x(p), Journal.z(p))) {
						continue;
					}
					Journal.Value after = sc.after(k);
					long[] had = layer.get(p);
					if (after == null || had != null && had[0] >= sc.layer(k)) {
						continue;
					}
					layer.put(p, new long[] {sc.layer(k)});
					out.put(p, net.minecraft.nbt.NbtUtils.readBlockState(net.minecraft.core.registries.BuiltInRegistries.BLOCK, after.state()));
				}
			}
		}
	}

	/**
	 * (6c D3, §14 item 9, a DevBridge read) Every active journal cell in {@code cols}, per position its stack bottom first ({@code group, site,
	 * entry, layer, policy}), guard leaves excluded: {@code [{x, y, z, stack}]}, ordered by x, z, y. Server thread.
	 */
	public static JsonArray stacks(String dimension, Cols cols) throws IOException {
		JournalStore store = WorldJournal.storeOrNull();
		int[] rect = cols.rect();
		JsonArray out = new JsonArray();
		if (store == null || rect == null) {
			return out;
		}
		int[] box = {rect[0], Integer.MIN_VALUE / 2, rect[1], rect[2], Integer.MAX_VALUE / 2, rect[3]};
		TreeMap<Long, List<Object[]>> at = new TreeMap<>(); // (x, z, y) packed -> [layer, meta]
		for (JournalStore.Meta m : store.find(mm -> mm.active() && !WorldJournal.LEAVES.equals(mm.kind()) && mm.intersects(dimension, box))) {
			for (long key : m.sections()) {
				int sx = SectionPos.x(key), sz = SectionPos.z(key);
				if (sx * 16 + 15 < rect[0] || sx * 16 > rect[2] || sz * 16 + 15 < rect[1] || sz * 16 > rect[3]) {
					continue;
				}
				SectionCells sc = store.section(m.id(), key);
				if (sc == null) {
					continue;
				}
				for (int k = 0; k < sc.size(); k++) {
					long p = sc.pos(k);
					int x = Journal.x(p), y = Journal.y(p), z = Journal.z(p);
					if (!cols.has(x, z)) {
						continue;
					}
					long ord = ((long) (x + (1 << 25)) << 38) | ((long) (z + (1 << 25)) << 12) | (y + 2048);
					at.computeIfAbsent(ord, q -> new ArrayList<>()).add(new Object[] {sc.layer(k), m, x, y, z});
				}
			}
		}
		for (List<Object[]> l : at.values()) {
			l.sort(java.util.Comparator.comparingLong(a -> (Long) a[0]));
			Object[] f = l.get(0);
			JsonObject o = new JsonObject();
			o.addProperty("x", (Integer) f[2]);
			o.addProperty("y", (Integer) f[3]);
			o.addProperty("z", (Integer) f[4]);
			JsonArray st = new JsonArray();
			for (Object[] a : l) {
				JournalStore.Meta m = (JournalStore.Meta) a[1];
				JsonObject e = new JsonObject();
				e.addProperty("group", m.group());
				e.addProperty("site", m.site());
				e.addProperty("entry", m.id());
				e.addProperty("layer", (Long) a[0]);
				e.addProperty("policy", m.policy().name());
				st.add(e);
			}
			o.add("stack", st);
			out.add(o);
		}
		return out;
	}

	/** Whether a journal entry's site is a region terrain tile of a stage outside {@code propsStages}. */
	static boolean terrainTile(String siteId, Set<String> propsStages) {
		Infra in = Infras.get(siteId);
		if (in == null) {
			in = Infras.pending(siteId);
		}
		if (in == null || !(in.ext().get(dev.larattalabs.architect.site.RegionItems.EXT_TILE) instanceof JsonElement t) || !t.isJsonPrimitive()) {
			return false;
		}
		String[] s = t.getAsString().split("\\|"); // stage|set|key
		return s.length >= 2 && "terrain".equals(s[1]) && !propsStages.contains(s[0]);
	}

	static JsonArray arr(int[] a) {
		JsonArray o = new JsonArray();
		for (int v : a) {
			o.add(v);
		}
		return o;
	}

	static @Nullable String str(JsonObject o, String k) {
		return o.get(k) instanceof JsonElement e && e.isJsonPrimitive() ? e.getAsString() : null;
	}

	/** Sections key helper (kept for symmetry with the kit's runs; unused beyond {@link #held}). */
	static long sectionKey(int x, int y, int z) {
		return Sections.key(x >> 4, y >> 4, z >> 4);
	}
}
