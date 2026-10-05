package dev.larattalabs.architect.apiimpl;

import dev.larattalabs.architect.api.Sample;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.BitSet;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.jspecify.annotations.Nullable;

/**
 * The pure part of a survey ({@code Survey.sample}): which columns and 4x4 biome cells an area has, which chunk each lies
 * in, and the arrays a {@link Sample} is built from. The world is read through {@link Columns}, one chunk at a time, so the
 * server side can slice the work over ticks; tests pass a fake. Not thread-safe. Internal.
 */
public final class SurveyGrid {
	/** One sampled column. */
	public record Column(int height, int floor, String top, boolean water, boolean tree, boolean natural) {
	}

	/** The world, read per chunk. */
	public interface Columns {
		Column column(int x, int z);

		@Nullable String biome(int x, int z);
	}

	final int minX;
	final int minZ;
	final int maxX;
	final int maxZ;
	final int resolution;
	final int width;
	final int depth;
	final int biomeWidth;
	final int biomeDepth;
	private final int[] height;
	private final int[] floor;
	private final int[] top;
	private final BitSet water = new BitSet();
	private final BitSet tree = new BitSet();
	private final BitSet natural = new BitSet();
	private final BitSet missing = new BitSet();
	private final int[] biome;
	private final Map<String, Integer> blockIds = new LinkedHashMap<>();
	private final Map<String, Integer> biomeIds = new LinkedHashMap<>();
	private final List<long[]> missingChunks = new ArrayList<>();
	/** Per chunk (key {@link #key}), the column indexes and biome cell indexes it holds. */
	private final Map<Long, int[][]> byChunk = new LinkedHashMap<>();

	/** An area (inclusive block bounds) at the requested resolution ({@link ApiRules#surveyResolution} decides the one used). */
	public SurveyGrid(int minX, int minZ, int maxX, int maxZ, int requestedResolution) {
		this.minX = Math.min(minX, maxX);
		this.minZ = Math.min(minZ, maxZ);
		this.maxX = Math.max(minX, maxX);
		this.maxZ = Math.max(minZ, maxZ);
		int wBlocks = this.maxX - this.minX + 1;
		int dBlocks = this.maxZ - this.minZ + 1;
		resolution = ApiRules.surveyResolution(requestedResolution, wBlocks, dBlocks);
		width = ApiRules.surveyColumns(wBlocks, resolution);
		depth = ApiRules.surveyColumns(dBlocks, resolution);
		biomeWidth = ApiRules.surveyColumns(wBlocks, 4);
		biomeDepth = ApiRules.surveyColumns(dBlocks, 4);
		height = new int[width * depth];
		floor = new int[width * depth];
		top = new int[width * depth];
		biome = new int[biomeWidth * biomeDepth];
		Arrays.fill(height, Sample.MISSING);
		Arrays.fill(floor, Sample.MISSING);
		Arrays.fill(top, -1);
		Arrays.fill(biome, -1);
		missing.set(0, width * depth);
		Map<Long, List<Integer>> cols = new LinkedHashMap<>();
		Map<Long, List<Integer>> cells = new LinkedHashMap<>();
		for (int j = 0; j < depth; j++) {
			for (int i = 0; i < width; i++) {
				cols.computeIfAbsent(key(colX(i) >> 4, colZ(j) >> 4), k -> new ArrayList<>()).add(i + j * width);
			}
		}
		for (int bj = 0; bj < biomeDepth; bj++) {
			for (int bi = 0; bi < biomeWidth; bi++) {
				cells.computeIfAbsent(key(cellX(bi) >> 4, cellZ(bj) >> 4), k -> new ArrayList<>()).add(bi + bj * biomeWidth);
			}
		}
		Set<Long> keys = new LinkedHashSet<>(cols.keySet());
		keys.addAll(cells.keySet());
		for (long k : keys) {
			byChunk.put(k, new int[][] {ints(cols.get(k)), ints(cells.get(k))});
		}
	}

	private static int[] ints(@Nullable List<Integer> l) {
		return l == null ? new int[0] : l.stream().mapToInt(Integer::intValue).toArray();
	}

	public static long key(int cx, int cz) {
		return (long) cx << 32 | (cz & 0xFFFFFFFFL);
	}

	public static int keyX(long k) {
		return (int) (k >> 32);
	}

	public static int keyZ(long k) {
		return (int) k;
	}

	public int colX(int i) {
		return minX + i * resolution;
	}

	public int colZ(int j) {
		return minZ + j * resolution;
	}

	/** The column a biome cell is read at: its centre, clamped into the area. */
	public int cellX(int bi) {
		return Math.min(maxX, minX + bi * 4 + 2);
	}

	public int cellZ(int bj) {
		return Math.min(maxZ, minZ + bj * 4 + 2);
	}

	public int resolution() {
		return resolution;
	}

	/** The chunks to read, in order (keys, {@link #keyX}/{@link #keyZ}). */
	public List<Long> chunks() {
		return List.copyOf(byChunk.keySet());
	}

	/** Reads every column and biome cell of chunk {@code k} from {@code src}. */
	public void sample(long k, Columns src) {
		int[][] in = byChunk.get(k);
		if (in == null) {
			return;
		}
		for (int idx : in[0]) {
			Column c = src.column(colX(idx % width), colZ(idx / width));
			height[idx] = c.height();
			floor[idx] = c.floor();
			top[idx] = blockIds.computeIfAbsent(c.top(), x -> blockIds.size());
			water.set(idx, c.water());
			tree.set(idx, c.tree());
			natural.set(idx, c.natural());
			missing.clear(idx);
		}
		for (int idx : in[1]) {
			String b = src.biome(cellX(idx % biomeWidth), cellZ(idx / biomeWidth));
			biome[idx] = b == null ? -1 : biomeIds.computeIfAbsent(b, x -> biomeIds.size());
		}
	}

	/** Chunk {@code k} was not read: its columns stay missing. */
	public void miss(long k) {
		if (byChunk.containsKey(k)) {
			missingChunks.add(new long[] {keyX(k), keyZ(k)});
		}
	}

	/** The finished sample. */
	public Sample finish(int chunksLoaded) {
		return new Sample(minX, minZ, maxX, maxZ, resolution, width, depth, height, floor, top, List.copyOf(blockIds.keySet()),
			Sample.slopes(height, width, depth), water, tree, natural, missing, biomeWidth, biomeDepth, biome, List.copyOf(biomeIds.keySet()),
			missingChunks, chunksLoaded);
	}

	/** Reads everything at once (tests, small areas). {@code loaded}: whether a chunk can be read. */
	public Sample sampleAll(java.util.function.LongPredicate loaded, Columns src) {
		for (long k : chunks()) {
			if (loaded.test(k)) {
				sample(k, src);
			} else {
				miss(k);
			}
		}
		return finish(0);
	}
}
