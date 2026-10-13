package dev.larattalabs.architect.client.dev;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import dev.larattalabs.architect.client.world.ServerTasks;
import dev.larattalabs.architect.placement.Blueprints;
import dev.larattalabs.architect.region.Packed;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.TreeMap;
import java.util.zip.CRC32;
import java.util.zip.Deflater;
import net.fabricmc.loader.api.FabricLoader;
import net.minecraft.commands.arguments.blocks.BlockStateParser;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Holder;
import net.minecraft.core.Registry;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.core.registries.Registries;
import net.minecraft.resources.Identifier;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.util.RandomSource;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.levelgen.FlatLevelSource;
import net.minecraft.world.level.levelgen.feature.Feature;

/**
 * Phase 6c slice F2 DevBridge hooks (docs/DEVBRIDGE.md; CONTRACT F2 §4): the stamp harvester. {@code dev.feature.stamp} places a
 * configured vanilla feature ({@code Registries.FEATURE}) in a scratch superflat world at a fixed spot over a ground template,
 * captures the cells it wrote (a diff against the template) and writes them as a stamp, {@code <dir>/<feature>/<seed>.bin}: gzip
 * (pinned header: mtime 0, OS byte 255) of ARSP bytes (kit/REGIONS.md "Kit 0.22.0"). The library is local-only (Noah, N-F2-1): the
 * default dir is the game's own {@code architect/stamps}, never the repo or the jar. One server task per seed: reset the box to
 * the template, snapshot, place with {@code RandomSource.create(seed)}, diff, reset again, so no tick runs between and a re-harvest on
 * the same version gives the same bytes. Server work only (also headless: devserver genHooks).
 */
public final class SliceF2Dev {
	/** The fixed spot's column and the box's half width around it. */
	static final int SPOT_X = 8;
	static final int SPOT_Z = 8;
	static final int HALF = 20;
	/** How high above the template's surface the box reaches. */
	static final int ABOVE = 48;
	/** The ground templates: their surface y over the world's bottom (superflat's own is 3: bedrock, dirt, dirt, grass). */
	static final Map<String, Integer> SURFACE = Map.of("stone", 40, "cave", 40);
	/** cave: the air pocket's floor and height over the bottom (stone above and below it, a 2-cell rim around it). */
	static final int CAVE_FLOOR = 20;
	static final int CAVE_HEIGHT = 9;
	static final int FLAGS = Block.UPDATE_CLIENTS | Block.UPDATE_KNOWN_SHAPE | Block.UPDATE_SUPPRESS_DROPS;

	private SliceF2Dev() {
	}

	public static void init() {
		DevBridge.register("dev.feature.stamp", 600_000, "{feature: 'minecraft:oak', seeds: [1, ...], ground?: 'grass_block'|<block>|'stone'|'cave', "
			+ "dir?} - (6c F2) harvest stamps: place the configured feature in this scratch superflat world at the fixed spot over the ground "
			+ "template, capture the cells it wrote, write <dir>/<feature path>/<seed>.bin (gzip ARSP; default dir <game>/architect/stamps) "
			+ "-> {feature, ground, dir, stamps: [{seed, placed, cells, size, root, palette, sha, file, blockEntities, edge}]}", (req, mc) -> {
				Fields f = Fields.of(req);
				String feature = f.nonBlank("feature");
				JsonArray seeds = req.getAsJsonArray("seeds");
				if (seeds == null || seeds.isEmpty() || seeds.size() > 64) {
					throw new DevBridge.DevException("field 'seeds' must be an array of 1..64 integers");
				}
				String ground = f.has("ground") ? f.nonBlank("ground") : "grass_block";
				Path dir = f.has("dir") ? Path.of(f.nonBlank("dir")) : Blueprints.gameDataDir().resolve("stamps");
				Path base = dir.isAbsolute() ? dir : FabricLoader.getInstance().getGameDir().resolve(dir);
				List<Long> seedList = new ArrayList<>();
				seeds.forEach(e -> seedList.add(e.getAsLong()));
				return ServerTasks.callAsPlayer((level, player) -> harvest(level, feature, seedList, ground, base));
			});
	}

	/** The ground template's cell at (y over the world's bottom `dy`, horizontal offset from the spot `ox`, `oz`). */
	static BlockState template(String ground, int dy, int ox, int oz) {
		if (dy == 0) {
			return Blocks.BEDROCK.defaultBlockState();
		}
		if ("stone".equals(ground)) {
			return dy <= SURFACE.get("stone") ? Blocks.STONE.defaultBlockState() : Blocks.AIR.defaultBlockState();
		}
		if ("cave".equals(ground)) {
			boolean pocket = dy >= CAVE_FLOOR && dy < CAVE_FLOOR + CAVE_HEIGHT && Math.abs(ox) <= HALF - 2 && Math.abs(oz) <= HALF - 2;
			return dy <= SURFACE.get("cave") && !pocket ? Blocks.STONE.defaultBlockState() : Blocks.AIR.defaultBlockState();
		}
		if (dy < 3) {
			return Blocks.DIRT.defaultBlockState();
		}
		if (dy == 3) {
			Identifier id = Identifier.parse(ground.contains(":") ? ground : "minecraft:" + ground);
			Optional<Holder.Reference<Block>> b = BuiltInRegistries.BLOCK.get(id);
			if (b.isEmpty()) {
				throw new DevBridge.DevException("ground '" + ground + "' is not a block (or stone / cave)");
			}
			return b.get().value().defaultBlockState();
		}
		return Blocks.AIR.defaultBlockState();
	}

	/** The template's surface y over the world's bottom: the spot is the cell above it (cave: the pocket's floor). */
	static int surface(String ground) {
		if ("cave".equals(ground)) {
			return CAVE_FLOOR - 1;
		}
		return SURFACE.getOrDefault(ground, 3);
	}

	static JsonObject harvest(ServerLevel level, String feature, List<Long> seeds, String ground, Path dir) {
		if (!(level.getChunkSource().getGenerator() instanceof FlatLevelSource)) {
			throw new DevBridge.DevException("dev.feature.stamp rewrites a box at the spot: it runs only in a superflat (scratch) world");
		}
		Registry<Feature> reg = level.registryAccess().lookupOrThrow(Registries.FEATURE);
		Identifier fid = Identifier.parse(feature);
		Optional<Holder.Reference<Feature>> h = reg.get(fid);
		if (h.isEmpty()) {
			throw new DevBridge.DevException("feature '" + feature + "' is not a configured feature of this game (Registries.FEATURE)");
		}
		Feature feat = h.get().value();
		int minY = level.getMinY();
		int x0 = SPOT_X - HALF;
		int z0 = SPOT_Z - HALF;
		int w = 2 * HALF + 1;
		int top = Math.min(level.getMaxY(), minY + surface(ground) + ABOVE);
		int hgt = top - minY + 1;
		for (int cx = x0 >> 4; cx <= (x0 + w - 1) >> 4; cx++) {
			for (int cz = z0 >> 4; cz <= (z0 + w - 1) >> 4; cz++) {
				level.getChunk(cx, cz); // load (or generate) the box's chunks now
			}
		}
		BlockPos origin = new BlockPos(SPOT_X, minY + surface(ground) + 1, SPOT_Z);
		String path = fid.getPath();
		String mcVersion = FabricLoader.getInstance().getModContainer("minecraft").map(m -> m.getMetadata().getVersion().getFriendlyString()).orElse("?");
		JsonObject out = new JsonObject();
		out.addProperty("feature", fid.toString());
		out.addProperty("ground", ground);
		out.addProperty("dir", dir.toString());
		out.addProperty("minecraft", mcVersion);
		JsonArray list = new JsonArray();
		BlockState[] before = new BlockState[w * w * hgt];
		BlockPos.MutableBlockPos p = new BlockPos.MutableBlockPos();
		for (long seed : seeds) {
			// the template, then the snapshot (what the world holds after the reset, block updates included)
			reset(level, ground, x0, z0, w, minY, hgt, p);
			for (int i = 0; i < w; i++) {
				for (int k = 0; k < w; k++) {
					for (int j = 0; j < hgt; j++) {
						before[(i * w + k) * hgt + j] = level.getBlockState(p.set(x0 + i, minY + j, z0 + k));
					}
				}
			}
			boolean placed = feat.place(level, level.getChunkSource().getGenerator(), RandomSource.create(seed), origin);
			TreeMap<Long, String> cells = new TreeMap<>();
			int blockEntities = 0;
			int edge = 0;
			int lo0 = Integer.MAX_VALUE;
			int lo1 = Integer.MAX_VALUE;
			int lo2 = Integer.MAX_VALUE;
			int hi0 = Integer.MIN_VALUE;
			int hi1 = Integer.MIN_VALUE;
			int hi2 = Integer.MIN_VALUE;
			List<int[]> changed = new ArrayList<>();
			List<String> states = new ArrayList<>();
			for (int i = 0; i < w; i++) {
				for (int k = 0; k < w; k++) {
					for (int j = 0; j < hgt; j++) {
						BlockState s = level.getBlockState(p.set(x0 + i, minY + j, z0 + k));
						if (s == before[(i * w + k) * hgt + j]) {
							continue;
						}
						if (i == 0 || k == 0 || i == w - 1 || k == w - 1 || j == hgt - 1) {
							edge++;
						}
						if (s.hasBlockEntity()) {
							blockEntities++; // a bee nest, a chest...: a stamp holds block states only
							continue;
						}
						if (s.isAir()) {
							continue; // a stamp writes blocks; the feature's own air writes over the template are dropped
						}
						int x = x0 + i;
						int y = minY + j;
						int z = z0 + k;
						changed.add(new int[] {x, y, z});
						states.add(BlockStateParser.serialize(s));
						lo0 = Math.min(lo0, x);
						lo1 = Math.min(lo1, y);
						lo2 = Math.min(lo2, z);
						hi0 = Math.max(hi0, x);
						hi1 = Math.max(hi1, y);
						hi2 = Math.max(hi2, z);
					}
				}
			}
			// leave the box as the template (the next seed and a re-harvest start from the same world)
			reset(level, ground, x0, z0, w, minY, hgt, p);
			JsonObject o = new JsonObject();
			o.addProperty("seed", seed);
			o.addProperty("placed", placed);
			o.addProperty("cells", changed.size());
			o.addProperty("blockEntities", blockEntities);
			o.addProperty("edge", edge);
			if (changed.isEmpty()) {
				list.add(o);
				continue;
			}
			int[] size = {hi0 - lo0 + 1, hi1 - lo1 + 1, hi2 - lo2 + 1};
			int[] root = {origin.getX() - lo0, origin.getY() - lo1, origin.getZ() - lo2};
			for (int n = 0; n < changed.size(); n++) {
				int[] c = changed.get(n);
				long idx = ((long) (c[1] - lo1) * size[2] + (c[2] - lo2)) * size[0] + (c[0] - lo0);
				cells.put(idx, states.get(n));
			}
			byte[] arvb = arvb(size, cells);
			byte[] arsp = arsp(fid.toString(), seed, mcVersion, ground, root, blockEntities, arvb);
			Path file = dir.resolve(path).resolve(seed + ".bin");
			try {
				Files.createDirectories(file.getParent());
				Path tmp = file.resolveSibling(file.getFileName() + ".tmp");
				Files.write(tmp, gzipPinned(arsp));
				Files.move(tmp, file, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
			} catch (IOException e) {
				throw new DevBridge.DevException("writing " + file + ": " + e.getMessage());
			}
			JsonArray sz = new JsonArray();
			for (int v : size) {
				sz.add(v);
			}
			JsonArray rt = new JsonArray();
			for (int v : root) {
				rt.add(v);
			}
			o.add("size", sz);
			o.add("root", rt);
			o.addProperty("palette", new java.util.TreeSet<>(cells.values()).size());
			o.addProperty("sha", Packed.sha256(arsp));
			o.addProperty("file", file.toString());
			list.add(o);
		}
		out.add("stamps", list);
		return out;
	}

	private static void reset(ServerLevel level, String ground, int x0, int z0, int w, int minY, int hgt, BlockPos.MutableBlockPos p) {
		for (int i = 0; i < w; i++) {
			for (int k = 0; k < w; k++) {
				for (int j = 0; j < hgt; j++) {
					BlockState want = template(ground, j, x0 + i - SPOT_X, z0 + k - SPOT_Z);
					p.set(x0 + i, minY + j, z0 + k);
					if (level.getBlockState(p) != want) {
						level.setBlock(p, want, FLAGS);
					}
				}
			}
		}
	}

	// ------------------------------------------------------------------ the bytes (kit/lib/region/voxels.mjs, kit/lib/region/stamps.mjs)

	/** ARVB (kit/lib/region/voxels.mjs encodeVoxels): cells by ascending local index, palette in order of first use. */
	static byte[] arvb(int[] size, TreeMap<Long, String> cells) {
		ByteArrayOutputStream b = new ByteArrayOutputStream();
		b.writeBytes(new byte[] {'A', 'R', 'V', 'B', 1, 0, 0, 0});
		for (int v : size) {
			i32(b, v);
		}
		Map<String, Integer> pal = new LinkedHashMap<>();
		List<Integer> ids = new ArrayList<>();
		for (String s : cells.values()) {
			ids.add(pal.computeIfAbsent(s, k -> pal.size()));
		}
		varint(b, pal.size());
		for (String s : pal.keySet()) {
			byte[] u = s.getBytes(StandardCharsets.UTF_8);
			varint(b, u.length);
			b.writeBytes(u);
		}
		varint(b, cells.size());
		long last = -1;
		for (long p : cells.keySet()) {
			varint(b, p - last);
			last = p;
		}
		for (int id : ids) {
			if (pal.size() <= 256) {
				b.write(id);
			} else {
				b.write(id & 255);
				b.write(id >>> 8);
			}
		}
		return b.toByteArray();
	}

	/**
	 * ARSP: 'ARSP' u8 1 u8 0 0 0; the feature id, the seed (decimal), the game version and the ground template as varint length +
	 * UTF-8; the root cell (the feature's origin) in the ARVB's local cells as 3 zigzag varints; varint block-entity cells left out;
	 * then the ARVB bytes to the end.
	 */
	static byte[] arsp(String feature, long seed, String mc, String ground, int[] root, int blockEntities, byte[] arvb) {
		ByteArrayOutputStream b = new ByteArrayOutputStream();
		b.writeBytes(new byte[] {'A', 'R', 'S', 'P', 1, 0, 0, 0});
		for (String s : new String[] {feature, Long.toString(seed), mc, ground}) {
			byte[] u = s.getBytes(StandardCharsets.UTF_8);
			varint(b, u.length);
			b.writeBytes(u);
		}
		for (int v : root) {
			varint(b, ((v << 1) ^ (v >> 31)) & 0xffffffffL);
		}
		varint(b, blockEntities);
		b.writeBytes(arvb);
		return b.toByteArray();
	}

	/** gzip with the kit's pinned header (mtime 0, XFL 0, OS 255), level 6: the same bytes on every run. */
	static byte[] gzipPinned(byte[] raw) {
		ByteArrayOutputStream b = new ByteArrayOutputStream();
		b.writeBytes(new byte[] {0x1f, (byte) 0x8b, 8, 0, 0, 0, 0, 0, 0, (byte) 255});
		Deflater d = new Deflater(6, true);
		d.setInput(raw);
		d.finish();
		byte[] buf = new byte[1 << 16];
		while (!d.finished()) {
			int n = d.deflate(buf);
			b.write(buf, 0, n);
		}
		d.end();
		CRC32 crc = new CRC32();
		crc.update(raw);
		i32(b, (int) crc.getValue());
		i32(b, raw.length);
		return b.toByteArray();
	}

	private static void i32(ByteArrayOutputStream b, int v) {
		b.write(v & 255);
		b.write((v >>> 8) & 255);
		b.write((v >>> 16) & 255);
		b.write((v >>> 24) & 255);
	}

	private static void varint(ByteArrayOutputStream b, long v) {
		long n = v;
		do {
			int x = (int) (n & 127);
			n >>>= 7;
			if (n != 0) {
				x |= 128;
			}
			b.write(x);
		} while (n != 0);
	}
}
