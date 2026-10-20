package dev.larattalabs.architect.site;

import dev.larattalabs.architect.journal.Journal.Value;
import dev.larattalabs.architect.journal.Pt;
import dev.larattalabs.architect.journal.UpdateMask;
import dev.larattalabs.architect.journal.WorldJournal;
import it.unimi.dsi.fastutil.longs.Long2ObjectMap;
import it.unimi.dsi.fastutil.longs.Long2ObjectOpenHashMap;
import it.unimi.dsi.fastutil.longs.LongLinkedOpenHashSet;
import java.util.ArrayList;
import java.util.List;
import java.util.Random;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.nbt.CompoundTag;
import net.minecraft.nbt.ListTag;
import net.minecraft.resources.ResourceKey;
import net.minecraft.world.level.BlockGetter;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.FallingBlock;
import net.minecraft.world.level.block.FenceGateBlock;
import net.minecraft.world.level.block.entity.BlockEntity;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.material.FluidState;
import org.jspecify.annotations.Nullable;

/**
 * The undo model tester's in-memory world (docs/UMT.md): block states, block entity data and player-placed records (PT) per cell
 * of a small arena that crosses section and region-of-chunk boundaries, with a durable copy (the last autosave: what a crash
 * leaves). It is a {@link BlockGetter} (the production {@code Sites.evidence} reads it) and a {@link SiteJournal.CellTarget} (the
 * production {@code SiteJournal.writeCells}/{@code fixHalves} write into it).
 *
 * <p><b>Modelled vanilla rules</b> (each a calibration item in docs/UMT.md, never production code):
 * <ul>
 * <li>V1 a write without {@code UPDATE_KNOWN_SHAPE} sends shape updates to its six neighbours, except into positions
 * {@link UpdateMask} masks (the restore's holes); a falling block, or a dirt path or farmland under a now solid block, that gets
 * one schedules a tick;</li>
 * <li>V2 a falling block written without {@code UPDATE_SKIP_ON_PLACE} schedules its own tick;</li>
 * <li>V3 at {@link #tick} a falling block over a free cell ({@link FallingBlock#isFree}) falls to the lowest free cell below it;
 * a dirt path or farmland under a solid block (not a fence gate) turns to dirt; each such change is an ordinary update
 * (it cascades); ticks at masked positions were dropped when scheduled;</li>
 * <li>V4 PT records: an Architect write that changes a cell clears its record, or, while an undo restores records
 * ({@code Restore.pts}), gives it back when the block it writes is the record's block; a fall or a conversion clears it.</li>
 * </ul>
 */
final class UmtWorld implements BlockGetter, SiteJournal.CellTarget {
	/** The arena (inclusive): two section rows in x and z, two in y (64 is a section boundary). */
	static final int X0 = 8;
	static final int X1 = 39;
	static final int Z0 = 8;
	static final int Z1 = 39;
	static final int Y0 = 56;
	static final int Y1 = 75;
	static final int GROUND = 63;
	static final ResourceKey<Level> DIM = Level.OVERWORLD;
	static final String DIM_ID = "minecraft:overworld";

	static final BlockState AIR = Blocks.AIR.defaultBlockState();
	static final BlockState STONE = Blocks.STONE.defaultBlockState();

	private Long2ObjectOpenHashMap<BlockState> states = new Long2ObjectOpenHashMap<>();
	private Long2ObjectOpenHashMap<CompoundTag> nbt = new Long2ObjectOpenHashMap<>();
	private Long2ObjectOpenHashMap<Pt> pt = new Long2ObjectOpenHashMap<>();
	/** The last autosave (what a crash leaves on disk). */
	private @Nullable UmtWorld saved;
	/** Scheduled ticks (V3), in order. */
	private final LongLinkedOpenHashSet ticks = new LongLinkedOpenHashSet();
	/** An undo's records being restored (V4; production: {@code Placed.beginRestore}), or null. */
	@Nullable Long2ObjectOpenHashMap<dev.larattalabs.architect.placed.Placed.Expect> restoring;
	/** Every change the world made by itself (falls, conversions), for reports. */
	final List<String> natural = new ArrayList<>();

	static boolean inArena(long p) {
		int x = BlockPos.getX(p);
		int y = BlockPos.getY(p);
		int z = BlockPos.getZ(p);
		return x >= X0 && x <= X1 && y >= Y0 && y <= Y1 && z >= Z0 && z <= Z1;
	}

	/** A seeded worldgen-like arena: stone, dirt, grass, a pond, sand (some of it hanging over air), a dirt path, farmland, a chest, a player's wall. */
	static UmtWorld generate(long seed) {
		Random r = new Random(seed);
		UmtWorld w = new UmtWorld();
		for (int x = X0; x <= X1; x++) {
			for (int z = Z0; z <= Z1; z++) {
				for (int y = Y0; y <= Y1; y++) {
					BlockState s = y < GROUND - 2 ? STONE : y < GROUND ? Blocks.DIRT.defaultBlockState() : y == GROUND ? Blocks.GRASS_BLOCK.defaultBlockState() : AIR;
					w.states.put(BlockPos.asLong(x, y, z), s);
				}
			}
		}
		// a pond (sources) with a short stream of flowing water at its rim
		int px = X0 + 3 + r.nextInt(8);
		int pz = Z0 + 3 + r.nextInt(8);
		for (int x = px; x < px + 4; x++) {
			for (int z = pz; z < pz + 3; z++) {
				w.states.put(BlockPos.asLong(x, GROUND, z), Blocks.WATER.defaultBlockState());
			}
		}
		for (int i = 1; i <= 3; i++) {
			w.states.put(BlockPos.asLong(px + 3 + i, GROUND, pz + 1), Blocks.WATER.defaultBlockState().setValue(net.minecraft.world.level.block.LiquidBlock.LEVEL,
				Math.min(7, i * 2)));
		}
		// a sand patch (supported) and worldgen sand hanging over a cave (unsupported until an update reaches it)
		int sx = X0 + 14 + r.nextInt(6);
		int sz = Z0 + 4 + r.nextInt(8);
		for (int x = sx; x < sx + 3; x++) {
			for (int z = sz; z < sz + 3; z++) {
				w.states.put(BlockPos.asLong(x, GROUND, z), Blocks.SAND.defaultBlockState());
				w.states.put(BlockPos.asLong(x, GROUND - 1, z), Blocks.SAND.defaultBlockState());
			}
		}
		w.states.put(BlockPos.asLong(sx + 1, GROUND - 2, sz + 1), AIR); // a cave pocket under the sand
		w.states.put(BlockPos.asLong(sx + 1, GROUND - 3, sz + 1), AIR);
		// a stone ledge with sand on top above the ground (stacked gravity)
		int lx = X0 + 4 + r.nextInt(10);
		int lz = Z0 + 18 + r.nextInt(8);
		w.states.put(BlockPos.asLong(lx, GROUND + 1, lz), STONE);
		w.states.put(BlockPos.asLong(lx, GROUND + 2, lz), Blocks.GRAVEL.defaultBlockState());
		// a lane of dirt path and a little farm
		int fz = Z0 + 26 + r.nextInt(4);
		for (int x = X0 + 2; x < X1 - 2; x++) {
			w.states.put(BlockPos.asLong(x, GROUND, fz), Blocks.DIRT_PATH.defaultBlockState());
		}
		for (int x = X0 + 18; x < X0 + 22; x++) {
			w.states.put(BlockPos.asLong(x, GROUND, fz + 2), Blocks.FARMLAND.defaultBlockState());
		}
		// a chest with items (block entity data)
		long chest = BlockPos.asLong(X0 + 20 + r.nextInt(6), GROUND + 1, Z0 + 20 + r.nextInt(6));
		w.states.put(chest, Blocks.CHEST.defaultBlockState());
		w.nbt.put(chest, chestNbt(chest, "minecraft:bread", 3));
		// a player's wall: cobblestone with records (6c PT)
		int wx = X0 + 24 + r.nextInt(4);
		int wz = Z0 + 6 + r.nextInt(6);
		Pt rec = new Pt(new java.util.UUID(1L, 2L), null);
		for (int i = 0; i < 4; i++) {
			long p = BlockPos.asLong(wx + i, GROUND + 1, wz);
			w.states.put(p, Blocks.COBBLESTONE.defaultBlockState());
			w.pt.put(p, rec);
		}
		w.autosave();
		return w;
	}

	static CompoundTag chestNbt(long p, String item, int count) {
		CompoundTag t = new CompoundTag();
		t.putString("id", "minecraft:chest");
		t.putInt("x", BlockPos.getX(p));
		t.putInt("y", BlockPos.getY(p));
		t.putInt("z", BlockPos.getZ(p));
		ListTag items = new ListTag();
		CompoundTag it = new CompoundTag();
		it.putString("id", item);
		it.putInt("count", count);
		it.putByte("Slot", (byte) 0);
		items.add(it);
		t.put("Items", items);
		return t;
	}

	// ------------------------------------------------------------------ reads

	BlockState get(long p) {
		BlockState s = states.get(p);
		if (s != null) {
			return s;
		}
		return BlockPos.getY(p) < GROUND - 2 ? STONE : AIR;
	}

	@Nullable CompoundTag nbt(long p) {
		return nbt.get(p);
	}

	@Nullable Pt record(long p) {
		return pt.get(p);
	}

	/** The cell as the journal keeps it ({@code WorldJournal.valueAt}). */
	Value value(long p) {
		Value v = WorldJournal.value(get(p));
		CompoundTag t = nbt.get(p);
		return t != null && get(p).hasBlockEntity() ? v.withNbt(t.copy()) : v;
	}

	/** Whether the cell still holds {@code after} for an undo: the production rule ({@code WorldJournal.holdsOurs}) on this cell. */
	boolean holdsOurs(long p, Value after) {
		return WorldJournal.holdsOurs(get(p), () -> nbt(p) == null ? null : nbt(p).copy(), () -> record(p) != null, after);
	}

	@Override
	public @Nullable BlockEntity getBlockEntity(BlockPos pos) {
		return null; // block entity data is kept as NBT (value, holdsOurs); the readers UMT drives never ask for the entity
	}

	@Override
	public BlockState getBlockState(BlockPos pos) {
		return get(pos.asLong());
	}

	@Override
	public FluidState getFluidState(BlockPos pos) {
		return get(pos.asLong()).getFluidState();
	}

	@Override
	public int getHeight() {
		return 384;
	}

	@Override
	public int getMinY() {
		return -64;
	}

	// ------------------------------------------------------------------ CellTarget (SiteJournal.writeCells, fixHalves)

	@Override
	public BlockState get(BlockPos p) {
		return get(p.asLong());
	}

	@Override
	public void set(BlockPos p, BlockState s, int flags) {
		write(p.asLong(), s, null, flags);
	}

	@Override
	public void loadNbt(BlockPos p, CompoundTag t) {
		if (get(p.asLong()).hasBlockEntity()) {
			nbt.put(p.asLong(), t.copy());
		}
	}

	@Override
	public ResourceKey<Level> dimension() {
		return DIM;
	}

	// ------------------------------------------------------------------ writes

	/** An Architect write ({@code Placed.set} / a template cell): V1, V2, V4. */
	void write(long p, BlockState s, @Nullable CompoundTag data, int flags) {
		BlockState old = get(p);
		if (old == s && data == null) {
			return; // setBlock changes nothing: no update, no record change
		}
		put(p, s, data);
		if (old != s) {
			var e = restoring == null ? null : restoring.get(p);
			if (e != null && !s.isAir() && s.getBlock() == e.block()) {
				pt.put(p, e.pt());
			} else {
				pt.remove(p);
			}
		}
		updates(p, s, flags);
	}

	/** A player's change: places {@code s} with a record ({@code rec}), or mines (air, no record). */
	void player(long p, BlockState s, @Nullable Pt rec, @Nullable CompoundTag data) {
		put(p, s, data);
		if (rec != null && !s.isAir()) {
			pt.put(p, rec);
		} else {
			pt.remove(p);
		}
		updates(p, s, Block.UPDATE_ALL);
		tick();
	}

	/** The world's own change (weathering, a dried farmland, grass spreading, water flowing): no record changes but a cleared cell's. */
	void natural(long p, BlockState s) {
		put(p, s, null);
		if (s.isAir()) {
			pt.remove(p);
		}
		natural.add("natural " + BlockPos.of(p).toShortString() + " -> " + s);
	}

	private void put(long p, BlockState s, @Nullable CompoundTag data) {
		BlockState old = get(p);
		states.put(p, s);
		if (!s.hasBlockEntity()) {
			nbt.remove(p);
		} else if (data != null) {
			nbt.put(p, data.copy());
		} else if (old.getBlock() != s.getBlock()) {
			nbt.remove(p); // a new block entity: empty
		}
	}

	private void updates(long p, BlockState s, int flags) {
		if ((flags & Block.UPDATE_SKIP_ON_PLACE) == 0 && s.getBlock() instanceof FallingBlock) {
			schedule(p); // V2
		}
		if ((flags & Block.UPDATE_KNOWN_SHAPE) != 0) {
			return;
		}
		for (Direction d : Direction.values()) {
			long n = BlockPos.offset(p, d);
			if (UpdateMask.masked(n)) {
				continue; // (4e) no shape update into a covered position
			}
			BlockState ns = get(n);
			if (ns.getBlock() instanceof FallingBlock || d == Direction.DOWN && turnsToDirt(ns, s)) {
				schedule(n); // V1
			}
		}
	}

	private void schedule(long p) {
		if (!UpdateMask.masked(p)) {
			ticks.add(p); // (4e LevelTicksMixin) a tick at a covered position is dropped
		}
	}

	static boolean turnsToDirt(BlockState s, BlockState above) {
		return (s.is(Blocks.DIRT_PATH) || s.is(Blocks.FARMLAND)) && above.isSolid() && !(above.getBlock() instanceof FenceGateBlock);
	}

	/** V3: runs the scheduled ticks until none is left (a cascade is bounded). */
	void tick() {
		int guard = 0;
		while (!ticks.isEmpty() && guard++ < 100_000) {
			long p = ticks.removeFirstLong();
			BlockState s = get(p);
			if (s.getBlock() instanceof FallingBlock && FallingBlock.isFree(get(BlockPos.offset(p, Direction.DOWN)))) {
				long q = p;
				while (BlockPos.getY(q) > Y0 && FallingBlock.isFree(get(BlockPos.offset(q, Direction.DOWN)))) {
					q = BlockPos.offset(q, Direction.DOWN);
				}
				natural(p, AIR);
				updates(p, AIR, Block.UPDATE_ALL);
				natural(q, s);
				pt.remove(q);
				updates(q, s, Block.UPDATE_ALL);
			} else if (turnsToDirt(s, get(BlockPos.offset(p, Direction.UP)))) {
				natural(p, Blocks.DIRT.defaultBlockState());
				pt.remove(p);
				updates(p, Blocks.DIRT.defaultBlockState(), Block.UPDATE_ALL);
			}
		}
	}

	// ------------------------------------------------------------------ durability

	/** An autosave: the world as it is now is what a crash leaves. */
	void autosave() {
		saved = copy();
	}

	/** A crash: back to the last autosave (pending ticks are lost). */
	void crash() {
		UmtWorld s = saved;
		if (s == null) {
			throw new IllegalStateException("never saved");
		}
		states = s.states.clone();
		nbt = new Long2ObjectOpenHashMap<>(s.nbt);
		pt = s.pt.clone();
		ticks.clear();
		restoring = null;
	}

	UmtWorld copy() {
		UmtWorld c = new UmtWorld();
		c.states = states.clone();
		nbt.long2ObjectEntrySet().forEach(e -> c.nbt.put(e.getLongKey(), e.getValue().copy()));
		c.pt = pt.clone();
		return c;
	}

	/** The cells where this world and {@code o} differ (state, block entity data or record), described; empty when equal. */
	List<String> diff(UmtWorld o, java.util.function.LongPredicate skip) {
		List<String> out = new ArrayList<>();
		for (int y = Y0 - 4; y <= Y1; y++) {
			for (int z = Z0; z <= Z1; z++) {
				for (int x = X0; x <= X1; x++) {
					long p = BlockPos.asLong(x, y, z);
					if (skip.test(p)) {
						continue;
					}
					if (get(p) != o.get(p) || !java.util.Objects.equals(nbt(p), o.nbt(p)) || !java.util.Objects.equals(record(p), o.record(p))) {
						out.add(x + "," + y + "," + z + ": " + str(o, p) + " expected, " + str(this, p) + " found");
					}
				}
			}
		}
		return out;
	}

	private static String str(UmtWorld w, long p) {
		return w.get(p) + (w.nbt(p) != null ? " +nbt" : "") + (w.record(p) != null ? " +pt" : "");
	}

	Long2ObjectMap<BlockState> states() {
		return states;
	}
}
