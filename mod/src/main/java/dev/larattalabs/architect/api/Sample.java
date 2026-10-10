package dev.larattalabs.architect.api;

import com.google.gson.JsonArray;
import com.google.gson.JsonNull;
import com.google.gson.JsonObject;
import java.util.ArrayList;
import java.util.BitSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * A terrain survey ({@link Survey#sample}). Columns are indexed {@code i + j * width}: column {@code (i, j)} is the world
 * column {@code (minX + i * resolution, minZ + j * resolution)}. A column in a chunk that was not read is <b>missing</b>:
 * its numbers are {@link #MISSING} and its mask bits are clear.
 *
 * <ul>
 * <li>{@code height}: the y of the highest motion-blocking block, leaves ignored (vanilla
 * {@code MOTION_BLOCKING_NO_LEAVES} minus one, so a block's own y, not the first free y above it);</li>
 * <li>{@code floor}: the same for the ocean floor ({@code OCEAN_FLOOR}: the highest solid block);</li>
 * <li>{@code top}: the block at {@code height} as an index into {@link #blocks()};</li>
 * <li>{@code slope}: the largest height difference to the 4 neighbouring sampled columns (missing neighbours are skipped);</li>
 * <li>{@code water}: water lies above the floor (the top fluid block is water);</li>
 * <li>{@code tree}: logs or leaves stand above the height (or are the top);</li>
 * <li>{@code natural}: the top block is natural terrain (soil, stone, sand, snow, ice, plants, water...), nothing built;</li>
 * <li>{@code biome}: one per 4x4 columns of the area (independent of the resolution), indexes into {@link #biomes()}, -1 missing;</li>
 * <li>{@code ground} (1.12.0): the y of the highest cell that isn't air, a fluid, LOG, LEAVES or PLANT (the kit's
 * {@code voxel_classes.json}, as {@link Survey#volume} classifies): the soil under a tree. Built blocks count, so a roof is
 * ground (a building's own logs, leaves and plants too). On a dry column without trees it equals {@code height}; under water it
 * is the bed. The 1.9.0 constructor copies {@code height}.</li>
 * </ul>
 * The arrays are the sample's own: don't change them.
 */
public record Sample(int minX, int minZ, int maxX, int maxZ, int resolution, int width, int depth, int[] height, int[] floor, int[] top,
	List<String> blocks, int[] slope, BitSet water, BitSet tree, BitSet natural, BitSet missing, int biomeWidth, int biomeDepth, int[] biome,
	List<String> biomes, List<long[]> missingChunks, int chunksLoaded, int[] ground) {
	public static final int MISSING = Integer.MIN_VALUE;

	/** The 1.0 constructor ({@code ground}: a copy of {@code height}). */
	public Sample(int minX, int minZ, int maxX, int maxZ, int resolution, int width, int depth, int[] height, int[] floor, int[] top,
		List<String> blocks, int[] slope, BitSet water, BitSet tree, BitSet natural, BitSet missing, int biomeWidth, int biomeDepth, int[] biome,
		List<String> biomes, List<long[]> missingChunks, int chunksLoaded) {
		this(minX, minZ, maxX, maxZ, resolution, width, depth, height, floor, top, blocks, slope, water, tree, natural, missing, biomeWidth, biomeDepth,
			biome, biomes, missingChunks, chunksLoaded, height.clone());
	}
	/** The largest ASCII grid {@link #summary()} draws, per side. */
	public static final int SUMMARY_GRID = 64;

	public Sample {
		blocks = List.copyOf(blocks);
		biomes = List.copyOf(biomes);
		missingChunks = List.copyOf(missingChunks);
	}

	public int index(int i, int j) {
		return i + j * width;
	}

	public boolean isMissing(int i, int j) {
		return missing.get(index(i, j));
	}

	public int columns() {
		return width * depth;
	}

	/** The world x of sample column {@code i}. */
	public int worldX(int i) {
		return minX + i * resolution;
	}

	public int worldZ(int j) {
		return minZ + j * resolution;
	}

	/** The block id at the top of column (i, j), or null when missing. */
	public String topBlock(int i, int j) {
		int k = top[index(i, j)];
		return k < 0 ? null : blocks.get(k);
	}

	/** The biome id of world column (x, z), or null when outside or missing. */
	public String biomeAt(int x, int z) {
		int bi = Math.floorDiv(x - minX, 4);
		int bj = Math.floorDiv(z - minZ, 4);
		if (bi < 0 || bj < 0 || bi >= biomeWidth || bj >= biomeDepth) {
			return null;
		}
		int k = biome[bi + bj * biomeWidth];
		return k < 0 ? null : biomes.get(k);
	}

	/** The largest height difference from each column to its 4 neighbours; {@link #MISSING} where the column is missing. Pure. */
	public static int[] slopes(int[] height, int width, int depth) {
		int[] out = new int[height.length];
		for (int j = 0; j < depth; j++) {
			for (int i = 0; i < width; i++) {
				int k = i + j * width;
				if (height[k] == MISSING) {
					out[k] = MISSING;
					continue;
				}
				int s = 0;
				int[][] nb = {{i - 1, j}, {i + 1, j}, {i, j - 1}, {i, j + 1}};
				for (int[] n : nb) {
					if (n[0] < 0 || n[1] < 0 || n[0] >= width || n[1] >= depth) {
						continue;
					}
					int h = height[n[0] + n[1] * width];
					if (h != MISSING) {
						s = Math.max(s, Math.abs(h - height[k]));
					}
				}
				out[k] = s;
			}
		}
		return out;
	}

	/**
	 * A summary for a model prompt: stats (columns, missing, height range and mean, water / tree / natural shares, the most
	 * common biomes and top blocks) and an ASCII height grid of at most {@value #SUMMARY_GRID}x{@value #SUMMARY_GRID} (north
	 * up, x to the right): {@code 0-9} the height from the lowest to the highest, {@code ~} water, {@code T} trees, {@code ?}
	 * missing.
	 */
	public String summary() {
		int n = columns();
		int present = n - missing.cardinality();
		int min = Integer.MAX_VALUE;
		int max = Integer.MIN_VALUE;
		long sum = 0;
		for (int k = 0; k < n; k++) {
			if (!missing.get(k)) {
				min = Math.min(min, height[k]);
				max = Math.max(max, height[k]);
				sum += height[k];
			}
		}
		StringBuilder sb = new StringBuilder();
		sb.append(String.format(Locale.ROOT, "survey x %d..%d, z %d..%d, resolution %d: %dx%d columns, %d missing%n", minX, maxX, minZ, maxZ,
			resolution, width, depth, n - present));
		if (present == 0) {
			sb.append("no loaded columns\n");
			return sb.toString();
		}
		sb.append(String.format(Locale.ROOT, "height %d..%d, mean %.1f; water %d%%, trees %d%%, natural %d%%%n", min, max, sum / (double) present,
			pct(water.cardinality(), present), pct(tree.cardinality(), present), pct(natural.cardinality(), present)));
		sb.append("biomes: ").append(top(counts(biome, biomes), 5)).append('\n');
		sb.append("top blocks: ").append(top(counts(top, blocks), 6)).append('\n');
		int step = Math.max(1, (Math.max(width, depth) + SUMMARY_GRID - 1) / SUMMARY_GRID);
		sb.append(String.format(Locale.ROOT, "height grid (1 char = %d sample column%s; 0 = y %d, 9 = y %d):%n", step, step == 1 ? "" : "s", min, max));
		for (int j = 0; j < depth; j += step) {
			for (int i = 0; i < width; i += step) {
				int k = index(i, j);
				char c;
				if (missing.get(k)) {
					c = '?';
				} else if (water.get(k)) {
					c = '~';
				} else if (tree.get(k)) {
					c = 'T';
				} else {
					c = (char) ('0' + (max == min ? 0 : (int) Math.round(9.0 * (height[k] - min) / (max - min))));
				}
				sb.append(c);
			}
			sb.append('\n');
		}
		return sb.toString();
	}

	private static int pct(int a, int b) {
		return b == 0 ? 0 : (int) Math.round(100.0 * a / b);
	}

	private static Map<String, Integer> counts(int[] idx, List<String> names) {
		Map<String, Integer> m = new LinkedHashMap<>();
		for (int k : idx) {
			if (k >= 0) {
				m.merge(names.get(k).replace("minecraft:", ""), 1, Integer::sum);
			}
		}
		return m;
	}

	private static String top(Map<String, Integer> m, int n) {
		List<Map.Entry<String, Integer>> l = new ArrayList<>(m.entrySet());
		l.sort((a, b) -> b.getValue() - a.getValue());
		int total = m.values().stream().mapToInt(Integer::intValue).sum();
		List<String> out = new ArrayList<>();
		for (int i = 0; i < Math.min(n, l.size()); i++) {
			out.add(l.get(i).getKey() + " " + pct(l.get(i).getValue(), total) + "%");
		}
		return out.isEmpty() ? "none" : String.join(", ", out);
	}

	/**
	 * The JSON form (what a job gets as a blob): area, resolution, width, depth, then per column {@code height}, {@code floor},
	 * {@code top}, {@code slope} (null where missing) and the masks {@code water}, {@code tree}, {@code natural},
	 * {@code missing} as 0/1 arrays, {@code blocks} and {@code biomes} palettes, {@code biome} (per 4x4, -1 missing),
	 * {@code missingChunks} ([cx, cz] pairs) and {@code chunksLoaded}.
	 */
	public JsonObject toJson() {
		JsonObject o = new JsonObject();
		JsonObject area = new JsonObject();
		area.addProperty("minX", minX);
		area.addProperty("minZ", minZ);
		area.addProperty("maxX", maxX);
		area.addProperty("maxZ", maxZ);
		o.add("area", area);
		o.addProperty("resolution", resolution);
		o.addProperty("width", width);
		o.addProperty("depth", depth);
		o.add("height", ints(height));
		o.add("floor", ints(floor));
		o.add("ground", ints(ground));
		o.add("top", ints(top));
		o.add("slope", ints(slope));
		o.add("water", bits(water));
		o.add("tree", bits(tree));
		o.add("natural", bits(natural));
		o.add("missing", bits(missing));
		JsonArray bl = new JsonArray();
		blocks.forEach(bl::add);
		o.add("blocks", bl);
		o.addProperty("biomeWidth", biomeWidth);
		o.addProperty("biomeDepth", biomeDepth);
		JsonArray bi = new JsonArray();
		for (int b : biome) {
			bi.add(b);
		}
		o.add("biome", bi);
		JsonArray bs = new JsonArray();
		biomes.forEach(bs::add);
		o.add("biomes", bs);
		JsonArray mc = new JsonArray();
		for (long[] c : missingChunks) {
			JsonArray p = new JsonArray();
			p.add(c[0]);
			p.add(c[1]);
			mc.add(p);
		}
		o.add("missingChunks", mc);
		o.addProperty("chunksLoaded", chunksLoaded);
		return o;
	}

	private JsonArray ints(int[] a) {
		JsonArray out = new JsonArray(a.length);
		for (int k = 0; k < a.length; k++) {
			if (missing.get(k) || a[k] == MISSING) {
				out.add(JsonNull.INSTANCE);
			} else {
				out.add(a[k]);
			}
		}
		return out;
	}

	private JsonArray bits(BitSet b) {
		JsonArray out = new JsonArray(columns());
		for (int k = 0; k < columns(); k++) {
			out.add(b.get(k) ? 1 : 0);
		}
		return out;
	}
}
