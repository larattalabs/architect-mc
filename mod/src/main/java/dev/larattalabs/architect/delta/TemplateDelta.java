package dev.larattalabs.architect.delta;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.TreeMap;
import net.minecraft.nbt.CompoundTag;
import net.minecraft.nbt.ListTag;
import net.minecraft.nbt.Tag;
import org.jspecify.annotations.Nullable;

/**
 * The blueprint delta of two versions of one library entry (docs/CONTRACT.md phase 5b "The blueprint delta"): template
 * against template, in design coordinates ({@code d = t - frame.origin}), cell by cell and part by part. The mod's
 * implementation, authoritative for world writes; the kit's {@code kit/tools/diff.mjs} must give the same cell sets on every
 * fixture pair (the equality test). Pure: raw NBT in, data out (the {@code .nbt}'s own {@code blocks} list in file order,
 * never vanilla's re-sorted template, so the {@code parts.nbt} indexes line up). Any thread.
 */
public final class TemplateDelta {
	private TemplateDelta() {
	}

	/** {@code ADDED}, {@code REMOVED}, {@code CHANGED}, {@code UNCHANGED} (the API's {@code PartStatus}). */
	public enum Status {
		ADDED,
		REMOVED,
		CHANGED,
		UNCHANGED
	}

	/** One version as the delta reads it: the raw template, its parts map (may be null), its blueprint JSON (may be null). */
	public record Version(CompoundTag nbt, @Nullable CompoundTag parts, @Nullable JsonObject json) {
	}

	/** A written cell's value: the block state (id and sorted properties) and the block-entity compound. */
	public record CellValue(String id, Map<String, String> props, @Nullable CompoundTag nbt) {
		public CellValue {
			props = java.util.Collections.unmodifiableMap(new TreeMap<>(props));
		}
	}

	/**
	 * A version decoded: design coordinate (packed, {@link #pack}) to its value and its part (-1: none), its part names, its
	 * frame origin, front, feet row, size and the total of written cells.
	 */
	public record Decoded(Map<Long, CellValue> cells, Map<Long, Integer> part, List<String> names, int[] origin, String front, int feet, int[] size,
		boolean approximate, List<Long> order) {
		public @Nullable String partName(long d) {
			Integer i = part.get(d);
			return i == null || i < 0 || i >= names.size() ? null : names.get(i);
		}
	}

	/** Per part: its status, counts, and its box in each version (design coordinates; null when absent). */
	public record Part(String name, Status status, int added, int removed, int changed, int @Nullable [] boxFrom, int @Nullable [] boxTo) {
	}

	/**
	 * The delta: the cell sets (design coordinates, packed), per part, the counts, whether the frame is kept, whether the labels
	 * are approximate, the notes and the frame hint (null: none).
	 */
	public record Result(List<Long> added, List<Long> removed, List<Long> changed, int unchanged, Map<String, Part> parts, boolean frameKept,
		boolean approximate, List<String> notes, int @Nullable [] frameHint, Decoded a, Decoded b) {
	}

	// ------------------------------------------------------------------ decoding

	/** Design coordinates packed as {@code BlockPos.asLong} does (negative coordinates allowed). */
	public static long pack(int x, int y, int z) {
		return net.minecraft.core.BlockPos.asLong(x, y, z);
	}

	public static int x(long p) {
		return net.minecraft.core.BlockPos.getX(p);
	}

	public static int y(long p) {
		return net.minecraft.core.BlockPos.getY(p);
	}

	public static int z(long p) {
		return net.minecraft.core.BlockPos.getZ(p);
	}

	/** The frame origin a blueprint JSON records ({@code frame.origin}); absent (every entry before 5b) = 0,0,0. */
	public static int[] origin(@Nullable JsonObject json) {
		if (json != null && json.get("frame") instanceof JsonObject f && f.get("origin") instanceof com.google.gson.JsonArray a && a.size() == 3) {
			return new int[] {a.get(0).getAsInt(), a.get(1).getAsInt(), a.get(2).getAsInt()};
		}
		return new int[] {0, 0, 0};
	}

	/** Decodes a version: cells in design coordinates in file order, the part of each (exact from parts.nbt, else by box). */
	public static Decoded decode(Version v) {
		CompoundTag t = v.nbt();
		ListTag palette = t.getListOrEmpty("palette");
		if (palette.isEmpty() && !t.getListOrEmpty("palettes").isEmpty()) {
			palette = t.getListOrEmpty("palettes").getListOrEmpty(0);
		}
		List<CellValue> states = new ArrayList<>(palette.size());
		for (int i = 0; i < palette.size(); i++) {
			CompoundTag p = palette.getCompoundOrEmpty(i);
			String id = p.contains("id") ? p.getStringOr("id", "minecraft:air") : p.getStringOr("Name", "minecraft:air");
			CompoundTag pr = p.contains("properties") ? p.getCompoundOrEmpty("properties") : p.getCompoundOrEmpty("Properties");
			Map<String, String> props = new TreeMap<>();
			for (String k : pr.keySet()) {
				props.put(k, pr.getStringOr(k, ""));
			}
			states.add(new CellValue(qualify(id), props, null));
		}
		int[] origin = origin(v.json());
		JsonObject json = v.json();
		String front = json != null && json.has("front") ? json.get("front").getAsString() : "south";
		int groundY = json != null && json.has("groundY") ? json.get("groundY").getAsInt() : 0;
		ListTag sizeTag = t.getListOrEmpty("size");
		int[] size = {sizeTag.getIntOr(0, 0), sizeTag.getIntOr(1, 0), sizeTag.getIntOr(2, 0)};
		ListTag blocks = t.getListOrEmpty("blocks");
		int n = blocks.size();
		// the exact part map, when it lines up with this file's blocks list
		List<String> names = new ArrayList<>();
		int[] idx = null;
		if (v.parts() != null) {
			ListTag nl = v.parts().getListOrEmpty("names");
			int[] ia = v.parts().getIntArray("idx").orElse(null);
			if (ia != null && ia.length == n) {
				for (int i = 0; i < nl.size(); i++) {
					names.add(nl.getStringOr(i, ""));
				}
				idx = ia;
			}
		}
		boolean approximate = idx == null;
		List<Object[]> boxes = new ArrayList<>(); // [name, int[6] template box, volume]
		if (approximate) {
			names.clear();
			if (json != null && json.get("parts") instanceof JsonObject parts) {
				for (Map.Entry<String, JsonElement> e : parts.entrySet()) {
					if (e.getValue() instanceof JsonObject po && po.get("box") instanceof com.google.gson.JsonArray b && b.size() == 6) {
						int[] bb = new int[6];
						for (int i = 0; i < 6; i++) {
							bb[i] = b.get(i).getAsInt();
						}
						long vol = (long) (bb[3] - bb[0] + 1) * (bb[4] - bb[1] + 1) * (bb[5] - bb[2] + 1);
						names.add(e.getKey());
						boxes.add(new Object[] {e.getKey(), bb, vol});
					}
				}
			}
		}
		Map<Long, CellValue> cells = new LinkedHashMap<>(n * 2);
		Map<Long, Integer> part = new HashMap<>(n * 2);
		List<Long> order = new ArrayList<>(n);
		for (int i = 0; i < n; i++) {
			CompoundTag b = blocks.getCompoundOrEmpty(i);
			ListTag pos = b.getListOrEmpty("pos");
			int tx = pos.getIntOr(0, 0);
			int ty = pos.getIntOr(1, 0);
			int tz = pos.getIntOr(2, 0);
			int si = b.getIntOr("state", -1);
			CellValue s = si >= 0 && si < states.size() ? states.get(si) : new CellValue("minecraft:air", Map.of(), null);
			CompoundTag be = b.getCompound("nbt").orElse(null);
			CellValue val = be == null ? s : new CellValue(s.id(), s.props(), be);
			long d = pack(tx - origin[0], ty - origin[1], tz - origin[2]);
			if (!cells.containsKey(d)) {
				order.add(d);
			}
			cells.put(d, val);
			int pi = -1;
			if (idx != null) {
				pi = idx[i] >= 0 && idx[i] < names.size() ? idx[i] : -1;
			} else {
				long best = Long.MAX_VALUE;
				for (int k = 0; k < boxes.size(); k++) {
					int[] bb = (int[]) boxes.get(k)[1];
					long vol = (long) boxes.get(k)[2];
					if (tx >= bb[0] && tx <= bb[3] && ty >= bb[1] && ty <= bb[4] && tz >= bb[2] && tz <= bb[5] && vol < best) {
						best = vol;
						pi = k;
					}
				}
			}
			part.put(d, pi);
		}
		return new Decoded(cells, part, names, origin, front, groundY - origin[1], size, approximate, order);
	}

	private static String qualify(String id) {
		return id.indexOf(':') < 0 ? "minecraft:" + id : id;
	}

	// ------------------------------------------------------------------ the delta

	/**
	 * {@code delta(A, B)}. A version made before 5b has no frame (its origin is unknown): against a framed version it takes the
	 * framed side's origin (its design coordinates did not move); two unframed versions compare at 0,0,0.
	 */
	public static Result delta(Version va, Version vb) {
		boolean fa = framed(va.json());
		boolean fb = framed(vb.json());
		if (fa != fb) {
			Version un = fa ? vb : va;
			int[] o = origin((fa ? va : vb).json());
			JsonObject j = un.json() == null ? new JsonObject() : un.json().deepCopy();
			JsonObject f = new JsonObject();
			com.google.gson.JsonArray a = new com.google.gson.JsonArray();
			for (int v : o) {
				a.add(v);
			}
			f.add("origin", a);
			j.add("frame", f);
			Version borrowed = new Version(un.nbt(), un.parts(), j);
			return fa ? delta(decode(va), decode(borrowed)) : delta(decode(borrowed), decode(vb));
		}
		return delta(decode(va), decode(vb));
	}

	/** The two origins a delta of these versions uses (the unframed side borrows the framed side's; see {@link #delta(Version, Version)}). */
	public static int[][] origins(@Nullable JsonObject a, @Nullable JsonObject b) {
		boolean fa = framed(a);
		boolean fb = framed(b);
		int[] oa = origin(fa || !fb ? a : b);
		int[] ob = origin(fb || !fa ? b : a);
		return new int[][] {oa, ob};
	}

	static boolean framed(@Nullable JsonObject json) {
		return json != null && json.get("frame") instanceof JsonObject f && f.get("origin") instanceof com.google.gson.JsonArray a && a.size() == 3;
	}

	public static Result delta(Decoded a, Decoded b) {
		List<Long> added = new ArrayList<>();
		List<Long> removed = new ArrayList<>();
		List<Long> changed = new ArrayList<>();
		int unchanged = 0;
		Map<String, int[]> counts = new LinkedHashMap<>(); // name -> {added, removed, changed, touched}
		Map<String, int[]> boxA = new LinkedHashMap<>();
		Map<String, int[]> boxB = new LinkedHashMap<>();
		for (long d : a.order()) {
			String pa = a.partName(d);
			if (pa != null) {
				grow(boxA, pa, d);
			}
			CellValue va = a.cells().get(d);
			CellValue vb = b.cells().get(d);
			if (vb == null) {
				removed.add(d);
				if (pa != null) {
					count(counts, pa)[1]++;
				}
			} else if (!va.equals(vb)) {
				changed.add(d);
				String pb = b.partName(d);
				if (pa != null) {
					count(counts, pa)[2]++;
				}
				if (pb != null && !pb.equals(pa)) {
					count(counts, pb)[2]++;
				}
			} else {
				unchanged++;
			}
		}
		for (long d : b.order()) {
			String pb = b.partName(d);
			if (pb != null) {
				grow(boxB, pb, d);
			}
			if (!a.cells().containsKey(d)) {
				added.add(d);
				if (pb != null) {
					count(counts, pb)[0]++;
				}
			}
		}
		Map<String, Part> parts = new LinkedHashMap<>();
		List<String> names = new ArrayList<>(boxA.keySet());
		for (String n : boxB.keySet()) {
			if (!names.contains(n)) {
				names.add(n);
			}
		}
		for (String n : names) {
			int[] c = counts.getOrDefault(n, new int[3]);
			boolean inA = boxA.containsKey(n);
			boolean inB = boxB.containsKey(n);
			Status st = !inA ? Status.ADDED : !inB ? Status.REMOVED : c[0] + c[1] + c[2] > 0 ? Status.CHANGED : Status.UNCHANGED;
			parts.put(n, new Part(n, st, c[0], c[1], c[2], boxA.get(n), boxB.get(n)));
		}
		sort(added);
		sort(removed);
		sort(changed);
		boolean frameKept = a.front().equals(b.front()) && a.feet() == b.feet();
		List<String> notes = new ArrayList<>();
		if (!a.front().equals(b.front())) {
			notes.add("front changed (" + a.front() + " -> " + b.front() + "): placed sites refuse FRAME_CHANGED");
		}
		if (a.feet() != b.feet()) {
			notes.add("entrance feet row changed (" + a.feet() + " -> " + b.feet() + "): placed sites refuse FRAME_CHANGED");
		}
		int[] hint = frameHint(a, b);
		if (hint != null) {
			notes.add("frame moved by " + hint[0] + "," + hint[1] + "," + hint[2] + ": set origin, keep design coordinates");
		}
		return new Result(added, removed, changed, unchanged, parts, frameKept, a.approximate() || b.approximate(), notes, hint, a, b);
	}

	private static int[] count(Map<String, int[]> m, String n) {
		return m.computeIfAbsent(n, k -> new int[3]);
	}

	private static void grow(Map<String, int[]> m, String n, long d) {
		int x = x(d);
		int y = y(d);
		int z = z(d);
		int[] b = m.get(n);
		if (b == null) {
			m.put(n, new int[] {x, y, z, x, y, z});
		} else {
			b[0] = Math.min(b[0], x);
			b[1] = Math.min(b[1], y);
			b[2] = Math.min(b[2], z);
			b[3] = Math.max(b[3], x);
			b[4] = Math.max(b[4], y);
			b[5] = Math.max(b[5], z);
		}
	}

	/** Sorts packed design coordinates by y, z, x (the kit's order). */
	public static void sort(List<Long> cells) {
		cells.sort((p, q) -> {
			int c = Integer.compare(y(p), y(q));
			if (c != 0) {
				return c;
			}
			c = Integer.compare(z(p), z(q));
			return c != 0 ? c : Integer.compare(x(p), x(q));
		});
	}

	/**
	 * The frame hint (docs/HANDOFF-5b.md "Pinned formats"): over the parts present in both versions, when more than half of
	 * their A cells fail to match B at the same design coordinate, the translation v (|v| <= 8 per axis) that makes at least 90%
	 * of a deterministic sample match. Null: no hint.
	 */
	static int @Nullable [] frameHint(Decoded a, Decoded b) {
		java.util.Set<String> inB = new java.util.HashSet<>();
		for (long d : b.order()) {
			String p = b.partName(d);
			if (p != null) {
				inB.add(p);
			}
		}
		List<Long> cand = new ArrayList<>();
		for (long d : a.order()) {
			String p = a.partName(d);
			if (p != null && inB.contains(p)) {
				cand.add(d);
			}
		}
		if (cand.isEmpty()) {
			return null;
		}
		sort(cand);
		int fail = 0;
		for (long d : cand) {
			if (!Objects.equals(a.cells().get(d), b.cells().get(d))) {
				fail++;
			}
		}
		if (fail * 2 <= cand.size()) {
			return null;
		}
		int k = (cand.size() + 1999) / 2000;
		List<Long> sample = new ArrayList<>();
		for (int i = 0; i < cand.size(); i += k) {
			sample.add(cand.get(i));
		}
		int[] best = null;
		int bestHits = -1;
		int bestSum = Integer.MAX_VALUE;
		for (int vx = -8; vx <= 8; vx++) {
			for (int vy = -8; vy <= 8; vy++) {
				for (int vz = -8; vz <= 8; vz++) {
					int hits = 0;
					for (long d : sample) {
						CellValue w = b.cells().get(pack(x(d) + vx, y(d) + vy, z(d) + vz));
						if (w != null && w.equals(a.cells().get(d))) {
							hits++;
						}
					}
					int sum = Math.abs(vx) + Math.abs(vy) + Math.abs(vz);
					// loops run x, y, z ascending: a later v with the same hits and |v| sum never replaces an earlier one
					if (hits > bestHits || hits == bestHits && sum < bestSum) {
						bestHits = hits;
						bestSum = sum;
						best = new int[] {vx, vy, vz};
					}
				}
			}
		}
		if (best == null || (best[0] == 0 && best[1] == 0 && best[2] == 0) || bestHits * 10 < sample.size() * 9) {
			return null;
		}
		return best;
	}

	/** The cell set of a result as {@code [[x,y,z], ...]} lists, for the equality test and DevBridge. */
	public static List<int[]> unpack(List<Long> cells) {
		List<int[]> out = new ArrayList<>(cells.size());
		for (long d : cells) {
			out.add(new int[] {x(d), y(d), z(d)});
		}
		return out;
	}

	/** {@code [x0,y0,z0,x1,y1,z1]} as text (tests). */
	public static String box(int @Nullable [] b) {
		return b == null ? "null" : Arrays.toString(b);
	}

	/** Whether a tag is a compound (raw NBT helpers for callers). */
	public static boolean isCompound(@Nullable Tag t) {
		return t instanceof CompoundTag;
	}
}
