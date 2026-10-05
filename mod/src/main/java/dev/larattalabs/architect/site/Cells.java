package dev.larattalabs.architect.site;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.nbt.CompoundTag;
import net.minecraft.nbt.ListTag;
import net.minecraft.nbt.NbtUtils;
import net.minecraft.resources.Identifier;
import net.minecraft.world.item.Item;
import net.minecraft.world.item.Items;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.levelgen.structure.templatesystem.StructureTemplate;
import dev.larattalabs.architect.survival.SurvivalItems;
import org.jspecify.annotations.Nullable;

/**
 * A captured box ({@link Sites#capture}: a structure template tag with every cell, air included) read back as arrays by box
 * index ({@link Construction#index}): what a snapshot or a construction site's target file holds per cell. Plus the block /
 * item id helpers the survival code shares.
 */
final class Cells {
	final int dx;
	final int dy;
	final int dz;
	final BlockState[] states;
	final @Nullable CompoundTag[] nbt;

	private Cells(int dx, int dy, int dz) {
		this.dx = dx;
		this.dy = dy;
		this.dz = dz;
		this.states = new BlockState[dx * dy * dz];
		this.nbt = new CompoundTag[dx * dy * dz];
	}

	int size() {
		return states.length;
	}

	static Cells read(CompoundTag tag) {
		ListTag size = tag.getListOrEmpty(StructureTemplate.SIZE_TAG);
		Cells c = new Cells(size.getIntOr(0, 0), size.getIntOr(1, 0), size.getIntOr(2, 0));
		ListTag paletteTag = tag.getListOrEmpty(StructureTemplate.PALETTE_TAG);
		List<BlockState> palette = new ArrayList<>(paletteTag.size());
		for (int i = 0; i < paletteTag.size(); i++) {
			palette.add(NbtUtils.readBlockState(BuiltInRegistries.BLOCK, paletteTag.getCompoundOrEmpty(i)));
		}
		ListTag blocks = tag.getListOrEmpty(StructureTemplate.BLOCKS_TAG);
		for (int i = 0; i < blocks.size(); i++) {
			CompoundTag b = blocks.getCompoundOrEmpty(i);
			ListTag pos = b.getListOrEmpty(StructureTemplate.BLOCK_TAG_POS);
			int x = pos.getIntOr(0, 0);
			int y = pos.getIntOr(1, 0);
			int z = pos.getIntOr(2, 0);
			if (x < 0 || y < 0 || z < 0 || x >= c.dx || y >= c.dy || z >= c.dz) {
				continue;
			}
			int si = b.getIntOr(StructureTemplate.BLOCK_TAG_STATE, -1);
			int k = Construction.index(x, y, z, c.dx, c.dz);
			c.states[k] = si >= 0 && si < palette.size() ? palette.get(si) : Blocks.AIR.defaultBlockState();
			if (b.contains(StructureTemplate.BLOCK_TAG_NBT)) {
				c.nbt[k] = b.getCompoundOrEmpty(StructureTemplate.BLOCK_TAG_NBT);
			}
		}
		for (int k = 0; k < c.states.length; k++) {
			if (c.states[k] == null) {
				c.states[k] = Blocks.AIR.defaultBlockState();
			}
		}
		return c;
	}

	// ------------------------------------------------------------------ ids

	static String blockId(BlockState s) {
		return BuiltInRegistries.BLOCK.getKey(s.getBlock()).toString();
	}

	static Map<String, String> props(BlockState s) {
		Map<String, String> out = new java.util.HashMap<>();
		s.getValues().forEach(v -> out.put(v.property().getName(), v.valueName()));
		return out;
	}

	/** {@code Block.asItem()} by id: the item id, or null when the block has none. */
	static @Nullable String asItem(String blockId) {
		Identifier id = Identifier.tryParse(blockId);
		if (id == null) {
			return null;
		}
		Block b = BuiltInRegistries.BLOCK.getOptional(id).orElse(null);
		if (b == null) {
			return null;
		}
		Item item = b.asItem();
		return item == Items.AIR ? null : BuiltInRegistries.ITEM.getKey(item).toString();
	}

	/** What a cell holding {@code s} costs in survival. */
	static List<SurvivalItems.Cost> cost(BlockState s) {
		if (s.isAir()) {
			return List.of();
		}
		return SurvivalItems.bundled().cost(blockId(s), props(s), Cells::asItem);
	}

	static @Nullable Item item(String id) {
		Identifier key = Identifier.tryParse(id);
		return key == null ? null : BuiltInRegistries.ITEM.getOptional(key).orElse(null);
	}
}
