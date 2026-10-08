package dev.larattalabs.architect.site;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import dev.larattalabs.architect.mixin.StructureTemplateAccessor;
import java.util.BitSet;
import java.util.List;
import java.util.Map;
import java.util.WeakHashMap;
import net.minecraft.core.BlockPos;
import net.minecraft.nbt.CompoundTag;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.util.ProblemReporter;
import net.minecraft.world.RandomizableContainer;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.entity.BlockEntity;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.levelgen.structure.templatesystem.StructurePlaceSettings;
import net.minecraft.world.level.levelgen.structure.templatesystem.StructureTemplate;
import net.minecraft.world.level.storage.TagValueInput;
import net.minecraft.world.phys.shapes.BitSetDiscreteVoxelShape;
import net.minecraft.world.phys.shapes.DiscreteVoxelShape;
import org.jspecify.annotations.Nullable;

/**
 * Vanilla's {@code StructureTemplate.placeInWorld} as a resumable cursor, so a template is written over ticks and still ends
 * up exactly as the one-tick call leaves it (docs/CONTRACT.md phase 4d "Ticked placement"). The same steps in the same order:
 * <ol>
 * <li>every cell of the palette in its list order: a barrier first where the cell has block-entity NBT, then the rotated
 * state with the caller's flags; a cell whose {@code setBlock} changed something counts as placed and gets its NBT;</li>
 * <li>the shape update at the edge of the placed cells ({@code updateShapeAtEdge});</li>
 * <li>for every placed cell, in order: {@code updateFromNeighbourShapes}, the neighbour update, {@code setChanged}.</li>
 * </ol>
 * Only what Architect's placements use is supported: no processors, no waterlogging (IGNORE_WATERLOGGING), no entities, no
 * bounding box. Ticks the writes schedule are held back by the caller ({@link TickDeferral}).
 *
 * <p>Repeated placements of the same template and rotation share one cell list ({@link #cells}): the offsets, the rotated
 * states and the NBT (copied per write).
 */
final class TemplateWriter {
	static final int SET = 0;
	static final int EDGE = 1;
	static final int POST = 2;
	static final int DONE = 3;
	/** Check the clock every this many cells. */
	private static final int CLOCK = 16;

	/**
	 * A template's cells as {@code placeInWorld} writes them for one rotation: offsets from the placement position, the
	 * mirrored and rotated states, and the NBT (never written to: copied per write).
	 */
	record Cells(int[] off, BlockState[] states, @Nullable CompoundTag[] nbt) {
		int size() {
			return states.length;
		}

		/** The same cells with the air ones first, in their order, then the rest in theirs (a delta's clears before its writes). */
		Cells airFirst() {
			int n = size();
			int[] o = new int[n * 3];
			BlockState[] st = new BlockState[n];
			CompoundTag[] nb = new CompoundTag[n];
			int k = 0;
			for (int pass = 0; pass < 2; pass++) {
				for (int i = 0; i < n; i++) {
					if (states[i].isAir() == (pass == 0)) {
						o[k * 3] = off[i * 3];
						o[k * 3 + 1] = off[i * 3 + 1];
						o[k * 3 + 2] = off[i * 3 + 2];
						st[k] = states[i];
						nb[k] = nbt[i];
						k++;
					}
				}
			}
			return new Cells(o, st, nb);
		}
	}

	private static final Map<StructureTemplate, Map<Integer, Cells>> CACHE = new WeakHashMap<>();

	/**
	 * The shared cell list of {@code t} placed with {@code settings} (rotation and mirror; no processors), cached per template
	 * and rotation. Server thread.
	 */
	static Cells cells(ServerLevel level, StructureTemplate t, StructurePlaceSettings settings) {
		if (!settings.getProcessors().isEmpty() || settings.getBoundingBox() != null || settings.shouldApplyWaterlogging() || settings.getKnownShape()) {
			throw new IllegalArgumentException("TemplateWriter supports plain placements only (no processors, box, waterlogging or known shape)");
		}
		List<StructureTemplate.Palette> palettes = ((StructureTemplateAccessor) t).architect$palettes();
		int key = settings.getRotation().ordinal() * 2 + settings.getMirror().ordinal();
		if (palettes.size() == 1) {
			synchronized (CACHE) {
				Cells c = CACHE.computeIfAbsent(t, k -> new java.util.HashMap<>()).get(key);
				if (c != null) {
					return c;
				}
			}
		}
		List<StructureTemplate.StructureBlockInfo> infos = palettes.isEmpty() ? List.of()
			: StructureTemplate.processBlockInfos(level, BlockPos.ZERO, BlockPos.ZERO, settings, settings.getRandomPalette(palettes, BlockPos.ZERO).blocks());
		int n = infos.size();
		int[] off = new int[n * 3];
		BlockState[] states = new BlockState[n];
		CompoundTag[] nbt = new CompoundTag[n];
		for (int i = 0; i < n; i++) {
			StructureTemplate.StructureBlockInfo info = infos.get(i);
			off[i * 3] = info.pos().getX();
			off[i * 3 + 1] = info.pos().getY();
			off[i * 3 + 2] = info.pos().getZ();
			states[i] = info.state().mirror(settings.getMirror()).rotate(settings.getRotation());
			nbt[i] = info.nbt();
		}
		Cells c = new Cells(off, states, nbt);
		if (palettes.size() == 1) {
			synchronized (CACHE) {
				CACHE.computeIfAbsent(t, k -> new java.util.HashMap<>()).put(key, c);
			}
		}
		return c;
	}

	final Cells cells;
	final int px;
	final int py;
	final int pz;
	final int flags;
	int phase = SET;
	int cursor;
	final BitSet placed = new BitSet();
	int minX = Integer.MAX_VALUE;
	int minY = Integer.MAX_VALUE;
	int minZ = Integer.MAX_VALUE;
	int maxX = Integer.MIN_VALUE;
	int maxY = Integer.MIN_VALUE;
	int maxZ = Integer.MIN_VALUE;

	TemplateWriter(Cells cells, BlockPos placePos, int flags) {
		this.cells = cells;
		this.px = placePos.getX();
		this.py = placePos.getY();
		this.pz = placePos.getZ();
		this.flags = flags;
	}

	boolean done() {
		return phase == DONE;
	}

	/** Cells written (or updated) so far, for progress: every SET cell, then every POST cell. */
	int progress() {
		return switch (phase) {
			case SET -> cursor;
			case EDGE -> cells.size();
			case POST -> cells.size() + placed.get(0, Math.max(0, cursor)).cardinality();
			default -> cells.size() + placed.cardinality();
		};
	}

	/** {@link #progress} once done. */
	int total() {
		return cells.size() + placed.cardinality();
	}

	/**
	 * Writes until done or {@code deadline} ({@link System#nanoTime}); at least one cell per call. Returns the cells handled.
	 * Server thread, inside the caller's {@link TickDeferral} window.
	 */
	int step(ServerLevel level, long deadline) {
		int handled = 0;
		while (phase != DONE) {
			if (handled > 0 && handled % CLOCK == 0 && System.nanoTime() >= deadline) {
				return handled;
			}
			switch (phase) {
				case SET -> {
					if (cursor >= cells.size()) {
						phase = EDGE;
						continue;
					}
					set(level, cursor++);
					handled++;
				}
				case EDGE -> {
					// vanilla's StructureTemplate.updateShapeAtEdge, face by face over ticks (phase 4e: a size-cap template's
					// edge took 40 ms in one tick): the same faces in the same order, the same updates
					if (minX > maxX) {
						phase = POST;
						cursor = -1;
						continue;
					}
					if (faces == null) {
						// the face list of a large template is built off the server thread (5b: a 96x64x96 delta's took 50-140 ms)
						if (facing == null) {
							int x0 = minX;
							int y0 = minY;
							int z0 = minZ;
							int sx = maxX - minX + 1;
							int sy = maxY - minY + 1;
							int sz = maxZ - minZ + 1;
							java.util.function.Supplier<int[]> build = () -> {
								DiscreteVoxelShape shape = new BitSetDiscreteVoxelShape(sx, sy, sz);
								for (int i = placed.nextSetBit(0); i >= 0; i = placed.nextSetBit(i + 1)) {
									shape.fill(px + cells.off[i * 3] - x0, py + cells.off[i * 3 + 1] - y0, pz + cells.off[i * 3 + 2] - z0);
								}
								it.unimi.dsi.fastutil.ints.IntArrayList f = new it.unimi.dsi.fastutil.ints.IntArrayList();
								shape.forAllFaces((d, x, y, z) -> {
									f.add(d.ordinal());
									f.add(x);
									f.add(y);
									f.add(z);
								});
								return f.toIntArray();
							};
							facing = placed.cardinality() > ASYNC_FACES ? java.util.concurrent.CompletableFuture.supplyAsync(build)
								: java.util.concurrent.CompletableFuture.completedFuture(build.get());
						}
						if (!facing.isDone()) {
							return Math.max(handled, 1);
						}
						faces = facing.join();
						facing = null;
						edgeCursor = 0;
					}
					if (edgeCursor < faces.length) {
						edgeFace(level, edgeCursor);
						edgeCursor += 4;
						handled++;
						continue;
					}
					faces = null;
					phase = POST;
					cursor = -1;
				}
				case POST -> {
					int i = placed.nextSetBit(cursor + 1);
					if (i < 0) {
						phase = DONE;
						continue;
					}
					cursor = i;
					post(level, i);
					handled++;
				}
				default -> {
					return handled;
				}
			}
		}
		return handled;
	}

	private int @Nullable [] faces;
	private java.util.concurrent.@Nullable CompletableFuture<int[]> facing;
	/** Above this many placed cells the edge's face list is built on a worker thread. */
	static final int ASYNC_FACES = 50_000;
	private int edgeCursor;
	private final BlockPos.MutableBlockPos edgeA = new BlockPos.MutableBlockPos();
	private final BlockPos.MutableBlockPos edgeB = new BlockPos.MutableBlockPos();

	/** One face of vanilla's updateShapeAtEdge lambda. */
	private void edgeFace(ServerLevel level, int k) {
		net.minecraft.core.Direction d = net.minecraft.core.Direction.values()[faces[k]];
		edgeA.set(minX + faces[k + 1], minY + faces[k + 2], minZ + faces[k + 3]);
		edgeB.setWithOffset(edgeA, d);
		BlockState a = level.getBlockState(edgeA);
		BlockState b = level.getBlockState(edgeB);
		BlockState na = a.updateShape(level, level, edgeA, d, edgeB, b, level.getRandom());
		if (a != na) {
			level.setBlock(edgeA, na, flags & -2);
		}
		BlockState nb = b.updateShape(level, level, edgeB, d.getOpposite(), edgeA, na, level.getRandom());
		if (b != nb) {
			level.setBlock(edgeB, nb, flags & -2);
		}
	}

	private void set(ServerLevel level, int i) {
		// an immutable position: a block entity created by setBlock keeps it
		BlockPos p = new BlockPos(px + cells.off[i * 3], py + cells.off[i * 3 + 1], pz + cells.off[i * 3 + 2]);
		BlockState state = cells.states[i];
		CompoundTag nbt = cells.nbt[i];
		if (nbt != null) {
			level.setBlock(p, Blocks.BARRIER.defaultBlockState(), 820);
		}
		if (level.setBlock(p, state, flags)) {
			minX = Math.min(minX, p.getX());
			minY = Math.min(minY, p.getY());
			minZ = Math.min(minZ, p.getZ());
			maxX = Math.max(maxX, p.getX());
			maxY = Math.max(maxY, p.getY());
			maxZ = Math.max(maxZ, p.getZ());
			placed.set(i);
			if (nbt != null) {
				BlockEntity be = level.getBlockEntity(p);
				if (be != null) {
					CompoundTag copy = nbt.copy();
					if (be instanceof RandomizableContainer) {
						copy.putLong("LootTableSeed", level.getRandom().nextLong());
					}
					be.loadWithComponents(TagValueInput.create(ProblemReporter.DISCARDING, level.registryAccess(), copy));
				}
			}
		}
	}

	private void post(ServerLevel level, int i) {
		BlockPos at = new BlockPos(px + cells.off[i * 3], py + cells.off[i * 3 + 1], pz + cells.off[i * 3 + 2]);
		BlockState state = level.getBlockState(at);
		BlockState newState = Block.updateFromNeighbourShapes(state, level, at);
		if (state != newState) {
			level.setBlock(at, newState, flags & -2 | 16);
		}
		level.updateNeighborsAt(at, newState.getBlock());
		if (cells.nbt[i] != null) {
			BlockEntity be = level.getBlockEntity(at);
			if (be != null) {
				be.setChanged();
			}
		}
	}

	// ------------------------------------------------------------------ persistence (a relog mid-job resumes from here)

	JsonObject toJson() {
		JsonObject o = new JsonObject();
		o.addProperty("phase", phase);
		o.addProperty("cursor", cursor);
		JsonArray bits = new JsonArray();
		for (long w : placed.toLongArray()) {
			bits.add(w);
		}
		o.add("placed", bits);
		JsonArray mm = new JsonArray();
		for (int v : new int[] {minX, minY, minZ, maxX, maxY, maxZ}) {
			mm.add(v);
		}
		o.add("bounds", mm);
		return o;
	}

	void load(JsonObject o) {
		phase = o.get("phase").getAsInt();
		cursor = o.get("cursor").getAsInt();
		JsonArray bits = o.getAsJsonArray("placed");
		long[] w = new long[bits.size()];
		for (int i = 0; i < w.length; i++) {
			w[i] = bits.get(i).getAsLong();
		}
		placed.clear();
		placed.or(BitSet.valueOf(w));
		JsonArray mm = o.getAsJsonArray("bounds");
		minX = mm.get(0).getAsInt();
		minY = mm.get(1).getAsInt();
		minZ = mm.get(2).getAsInt();
		maxX = mm.get(3).getAsInt();
		maxY = mm.get(4).getAsInt();
		maxZ = mm.get(5).getAsInt();
	}
}
