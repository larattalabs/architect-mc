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
 * The drift check at region start (CONTRACT §6 {@code DRIFTED}, Steward S2): the plan survey's {@code height} against the
 * world now, at up to 4096 sampled columns present in both: |dh| at most 2 on at least 95%, and no column over 8 inside a lot
 * box or a path. Loaded chunks are read live; others from their stored heightmap ({@code MOTION_BLOCKING_NO_LEAVES}, read off
 * the server thread), so nothing is loaded or generated. A column of a chunk never generated is skipped.
 */
final class Drift {
	record Result(boolean ok, String message, int sampled, int within2, int over8InLots) {
	}

	private Drift() {
	}

	static CompletableFuture<Result> check(ServerLevel level, RegionsImpl.PlanRec p) {
		Columns plan;
		try {
			Path f = RegionStore.plan(level.getServer().getWorldPath(LevelResource.ROOT), p.planId()).resolveSibling(p.planId() + ".survey.bin");
			byte[] a = RegionStore.read(f);
			if (a == null) {
				return CompletableFuture.completedFuture(new Result(true, "no plan survey kept: not checked", 0, 0, 0));
			}
			plan = Columns.decode(a);
		} catch (IOException | RuntimeException e) {
			return CompletableFuture.completedFuture(new Result(true, "plan survey unreadable: not checked", 0, 0, 0));
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
			return new Result(ok, msg, sampled, within, over8);
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
