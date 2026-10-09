package dev.larattalabs.architect.region.volume;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.larattalabs.architect.api.VoxelClass;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.IdentityHashMap;
import java.util.List;
import java.util.Map;
import org.jspecify.annotations.Nullable;

/**
 * The block -> {@link VoxelClass} table: the kit's generated {@code kit/voxel_classes.json} (from 26.3's block tags, the same
 * natural rules as {@code TerrainFit} and the tree rules), bundled into the jar at build time as {@link #RESOURCE}. Natural blocks
 * only: a block not listed is {@link VoxelClass#PLAYER}. A JVM test asserts the bundled file equals the kit's and the enum order
 * equals its {@code classes}.
 */
public final class VoxelTable {
	public static final String RESOURCE = "/architect_mc/voxel_classes.json";
	private static volatile @Nullable VoxelTable instance;

	public final List<String> classes;
	private final Map<String, VoxelClass> byId;
	/** Block -> class, filled lazily (identity: blocks are singletons). */
	private final Map<Object, VoxelClass> byBlock = new IdentityHashMap<>();

	VoxelTable(JsonObject o) {
		List<String> cs = new java.util.ArrayList<>();
		o.getAsJsonArray("classes").forEach(e -> cs.add(e.getAsString()));
		classes = List.copyOf(cs);
		Map<String, VoxelClass> m = new HashMap<>();
		o.getAsJsonObject("blocks").entrySet().forEach(e -> m.put(e.getKey(), VoxelClass.valueOf(e.getValue().getAsString())));
		byId = Map.copyOf(m);
	}

	public static VoxelTable get() {
		VoxelTable t = instance;
		if (t == null) {
			synchronized (VoxelTable.class) {
				t = instance;
				if (t == null) {
					t = new VoxelTable(load());
					instance = t;
				}
			}
		}
		return t;
	}

	static JsonObject load() {
		try (InputStream in = VoxelTable.class.getResourceAsStream(RESOURCE)) {
			if (in == null) {
				throw new IllegalStateException("the jar has no " + RESOURCE + " (built without kit/voxel_classes.json)");
			}
			return JsonParser.parseString(new String(in.readAllBytes(), StandardCharsets.UTF_8)).getAsJsonObject();
		} catch (IOException e) {
			throw new IllegalStateException(e);
		}
	}

	/** The class of a block id ({@code minecraft:stone}); not listed: PLAYER. */
	public VoxelClass of(String blockId) {
		return byId.getOrDefault(blockId, VoxelClass.PLAYER);
	}

	/** The class of a block (by its registry id), cached per block. Thread-safe. */
	public VoxelClass of(net.minecraft.world.level.block.Block b) {
		synchronized (byBlock) {
			VoxelClass c = byBlock.get(b);
			if (c == null) {
				c = of(net.minecraft.core.registries.BuiltInRegistries.BLOCK.getKey(b).toString());
				byBlock.put(b, c);
			}
			return c;
		}
	}

	/** Whether a block is natural (listed: any class but PLAYER). */
	public boolean natural(net.minecraft.world.level.block.Block b) {
		return of(b) != VoxelClass.PLAYER;
	}

	public int size() {
		return byId.size();
	}
}
