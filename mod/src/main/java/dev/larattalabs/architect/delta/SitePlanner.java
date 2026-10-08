package dev.larattalabs.architect.delta;

import dev.larattalabs.architect.journal.Journal;
import dev.larattalabs.architect.journal.Journal.Value;
import dev.larattalabs.architect.journal.WorldJournal;
import dev.larattalabs.architect.placement.Anchors;
import dev.larattalabs.architect.placement.Approach;
import dev.larattalabs.architect.placement.Blueprint;
import dev.larattalabs.architect.placement.BlueprintTransform;
import dev.larattalabs.architect.placement.GhostModel;
import dev.larattalabs.architect.placement.TerrainFit;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.LongPredicate;
import net.minecraft.core.HolderGetter;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.nbt.CompoundTag;
import net.minecraft.nbt.ListTag;
import net.minecraft.nbt.NbtUtils;
import net.minecraft.world.level.block.BedBlock;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.Rotation;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.levelgen.structure.templatesystem.StructureTemplate;
import org.jspecify.annotations.Nullable;

/**
 * The plan of an instant placement (docs/CONTRACT.md phase 5b "The delta set (plan against plan)"): the <b>written cells</b>
 * of a placement of one version at a site's origin and rotation, computed against a world view, in {@code PlaceJob}'s order:
 * template cells (rotated states and their block-entity data), beds the bed rule leaves out (air), foundation fill, clears,
 * then the approach (clear, fill, path, slabs). Later writes win. Guard data (held leaves, the leaf ring, cut plant halves) is
 * not part of a plan. Pure: the world is a function; tested without a game.
 */
public final class SitePlanner {
	private SitePlanner() {
	}

	/** A version's template cells, template-local and unrotated (structure voids left out), with their block-entity data. */
	public record VersionCells(int sizeX, int sizeY, int sizeZ, int[] xyz, BlockState[] states, @Nullable CompoundTag[] nbt) {
		public int count() {
			return states.length;
		}

		/** Reads a loaded template (vanilla's saved form; the order does not matter to a plan). */
		public static VersionCells of(StructureTemplate t) {
			CompoundTag tag = t.save(new CompoundTag());
			HolderGetter<Block> blocks = BuiltInRegistries.BLOCK;
			ListTag paletteTag = tag.getListOrEmpty(StructureTemplate.PALETTE_TAG);
			if (paletteTag.isEmpty()) {
				paletteTag = tag.getListOrEmpty(StructureTemplate.PALETTE_LIST_TAG).getListOrEmpty(0);
			}
			List<BlockState> palette = new ArrayList<>(paletteTag.size());
			for (int i = 0; i < paletteTag.size(); i++) {
				palette.add(NbtUtils.readBlockState(blocks, paletteTag.getCompoundOrEmpty(i)));
			}
			ListTag list = tag.getListOrEmpty(StructureTemplate.BLOCKS_TAG);
			int n = list.size();
			int[] xyz = new int[n * 3];
			BlockState[] states = new BlockState[n];
			CompoundTag[] nbt = new CompoundTag[n];
			int k = 0;
			for (int i = 0; i < n; i++) {
				CompoundTag b = list.getCompoundOrEmpty(i);
				ListTag pos = b.getListOrEmpty(StructureTemplate.BLOCK_TAG_POS);
				int si = b.getIntOr(StructureTemplate.BLOCK_TAG_STATE, -1);
				BlockState s = si >= 0 && si < palette.size() ? palette.get(si) : Blocks.AIR.defaultBlockState();
				if (s.is(Blocks.STRUCTURE_VOID)) {
					continue;
				}
				xyz[k * 3] = pos.getIntOr(0, 0);
				xyz[k * 3 + 1] = pos.getIntOr(1, 0);
				xyz[k * 3 + 2] = pos.getIntOr(2, 0);
				states[k] = s;
				nbt[k] = b.getCompound(StructureTemplate.BLOCK_TAG_NBT).orElse(null);
				k++;
			}
			var size = t.getSize();
			return new VersionCells(size.getX(), size.getY(), size.getZ(), java.util.Arrays.copyOf(xyz, k * 3), java.util.Arrays.copyOf(states, k),
				java.util.Arrays.copyOf(nbt, k));
		}

		/** The rotated ghost model (positions in the rotated box; air cells invisible): what TerrainFit plans with. */
		public GhostModel model(int groundY, int turns) {
			int[] argb = new int[count()];
			for (int i = 0; i < argb.length; i++) {
				argb[i] = states[i].isAir() ? 0 : 0xFFFFFFFF;
			}
			return GhostModel.of(new GhostModel.Cells(sizeX, sizeY, sizeZ, groundY, xyz, argb), turns);
		}
	}

	/** The world a plan reads: values (what a plan's unwritten cells keep) and TerrainFit flags. */
	public interface World {
		Value value(long pos);

		int flags(int x, int y, int z);
	}

	/**
	 * A plan: the written cells in write order (a later write at a position replaced an earlier one), the template box, the
	 * restore box ({@code Sites.snapshotBox}), the terrain and approach plans.
	 */
	public record Plan(Map<Long, Value> writes, Anchors.Bounds box, Anchors.Bounds snapBox, TerrainFit.Plan terrain, Approach.Plan approach,
		Map<Long, Integer> part) {
		/** The plan's value at {@code pos}, or the world's when the plan doesn't write it. */
		public Value at(long pos, World w) {
			Value v = writes.get(pos);
			return v != null ? v : w.value(pos);
		}
	}

	/** Whether the bed rule leaves a template bed out here (the Nether, the End); its head cell decides. */
	public interface Beds {
		boolean unsafe(long head, BedBlock bed);

		Beds SAFE = (h, b) -> false;
	}

	/**
	 * The plan of placing {@code cells} (blueprint {@code bp}) with {@code turns} at the box whose minimum corner is
	 * {@code (bx, by, bz)}. {@code foundation}, {@code path}, {@code slab}: the states the placement writes for them.
	 * {@code partOf}: template-local cell index -> part index (may be null), recorded per world position in {@link Plan#part}.
	 */
	public static Plan plan(VersionCells cells, Blueprint bp, int turns, int bx, int by, int bz, World w, Beds beds, BlockState foundation,
		BlockState path, BlockState slab, int @Nullable [] partOf) {
		GhostModel m = cells.model(bp.groundY(), turns);
		Anchors.Bounds box = new Anchors.Bounds(bx, by, bz, bx + m.sizeX - 1, by + m.sizeY - 1, bz + m.sizeZ - 1);
		TerrainFit.World tw = w::flags;
		TerrainFit.Plan terrain = TerrainFit.plan(m, bx, by, bz, tw);
		Approach.Plan approach = Approach.forBlueprint(bp, turns, box, tw);
		Rotation rot = Rotation.values()[Math.floorMod(turns, 4)];
		Map<Long, Value> writes = new LinkedHashMap<>(cells.count() * 2);
		Map<Long, Integer> part = new java.util.HashMap<>();
		Value air = WorldJournal.value(Blocks.AIR.defaultBlockState());
		for (int i = 0; i < cells.count(); i++) {
			long p = Journal.pos(bx + m.x(i), by + m.y(i), bz + m.z(i));
			BlockState s = cells.states()[i].rotate(rot);
			Value v = WorldJournal.value(s);
			CompoundTag nbt = cells.nbt()[i];
			writes.put(p, nbt == null ? v : v.withNbt(nbt));
			if (partOf != null && i < partOf.length) {
				part.put(p, partOf[i]);
			}
		}
		// beds the level's bed rule leaves out: both halves become air (Sites.removeUnsafeBeds)
		for (int i = 0; i < cells.count(); i++) {
			BlockState s = cells.states()[i].rotate(rot);
			if (s.getBlock() instanceof BedBlock) {
				net.minecraft.core.Direction f = s.getValue(BedBlock.FACING);
				int x = bx + m.x(i);
				int y = by + m.y(i);
				int z = bz + m.z(i);
				boolean head = s.getValue(BedBlock.PART) == net.minecraft.world.level.block.state.properties.BedPart.HEAD;
				long h = head ? Journal.pos(x, y, z) : Journal.pos(x + f.getStepX(), y, z + f.getStepZ());
				if (beds.unsafe(h, (BedBlock) s.getBlock())) {
					writes.put(Journal.pos(x, y, z), air);
				}
			}
		}
		Value found = WorldJournal.value(foundation);
		put(writes, terrain.fill(), found);
		put(writes, terrain.clear(), air);
		put(writes, approach.clear(), air);
		put(writes, approach.fill(), found);
		put(writes, approach.path(), WorldJournal.value(path));
		put(writes, approach.slabs(), WorldJournal.value(slab));
		// a dirt path under a solid block turns to dirt at its next tick (vanilla), whichever placement wrote it: the plan says
		// dirt there, so the captured after, a construction's target and a fresh placement agree
		Value dirt = WorldJournal.value(Blocks.DIRT.defaultBlockState());
		for (var e : List.copyOf(writes.entrySet())) {
			if (!WorldJournal.state(e.getValue()).is(Blocks.DIRT_PATH)) {
				continue;
			}
			long up = Journal.pos(Journal.x(e.getKey()), Journal.y(e.getKey()) + 1, Journal.z(e.getKey()));
			Value a = writes.get(up);
			BlockState above = WorldJournal.state(a != null ? a : w.value(up));
			if (above.isSolid() && !(above.getBlock() instanceof net.minecraft.world.level.block.FenceGateBlock)) {
				writes.put(e.getKey(), dirt);
			}
		}
		Anchors.Bounds u = approach.union(box);
		Anchors.Bounds snap = new Anchors.Bounds(u.minX(), Math.min(u.minY(), terrain.minY()) - 1, u.minZ(), u.maxX(), u.maxY(), u.maxZ());
		return new Plan(Collections.unmodifiableMap(writes), box, snap, terrain, approach, part);
	}

	private static void put(Map<Long, Value> writes, int[] xyz, Value v) {
		for (int i = 0; i + 2 < xyz.length; i += 3) {
			long p = Journal.pos(xyz[i], xyz[i + 1], xyz[i + 2]);
			writes.remove(p); // a later write goes to the end of the order, as the placement writes it later
			writes.put(p, v);
		}
	}

	/**
	 * The box minimum corner of version {@code b} placed so that every design coordinate lands on the world cell it has in
	 * version {@code a} (frame aligned, docs/CONTRACT.md phase 5b "Plans"): {@code aMin} is a's box corner, {@code oa}/{@code ob}
	 * the frame origins, sizes unrotated.
	 */
	public static int[] alignedMin(int[] aMin, int[] oa, int asx, int asz, int[] ob, int bsx, int bsz, int turns) {
		int[] ra = BlueprintTransform.rotateBlock(oa[0], oa[2], asx, asz, turns);
		int[] rb = BlueprintTransform.rotateBlock(ob[0], ob[2], bsx, bsz, turns);
		return new int[] {aMin[0] + ra[0] - rb[0], aMin[1] + oa[1] - ob[1], aMin[2] + ra[1] - rb[1]};
	}

	/** The positions of a box (packed), as a predicate. */
	public static LongPredicate in(Anchors.Bounds b) {
		return p -> b.contains(Journal.x(p), Journal.y(p), Journal.z(p));
	}
}
