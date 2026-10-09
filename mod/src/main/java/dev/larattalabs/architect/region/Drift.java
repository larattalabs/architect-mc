package dev.larattalabs.architect.region;

import java.io.IOException;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.CompletableFuture;
import net.minecraft.nbt.CompoundTag;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.util.Mth;
import net.minecraft.world.level.ChunkPos;
import net.minecraft.world.level.chunk.LevelChunk;
import net.minecraft.world.level.levelgen.Heightmap;
import net.minecraft.world.level.storage.LevelResource;

/**
 * The drift checks (CONTRACT §6 {@code DRIFTED}, Steward S2: "at region start (and per stage)"). At region start ({@link #check})
 * the plan survey's {@code height} against the world now; before each later stage ({@link #checkStage}) the stage's tiles and
 * lots against the region's own baseline there. Up to 4096 sampled columns: |dh| at most 2 on at least 95%, and no column over 8
 * inside a lot box. Loaded chunks are read live; others from their stored heightmap ({@code MOTION_BLOCKING_NO_LEAVES}, read off
 * the server thread), so nothing is loaded or generated. A column of a chunk never generated is skipped.
 */
final class Drift {
	record Result(boolean ok, String message, int sampled, int within2, int over8InLots) {
	}

	private Drift() {
	}

	static CompletableFuture<Result> check(ServerLevel level, RegionsImpl.PlanRec p) {
		Columns plan = planSurvey(level, p.planId());
		if (plan == null) {
			return CompletableFuture.completedFuture(new Result(true, "no plan survey kept: not checked", 0, 0, 0));
		}
		int n = plan.width * plan.depth;
		int step = Math.max(1, (int) Math.ceil(Math.sqrt(n / 4096.0)));
		List<int[]> cols = new ArrayList<>(); // x, z, planHeight, inLot
		for (int j = 0; j < plan.depth; j += step) {
			for (int i = 0; i < plan.width; i += step) {
				int k = plan.index(i, j);
				if (plan.missing(k)) {
					continue;
				}
				int x = plan.minX + i * plan.resolution;
				int z = plan.minZ + j * plan.resolution;
				cols.add(new int[] {x, z, plan.height[k], inLot(p.ir(), x, z) ? 1 : 0});
			}
		}
		return compare(level, cols, "");
	}

	/** The plan's survey as kept with the plan, or null. */
	static @org.jspecify.annotations.Nullable Columns planSurvey(ServerLevel level, String planId) {
		try {
			Path f = RegionStore.plan(level.getServer().getWorldPath(LevelResource.ROOT), planId).resolveSibling(planId + ".survey.bin");
			byte[] a = RegionStore.read(f);
			return a == null ? null : Columns.decode(a);
		} catch (IOException | RuntimeException e) {
			return null;
		}
	}

	/**
	 * The per-stage check (Steward S2, "at region start (and per stage)"), run when a stage after the first is about to start:
	 * up to 4096 columns sampled over the stage's tiles and lot boxes, each compared with what the region expects there now.
	 * The baseline is, in order: the height the region's own placed items left ({@link Heights#after}), else the frozen pre-region
	 * height ({@link Heights#shard}), else the plan survey. Same tolerance as at region start. Server thread; the world's heights
	 * are read as in {@link #check} (loaded chunks live, others from their stored heightmap; nothing loaded or generated).
	 */
	static CompletableFuture<Result> checkStage(ServerLevel level, RegionsImpl.Live l, String stage) {
		Ir ir = l.ir();
		String region = l.rec().id;
		Path world = l.world();
		Columns plan = planSurvey(level, l.rec().planId);
		List<int[]> boxes = new ArrayList<>(); // x0, z0, x1, z1, lot
		List<String> keys = new ArrayList<>(ir.terrainTiles().getOrDefault(stage, List.of()));
		keys.addAll(ir.pathTiles().getOrDefault(stage, List.of()));
		for (String key : keys) {
			int[] t = Ir.tile(key);
			boxes.add(new int[] {Heights.TILE * t[0], Heights.TILE * t[1], Heights.TILE * t[0] + Heights.TILE - 1, Heights.TILE * t[1] + Heights.TILE - 1,
				0});
		}
		for (Ir.Lot lot : ir.lots()) {
			if (lot.stage().equals(stage)) {
				int[] b = lot.box();
				boxes.add(new int[] {b[0], b[2], b[3], b[5], 1});
			}
		}
		long n = 0;
		for (int[] b : boxes) {
			n += (long) (b[2] - b[0] + 1) * (b[3] - b[1] + 1);
		}
		int res = plan == null ? 1 : plan.resolution;
		int step = Math.max(1, (int) Math.ceil(Math.sqrt(n / 4096.0)));
		step = (step + res - 1) / res * res; // on the plan's grid, so the survey is a fallback for every sampled column
		int ox = plan == null ? 0 : plan.minX;
		int oz = plan == null ? 0 : plan.minZ;
		Map<Long, int[]> cols = new java.util.LinkedHashMap<>(); // x, z, expected, inLot
		int[] from = new int[3]; // after, frozen, plan
		for (int[] b : boxes) {
			for (int x = ox + Math.ceilDiv(b[0] - ox, step) * step; x <= b[2]; x += step) {
				for (int z = oz + Math.ceilDiv(b[1] - oz, step) * step; z <= b[3]; z += step) {
					long k = ChunkPos.pack(x, z);
					int[] had = cols.get(k);
					if (had != null) {
						had[3] |= b[4];
						continue;
					}
					int tx = Math.floorDiv(x, Heights.TILE);
					int tz = Math.floorDiv(z, Heights.TILE);
					int exp = expected(Heights.after(world, region, tx, tz), Heights.shard(world, region, tx, tz), plan, x, z, from);
					if (exp != NONE) {
						cols.put(k, new int[] {x, z, exp, b[4]});
					}
				}
			}
		}
		String base = String.format(java.util.Locale.ROOT, " (stage %s; baseline: %d built, %d frozen, %d plan)", stage, from[0], from[1], from[2]);
		return compare(level, new ArrayList<>(cols.values()), base);
	}

	static final int NONE = Integer.MIN_VALUE;

	/**
	 * A column's per-stage baseline: what the region's placed items left ({@code after}), else the frozen pre-region height,
	 * else the plan survey's; {@link #NONE} when none has it. Counts the source in {@code from} (after, frozen, plan).
	 */
	static int expected(Columns after, Columns frozen, @org.jspecify.annotations.Nullable Columns plan, int x, int z, int[] from) {
		int ka = after.at(x, z);
		if (ka >= 0 && !after.missing(ka)) {
			from[0]++;
			return after.height[ka];
		}
		int kf = frozen.at(x, z);
		if (kf >= 0 && !frozen.missing(kf)) {
			from[1]++;
			return frozen.height[kf];
		}
		int kp = plan == null ? -1 : plan.at(x, z);
		if (kp >= 0 && !plan.missing(kp)) {
			from[2]++;
			return plan.height[kp];
		}
		return NONE;
	}

	/** Columns {x, z, expected height, inLot} against the world's heights now. */
	private static CompletableFuture<Result> compare(ServerLevel level, List<int[]> cols, String suffix) {
		Map<Long, List<int[]>> byChunk = new HashMap<>();
		for (int[] c : cols) {
			byChunk.computeIfAbsent(ChunkPos.pack(c[0] >> 4, c[1] >> 4), k -> new ArrayList<>()).add(c);
		}
		Map<Long, int[]> live = new HashMap<>(); // chunk -> 256 heights (top block y), or null
		List<CompletableFuture<Void>> reads = new ArrayList<>();
		int bits = Mth.ceillog2(level.getHeight() + 1);
		int minY = level.getMinY();
		for (long ck : byChunk.keySet()) {
			LevelChunk c = level.getChunkSource().getChunkNow(ChunkPos.getX(ck), ChunkPos.getZ(ck));
			if (c != null) {
				int[] h = new int[256];
				for (int z = 0; z < 16; z++) {
					for (int x = 0; x < 16; x++) {
						h[x + z * 16] = c.getHeight(Heightmap.Types.MOTION_BLOCKING_NO_LEAVES, x, z);
					}
				}
				live.put(ck, h);
				continue;
			}
			reads.add(level.getChunkSource().chunkMap.read(ChunkPos.unpack(ck)).thenAccept((Optional<CompoundTag> t) -> {
				int[] h = t.flatMap(tag -> tag.getCompound("Heightmaps")).flatMap(hm -> hm.getLongArray("MOTION_BLOCKING_NO_LEAVES")).map(arr -> unpack(arr,
					bits, minY)).orElse(null);
				if (h != null && "minecraft:full".equals(t.get().getStringOr("Status", ""))) {
					synchronized (live) {
						live.put(ck, h);
					}
				}
			}).exceptionally(e -> null));
		}
		return CompletableFuture.allOf(reads.toArray(new CompletableFuture[0])).thenApply(v -> {
			int sampled = 0;
			int within = 0;
			int over8 = 0;
			for (var e : byChunk.entrySet()) {
				int[] h;
				synchronized (live) {
					h = live.get(e.getKey());
				}
				if (h == null) {
					continue;
				}
				for (int[] c : e.getValue()) {
					int now = h[(c[0] & 15) + (c[1] & 15) * 16];
					int dh = Math.abs(now - c[2]);
					sampled++;
					within += dh <= 2 ? 1 : 0;
					if (c[3] == 1 && dh > 8) {
						over8++;
					}
				}
			}
			boolean ok = sampled == 0 || within >= 0.95 * sampled && over8 == 0;
			String msg = sampled == 0 ? "no sampled column to compare" : String.format(java.util.Locale.ROOT, "%d of %d sampled columns within 2 (%.1f%%), %d over 8 in lots",
				within, sampled, 100.0 * within / sampled, over8);
			return new Result(ok, msg + suffix, sampled, within, over8);
		});
	}

	/** A packed heightmap (SimpleBitStorage: values never span longs) as top block y per column (x + z * 16). */
	static int[] unpack(long[] data, int bits, int minY) {
		int per = 64 / bits;
		long mask = (1L << bits) - 1;
		int[] out = new int[256];
		for (int i = 0; i < 256; i++) {
			int li = i / per;
			if (li >= data.length) {
				return null;
			}
			int off = (i % per) * bits;
			out[i] = (int) (data[li] >>> off & mask) + minY - 1;
		}
		return out;
	}

	private static boolean inLot(Ir ir, int x, int z) {
		for (Ir.Lot l : ir.lots()) {
			int[] b = l.box();
			if (x >= b[0] && x <= b[3] && z >= b[2] && z <= b[5]) {
				return true;
			}
		}
		return false;
	}
}
