package dev.larattalabs.architect.site;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import dev.larattalabs.architect.Architect;
import dev.larattalabs.architect.placement.Anchor;
import dev.larattalabs.architect.placement.Anchors;
import dev.larattalabs.architect.placement.Approach;
import dev.larattalabs.architect.placement.Blueprint;
import dev.larattalabs.architect.placement.Blueprints;
import dev.larattalabs.architect.placement.GhostModel;
import dev.larattalabs.architect.placement.TemplateGrid;
import dev.larattalabs.architect.placement.TerrainFit;
import dev.larattalabs.architect.survival.BuildOrder;
import dev.larattalabs.architect.survival.CellBits;
import dev.larattalabs.architect.survival.CrateBlockEntity;
import dev.larattalabs.architect.survival.CrateBlocks;
import dev.larattalabs.architect.survival.Equivalents;
import dev.larattalabs.architect.survival.Ledger;
import dev.larattalabs.architect.survival.Refunds;
import dev.larattalabs.architect.survival.SiteNet;
import dev.larattalabs.architect.survival.SurvivalItems;
import dev.larattalabs.architect.survival.SurvivalWorld;
import java.io.IOException;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.BitSet;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerLifecycleEvents;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerTickEvents;
import net.fabricmc.fabric.api.networking.v1.ServerPlayNetworking;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.nbt.CompoundTag;
import net.minecraft.nbt.NbtUtils;
import net.minecraft.nbt.TagParser;
import net.minecraft.network.chat.Component;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.sounds.SoundSource;
import net.minecraft.util.ProblemReporter;
import net.minecraft.world.Container;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.entity.item.ItemEntity;
import net.minecraft.world.item.Item;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.EmptyBlockGetter;
import net.minecraft.world.level.block.AbstractBannerBlock;
import net.minecraft.world.level.block.BaseRailBlock;
import net.minecraft.world.level.block.BasePressurePlateBlock;
import net.minecraft.world.level.block.BaseTorchBlock;
import net.minecraft.world.level.block.BedBlock;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.CandleBlock;
import net.minecraft.world.level.block.CarpetBlock;
import net.minecraft.world.level.block.CeilingHangingSignBlock;
import net.minecraft.world.level.block.DiodeBlock;
import net.minecraft.world.level.block.DoorBlock;
import net.minecraft.world.level.block.FaceAttachedHorizontalDirectionalBlock;
import net.minecraft.world.level.block.FlowerPotBlock;
import net.minecraft.world.level.block.LadderBlock;
import net.minecraft.world.level.block.LanternBlock;
import net.minecraft.world.level.block.RedstoneWireBlock;
import net.minecraft.world.level.block.SeaPickleBlock;
import net.minecraft.world.level.block.SignBlock;
import net.minecraft.world.level.block.SnowLayerBlock;
import net.minecraft.world.level.block.TripWireHookBlock;
import net.minecraft.world.level.block.VegetationBlock;
import net.minecraft.world.level.block.VineBlock;
import net.minecraft.world.level.block.WallBannerBlock;
import net.minecraft.world.level.block.WallHangingSignBlock;
import net.minecraft.world.level.block.WallSignBlock;
import net.minecraft.world.level.block.WallTorchBlock;
import net.minecraft.world.level.block.entity.BlockEntity;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.block.state.properties.AttachFace;
import net.minecraft.world.level.block.state.properties.BedPart;
import net.minecraft.world.level.block.state.properties.BlockStateProperties;
import net.minecraft.world.level.block.state.properties.DoubleBlockHalf;
import net.minecraft.world.level.storage.TagValueInput;
import net.minecraft.world.level.storage.TagValueOutput;
import net.minecraft.world.phys.AABB;
import org.jspecify.annotations.Nullable;

/**
 * Survival construction sites at run time (docs/CONTRACT.md phase 3): turning an instant placement into a site, the builder
 * (each server tick, up to {@code blocksPerTick} queued cells whose item the crate holds), the crate's acceptance rule, the
 * ghost sync, finishing, {@code /architect site finish} and deconstruct with refunds.
 *
 * <p><b>Identical to instant placement by construction.</b> Placing a site runs the instant placement unchanged
 * ({@link Sites}'s build), captures what it wrote over the snapshot box into the site's <b>target file</b>, then clears every
 * queued cell to air in the same tick (no drops). The builder later writes each cell's captured state and block-entity NBT
 * with the same {@link Sites#FLAGS}, so a finished site holds exactly what the instant placement held (stairs, fences, panes
 * keep the shapes it computed). Container inventories in the captured NBT are cleared; waterlogged cells are built dry.
 *
 * <p>What is built is derived from the world (a queued cell is built when the world holds its target block there), never
 * persisted per tick. The crate's ledger lives in its block entity. Server thread only.
 */
public final class Builder {
	/** Ticks a cell may stay blocked before the crate screen reports it. */
	public static final int BLOCKED_TICKS = 200;
	/** Clients within this many blocks (horizontally) of a building site get its ghost. */
	public static final int RANGE = 160;
	/** How far the builder looks ahead in the queue per tick for cells it can place. */
	static final int SCAN = 4096;
	private static final Map<String, Run> RUNS = new ConcurrentHashMap<>();
	/** SITE_PROGRESS rate limit: per site, the tick and built count of the last event. */
	private static final Map<String, long[]> PROGRESS = new ConcurrentHashMap<>();
	/** At most one SITE_PROGRESS per site per this many ticks (one second). */
	static final int PROGRESS_TICKS = 20;
	private static long ticks;

	private Builder() {
	}

	public static void init() {
		ServerTickEvents.END_SERVER_TICK.register(Builder::tick);
		ServerLifecycleEvents.SERVER_STARTED.register(s -> server = s);
		ServerLifecycleEvents.SERVER_STOPPED.register(s -> {
			RUNS.clear();
			PROGRESS.clear();
			server = null;
		});
	}

	// ------------------------------------------------------------------ the run-time state of one site

	/** One construction site's cells, decoded once from its target file, plus what is built and blocked now. */
	static final class Run {
		final String id;
		final long placedAt;
		final Anchors.Bounds box;
		final int dx;
		final int dz;
		final int[] queue;
		final BlockState[] target;
		final @Nullable CompoundTag[] nbt;
		final List<List<SurvivalItems.Cost>> cost;
		final int[] second;
		final boolean[] isSecond;
		final int[] support;
		final Map<Integer, Integer> byBox = new HashMap<>();
		final BitSet built = new BitSet();
		final Map<String, Integer> unbuilt = new TreeMap<>();
		final Map<String, Integer> bom = new TreeMap<>();
		final Map<Integer, Long> blockedSince = new HashMap<>();
		final Set<UUID> sentTo = new HashSet<>();
		int[] newly = new int[64];
		int newlyCount;
		boolean resend;
		int waterlogged;
		boolean crateMissing;
		String name;

		Run(Site s, Cells t) {
			Construction c = s.construction();
			this.id = s.id();
			this.placedAt = s.placedAt();
			this.box = s.restoreBox();
			this.dx = box.maxX() - box.minX() + 1;
			this.dz = box.maxZ() - box.minZ() + 1;
			this.queue = c.queue();
			int n = queue.length;
			this.target = new BlockState[n];
			this.nbt = new CompoundTag[n];
			this.cost = new ArrayList<>(n);
			this.second = new int[n];
			this.isSecond = new boolean[n];
			this.support = new int[n];
			Blueprint bp = Blueprints.get(s.blueprint());
			this.name = bp != null ? bp.name() : s.blueprint();
			for (int i = 0; i < n; i++) {
				byBox.put(queue[i], i);
			}
			for (int i = 0; i < n; i++) {
				int k = queue[i];
				BlockState st = k >= 0 && k < t.size() ? t.states[k] : Blocks.AIR.defaultBlockState();
				if (st.hasProperty(BlockStateProperties.WATERLOGGED) && st.getValue(BlockStateProperties.WATERLOGGED)) {
					st = st.setValue(BlockStateProperties.WATERLOGGED, false); // built dry in survival (no water bucket cost)
					waterlogged++;
				}
				target[i] = st;
				nbt[i] = k >= 0 && k < t.size() ? t.nbt[k] : null;
				List<SurvivalItems.Cost> cs = Cells.cost(st);
				cost.add(cs);
				cs.forEach(x -> bom.merge(x.item(), x.count(), Integer::sum));
			}
			Arrays.fill(second, -1);
			Arrays.fill(support, -1);
			for (int i = 0; i < n; i++) {
				int p = pairFirst(i);
				if (p >= 0) {
					isSecond[i] = true;
					second[p] = i;
				}
				support[i] = supportOf(i);
			}
			// nothing built yet: rescan derives it from the world
			for (int i = 0; i < n; i++) {
				cost.get(i).forEach(x -> unbuilt.merge(x.item(), x.count(), Integer::sum));
			}
		}

		int size() {
			return queue.length;
		}

		BlockPos pos(int i) {
			int[] o = Construction.offsets(queue[i], dx, dz);
			return new BlockPos(box.minX() + o[0], box.minY() + o[1], box.minZ() + o[2]);
		}

		int queuePos(BlockPos p) {
			if (!box.contains(p.getX(), p.getY(), p.getZ())) {
				return -1;
			}
			Integer i = byBox.get(Construction.index(p.getX() - box.minX(), p.getY() - box.minY(), p.getZ() - box.minZ(), dx, dz));
			return i == null ? -1 : i;
		}

		/** For the second cell of a pair (door upper half, bed head, tall plant top), its first; else -1. */
		int pairFirst(int i) {
			BlockState s = target[i];
			BlockPos p = pos(i);
			BlockPos first = null;
			if (s.hasProperty(BlockStateProperties.DOUBLE_BLOCK_HALF) && s.getValue(BlockStateProperties.DOUBLE_BLOCK_HALF) == DoubleBlockHalf.UPPER) {
				first = p.below();
			} else if (s.getBlock() instanceof BedBlock && s.getValue(BedBlock.PART) == BedPart.HEAD) {
				first = p.relative(s.getValue(BedBlock.FACING).getOpposite());
			}
			if (first == null) {
				return -1;
			}
			int f = queuePos(first);
			return f >= 0 && target[f].is(s.getBlock()) ? f : -1;
		}

		/** The queued cell an attachable needs first, or -1. */
		int supportOf(int i) {
			BlockState s = target[i];
			if (kind(s) != BuildOrder.ATTACHABLE) {
				return -1;
			}
			Direction d = supportDirection(s);
			int q = queuePos(pos(i).relative(d));
			return q == i ? -1 : q;
		}

		boolean affordable(int i, Ledger ledger) {
			Map<String, Integer> need = new HashMap<>();
			cost.get(i).forEach(c -> need.merge(c.item(), c.count(), Integer::sum));
			if (second[i] >= 0) {
				cost.get(second[i]).forEach(c -> need.merge(c.item(), c.count(), Integer::sum));
			}
			for (var e : need.entrySet()) {
				if (ledger.stock(e.getKey()) < e.getValue()) {
					return false;
				}
			}
			return true;
		}

		void markBuilt(int i, boolean on) {
			if (built.get(i) == on) {
				return;
			}
			built.set(i, on);
			cost.get(i).forEach(c -> unbuilt.merge(c.item(), on ? -c.count() : c.count(), Integer::sum));
			if (on) {
				if (newlyCount == newly.length) {
					newly = Arrays.copyOf(newly, newly.length * 2);
				}
				newly[newlyCount++] = i;
			} else {
				resend = true;
			}
		}

		int unbuiltCost(String item) {
			return Math.max(0, unbuilt.getOrDefault(item, 0));
		}

		/** The world holds what this cell gets (by block: a door the player opened is still built). */
		boolean matches(BlockState now, int i) {
			return now.is(target[i].getBlock());
		}

		/** Derives {@link #built} from the world for every queued cell in a loaded chunk. Returns cells that changed. */
		int rescan(ServerLevel level) {
			return rescan(level, false);
		}

		/**
		 * {@code load}: read unloaded chunks too (once, at world start, as the sites check does for every site); the builder's
		 * own rescans never load a chunk.
		 */
		int rescan(ServerLevel level, boolean load) {
			int changed = 0;
			BlockPos.MutableBlockPos m = new BlockPos.MutableBlockPos();
			for (int i = 0; i < queue.length; i++) {
				int[] o = Construction.offsets(queue[i], dx, dz);
				m.set(box.minX() + o[0], box.minY() + o[1], box.minZ() + o[2]);
				if (!load && !level.isLoaded(m)) {
					continue;
				}
				boolean b = matches(level.getBlockState(m), i);
				if (b != built.get(i)) {
					markBuilt(i, b);
					changed++;
				}
			}
			return changed;
		}

		int[] takeNewly() {
			int[] a = CellBits.batch(newly, newlyCount);
			newlyCount = 0;
			return a;
		}

		int blockedReported() {
			int n = 0;
			for (long since : blockedSince.values()) {
				if (ticks - since >= BLOCKED_TICKS) {
					n++;
				}
			}
			return n;
		}
	}

	/** {@link BuildOrder#FULL}, {@link BuildOrder#PARTIAL} or {@link BuildOrder#ATTACHABLE} for a block state. */
	static int kind(BlockState s) {
		var b = s.getBlock();
		if (b instanceof BaseTorchBlock || b instanceof LanternBlock || b instanceof FaceAttachedHorizontalDirectionalBlock || b instanceof DoorBlock
			|| b instanceof BedBlock || b instanceof LadderBlock || b instanceof SignBlock || b instanceof AbstractBannerBlock || b instanceof CarpetBlock
			|| b instanceof VegetationBlock || b instanceof FlowerPotBlock || b instanceof BasePressurePlateBlock || b instanceof BaseRailBlock
			|| b instanceof RedstoneWireBlock || b instanceof CandleBlock || b instanceof SeaPickleBlock || b instanceof VineBlock
			|| b instanceof SnowLayerBlock || b instanceof TripWireHookBlock || b instanceof DiodeBlock) {
			return BuildOrder.ATTACHABLE;
		}
		return s.isCollisionShapeFullBlock(EmptyBlockGetter.INSTANCE, BlockPos.ZERO) ? BuildOrder.FULL : BuildOrder.PARTIAL;
	}

	/** Where an attachable's support is. */
	static Direction supportDirection(BlockState s) {
		var b = s.getBlock();
		if (b instanceof WallTorchBlock || b instanceof LadderBlock || b instanceof WallSignBlock || b instanceof WallHangingSignBlock
			|| b instanceof WallBannerBlock || b instanceof TripWireHookBlock) {
			if (s.hasProperty(BlockStateProperties.HORIZONTAL_FACING)) {
				return s.getValue(BlockStateProperties.HORIZONTAL_FACING).getOpposite();
			}
		}
		if (b instanceof FaceAttachedHorizontalDirectionalBlock && s.hasProperty(BlockStateProperties.ATTACH_FACE)) {
			AttachFace f = s.getValue(BlockStateProperties.ATTACH_FACE);
			return f == AttachFace.FLOOR ? Direction.DOWN : f == AttachFace.CEILING ? Direction.UP
				: s.getValue(BlockStateProperties.HORIZONTAL_FACING).getOpposite();
		}
		if (b instanceof LanternBlock && s.getValue(LanternBlock.HANGING) || b instanceof CeilingHangingSignBlock) {
			return Direction.UP;
		}
		return Direction.DOWN;
	}

	// ------------------------------------------------------------------ lookups

	static @Nullable Run run(MinecraftServer server, Site s) {
		Construction c = s.construction();
		if (c == null) {
			return null;
		}
		Run r = RUNS.get(s.id());
		if (r != null && r.placedAt == s.placedAt() && r.box.equals(s.restoreBox())) {
			return r;
		}
		CompoundTag tag;
		try {
			tag = Sites.readSnapshot(c.target());
		} catch (IOException | RuntimeException e) {
			Architect.LOGGER.warn("Construction site {}: its target file {} can't be read; it can only be removed", s.id(), c.target(), e);
			return null;
		}
		r = new Run(s, Cells.read(tag));
		ServerLevel level = Sites.levelOf(server, s);
		if (level != null) {
			r.rescan(level);
			r.newlyCount = 0;
			r.resend = false;
		}
		RUNS.put(s.id(), r);
		return r;
	}

	private static @Nullable MinecraftServer server;

	/** Whether {@code siteId} is a construction site still building (the crate is unbreakable then). Any thread. */
	public static boolean siteBuilding(String siteId) {
		Site s = siteId == null || siteId.isEmpty() ? null : Sites.get(siteId);
		return s != null && s.building();
	}

	static @Nullable CrateBlockEntity crate(ServerLevel level, Site s, boolean load) {
		Construction c = s.construction();
		if (c == null || c.crate() == null) {
			return null;
		}
		BlockPos p = new BlockPos(c.crate().x(), c.crate().y(), c.crate().z());
		if (!load && !level.isLoaded(p)) {
			return null;
		}
		return level.getBlockEntity(p) instanceof CrateBlockEntity be && s.id().equals(be.siteId()) ? be : null;
	}

	/**
	 * The crate's acceptance rule: what one unit of {@code item} would credit (itself or an equivalent the site still misses),
	 * booked when {@code commit}. Null when the site doesn't need it, isn't building, or is unknown.
	 */
	public static Ledger.@Nullable Accepted accepts(String siteId, CrateBlockEntity crate, String item, boolean commit) {
		MinecraftServer srv = server;
		Site s = siteId == null || siteId.isEmpty() ? null : Sites.get(siteId);
		if (srv == null || s == null || !s.building()) {
			return null;
		}
		Run r = run(srv, s);
		if (r == null) {
			return null;
		}
		return crate.ledger().accept(item, r::unbuiltCost, Equivalents.bundled(), commit);
	}

	/** An insert changed the crate's ledger (status is sent again soon). */
	public static void delivered(String siteId) {
	}

	// ------------------------------------------------------------------ place: instant placement -> construction site

	/**
	 * Turns the instant placement just built into a construction site: captures the target, puts the crate down and clears
	 * every queued cell to air (free, no drops). Called by {@link Sites#place} before the record is committed; throws after
	 * undoing its own changes (the caller takes the placement down).
	 */
	static Construction convert(ServerLevel level, Blueprint bp, Sites.Built built, String id, @Nullable String owner) throws Sites.SiteException {
		Anchors.Bounds sb = built.snapshotBox();
		int dx = sb.maxX() - sb.minX() + 1;
		int dz = sb.maxZ() - sb.minZ() + 1;
		// the queued cells: what the instant placement wrote that is not air (template, foundation fill, approach)
		List<BlockPos> cells = new ArrayList<>();
		Set<Long> seen = new HashSet<>();
		GhostModel m = built.grid().ghost(built.turns());
		BlockState[] tstates = built.grid().states();
		for (int i = 0; i < m.count(); i++) {
			if (tstates[i].isAir()) {
				continue;
			}
			add(cells, seen, new BlockPos(built.box().minX() + m.x(i), built.box().minY() + m.y(i), built.box().minZ() + m.z(i)));
		}
		TerrainFit.Plan plan = built.plan();
		for (int i = 0; i + 2 < plan.fill().length; i += 3) {
			add(cells, seen, new BlockPos(plan.fill()[i], plan.fill()[i + 1], plan.fill()[i + 2]));
		}
		Approach.Plan a = built.approach();
		for (int[] arr : new int[][] {a.fill(), a.path(), a.slabs()}) {
			for (int i = 0; i + 2 < arr.length; i += 3) {
				add(cells, seen, new BlockPos(arr[i], arr[i + 1], arr[i + 2]));
			}
		}
		// settle: block ticks the instant placement scheduled on its own cells run now (a path that ended up under a solid
		// block turns to dirt one tick later), so the target is what an instant placement holds once it has settled
		int settled = 0;
		for (BlockPos p : cells) {
			BlockState st = level.getBlockState(p);
			if (!st.isAir() && level.getBlockTicks().hasScheduledTick(p, st.getBlock())) {
				st.tick(level, p, level.getRandom());
				settled++;
			}
		}
		if (settled > 0) {
			Architect.LOGGER.info("Construction site {}: ran {} block tick(s) the instant placement scheduled on its cells", id, settled);
		}
		// the target: what the instant placement left over the whole snapshot box (states and block-entity NBT)
		CompoundTag target;
		String targetFile = id + "-" + System.currentTimeMillis() + "-target.nbt";
		try {
			target = Sites.capture(level, sb);
			Sites.writeSnapshotFile(targetFile, target);
		} catch (IOException e) {
			throw new Sites.SiteException("Could not save the construction site's plan (" + e.getMessage() + "); nothing was placed");
		}
		Cells t = Cells.read(target);
		List<Integer> idx = new ArrayList<>();
		for (BlockPos p : cells) {
			int k = Construction.index(p.getX() - sb.minX(), p.getY() - sb.minY(), p.getZ() - sb.minZ(), dx, dz);
			if (k >= 0 && k < t.size() && !t.states[k].isAir()) {
				idx.add(k); // a bed BedSafety left out is air: not queued, not charged
			}
		}
		// build order
		int n = idx.size();
		int[] boxIdx = idx.stream().mapToInt(Integer::intValue).toArray();
		Site probe = new Site(id, bp.id(), "none", built.box(), built.box(), Map.of(), 0L, Sites.dimensionId(level), sb, built.snapshot(), null, null,
			new Construction(Construction.BUILDING, boxIdx, targetFile, null, new BitSet(), false, owner));
		Run r = new Run(probe, t);
		int[] y = new int[n];
		int[] kind = new int[n];
		int[] pairOf = new int[n];
		for (int i = 0; i < n; i++) {
			y[i] = r.pos(i).getY();
			kind[i] = kind(r.target[i]);
			pairOf[i] = r.isSecond[i] ? r.pairFirst(i) : -1;
		}
		int[] order = BuildOrder.order(y, kind, r.support, pairOf);
		int[] queue = new int[n];
		for (int i = 0; i < n; i++) {
			queue[i] = boxIdx[order[i]];
		}
		// the crate: outside the snapshot box, at the approach's end (or 2 out from the entrance)
		BlockPos cratePos = cratePos(level, bp, built, sb);
		BlockState was = level.getBlockState(cratePos);
		BlockEntity wasBe = level.getBlockEntity(cratePos);
		String wasNbt = wasBe == null ? null : wasBe.saveWithFullMetadata(level.registryAccess()).toString();
		Construction.Crate crate = new Construction.Crate(cratePos.getX(), cratePos.getY(), cratePos.getZ(), NbtUtils.writeBlockState(was).toString(),
			wasNbt);
		level.setBlock(cratePos, CrateBlocks.CRATE.defaultBlockState(), Sites.FLAGS);
		if (level.getBlockEntity(cratePos) instanceof CrateBlockEntity be) {
			be.setSiteId(id);
		}
		// clear the queued cells: top down, no drops, no neighbour updates (nothing pops off)
		Integer[] topDown = idx.toArray(new Integer[0]);
		Arrays.sort(topDown, Comparator.comparingInt((Integer k) -> -k));
		BlockPos.MutableBlockPos mp = new BlockPos.MutableBlockPos();
		BlockState air = Blocks.AIR.defaultBlockState();
		for (int k : topDown) {
			int[] o = Construction.offsets(k, dx, dz);
			level.setBlock(mp.set(sb.minX() + o[0], sb.minY() + o[1], sb.minZ() + o[2]), air, Sites.FLAGS);
		}
		Architect.LOGGER.info("Construction site {} ({}): {} cells queued, crate at {}{}", id, bp.id(), n, cratePos.toShortString(),
			r.waterlogged > 0 ? ", " + r.waterlogged + " waterlogged cell(s) built dry" : "");
		return new Construction(Construction.BUILDING, queue, targetFile, crate, new BitSet(), false, owner);
	}

	private static void add(List<BlockPos> cells, Set<Long> seen, BlockPos p) {
		if (seen.add(p.asLong())) {
			cells.add(p);
		}
	}

	/** Undoes {@link #convert}'s crate (a placement rolled back after the conversion). */
	static void removeCrate(ServerLevel level, Construction c) {
		if (c.crate() != null) {
			restoreCrateCell(level, c.crate());
		}
		Sites.deleteSnapshotFile(c.target());
	}

	/** The crate's cell: one past the approach's last row (at its feet height), or 2 out from the entrance; never in the box. */
	static BlockPos cratePos(ServerLevel level, Blueprint bp, Sites.Built built, Anchors.Bounds sb) {
		String front = dev.larattalabs.architect.placement.BlueprintTransform.rotateDirection(bp.front(), built.turns());
		int[] out = Approach.outward(front);
		double[] end = built.approach().end();
		BlockPos start;
		int step;
		if (end != null) {
			start = BlockPos.containing(end[0], end[1], end[2]);
			step = 1;
		} else {
			Anchor e = built.anchors().get(Blueprint.ENTRANCE);
			start = e != null ? BlockPos.containing(e.x(), e.y(), e.z()) : new BlockPos((sb.minX() + sb.maxX()) / 2, built.box().minY() + bp.groundY(),
				(sb.minZ() + sb.maxZ()) / 2);
			step = 2;
		}
		// beside the path's end rather than on it: one cell to the right of the walking line, so it never blocks the way in
		int[] right = {-out[1], out[0]};
		BlockPos p = start.offset(out[0] * step + right[0], 0, out[1] * step + right[1]);
		for (int i = 0; i < 24 && (sb.contains(p.getX(), p.getY(), p.getZ()) || inOtherSite(level, p)); i++) {
			p = p.offset(out[0], 0, out[1]);
		}
		return p;
	}

	private static boolean inOtherSite(ServerLevel level, BlockPos p) {
		String dim = Sites.dimensionId(level);
		for (Site o : Sites.all()) {
			if (o.dimension().equals(dim) && o.restoreBox().contains(p.getX(), p.getY(), p.getZ())) {
				return true;
			}
		}
		return false;
	}

	static void restoreCrateCell(ServerLevel level, Construction.Crate c) {
		BlockPos p = new BlockPos(c.x(), c.y(), c.z());
		BlockState st;
		try {
			st = NbtUtils.readBlockState(BuiltInRegistries.BLOCK, TagParser.parseCompoundFully(c.snapshotState()));
		} catch (Exception e) {
			st = Blocks.AIR.defaultBlockState();
		}
		level.setBlock(p, st, Sites.FLAGS);
		if (c.snapshotNbt() != null) {
			try {
				CompoundTag tag = TagParser.parseCompoundFully(c.snapshotNbt());
				BlockEntity be = level.getBlockEntity(p);
				if (be != null) {
					be.loadWithComponents(TagValueInput.create(ProblemReporter.DISCARDING, level.registryAccess(), tag));
					be.setChanged();
				}
			} catch (Exception e) {
				Architect.LOGGER.warn("Could not restore the block entity under the crate at {}", p.toShortString(), e);
			}
		}
	}

	// ------------------------------------------------------------------ the builder

	static void tick(MinecraftServer srv) {
		server = srv;
		ticks++;
		for (Site s : Sites.all()) {
			if (s.construction() == null || !s.building()) {
				continue;
			}
			ServerLevel level = Sites.levelOf(srv, s);
			Run r = level == null ? null : run(srv, s);
			if (r == null) {
				continue;
			}
			try {
				step(srv, level, s, r);
			} catch (RuntimeException e) {
				Architect.LOGGER.error("Construction site {}: builder step failed", s.id(), e);
			}
			Site now = Sites.get(s.id());
			if (now != null && now.building()) {
				long[] last = PROGRESS.computeIfAbsent(s.id(), k -> new long[] {Long.MIN_VALUE / 2, r.built.cardinality()});
				int built = r.built.cardinality();
				if (progressDue(last[0], (int) last[1], ticks, built)) {
					last[0] = ticks;
					last[1] = built;
					dev.larattalabs.architect.apiimpl.ApiEvents.progress(srv, now);
				}
			}
		}
		syncGhosts(srv);
	}

	/** Whether a SITE_PROGRESS is due: the built count changed and a second passed since the last one. Pure. */
	static boolean progressDue(long lastTick, int lastBuilt, long now, int built) {
		return built != lastBuilt && now - lastTick >= PROGRESS_TICKS;
	}

	/** {built, queued} of a construction site's queue ({queued, queued} once built); {0, 0} for an instant site. Server thread. */
	public static int[] progress(MinecraftServer srv, Site s) {
		Construction c = s.construction();
		if (c == null) {
			return new int[] {0, 0};
		}
		if (!c.building()) {
			return new int[] {c.size(), c.size()};
		}
		Run r = run(srv, s);
		return r == null ? new int[] {0, c.size()} : new int[] {r.built.cardinality(), r.size()};
	}

	private static void step(MinecraftServer srv, ServerLevel level, Site s, Run r) {
		if (ticks % 20 == 0) {
			r.rescan(level);
		}
		Construction c = s.construction();
		CrateBlockEntity crate = crate(level, s, false);
		BlockPos cp = c.crate() == null ? null : new BlockPos(c.crate().x(), c.crate().y(), c.crate().z());
		r.crateMissing = cp == null || level.isLoaded(cp) && crate == null;
		if (r.built.cardinality() == r.size()) {
			complete(srv, level, s, r, crate);
			return;
		}
		if (crate == null || c.paused()) {
			return;
		}
		Ledger ledger = crate.ledger();
		int budget = SurvivalWorld.blocksPerTick();
		BitSet free = c.free();
		boolean freeChanged = false;
		int placed = 0;
		int scanned = 0;
		for (int i = r.built.nextClearBit(0); i < r.size() && budget > 0 && scanned < SCAN; i = r.built.nextClearBit(i + 1)) {
			scanned++;
			if (r.isSecond[i]) {
				continue; // placed with its first
			}
			BlockPos p = r.pos(i);
			if (!level.isLoaded(p)) {
				continue; // only cells in loaded chunks progress; never load one
			}
			BlockState now = level.getBlockState(p);
			if (r.matches(now, i)) {
				r.markBuilt(i, true); // already there (the player placed it)
				continue;
			}
			if (!r.affordable(i, ledger)) {
				continue;
			}
			if (r.support[i] >= 0 && !r.built.get(r.support[i])) {
				continue;
			}
			int j = r.second[i];
			BlockPos q = j >= 0 ? r.pos(j) : null;
			if (!free(level, p, now, r.target[i]) || q != null && (!level.isLoaded(q) || !free(level, q, level.getBlockState(q), r.target[j]))) {
				r.blockedSince.putIfAbsent(i, ticks);
				continue;
			}
			r.blockedSince.remove(i);
			pay(ledger, r.cost.get(i));
			put(level, r, i, p, true);
			if (j >= 0) {
				pay(ledger, r.cost.get(j));
				put(level, r, j, q, false);
			}
			// a cell finish placed free, mined since and now paid for: it is refundable again
			if (free.get(i) || j >= 0 && free.get(j)) {
				free.clear(i);
				if (j >= 0) {
					free.clear(j);
				}
				freeChanged = true;
			}
			budget--;
			placed++;
		}
		if (placed > 0) {
			crate.ledgerChanged();
		}
		if (freeChanged) {
			Sites.replace(srv, s.withConstruction(c.withFree(free)));
			s = Sites.get(s.id());
		}
		if (s != null && r.built.cardinality() == r.size()) {
			complete(srv, level, s, r, crate);
		}
	}

	private static void pay(Ledger ledger, List<SurvivalItems.Cost> costs) {
		for (SurvivalItems.Cost c : costs) {
			ledger.consume(c.item(), c.count());
		}
	}

	/** Whether the builder may write a cell holding {@code now}: air, fluid or a replaceable plant, and no one stands in it. */
	static boolean free(ServerLevel level, BlockPos p, BlockState now, BlockState target) {
		if (!(now.isAir() || now.canBeReplaced())) {
			return false;
		}
		if (target.getCollisionShape(level, p).isEmpty()) {
			return true;
		}
		return level.getEntities((Entity) null, new AABB(p), e -> e instanceof LivingEntity && e.isAlive() && !e.isSpectator()).isEmpty();
	}

	/** Writes queue cell {@code i} exactly as the instant placement did (state, block-entity NBT without inventories). */
	static void put(ServerLevel level, Run r, int i, BlockPos p, boolean sound) {
		BlockState t = r.target[i];
		level.setBlock(p, t, Sites.FLAGS);
		CompoundTag tag = r.nbt[i];
		if (tag != null) {
			BlockEntity be = level.getBlockEntity(p);
			if (be != null) {
				CompoundTag copy = tag.copy();
				if (be instanceof Container) {
					for (String k : new String[] {"Items", "item", "RecordItem", "LootTable", "LootTableSeed"}) {
						copy.remove(k);
					}
				}
				be.loadWithComponents(TagValueInput.create(ProblemReporter.DISCARDING, level.registryAccess(), copy));
				be.setChanged();
			}
		}
		if (sound) {
			var st = t.getSoundType();
			level.playSound(null, p, st.getPlaceSound(), SoundSource.BLOCKS, (st.getVolume() + 1.0f) / 2.0f * 0.35f, st.getPitch() * 0.8f);
		}
		r.markBuilt(i, true);
	}

	/** Every queued cell built: the site is built, the crate gives back its stock and goes, a toast and a chat note fire. */
	private static void complete(MinecraftServer srv, ServerLevel level, Site s, Run r, @Nullable CrateBlockEntity crate) {
		Construction c = s.construction();
		Map<String, Integer> left = crate != null ? crate.ledger().takeStock() : Map.of();
		BlockPos at = c.crate() != null ? new BlockPos(c.crate().x(), c.crate().y(), c.crate().z()) : dropPos(s);
		if (c.crate() != null && (crate != null || level.isLoaded(at))) {
			restoreCrateCell(level, c.crate());
		}
		dropItems(level, at, left, null);
		// the crate record stays (its block is gone): a later deconstruct drops its refunds on that cell, outside the box
		Site done = s.withConstruction(c.withState(Construction.BUILT, c.crate()).withPaused(false));
		Sites.replace(srv, done);
		sendClear(srv, r, true);
		r.blockedSince.clear();
		String msg = r.name + " (" + s.id() + ") is built" + (left.isEmpty() ? "" : "; the crate's leftovers ("
			+ Refunds.Tally.total(left) + " items) lie where it stood");
		for (ServerPlayer p : level.players()) {
			if (near(p, s.restoreBox(), RANGE) || c.owner() != null && c.owner().equals(p.getUUID().toString())) {
				p.sendSystemMessage(Component.literal("[Architect] " + msg));
			}
		}
		Architect.LOGGER.info("Construction site {}: built ({} cells); crate leftovers {}", s.id(), r.size(), left);
		PROGRESS.remove(s.id());
		Site now = Sites.get(s.id());
		dev.larattalabs.architect.apiimpl.ApiEvents.built(srv, now != null ? now : done);
	}

	// ------------------------------------------------------------------ ghost sync

	private static boolean near(ServerPlayer p, Anchors.Bounds b, int range) {
		double x = Math.max(b.minX(), Math.min(b.maxX() + 1, p.getX()));
		double z = Math.max(b.minZ(), Math.min(b.maxZ() + 1, p.getZ()));
		double ddx = x - p.getX();
		double ddz = z - p.getZ();
		return ddx * ddx + ddz * ddz <= (double) range * range;
	}

	private static void syncGhosts(MinecraftServer srv) {
		for (Site s : Sites.all()) {
			if (!s.building()) {
				continue;
			}
			Run r = RUNS.get(s.id());
			ServerLevel level = Sites.levelOf(srv, s);
			if (r == null || level == null) {
				continue;
			}
			int[] newly = r.takeNewly();
			boolean full = r.resend;
			r.resend = false;
			for (ServerPlayer p : srv.getPlayerList().getPlayers()) {
				boolean in = p.level() == level && near(p, s.restoreBox(), RANGE);
				boolean had = r.sentTo.contains(p.getUUID());
				if (!in) {
					if (had) {
						r.sentTo.remove(p.getUUID());
						send(p, new SiteNet.SiteClear(s.id(), false, r.name));
					}
					continue;
				}
				if (!had || full) {
					send(p, ghost(s, r));
					r.sentTo.add(p.getUUID());
				} else if (newly.length > 0) {
					send(p, new SiteNet.SiteProgress(s.id(), CellBits.encodeInts(newly)));
				}
				if (!had || ticks % 20 == 0) {
					send(p, status(srv, level, s, r));
				}
			}
			r.sentTo.removeIf(u -> srv.getPlayerList().getPlayer(u) == null);
		}
	}

	private static void send(ServerPlayer p, net.minecraft.network.protocol.common.custom.CustomPacketPayload payload) {
		if (ServerPlayNetworking.canSend(p, payload.type())) {
			ServerPlayNetworking.send(p, payload);
		}
	}

	static SiteNet.SiteGhost ghost(Site s, Run r) {
		int[] states = new int[r.size()];
		for (int i = 0; i < states.length; i++) {
			states[i] = net.minecraft.world.level.block.Block.getId(r.target[i]);
		}
		Anchors.Bounds b = r.box;
		return new SiteNet.SiteGhost(s.id(), s.blueprint(), s.rotation(), r.name, b.minX(), b.minY(), b.minZ(), r.dx, b.maxY() - b.minY() + 1, r.dz,
			CellBits.encodeInts(r.queue), states, CellBits.words(r.built));
	}

	static SiteNet.SiteStatus status(MinecraftServer srv, ServerLevel level, Site s, Run r) {
		CrateBlockEntity crate = crate(level, s, false);
		List<String> avail = new ArrayList<>();
		String needs = "";
		if (crate != null) {
			avail.addAll(crate.ledger().stock().keySet());
			int most = 0;
			for (var e : r.unbuilt.entrySet()) {
				int miss = crate.ledger().missing(e.getKey(), r::unbuiltCost);
				if (miss > most) {
					most = miss;
					needs = miss + " × " + itemName(e.getKey()); // "112 × spruce log": item names have no plural form
				}
			}
		}
		Construction.Crate cc = s.construction().crate();
		return new SiteNet.SiteStatus(s.id(), r.name, r.built.cardinality(), r.size(), needs, s.construction().paused(), r.blockedReported(), avail,
			s.construction().owner() == null ? "" : s.construction().owner(), r.crateMissing, cc == null ? 0 : cc.x(), cc == null ? 0 : cc.y(),
			cc == null ? 0 : cc.z());
	}

	static void sendClear(MinecraftServer srv, Run r, boolean finished) {
		for (UUID u : r.sentTo) {
			ServerPlayer p = srv.getPlayerList().getPlayer(u);
			if (p != null) {
				send(p, new SiteNet.SiteClear(r.id, finished, r.name));
			}
		}
		r.sentTo.clear();
	}

	/** The site left (removed, forgotten): its ghost goes from every client. */
	static void forget(MinecraftServer srv, String id) {
		Run r = RUNS.remove(id);
		if (r != null) {
			sendClear(srv, r, false);
		}
	}

	/** An item's display name, lower case ("spruce planks"); the id when unknown. */
	public static String itemNameClient(String id) {
		return itemName(id);
	}

	static String itemName(String id) {
		Item it = Cells.item(id);
		return it == null ? id : new ItemStack(it).getHoverName().getString().toLowerCase(java.util.Locale.ROOT);
	}

	// ------------------------------------------------------------------ crate actions

	/** Right-click on a crate: the crate screen, or (a crate no site owns) the crate goes, giving back what it held. */
	public static void openCrate(ServerLevel level, ServerPlayer player, CrateBlockEntity crate) {
		Site s = Sites.get(crate.siteId());
		Construction c = s == null ? null : s.construction();
		if (s == null || c == null || !s.building() || c.crate() == null || !crate.getBlockPos().equals(new BlockPos(c.crate().x(), c.crate().y(),
			c.crate().z()))) {
			BlockPos p = crate.getBlockPos();
			Map<String, Integer> left = crate.ledger().takeStock();
			level.setBlock(p, Blocks.AIR.defaultBlockState(), net.minecraft.world.level.block.Block.UPDATE_ALL);
			dropItems(level, p, left, null);
			player.sendSystemMessage(Component.literal("[Architect] This crate belongs to no construction site; it was taken away"
				+ (left.isEmpty() ? "" : " and gave back what it held")));
			return;
		}
		send(player, new SiteNet.CrateOpen(s.id()));
	}

	/** Moves every item the site needs from the player's inventory into its crate. Returns the items moved. */
	public static int insertFromInventory(ServerPlayer player, String id) throws Sites.SiteException {
		Site s = requireBuilding(id);
		ServerLevel level = Sites.levelOf(player.level().getServer(), s);
		CrateBlockEntity crate = level == null ? null : crate(level, s, false);
		if (crate == null) {
			throw new Sites.SiteException("The crate of " + id + " is missing (or not loaded)");
		}
		if (player.level() != level || player.blockPosition().distSqr(crate.getBlockPos()) > 16 * 16) {
			throw new Sites.SiteException("Stand next to the crate of " + id + " to fill it");
		}
		int moved = 0;
		var inv = player.getInventory();
		for (int slot = 0; slot < inv.getContainerSize(); slot++) {
			ItemStack st = inv.getItem(slot);
			if (!st.isEmpty()) {
				moved += crate.insert(st);
			}
		}
		if (moved > 0) {
			inv.setChanged();
		}
		return moved;
	}

	/** Dev / test hook: books items into the crate as a hopper would (counting equivalents). Returns what went in per item. */
	public static Map<String, Integer> insertItems(MinecraftServer srv, String id, Map<String, Integer> items) throws Sites.SiteException {
		Site s = requireBuilding(id);
		ServerLevel level = Sites.levelOf(srv, s);
		CrateBlockEntity crate = level == null ? null : crate(level, s, true);
		if (crate == null) {
			throw new Sites.SiteException("The crate of " + id + " is missing");
		}
		Map<String, Integer> in = new LinkedHashMap<>();
		for (var e : items.entrySet()) {
			Item it = Cells.item(e.getKey());
			if (it == null) {
				throw new Sites.SiteException("Unknown item " + e.getKey());
			}
			ItemStack st = new ItemStack(it, e.getValue());
			in.put(e.getKey(), crate.insert(st));
		}
		return in;
	}

	public static void setPaused(MinecraftServer srv, String id, boolean paused) throws Sites.SiteException {
		Site s = requireBuilding(id);
		Sites.replace(srv, s.withConstruction(s.construction().withPaused(paused)));
	}

	private static Site requireBuilding(String id) throws Sites.SiteException {
		Site s = Sites.get(id);
		if (s == null) {
			throw new Sites.SiteException("No site " + id);
		}
		if (!s.building()) {
			throw new Sites.SiteException(id + " is not a construction site that is building");
		}
		return s;
	}

	/**
	 * {@code /architect site finish}: builds every remaining cell at once without payment (its cells are tracked as free, so a
	 * later deconstruct refunds nothing for them). Cells something blocks are left; chunks must be loaded. Returns the cells placed.
	 */
	public static int finish(MinecraftServer srv, String id) throws Sites.SiteException {
		Site s = requireBuilding(id);
		ServerLevel level = Sites.levelOf(srv, s);
		Run r = level == null ? null : run(srv, s);
		if (r == null) {
			throw new Sites.SiteException(id + "'s plan can't be read; it can only be removed");
		}
		r.rescan(level);
		BitSet free = s.construction().free();
		int placed = 0;
		int blocked = 0;
		for (int i = r.built.nextClearBit(0); i < r.size(); i = r.built.nextClearBit(i + 1)) {
			BlockPos p = r.pos(i);
			if (!level.isLoaded(p)) {
				throw new Sites.SiteException("Part of " + id + " is not loaded; walk closer and finish again");
			}
		}
		for (int pass = 0; pass < 2; pass++) { // attachables whose support was blocked in pass 0
			for (int i = r.built.nextClearBit(0); i < r.size(); i = r.built.nextClearBit(i + 1)) {
				BlockPos p = r.pos(i);
				BlockState now = level.getBlockState(p);
				if (r.matches(now, i)) {
					r.markBuilt(i, true);
					continue;
				}
				if (!free(level, p, now, r.target[i])) {
					if (pass == 1) {
						blocked++;
					}
					continue;
				}
				put(level, r, i, p, false);
				free.set(i);
				placed++;
			}
		}
		Site cur = Sites.get(id);
		if (cur != null) {
			Sites.replace(srv, cur.withConstruction(cur.construction().withFree(free)));
			cur = Sites.get(id);
		}
		if (cur != null && r.built.cardinality() == r.size()) {
			complete(srv, level, cur, r, crate(level, cur, true));
		}
		if (blocked > 0) {
			throw new Sites.SiteException("Finished " + placed + " cells of " + id + "; " + blocked + " are blocked (something stands there)");
		}
		return placed;
	}

	// ------------------------------------------------------------------ deconstruct

	/** What a deconstruct gives back: refunds, the player's blocks and the crate's stock, and where they drop. */
	record Deconstruction(Refunds.Tally tally, Map<String, Integer> crateStock, BlockPos at, int queued, int missing) {
		Map<String, Integer> all() {
			Map<String, Integer> m = new TreeMap<>(tally.refund());
			tally.playerBlocks().forEach((k, v) -> m.merge(k, v, Integer::sum));
			crateStock.forEach((k, v) -> m.merge(k, v, Integer::sum));
			return m;
		}

		JsonObject toJson() {
			JsonObject o = new JsonObject();
			o.add("refund", counts(tally.refund()));
			o.addProperty("refundTotal", Refunds.Tally.total(tally.refund()));
			o.add("playerBlocks", counts(tally.playerBlocks()));
			o.add("crateStock", counts(crateStock));
			o.addProperty("queued", queued);
			o.addProperty("missingOrMined", missing);
			o.addProperty("dropAt", at.toShortString());
			return o;
		}
	}

	private static @Nullable Deconstruction lastDeconstruction;

	static @Nullable Deconstruction lastDeconstruction() {
		return lastDeconstruction;
	}

	/** The last deconstruct's tally (refund, the player's blocks, crate stock, cells missing or mined), or null. */
	public static @Nullable JsonObject lastDeconstructionJson() {
		Deconstruction d = lastDeconstruction;
		return d == null ? null : d.toJson();
	}

	/**
	 * Before the snapshot of a construction site is restored: tallies every cell of the box (refund / the player's / nothing),
	 * takes the crate's stock and puts the crate's cell back. {@code snapshot}: the site's snapshot tag. The caller restores
	 * the box, then calls {@link #dropDeconstruction}.
	 */
	static Deconstruction prepareDeconstruct(ServerLevel level, Site s, CompoundTag snapshot) {
		MinecraftServer srv = level.getServer();
		Run r = run(srv, s);
		Cells before = Cells.read(snapshot);
		Anchors.Bounds b = s.restoreBox();
		BitSet free = s.construction().free();
		Refunds.Tally tally = new Refunds.Tally();
		int missing = 0;
		BlockPos.MutableBlockPos m = new BlockPos.MutableBlockPos();
		int dx = b.maxX() - b.minX() + 1;
		int dz = b.maxZ() - b.minZ() + 1;
		for (int y = b.minY(); y <= b.maxY(); y++) {
			for (int z = b.minZ(); z <= b.maxZ(); z++) {
				for (int x = b.minX(); x <= b.maxX(); x++) {
					m.set(x, y, z);
					BlockState now = level.getBlockState(m);
					int k = Construction.index(x - b.minX(), y - b.minY(), z - b.minZ(), dx, dz);
					BlockState was = k < before.size() ? before.states[k] : Blocks.AIR.defaultBlockState();
					int qi = r == null ? -1 : r.queuePos(m);
					boolean asPlaced = qi >= 0 && r.matches(now, qi);
					Refunds.Outcome o = Refunds.classify(qi >= 0, asPlaced, qi >= 0 && free.get(qi), now.isAir(), was.is(now.getBlock()),
						Refunds.natural(Cells.blockId(was), Cells.blockId(now)));
					if (o == Refunds.Outcome.REFUND) {
						tally.add(o, r.cost.get(qi));
					} else if (o == Refunds.Outcome.PLAYER_DROP) {
						tally.add(o, Cells.cost(now));
					} else if (qi >= 0 && !asPlaced && now.isAir()) {
						missing++;
						tally.mined();
					}
				}
			}
		}
		Construction c = s.construction();
		Map<String, Integer> stock = Map.of();
		BlockPos at = dropPos(s);
		if (c.crate() != null) {
			at = new BlockPos(c.crate().x(), c.crate().y(), c.crate().z());
			CrateBlockEntity crate = crate(level, s, true);
			if (crate != null) {
				stock = crate.ledger().takeStock();
				restoreCrateCell(level, c.crate());
			}
		}
		Deconstruction d = new Deconstruction(tally, stock, at, r == null ? 0 : r.size(), missing);
		lastDeconstruction = d;
		return d;
	}

	/** After the restore: the deconstruct's items drop at the crate's cell (kept from the restore's drop cleanup). */
	static void dropDeconstruction(ServerLevel level, Site s, Deconstruction d, Sites.Drops drops) {
		dropItems(level, d.at(), d.all(), drops);
		forget(level.getServer(), s.id());
		Construction c = s.construction();
		if (c != null) {
			Architect.LOGGER.info("Deconstructed {}: refund {} ({} items), the player's blocks {}, crate stock {}, {} queued cells missing or mined",
				s.id(), d.tally().refund(), Refunds.Tally.total(d.tally().refund()), d.tally().playerBlocks(), d.crateStock(), d.missing());
		}
	}

	/** Where items go when the crate is gone: the site's spawn anchor, else above the box's middle. */
	static BlockPos dropPos(Site s) {
		Anchor a = s.anchors().get("spawn");
		if (a != null) {
			return BlockPos.containing(a.x(), a.y(), a.z());
		}
		Anchors.Bounds b = s.restoreBox();
		return new BlockPos((b.minX() + b.maxX()) / 2, b.maxY() + 1, (b.minZ() + b.maxZ()) / 2);
	}

	static void dropItems(ServerLevel level, BlockPos at, Map<String, Integer> items, Sites.@Nullable Drops drops) {
		for (var e : items.entrySet()) {
			Item it = Cells.item(e.getKey());
			if (it == null || e.getValue() <= 0) {
				continue;
			}
			int left = e.getValue();
			int max = new ItemStack(it).getMaxStackSize();
			while (left > 0) {
				int n = Math.min(max, left);
				left -= n;
				ItemEntity ie = new ItemEntity(level, at.getX() + 0.5, at.getY() + 0.25, at.getZ() + 0.5, new ItemStack(it, n), 0, 0, 0);
				ie.setDefaultPickUpDelay();
				level.addFreshEntity(ie);
				if (drops != null) {
					drops.keep(ie);
				}
			}
		}
	}

	// ------------------------------------------------------------------ state (crate screen, DevBridge)

	/** A site's construction state: queue, built, BOM rows (needed / delivered / placed / missing), ledger, blocked cells. */
	public static JsonObject state(MinecraftServer srv, String id) throws Sites.SiteException {
		Site s = Sites.get(id);
		if (s == null) {
			throw new Sites.SiteException("No site " + id);
		}
		Construction c = s.construction();
		JsonObject o = new JsonObject();
		o.addProperty("site", id); // not "id": DevBridge replies carry the request id there
		o.addProperty("blueprint", s.blueprint());
		if (c == null) {
			o.addProperty("state", "instant");
			return o;
		}
		Run r = run(srv, s);
		ServerLevel level = Sites.levelOf(srv, s);
		o.addProperty("state", c.state());
		o.addProperty("paused", c.paused());
		o.addProperty("queue", c.size());
		o.addProperty("free", c.free().cardinality());
		if (r == null) {
			o.addProperty("error", "the site's plan (" + c.target() + ") can't be read; it can only be removed");
			return o;
		}
		o.addProperty("name", r.name);
		if (level != null && !s.building()) {
			r.rescan(level);
			r.newlyCount = 0;
		}
		int built = r.built.cardinality();
		o.addProperty("built", built);
		o.addProperty("percent", r.size() == 0 ? 100 : built * 100 / r.size());
		o.addProperty("waterlogged", r.waterlogged);
		o.add("bom", counts(r.bom));
		o.addProperty("bomTotal", Refunds.Tally.total(r.bom));
		CrateBlockEntity crate = level == null ? null : crate(level, s, false);
		JsonObject cr = new JsonObject();
		if (c.crate() != null) {
			cr.addProperty("x", c.crate().x());
			cr.addProperty("y", c.crate().y());
			cr.addProperty("z", c.crate().z());
		}
		cr.addProperty("present", crate != null);
		cr.addProperty("missing", s.building() && r.crateMissing);
		o.add("crate", cr);
		JsonArray rows = new JsonArray();
		Ledger l = crate != null ? crate.ledger() : new Ledger();
		Set<String> items = new java.util.TreeSet<>(r.bom.keySet());
		items.addAll(l.delivered().keySet());
		for (String it : items) {
			JsonObject row = new JsonObject();
			row.addProperty("item", it);
			row.addProperty("name", itemName(it));
			row.addProperty("needed", r.bom.getOrDefault(it, 0));
			row.addProperty("delivered", l.delivered(it));
			row.addProperty("placed", l.placed(it));
			row.addProperty("stock", l.stock(it));
			row.addProperty("missing", s.building() ? l.missing(it, r::unbuiltCost) : 0);
			rows.add(row);
		}
		o.add("rows", rows);
		JsonObject ledger = new JsonObject();
		ledger.add("delivered", counts(l.delivered()));
		ledger.add("placed", counts(l.placed()));
		ledger.add("stock", counts(l.stock()));
		ledger.add("credit", counts(l.credit(r::unbuiltCost)));
		o.add("ledger", ledger);
		JsonArray blocked = new JsonArray();
		r.blockedSince.entrySet().stream().filter(e -> ticks - e.getValue() >= BLOCKED_TICKS).limit(32).forEach(e -> {
			BlockPos p = r.pos(e.getKey());
			JsonObject b = new JsonObject();
			b.addProperty("at", p.getX() + "," + p.getY() + "," + p.getZ());
			b.addProperty("ticks", ticks - e.getValue());
			blocked.add(b);
		});
		o.add("blocked", blocked);
		JsonArray notes = new JsonArray();
		if (r.waterlogged > 0) {
			notes.add(r.waterlogged + " waterlogged cell(s) are built dry in survival (no water bucket cost)");
		}
		if (s.building() && r.crateMissing) {
			notes.add("crate missing: the site can't take items; Deconstruct from the Library still works (refunds placed cells only)");
		}
		o.add("notes", notes);
		Deconstruction d = lastDeconstruction;
		if (d != null) {
			o.add("lastDeconstruct", d.toJson());
		}
		return o;
	}

	static JsonObject counts(Map<String, Integer> m) {
		JsonObject o = new JsonObject();
		new TreeMap<>(m).forEach(o::addProperty);
		return o;
	}

	/** The cost of a block state in survival, for the client's Library BOM. */
	public static List<SurvivalItems.Cost> costOf(BlockState s) {
		return Cells.cost(s);
	}

	/** The template-only BOM of a design (the Library's "Needs"; the spot adds its foundation and approach). */
	public static Map<String, Integer> templateBom(TemplateGrid grid) {
		Map<String, Integer> out = new TreeMap<>();
		for (BlockState s : grid.states()) {
			for (SurvivalItems.Cost c : Cells.cost(s)) {
				out.merge(c.item(), c.count(), Integer::sum);
			}
		}
		return out;
	}

	/** The design's blocks survival can't build (placement refuses it in survival). */
	public static List<String> creativeOnly(TemplateGrid grid, Blueprint bp) {
		Set<String> out = new java.util.TreeSet<>();
		SurvivalItems rules = SurvivalItems.bundled();
		for (BlockState s : grid.states()) {
			String id = Cells.blockId(s);
			if (rules.creativeOnly(id)) {
				out.add(id);
			}
		}
		for (String id : new String[] {bp.foundationBlock(), bp.approach().block(), bp.approach().slab()}) {
			if (id != null && rules.creativeOnly(id)) {
				out.add(id);
			}
		}
		return List.copyOf(out);
	}

	/** Test hook: the block-entity NBT a cell holds now (the gate's cell-for-cell comparison). */
	static String beNbt(ServerLevel level, BlockPos p) {
		BlockEntity be = level.getBlockEntity(p);
		if (be == null) {
			return "";
		}
		TagValueOutput out = TagValueOutput.createWithContext(ProblemReporter.DISCARDING, level.registryAccess());
		be.saveWithFullMetadata(out);
		return out.buildResult().toString();
	}
}
