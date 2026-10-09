package dev.larattalabs.architect.region;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import dev.larattalabs.architect.journal.WorldJournal;
import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HexFormat;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.zip.GZIPInputStream;
import java.util.zip.GZIPOutputStream;
import net.minecraft.core.BlockPos;
import net.minecraft.nbt.CompoundTag;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.TicketType;
import net.minecraft.world.level.ChunkPos;
import net.minecraft.world.level.block.BushBlock;
import net.minecraft.world.level.block.FallingBlock;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.chunk.LevelChunk;
import org.jspecify.annotations.Nullable;

/**
 * Region-sized world reads for the gate (DevBridge {@code dev.region.hash}, {@code dev.region.snap}, {@code dev.region.diff}),
 * sliced over ticks, 64x64-column tiles, chunks loaded by short-lived tickets (at most 32 at once) and never generated:
 * <ul>
 * <li>hash: SHA-256 per tile over every state and block-entity NBT (y ascending, then z, then x), combined in tile order;</li>
 * <li>snap: the same cells to a gzip file (a palette and one index per cell; BE NBT as text);</li>
 * <li>diff: the box against a snap: every mismatch with its position, the snapped and the current value, and the class of the
 * snapped cell ({@code gravity}: a gravity block over air or fluid; {@code unsupported}: a plant or mushroom that can't
 * survive there now; else {@code none}) for E-normal's classified rule.</li>
 * </ul>
 */
public final class RegionHash {
	static final TicketType TICKET = net.minecraft.core.Registry.register(net.minecraft.core.registries.BuiltInRegistries.TICKET_TYPE,
		dev.larattalabs.architect.Architect.id("region_hash"), new TicketType(0L, TicketType.FLAG_LOADING));
	static final long BUDGET = 8_000_000L;

	enum Mode { HASH, SNAP, DIFF }

	private static final class Job {
		final ServerLevel level;
		final int[] box;
		final List<int[]> exclude;
		final Mode mode;
		final @Nullable Path file;
		final CompletableFuture<JsonObject> future = new CompletableFuture<>();
		final List<int[]> tiles = new ArrayList<>();
		int tile;
		final Set<Long> ticketed = new LinkedHashSet<>();
		MessageDigest all;
		final JsonArray tileHashes = new JsonArray();
		long cells;
		// snap
		DataOutputStream out;
		final Map<String, Integer> palette = new HashMap<>();
		final List<String> paletteList = new ArrayList<>();
		// diff
		DataInputStream in;
		List<String> snapPalette;
		final JsonArray mismatches = new JsonArray();
		final Map<String, Integer> classes = new HashMap<>();
		long mismatchCount;
		final long started = System.nanoTime();

		Job(ServerLevel level, int[] box, List<int[]> exclude, Mode mode, @Nullable Path file) {
			this.level = level;
			this.box = box;
			this.exclude = exclude;
			this.mode = mode;
			this.file = file;
		}
	}

	private static final List<Job> JOBS = new ArrayList<>();

	private RegionHash() {
	}

	public static CompletableFuture<JsonObject> start(ServerLevel level, int[] box, List<int[]> exclude, String mode, @Nullable Path file) {
		Job j = new Job(level, box, exclude, Mode.valueOf(mode.toUpperCase(java.util.Locale.ROOT)), file);
		for (int tx = Math.floorDiv(box[0], 64); tx <= Math.floorDiv(box[3], 64); tx++) {
			for (int tz = Math.floorDiv(box[2], 64); tz <= Math.floorDiv(box[5], 64); tz++) {
				j.tiles.add(new int[] {tx, tz});
			}
		}
		try {
			j.all = MessageDigest.getInstance("SHA-256");
			if (j.mode == Mode.SNAP) {
				Files.createDirectories(file.getParent());
				j.out = new DataOutputStream(new java.io.BufferedOutputStream(new GZIPOutputStream(Files.newOutputStream(file), 1 << 16), 1 << 16));
				j.out.writeInt(box.length);
				for (int v : box) {
					j.out.writeInt(v);
				}
			} else if (j.mode == Mode.DIFF) {
				j.in = new DataInputStream(new java.io.BufferedInputStream(new GZIPInputStream(Files.newInputStream(file), 1 << 16), 1 << 16));
				int n = j.in.readInt();
				for (int i = 0; i < n; i++) {
					if (j.in.readInt() != box[i]) {
						throw new IOException("the snap was taken over another box");
					}
				}
				// the palette is at the end of a snap: read it from a side file
				j.snapPalette = Files.readAllLines(file.resolveSibling(file.getFileName() + ".palette"));
			}
		} catch (Exception e) {
			return CompletableFuture.failedFuture(e);
		}
		level.getServer().execute(() -> JOBS.add(j));
		return j.future;
	}

	public static void tick(MinecraftServer server) {
		if (JOBS.isEmpty()) {
			return;
		}
		Job j = JOBS.get(0);
		long end = System.nanoTime() + BUDGET;
		try {
			while (j.tile < j.tiles.size() && System.nanoTime() < end) {
				int[] t = j.tiles.get(j.tile);
				// ticket this tile's chunks and the next tile's
				for (int ahead = j.tile; ahead < Math.min(j.tiles.size(), j.tile + 2); ahead++) {
					for (long c : chunks(j, j.tiles.get(ahead))) {
						if (j.ticketed.size() >= 48) {
							break;
						}
						if (j.ticketed.add(c)) {
							j.level.getChunkSource().addTicketWithRadius(TICKET, ChunkPos.unpack(c), 0);
						}
					}
				}
				boolean ready = true;
				for (long c : chunks(j, t)) {
					if (j.level.getChunkSource().getChunkNow(ChunkPos.getX(c), ChunkPos.getZ(c)) == null) {
						ready = false;
						break;
					}
				}
				if (!ready) {
					return;
				}
				tileWork(j, t);
				for (long c : chunks(j, t)) {
					if (j.ticketed.remove(c)) {
						j.level.getChunkSource().removeTicketWithRadius(TICKET, ChunkPos.unpack(c), 0);
					}
				}
				j.tile++;
			}
			if (j.tile >= j.tiles.size()) {
				finish(j);
				JOBS.remove(0);
			}
		} catch (Exception e) {
			JOBS.remove(0);
			release(j);
			j.future.completeExceptionally(e);
		}
	}

	private static List<Long> chunks(Job j, int[] t) {
		List<Long> out = new ArrayList<>();
		int x0 = Math.max(j.box[0], t[0] * 64);
		int x1 = Math.min(j.box[3], t[0] * 64 + 63);
		int z0 = Math.max(j.box[2], t[1] * 64);
		int z1 = Math.min(j.box[5], t[1] * 64 + 63);
		for (int cx = x0 >> 4; cx <= x1 >> 4; cx++) {
			for (int cz = z0 >> 4; cz <= z1 >> 4; cz++) {
				out.add(ChunkPos.pack(cx, cz));
			}
		}
		return out;
	}

	private static boolean excluded(Job j, int x, int y, int z) {
		for (int[] e : j.exclude) {
			if (x >= e[0] && y >= e[1] && z >= e[2] && x <= e[3] && y <= e[4] && z <= e[5]) {
				return true;
			}
		}
		return false;
	}

	private static void tileWork(Job j, int[] t) throws IOException {
		int x0 = Math.max(j.box[0], t[0] * 64);
		int x1 = Math.min(j.box[3], t[0] * 64 + 63);
		int z0 = Math.max(j.box[2], t[1] * 64);
		int z1 = Math.min(j.box[5], t[1] * 64 + 63);
		MessageDigest md;
		try {
			md = MessageDigest.getInstance("SHA-256");
		} catch (Exception e) {
			throw new IOException(e);
		}
		BlockPos.MutableBlockPos m = new BlockPos.MutableBlockPos();
		for (int y = j.box[1]; y <= j.box[4]; y++) {
			for (int z = z0; z <= z1; z++) {
				for (int x = x0; x <= x1; x++) {
					if (excluded(j, x, y, z)) {
						continue;
					}
					LevelChunk c = j.level.getChunkSource().getChunkNow(x >> 4, z >> 4);
					BlockState s = c.getBlockState(m.set(x, y, z));
					String v = value(j.level, s, m);
					j.cells++;
					switch (j.mode) {
						case HASH -> {
							md.update(v.getBytes(java.nio.charset.StandardCharsets.UTF_8));
							md.update((byte) 0);
						}
						case SNAP -> {
							Integer k = j.palette.get(v);
							if (k == null) {
								k = j.paletteList.size();
								j.palette.put(v, k);
								j.paletteList.add(v);
							}
							writeVar(j.out, k);
						}
						case DIFF -> {
							String was = j.snapPalette.get(readVar(j.in));
							if (!was.equals(v)) {
								j.mismatchCount++;
								String cls = classify(j.level, m.immutable(), was, v);
								j.classes.merge(cls, 1, Integer::sum);
								if (j.mismatches.size() < 2000) {
									JsonObject o = new JsonObject();
									o.addProperty("pos", x + "," + y + "," + z);
									o.addProperty("was", was);
									o.addProperty("now", v);
									o.addProperty("class", cls);
									j.mismatches.add(o);
								}
							}
						}
						default -> {
						}
					}
				}
			}
		}
		if (j.mode == Mode.HASH) {
			String h = HexFormat.of().formatHex(md.digest());
			j.tileHashes.add(t[0] + "," + t[1] + "=" + h);
			j.all.update(h.getBytes(java.nio.charset.StandardCharsets.UTF_8));
		}
	}

	/** A cell as text: the state and, for a block entity, its saved NBT. */
	static String value(ServerLevel level, BlockState s, BlockPos p) {
		String v = net.minecraft.commands.arguments.blocks.BlockStateParser.serialize(s);
		if (s.hasBlockEntity()) {
			CompoundTag nbt = WorldJournal.beNbt(level, p);
			if (nbt != null) {
				v = v + nbt;
			}
		}
		return v;
	}

	/** E-normal's classifier: whether the snapped (pre-region) cell can't stand on its own. */
	/** Blocks that random ticks grow (phase 6a, the E-normal and forest classifier's {@code growth}). */
	static final java.util.Set<String> GROWS = java.util.Set.of("minecraft:kelp", "minecraft:kelp_plant", "minecraft:sugar_cane", "minecraft:cactus",
		"minecraft:bamboo", "minecraft:bamboo_sapling", "minecraft:vine", "minecraft:cave_vines", "minecraft:cave_vines_plant", "minecraft:weeping_vines",
		"minecraft:weeping_vines_plant", "minecraft:twisting_vines", "minecraft:twisting_vines_plant", "minecraft:wheat", "minecraft:carrots",
		"minecraft:potatoes", "minecraft:beetroots", "minecraft:sweet_berry_bush", "minecraft:cocoa", "minecraft:melon_stem", "minecraft:pumpkin_stem",
		"minecraft:attached_melon_stem", "minecraft:attached_pumpkin_stem", "minecraft:melon", "minecraft:pumpkin", "minecraft:glow_lichen",
		"minecraft:pointed_dripstone", "minecraft:small_amethyst_bud", "minecraft:medium_amethyst_bud", "minecraft:large_amethyst_bud",
		"minecraft:amethyst_cluster", "minecraft:cactus_flower");
	/** Blocks random ticks turn into each other (grass and mycelium spreading onto dirt, and back under a block). */
	static final java.util.Set<String> SPREAD = java.util.Set.of("minecraft:dirt", "minecraft:grass_block", "minecraft:mycelium", "minecraft:podzol");

	static boolean growth(String block) {
		return GROWS.contains(block) || block.endsWith("_sapling");
	}

	static String classify(ServerLevel level, BlockPos p, String was) {
		return classify(level, p, was, null);
	}

	/**
	 * E-normal's classifier. {@code gravity}: the pre-region cell is a gravity block over air or fluid, or one now gone whose
	 * column below holds the same block first (it fell), or the cell is where such a block landed (now a gravity block, before
	 * air or fluid); {@code unsupported}: a plant or mushroom that can't survive there
	 * now; {@code live}: the same block whose block entity changed, on a block the world itself changes ({@link LiveBlocks#LIVE_BE}: bees in
	 * a nest, a furnace, a hopper); else {@code none} (a block-entity change on any other block is unexplained).
	 */
	static String classify(ServerLevel level, BlockPos p, String was, @Nullable String now) {
		if (now != null) {
			String be = LiveBlocks.sameBlockChange(was, now);
			if (be != null) {
				return be;
			}
			String wb = LiveBlocks.block(was);
			String nb = LiveBlocks.block(now);
			if (growth(wb) && (growth(nb) || nb.equals("minecraft:water") || nb.equals("minecraft:air"))
				|| growth(nb) && (wb.equals("minecraft:water") || wb.equals("minecraft:air"))
				|| SPREAD.contains(wb) && SPREAD.contains(nb)) {
				return "growth"; // a random tick grew or spread it (kelp, cane, vines, crops; grass onto dirt): the world's doing
			}
			try {
				BlockState ns = Packed.parse(now.contains("{") ? now.substring(0, now.indexOf('{')) : now);
				BlockState ws = Packed.parse(was.contains("{") ? was.substring(0, was.indexOf('{')) : was);
				if (ns.getBlock() instanceof FallingBlock && (ws.isAir() || !ws.getFluidState().isEmpty())) {
					return "gravity";
				}
			} catch (RuntimeException e) {
				// unparsable: fall through
			}
		}
		BlockState s;
		try {
			s = Packed.parse(was.contains("{") ? was.substring(0, was.indexOf('{')) : was);
		} catch (RuntimeException e) {
			return "none";
		}
		if (s.getBlock() instanceof FallingBlock) {
			BlockState below = level.getBlockState(p.below());
			if (below.isAir() || !below.getFluidState().isEmpty() || FallingBlock.isFree(below)) {
				return "gravity";
			}
			// it fell and air or fluid took its place: the first block down its column is the same block (a fall onto ground)
			BlockState here = level.getBlockState(p);
			if (here.isAir() || here.getBlock() instanceof net.minecraft.world.level.block.LiquidBlock) {
				BlockPos.MutableBlockPos q = p.mutable();
				for (int d = 1; d <= 64 && q.getY() > level.getMinY(); d++) {
					BlockState b = level.getBlockState(q.move(0, -1, 0));
					if (b.isAir() || b.getBlock() instanceof net.minecraft.world.level.block.LiquidBlock) {
						continue;
					}
					if (b.getBlock() == s.getBlock()) {
						return "gravity";
					}
					break;
				}
			}
		}
		if ((s.getBlock() instanceof BushBlock || s.is(net.minecraft.tags.BlockTags.SMALL_FLOWERS) || s.getBlock() instanceof net.minecraft.world.level.block
			.MushroomBlock) && !s.canSurvive(level, p)) {
			return "unsupported";
		}
		return "none";
	}

	private static void finish(Job j) throws IOException {
		release(j);
		JsonObject o = new JsonObject();
		o.addProperty("cells", j.cells);
		o.addProperty("tiles", j.tiles.size());
		o.addProperty("ms", (System.nanoTime() - j.started) / 1e6);
		switch (j.mode) {
			case HASH -> {
				o.addProperty("sha256", HexFormat.of().formatHex(j.all.digest()));
				o.add("tileHashes", j.tileHashes);
			}
			case SNAP -> {
				j.out.close();
				Files.write(j.file.resolveSibling(j.file.getFileName() + ".palette"), j.paletteList);
				o.addProperty("file", j.file.toString());
				o.addProperty("bytes", Files.size(j.file));
				o.addProperty("palette", j.paletteList.size());
			}
			case DIFF -> {
				j.in.close();
				o.addProperty("mismatches", j.mismatchCount);
				JsonObject c = new JsonObject();
				j.classes.forEach(c::addProperty);
				o.add("classes", c);
				o.add("list", j.mismatches);
			}
			default -> {
			}
		}
		j.future.complete(o);
	}

	private static void release(Job j) {
		for (long c : j.ticketed) {
			j.level.getChunkSource().removeTicketWithRadius(TICKET, ChunkPos.unpack(c), 0);
		}
		j.ticketed.clear();
	}

	private static void writeVar(DataOutputStream out, int v) throws IOException {
		while ((v & ~0x7f) != 0) {
			out.write(v & 0x7f | 0x80);
			v >>>= 7;
		}
		out.write(v);
	}

	private static int readVar(DataInputStream in) throws IOException {
		int v = 0;
		int shift = 0;
		while (true) {
			int b = in.readUnsignedByte();
			v |= (b & 0x7f) << shift;
			if ((b & 0x80) == 0) {
				return v;
			}
			shift += 7;
		}
	}

}
