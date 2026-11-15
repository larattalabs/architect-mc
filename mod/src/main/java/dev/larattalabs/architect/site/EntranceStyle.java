package dev.larattalabs.architect.site;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import dev.larattalabs.architect.Architect;
import dev.larattalabs.architect.placement.Approach;
import dev.larattalabs.architect.region.RegionsImpl;
import it.unimi.dsi.fastutil.longs.LongSet;
import java.util.Locale;
import net.minecraft.commands.arguments.blocks.BlockStateParser;
import net.minecraft.core.BlockPos;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.chunk.LevelChunk;
import org.jspecify.annotations.Nullable;

/**
 * What styles a placement's entrance approach (docs/CONTRACT.md "6b addition: region lot entrances"): a region lot's (its
 * region's {@code path} and {@code foundation} roles, and the region's own walk surfaces), or a plain placement's that asked for
 * one ({@code PlaceRequest.pathStyle}: that block, roads only). Null everywhere it is passed = the design's own approach,
 * unchanged. Pure data; {@link #resolve} turns it into the {@link Approach.Style} a plan uses.
 *
 * @param path the path block state ({@code minecraft:stone_bricks}, properties allowed)
 * @param foundation the fill below the path, or null for the design's foundation
 * @param regionGroup a region lot's: the region's site group (its tiles' cells are walk surfaces), else null
 */
public record EntranceStyle(String path, @Nullable String foundation, @Nullable String regionGroup) {
	/** A plain placement's style from {@code PlaceRequest.pathStyle}, or null when it has none. */
	public static @Nullable EntranceStyle plain(@Nullable String pathStyle) {
		if (pathStyle == null || pathStyle.isBlank()) {
			return null;
		}
		String s = pathStyle.strip().toLowerCase(Locale.ROOT);
		return new EntranceStyle(s.indexOf(':') < 0 ? "minecraft:" + s : s, null, null);
	}

	/** Why {@code pathStyle} can't style an approach (not a block, or air), or null when it can. */
	public static @Nullable String refusal(@Nullable String pathStyle) {
		EntranceStyle s = plain(pathStyle);
		if (s == null) {
			return null;
		}
		BlockState st = parse(s.path());
		return st == null || st.isAir() ? "pathStyle " + s.path() + " is not a block" : null;
	}

	/**
	 * A region lot's style: its region's {@code path} and {@code foundation} roles (the IR's resolved {@code roles}), its group's
	 * tiles as walk surfaces. Null when the region is not loaded or its IR has no path role (the design's own approach then).
	 */
	public static @Nullable EntranceStyle region(@Nullable String regionId) {
		return region(regionId, null);
	}

	/** {@link #region(String)}; {@code group}: the region batch's site group (its tiles' Infras carry it), null = the record's. */
	public static @Nullable EntranceStyle region(@Nullable String regionId, @Nullable String group) {
		RegionsImpl.Live r = regionId == null ? null : RegionsImpl.live(regionId);
		if (r == null) {
			return null;
		}
		return ofIr(r.irJson(), group == null || group.isEmpty() ? r.rec().groupId : group);
	}

	/**
	 * The entrance style a region's IR gives its lots (its {@code roles}' path and foundation), with that site group; null when the IR names
	 * no path. {@link #region} reads a live region's; (M5 QT) a quote reads a plan's before it is a region.
	 */
	public static @Nullable EntranceStyle ofIr(JsonObject irJson, @Nullable String group) {
		JsonElement roles = irJson.get("roles");
		if (roles == null || !roles.isJsonObject()) {
			return null;
		}
		JsonObject o = roles.getAsJsonObject();
		String path = role(o, "path");
		if (path == null) {
			return null;
		}
		return new EntranceStyle(path, role(o, "foundation"), group == null || group.isEmpty() ? null : group);
	}

	private static @Nullable String role(JsonObject o, String name) {
		JsonElement e = o.get(name);
		if (e == null || !e.isJsonPrimitive()) {
			return null;
		}
		BlockState st = parse(e.getAsString());
		return st == null || st.isAir() ? null : e.getAsString();
	}

	/** The checkSite cache key of a style (null: none). */
	static String key(@Nullable EntranceStyle s) {
		return s == null ? "-" : s.path + "/" + s.foundation + "/" + s.regionGroup;
	}

	/**
	 * The plan-time style: the walk surfaces are the {@code roads} cells (4e roads and region path walk cells, as the approach's
	 * ROAD flag) and, for a region lot, region-made standable ground: a cell with a collision shape that one of the region's tile
	 * entries owns (the top entry there) with two cells above it that have none and hold no fluid (island tops, terrace floors,
	 * decks). Only the cells the approach examines are looked at (the ownership read last). {@code dryRun}: unloaded chunks are
	 * not loaded (their cells are no surface).
	 */
	Approach.Style resolve(ServerLevel level, LongSet roads, boolean dryRun) {
		String dim = Sites.dimensionId(level);
		BlockPos.MutableBlockPos m = new BlockPos.MutableBlockPos();
		StateAt at = withLand(QuoteLand.QUOTE.get(), (x, y, z) -> read(level, dryRun, m.set(x, y, z)));
		return new Approach.Style(path, foundation, surface(level, at, roads, regionGroup != null, pos -> regionTile(dim, pos)));
	}

	/** A cell's state, or null when it can't be read (a chunk not loaded). */
	@FunctionalInterface
	public interface StateAt {
		@Nullable BlockState at(int x, int y, int z);
	}

	/** (QL-c) {@code world} with a quote's land on top (its planned state first), or {@code world} when there is none. */
	public static StateAt withLand(@Nullable QuoteLand land, StateAt world) {
		if (land == null) {
			return world;
		}
		return (x, y, z) -> {
			BlockState st = world.at(x, y, z);
			if (st == null) {
				return null; // not loaded: no surface, as before
			}
			BlockState planned = land.at(x, y, z);
			return planned != null ? planned : st;
		};
	}

	/**
	 * The walk surfaces over {@code at} (shapes read through {@code shapes} at the cell): a road cell, or with {@code region} a cell with a
	 * collision shape that {@code regionTile} owns, with two open fluid-free cells above it. Pure; the unit tests' seam.
	 */
	public static Approach.Surface surface(net.minecraft.world.level.BlockGetter shapes, StateAt at, LongSet roads, boolean region,
		java.util.function.LongPredicate regionTile) {
		BlockPos.MutableBlockPos m = new BlockPos.MutableBlockPos();
		return (x, y, z) -> {
			BlockState st = at.at(x, y, z);
			if (st == null || st.isAir()) {
				return null;
			}
			m.set(x, y, z);
			long pos = BlockPos.asLong(x, y, z);
			if (!roads.contains(pos)) {
				if (!region || st.getCollisionShape(shapes, m).isEmpty() || !st.getFluidState().isEmpty() || !open(shapes, at, x, y + 1, z) || !open(shapes, at, x,
					y + 2, z) || !regionTile.test(pos)) {
					return null;
				}
			}
			m.set(x, y, z);
			boolean full = st.isCollisionShapeFullBlock(shapes, m) && !st.hasBlockEntity() && st.getFluidState().isEmpty();
			return new Approach.Met(BlockStateParser.serialize(st), full);
		};
	}

	private static boolean open(net.minecraft.world.level.BlockGetter shapes, StateAt at, int x, int y, int z) {
		BlockState st = at.at(x, y, z);
		return st != null && st.getCollisionShape(shapes, new BlockPos(x, y, z)).isEmpty() && st.getFluidState().isEmpty();
	}

	private boolean regionTile(String dim, long pos) {
		QuoteLand land = QuoteLand.QUOTE.get();
		if (land != null && land.tiles().contains(pos)) {
			return true; // (QL-c) a quote: a cell a tile of the plan queues before the lot (its entry owns it at put-down)
		}
		String owner = SiteJournal.ownerSite(dim, pos);
		Infra in = owner == null ? null : Infras.get(owner);
		return in != null && regionGroup.equals(in.group()) && in.kind().startsWith(Infra.CELLS) && RegionKinds.tile(in.kind().substring(Infra.CELLS
			.length()));
	}

	private static @Nullable BlockState read(ServerLevel level, boolean dryRun, BlockPos p) {
		if (p.getY() < level.getMinY() || p.getY() > level.getMaxY()) {
			return Blocks.AIR.defaultBlockState();
		}
		LevelChunk c = dryRun ? level.getChunkSource().getChunkNow(p.getX() >> 4, p.getZ() >> 4) : level.getChunk(p.getX() >> 4, p.getZ() >> 4);
		return c == null ? null : c.getBlockState(p);
	}

	/** A block state string as a state, or null when it is none. */
	static @Nullable BlockState parse(@Nullable String id) {
		if (id == null || id.isBlank()) {
			return null;
		}
		try {
			return BlockStateParser.parseForBlock(BuiltInRegistries.BLOCK, id, false).blockState();
		} catch (com.mojang.brigadier.exceptions.CommandSyntaxException | RuntimeException e) {
			return null;
		}
	}

	/** The state a styled approach writes for {@code id} (a plan's pathBlock / fillBlock), else {@code def}. */
	static BlockState state(@Nullable String id, BlockState def) {
		if (id == null) {
			return def;
		}
		BlockState st = parse(id);
		if (st == null || st.isAir()) {
			Architect.LOGGER.warn("Entrance style block {} is not a block; using {}", id, BlockStateParser.serialize(def));
			return def;
		}
		return st;
	}
}
