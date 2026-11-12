package dev.larattalabs.architect.site;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import dev.larattalabs.architect.journal.Journal;
import it.unimi.dsi.fastutil.longs.LongOpenHashSet;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.resources.Identifier;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.state.BlockState;
import org.jspecify.annotations.Nullable;

/**
 * (M5 FC, S-M5-4, docs/CONTRACT.md "M5 support" row FC) A module lot's field: its farmland cells and the cell above each (the crop
 * cells), with the crop kinds the field grows. A worked field changes every day (harvested cells are air over our farmland, the player
 * replants), so for the lot that carries it, and only there:
 * <ul>
 * <li>LC ({@code LandCheck}) and the standing / reconcile score ({@code Sites.standing}) read a crop cell holding air or a field crop of any
 * age (a PT record or not) as unchanged ({@link #unchanged});</li>
 * <li>at undo a player's field crop (a PT record) goes with the lot, is no removal blocker, and its planting item (one) is given back once
 * as cargo (the player's blocks), never as the construction refund ({@code Builder.fieldCell}).</li>
 * </ul>
 * Any other player block on a field cell stays as PT says.
 *
 * <p>Carried on the lot site's ext as {@link #EXT} {@code {cells: [x, z, y0, y1, ...] (the farmland, flat column runs), crops: [block
 * ids]}}, from the IR's {@code lots[].field}, so it persists with the queue item, the site record and the journal head. Since NEXT.
 */
public final class FieldCells {
	/** The site ext key holding the field. */
	public static final String EXT = "architect_mc:field";
	/** The crop blocks a field may name: single-block crops on farmland whose block's item is its planting item. */
	public static final List<String> CROPS = List.of("minecraft:wheat", "minecraft:carrots", "minecraft:potatoes", "minecraft:beetroots",
		"minecraft:torchflower_crop");

	private final LongOpenHashSet farmland;
	private final LongOpenHashSet crop;
	private final Set<Block> crops;

	FieldCells(LongOpenHashSet farmland, Set<Block> crops) {
		this.farmland = farmland;
		this.crops = crops;
		this.crop = new LongOpenHashSet(farmland.size());
		for (var it = farmland.iterator(); it.hasNext();) {
			long p = it.nextLong();
			crop.add(Journal.pos(net.minecraft.core.BlockPos.getX(p), net.minecraft.core.BlockPos.getY(p) + 1, net.minecraft.core.BlockPos.getZ(p)));
		}
	}

	/** The field of a site's ext, or null when it has none (or none of its crops is known, or no cell). */
	public static @Nullable FieldCells of(@Nullable JsonObject ext) {
		if (ext == null || !(ext.get(EXT) instanceof JsonObject f)) {
			return null;
		}
		LongOpenHashSet cells = new LongOpenHashSet();
		LotMask.addRuns(f.get("cells") instanceof JsonArray a ? a : null, cells);
		Set<Block> crops = new LinkedHashSet<>();
		if (f.get("crops") instanceof JsonArray ca) {
			for (JsonElement e : ca) {
				Block b = e.isJsonPrimitive() ? crop(e.getAsString()) : null;
				if (b != null) {
					crops.add(b);
				}
			}
		}
		return cells.isEmpty() || crops.isEmpty() ? null : new FieldCells(cells, crops);
	}

	/** The field of a site, or null. */
	public static @Nullable FieldCells of(@Nullable Site s) {
		return s == null ? null : of(s.ext());
	}

	/** A crop block of {@link #CROPS} by id, or null. */
	static @Nullable Block crop(String id) {
		if (!CROPS.contains(id)) {
			return null;
		}
		Identifier k = Identifier.tryParse(id);
		return k == null ? null : BuiltInRegistries.BLOCK.getOptional(k).orElse(null);
	}

	/** The ext value from IR column runs ({@code [[x, z, y0, y1], ...]} or flat) and crop ids: {@code {cells: [flat runs], crops}}. */
	public static JsonObject extOf(@Nullable JsonArray runs, @Nullable JsonArray crops) {
		JsonObject o = LotMask.extOfAny(runs);
		JsonArray c = new JsonArray();
		if (crops != null) {
			for (JsonElement e : crops) {
				if (e.isJsonPrimitive() && CROPS.contains(e.getAsString())) {
					c.add(e.getAsString());
				}
			}
		}
		o.add("crops", c);
		return o;
	}

	/** Whether {@code pos} is a crop cell (the cell above a farmland cell of the field). */
	public boolean cropCell(long pos) {
		return crop.contains(pos);
	}

	/** Whether {@code pos} is a farmland cell of the field. */
	public boolean farmlandCell(long pos) {
		return farmland.contains(pos);
	}

	/** Whether {@code s} is one of the field's crops, at any age. */
	public boolean fieldCrop(BlockState s) {
		return crops.contains(s.getBlock());
	}

	/** The field rule: a crop cell holding air or a field crop of any age reads unchanged. False off the crop cells. */
	public boolean unchanged(long pos, BlockState now) {
		return crop.contains(pos) && (now.isAir() || fieldCrop(now));
	}

	/** How many farmland cells the field has. */
	public int size() {
		return farmland.size();
	}
}
