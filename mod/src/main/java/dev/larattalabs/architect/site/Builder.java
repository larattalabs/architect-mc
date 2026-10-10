package dev.larattalabs.architect.site;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import dev.larattalabs.architect.Architect;
import dev.larattalabs.architect.journal.WorldJournal;
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
	/** Set around a batch's construction placement whose group shares one crate (phase 4d, R6): the group id. Server thread. */
	static final ThreadLocal<String> SHARED_CRATE = new ThreadLocal<>();

	private Builder() {
	}

	public static void init() {
		ServerTickEvents.END_SERVER_TICK.register(Builder::tick);
		RoadBuilder.init(); // 6c 0c (C16): construction roads
		ServerLifecycleEvents.SERVER_STARTED.register(s -> server = s);
		ServerLifecycleEvents.SERVER_STOPPED.register(s -> {
			RUNS.clear();
			PROGRESS.clear();
			REFUNDED.clear();
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
		/** Phase 5b: a construction delta's swap cells (changed cells that keep the old block until swapped) and their old states. */
		final BitSet swap;
		final BlockState @Nullable [] old;

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
			this.swap = c.swap();
			Cells before = c.delta() == null || swap.isEmpty() ? null : SiteJournal.beforeOf(c.delta(), box);
			if (before != null) {
				this.old = new BlockState[n];
				for (int i = swap.nextSetBit(0); i >= 0 && i < n; i = swap.nextSetBit(i + 1)) {
					int k = queue[i];
					old[i] = k >= 0 && k < before.size() ? before.states[k] : null;
				}
			} else {
				this.old = null;
			}
		}

		/** Whether the world at a swap cell still holds the old version's block (the swap has not happened). */
		boolean holdsOld(BlockState now, int i) {
			return old != null && swap.get(i) && old[i] != null && now.is(old[i].getBlock()) && !matches(now, i);
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
			if (swap.get(i) && old != null && old[i] != null && old[i].is(target[i].getBlock())) {
				// a swap that keeps the block (a re-oriented stair, another slab type): built when the state is the target's
				return dev.larattalabs.architect.journal.StillOurs.holds(now, null, target[i], null);
			}
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
		// phase 4e: the target is the site entry's after (the instant placement's box once it settled)
		Cells target = SiteJournal.target(s.id(), s.restoreBox());
		if (target == null) {
			Architect.LOGGER.warn("Construction site {}: its target (the journal entry's after) can't be read; it can only be removed", s.id());
			return null;
		}
		r = new Run(s, target);
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

	/** Whether any construction site is building (the placement stats count those ticks). */
	static boolean anyBuilding() {
		for (Site s : Sites.all()) {
			if (s.building()) {
				return true;
			}
		}
		return false;
	}

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
		return level.getBlockEntity(p) instanceof CrateBlockEntity be && crateOwner(s).equals(be.siteId()) ? be : null;
	}

	// ------------------------------------------------------------------ the group crate (phase 4d, R6)

	/** The group whose shared crate this construction site uses, or null (its own crate). */
	static @Nullable SiteGroupRec sharedGroup(Site s) {
		Construction c = s.construction();
		SiteGroupRec g = s.group() == null ? null : Sites.group(s.group());
		if (c == null || c.crate() == null || g == null || !g.sharedCrate() || g.crate() == null) {
			return null;
		}
		Construction.Crate gc = g.crate();
		return gc.x() == c.crate().x() && gc.y() == c.crate().y() && gc.z() == c.crate().z() ? g : null;
	}

	/** The owner id the site's crate block entity carries: the site's id, or {@code group:<id>} for a shared crate. */
	static String crateOwner(Site s) {
		SiteGroupRec g = sharedGroup(s);
		return g == null ? s.id() : g.crateOwner();
	}

	/** The other construction sites still building on {@code s}'s shared crate, in placement order. */
	static List<Site> otherBuildingShared(Site s) {
		SiteGroupRec g = sharedGroup(s);
		List<Site> out = new ArrayList<>();
		if (g == null) {
			return out;
		}
		for (Site o : Sites.all()) {
			if (!o.id().equals(s.id()) && o.building() && g.id().equals(o.group()) && sharedGroup(o) != null) {
				out.add(o);
			}
		}
		return out;
	}

	/** 6c 0c (C16): whether a construction site of {@code groupId} still builds from the group's shared crate. */
	static boolean anyBuildingShared(String groupId) {
		for (Site o : Sites.all()) {
			if (o.building() && groupId.equals(o.group()) && sharedGroup(o) != null) {
				return true;
			}
		}
		return false;
	}

	static long ticksNow() {
		return ticks;
	}

	/** The building sites a crate feeds: the site, or every building site of the group sharing it (placement order). */
	private static List<Site> fedBy(String crateOwner) {
		if (!crateOwner.startsWith(SiteGroupRec.CRATE_PREFIX)) {
			Site s = Sites.get(crateOwner);
			return s == null ? List.of() : List.of(s);
		}
		String gid = crateOwner.substring(SiteGroupRec.CRATE_PREFIX.length());
		List<Site> out = new ArrayList<>();
		for (Site o : Sites.all()) {
			if (o.building() && gid.equals(o.group()) && sharedGroup(o) != null) {
				out.add(o);
			}
		}
		return out;
	}

	/** A shared crate about to go: its delivered counts stay on the group record ({@code Sites.stock} after the build). */
	private static void keepDelivered(MinecraftServer srv, Site s, @Nullable CrateBlockEntity crate, boolean keep) {
		SiteGroupRec g = sharedGroup(s);
		if (g != null && crate != null && !keep) {
			Sites.putGroup(srv, g.withDelivered(crate.ledger().delivered()));
		}
	}

	/** What a group's stockpile holds (R6, {@code Sites.stock}). */
	public record GroupStock(Map<String, Integer> delivered, Map<String, Integer> credit, Map<String, Map<String, Integer>> outstandingBySite,
		Map<String, Integer> outstanding, @Nullable BlockPos crate) {
	}

	/** A group's stock: delivered and credit from its crate(s), the outstanding bill per building site and in total. Server thread. */
	public static GroupStock groupStock(MinecraftServer srv, SiteGroupRec g) {
		Map<String, Map<String, Integer>> bySite = new LinkedHashMap<>();
		Map<String, Integer> total = new TreeMap<>();
		Map<String, Integer> delivered = new TreeMap<>();
		Map<String, Integer> credit = new TreeMap<>();
		Set<BlockPos> crates = new HashSet<>();
		for (Site s : Sites.all()) {
			if (!g.id().equals(s.group()) || s.construction() == null) {
				continue;
			}
			Run r = s.building() ? run(srv, s) : null;
			if (r != null) {
				Map<String, Integer> out = new TreeMap<>();
				r.unbuilt.forEach((k, v) -> {
					if (v > 0) {
						out.put(k, v);
					}
				});
				bySite.put(s.id(), out);
				out.forEach((k, v) -> total.merge(k, v, Integer::sum));
			}
			ServerLevel level = Sites.levelOf(srv, s);
			CrateBlockEntity crate = level == null ? null : crate(level, s, false);
			if (crate != null && crates.add(crate.getBlockPos())) {
				crate.ledger().delivered().forEach((k, v) -> delivered.merge(k, v, Integer::sum));
				String owner = crateOwner(s);
				crate.ledger().credit(item -> unbuiltFor(srv, owner, item)).forEach((k, v) -> credit.merge(k, v, Integer::sum));
			}
		}
		RoadBuilder.stock(srv, g, bySite, total); // 6c 0c (C16): the group's construction roads, by road id
		Construction.Crate gc = g.crate();
		if (crates.isEmpty() && gc != null && srv.overworld() != null) {
			// only roads build from it (no construction site of the group has a crate record): read the group's crate itself
			for (ServerLevel lv : srv.getAllLevels()) {
				if (lv.getBlockEntity(new BlockPos(gc.x(), gc.y(), gc.z())) instanceof CrateBlockEntity be && g.crateOwner().equals(be.siteId())
					&& crates.add(be.getBlockPos())) {
					be.ledger().delivered().forEach((k, v) -> delivered.merge(k, v, Integer::sum));
					be.ledger().credit(item -> unbuiltFor(srv, g.crateOwner(), item)).forEach((k, v) -> credit.merge(k, v, Integer::sum));
					break;
				}
			}
		}
		SiteGroupRec now = Sites.group(g.id());
		if (crates.isEmpty() && now != null) {
			delivered.putAll(now.delivered()); // the shared crate is gone (every site built): its ledger was kept on the group
		}
		return new GroupStock(delivered, credit, bySite, total, gc == null ? null : new BlockPos(gc.x(), gc.y(), gc.z()));
	}

	/** What the sites a crate feeds still need of {@code item}. */
	private static int unbuiltFor(MinecraftServer srv, String crateOwner, String item) {
		int n = RoadBuilder.unbuiltFor(srv, crateOwner, item); // 6c 0c (C16)
		for (Site s : fedBy(crateOwner)) {
			Run r = run(srv, s);
			if (r != null) {
				n += r.unbuiltCost(item);
			}
		}
		return n;
	}

	/**
	 * The crate's acceptance rule: what one unit of {@code item} would credit (itself or an equivalent the site still misses),
	 * booked when {@code commit}. Null when the site doesn't need it, isn't building, or is unknown.
	 */
	public static Ledger.@Nullable Accepted accepts(String siteId, CrateBlockEntity crate, String item, boolean commit) {
		MinecraftServer srv = server;
		if (srv == null || siteId == null || siteId.isEmpty()) {
			return null;
		}
		if (siteId.startsWith(SiteGroupRec.CRATE_PREFIX)) {
			// a group's shared crate: what any of its building sites still needs (R6)
			if (fedBy(siteId).isEmpty() && !RoadBuilder.feeds(siteId)) {
				return null;
			}
			return crate.ledger().accept(item, it -> unbuiltFor(srv, siteId, it), Equivalents.bundled(), commit);
		}
		Site s = Sites.get(siteId);
		if (s == null || !s.building()) {
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
	 * What turning an instant placement into a construction site takes (docs/CONTRACT.md phase 3, 4e): the queued cells in build
	 * order, the target (the box as the instant placement left it once its own block ticks ran: P6, the site entry's
	 * {@code after}), the crate's cell (and whether a new crate goes there).
	 */
	record ConvertPlan(String id, Construction construction, WorldJournal.Captured target, Anchors.Bounds sb, boolean newCrate,
		@Nullable String sharedGroup) {
	}

	/**
	 * P6 of a construction placement: settles the block ticks the instant placement scheduled on its own cells, captures the
	 * target over the snapshot box, orders the queue and picks the crate's cell. Writes nothing else.
	 */
	static ConvertPlan planConvert(ServerLevel level, Blueprint bp, Sites.Built built, String id, @Nullable String owner) throws Sites.SiteException {
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
		// the target: what the instant placement left over the whole snapshot box (states and block-entity NBT), P6
		WorldJournal.Captured target = WorldJournal.capture(level, sb);
		Cells t = Cells.fromCapture(target);
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
			new Construction(Construction.BUILDING, boxIdx, JOURNAL_TARGET, null, new BitSet(), false, owner));
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
		// the crate: outside the snapshot box, at the approach's end (or 2 out from the entrance); a batch whose group shares one
		// crate (phase 4d, R6) puts it down once (at crateAt, or beside the first site's approach end) and every site uses it
		String sharedId = SHARED_CRATE.get();
		SiteGroupRec grp = sharedId == null ? null : Sites.group(sharedId);
		Construction.Crate crate = null;
		if (grp != null && grp.crate() != null) {
			Construction.Crate gc = grp.crate();
			if (level.getBlockEntity(new BlockPos(gc.x(), gc.y(), gc.z())) instanceof CrateBlockEntity be && grp.crateOwner().equals(be.siteId())) {
				crate = gc;
			}
		}
		boolean newCrate = crate == null;
		if (crate == null) {
			BlockPos cratePos = grp != null && grp.crateAt() != null ? new BlockPos(grp.crateAt()[0], grp.crateAt()[1], grp.crateAt()[2])
				: cratePos(level, bp, built, sb);
			BlockState was = level.getBlockState(cratePos);
			BlockEntity wasBe = level.getBlockEntity(cratePos);
			String wasNbt = wasBe == null ? null : wasBe.saveWithFullMetadata(level.registryAccess()).toString();
			crate = new Construction.Crate(cratePos.getX(), cratePos.getY(), cratePos.getZ(), NbtUtils.writeBlockState(was).toString(), wasNbt);
		}
		Architect.LOGGER.info("Construction site {} ({}): {} cells queued, crate at {}{}", id, bp.id(), n, crate.x() + "," + crate.y() + "," + crate.z(),
			r.waterlogged > 0 ? ", " + r.waterlogged + " waterlogged cell(s) built dry" : "");
		return new ConvertPlan(id, new Construction(Construction.BUILDING, queue, JOURNAL_TARGET, crate, new BitSet(), false, owner), target, sb, newCrate,
			grp == null ? null : grp.id());
	}

	/** {@link Construction#target} of a 4e construction site: its target lives in its journal entry ({@code after}). */
	static final String JOURNAL_TARGET = "journal";

	/** P7 of a construction placement: the site entry's after is the target, and a new crate's cell its own {@code crate} entry. */
	static java.util.concurrent.CompletableFuture<Void> commitConvert(ServerLevel level, ConvertPlan p) throws Sites.SiteException {
		Construction.Crate c = p.construction().crate();
		if (!p.newCrate() || c == null) {
			return SiteJournal.complete(p.id(), p.target(), null);
		}
		String owner = p.sharedGroup() != null ? SiteGroupRec.CRATE_PREFIX + p.sharedGroup() : p.id();
		SiteGroupRec g = p.sharedGroup() == null ? null : Sites.group(p.sharedGroup());
		String group = g != null ? g.id() : Sites.get(p.id()) != null ? Sites.get(p.id()).group() : null;
		Sites.SiteException[] err = new Sites.SiteException[1];
		var f = SiteJournal.complete(p.id(), p.target(), t -> {
			try {
				SiteJournal.crateEntry(t, level, owner, group, new BlockPos(c.x(), c.y(), c.z()), WorldJournal.value(CrateBlocks.CRATE.defaultBlockState()));
			} catch (Sites.SiteException e) {
				err[0] = e;
			}
		});
		if (err[0] != null) {
			throw err[0];
		}
		return f;
	}

	/** After P7: a new crate goes down (its entry is committed). */
	static void placeCrate(ServerLevel level, ConvertPlan p) {
		Construction.Crate c = p.construction().crate();
		if (!p.newCrate() || c == null) {
			return;
		}
		BlockPos cratePos = new BlockPos(c.x(), c.y(), c.z());
		SiteGroupRec grp = p.sharedGroup() == null ? null : Sites.group(p.sharedGroup());
		level.setBlock(cratePos, CrateBlocks.CRATE.defaultBlockState(), Sites.FLAGS);
		if (level.getBlockEntity(cratePos) instanceof CrateBlockEntity be) {
			be.setSiteId(grp != null ? grp.crateOwner() : p.id());
		}
		if (grp != null) {
			Sites.putGroup(level.getServer(), grp.withCrate(c));
		}
	}

	/**
	 * Block update flags for clearing queued cells to air ({@link #clear}, a construction delta's added cells): {@link Sites#FLAGS}
	 * plus {@link net.minecraft.world.level.block.Block#UPDATE_KNOWN_SHAPE}. Without it, {@code Level.setBlock} still runs the
	 * neighbours' shape updates and strips {@code UPDATE_SUPPRESS_DROPS} for them ({@code flags & -34}): clearing a door's upper
	 * half breaks its lower half, one bed half the other, a hanging lantern's support the lantern, each dropping its item while
	 * the builder later places the block again from paid items (a free item). The builder's own writes re-run the shape
	 * updates, so the finished site is unchanged.
	 */
	static final int CLEAR_FLAGS = Sites.FLAGS | net.minecraft.world.level.block.Block.UPDATE_KNOWN_SHAPE;

	/**
	 * Clears queued cells of {@code c} to air, top down, no drops, no neighbour updates ({@link #CLEAR_FLAGS}: nothing pops off): from index
	 * {@code from} of the top-down order until {@code deadline} ({@link System#nanoTime}; {@code Long.MAX_VALUE}: all). Returns
	 * the next index ({@code c.size()} when done).
	 */
	static int clear(ServerLevel level, Construction c, Anchors.Bounds sb, int from, long deadline) {
		int[] topDown = c.queue();
		Arrays.sort(topDown);
		int dx = sb.maxX() - sb.minX() + 1;
		int dz = sb.maxZ() - sb.minZ() + 1;
		BlockPos.MutableBlockPos mp = new BlockPos.MutableBlockPos();
		BlockState air = Blocks.AIR.defaultBlockState();
		int i = from;
		for (; i < topDown.length; i++) {
			if (i > from && (i - from) % 16 == 0 && System.nanoTime() >= deadline) {
				return i;
			}
			int k = topDown[topDown.length - 1 - i];
			int[] o = Construction.offsets(k, dx, dz);
			level.setBlock(mp.set(sb.minX() + o[0], sb.minY() + o[1], sb.minZ() + o[2]), air, CLEAR_FLAGS);
		}
		return i;
	}

	/**
	 * Turns the instant placement just built into a construction site at once (a single Place): P6, the P7 commit
	 * (synchronous), the crate and the clearing. Called by {@link Sites#place} before the record is placed; throws after undoing
	 * nothing of the world (the caller takes the placement down).
	 */
	static Construction convertNow(ServerLevel level, Blueprint bp, Sites.Built built, String id, @Nullable String owner) throws Sites.SiteException {
		long t0 = System.nanoTime();
		ConvertPlan p = planConvert(level, bp, built, id, owner);
		SiteJournal.await(commitConvert(level, p), "the construction plan of " + id);
		placeCrate(level, p);
		clear(level, p.construction(), p.sb(), 0, Long.MAX_VALUE);
		Placement.noteConvert(id, System.nanoTime() - t0);
		return p.construction();
	}

	private static void add(List<BlockPos> cells, Set<Long> seen, BlockPos p) {
		if (seen.add(p.asLong())) {
			cells.add(p);
		}
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
		// the per-tick placement budget (phase 4d) is shared: past it, a site places only its first cell this tick
		for (int i = r.built.nextClearBit(0); i < r.size() && budget > 0 && scanned < SCAN && (placed == 0 || Placement.remainingNanos() > 0);
			i = r.built.nextClearBit(i + 1)) {
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
			// phase 5b: a swap replaces the old version's block only now that the new item is in the crate; the old block is
			// refunded when it was paid (the free bit) and is still the site's
			boolean swapNow = r.holdsOld(now, i) && (q == null || r.holdsOld(level.getBlockState(q), j) || free(level, q, level.getBlockState(q), r.target[j]));
			if (!swapNow && (!free(level, p, now, r.target[i]) || q != null && (!level.isLoaded(q) || !free(level, q, level.getBlockState(q), r.target[j])))) {
				r.blockedSince.putIfAbsent(i, ticks);
				continue;
			}
			r.blockedSince.remove(i);
			if (swapNow) {
				refundSwap(level, s, r, i, free);
				if (j >= 0 && r.holdsOld(level.getBlockState(q), j)) {
					refundSwap(level, s, r, j, free);
				}
				freeChanged = true;
			}
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
		// a group's shared crate stays while another of its sites still builds (R6)
		boolean keepCrate = !otherBuildingShared(s).isEmpty() || s.group() != null && !RoadBuilder.building(s.group()).isEmpty();
		keepDelivered(srv, s, crate, keepCrate);
		Map<String, Integer> left = crate != null && !keepCrate ? crate.ledger().takeStock() : Map.of();
		BlockPos at = c.crate() != null ? new BlockPos(c.crate().x(), c.crate().y(), c.crate().z()) : dropPos(s);
		if (c.crate() != null && !keepCrate && (crate != null || level.isLoaded(at))) {
			restoreCrateCell(level, c.crate());
			SiteJournal.releaseKind(crateOwner(s), WorldJournal.CRATE); // its cell is the ground again (phase 4e)
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

	static boolean near(ServerPlayer p, Anchors.Bounds b, int range) {
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

	static void send(ServerPlayer p, net.minecraft.network.protocol.common.custom.CustomPacketPayload payload) {
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
		if (crate.siteId().startsWith(SiteGroupRec.CRATE_PREFIX)) {
			List<Site> fed = fedBy(crate.siteId());
			s = fed.isEmpty() ? null : fed.get(0);
		}
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
	static Deconstruction prepareDeconstruct(ServerLevel level, Site s) {
		MinecraftServer srv = level.getServer();
		Run r = run(srv, s);
		Map<Long, dev.larattalabs.architect.journal.Journal.Value> known = SiteJournal.beforeMap(s.id(), false);
		Cells before = known == null ? Cells.fromValues(s.restoreBox(), Map.of()) : Cells.fromValues(s.restoreBox(), known);
		Anchors.Bounds b = s.restoreBox();
		BitSet free = s.construction().free();
		Refunds.Tally tally = new Refunds.Tally();
		int missing = 0;
		BlockPos.MutableBlockPos m = new BlockPos.MutableBlockPos();
		int dx = b.maxX() - b.minX() + 1;
		int dz = b.maxZ() - b.minZ() + 1;
		// phase 4e "Survival layering": cells another site covers belong to it; a paid cell of this site whose intact block the
		// covering site displaced (its before there is this site's block) is refunded (rule 3b), nothing else there
		Map<Long, dev.larattalabs.architect.journal.Journal.Value> cover = SiteJournal.coverBefores(s.id());
		for (int y = b.minY(); y <= b.maxY(); y++) {
			for (int z = b.minZ(); z <= b.maxZ(); z++) {
				for (int x = b.minX(); x <= b.maxX(); x++) {
					m.set(x, y, z);
					if (!cover.isEmpty()) {
						var over = cover.get(m.asLong());
						if (over != null) {
							int qi = r == null ? -1 : r.queuePos(m);
							// displaced: the covering site's before is this site's block and the world no longer holds it there (a block
							// the covering site kept stays in the world; it drops once, with the covering site's removal)
							if (qi >= 0 && !free.get(qi) && WorldJournal.state(over).is(r.target[qi].getBlock()) && !level.getBlockState(m).is(r.target[qi]
								.getBlock())) {
								tally.add(Refunds.Outcome.REFUND, r.cost.get(qi));
							}
							continue;
						}
					}
					int qi0 = r == null ? -1 : r.queuePos(m);
					if (qi0 < 0 && known != null && !known.containsKey(m.asLong())) {
						continue; // a cell of the restore box no entry of the site recorded (between versions' boxes): not the site's
					}
					BlockState now = level.getBlockState(m);
					int k = Construction.index(x - b.minX(), y - b.minY(), z - b.minZ(), dx, dz);
					BlockState was = k < before.size() ? before.states[k] : Blocks.AIR.defaultBlockState();
					int qi = r == null ? -1 : r.queuePos(m);
					boolean asPlaced = qi >= 0 && r.matches(now, qi);
					Refunds.Outcome o = Refunds.classify(qi >= 0, asPlaced, qi >= 0 && free.get(qi), now.isAir(), was.is(now.getBlock()),
						Refunds.natural(Cells.blockId(was), Cells.blockId(now)));
					if (o == Refunds.Outcome.REFUND) {
						tally.add(o, r.cost.get(qi));
						if (TRACE_REFUNDS) {
							Architect.LOGGER.info("refund-trace deconstruct {} {} target {} now {} cost {}", s.id(), m.toShortString(), r.target[qi], now, r.cost.get(qi));
						}
					} else if (o == Refunds.Outcome.PLAYER_DROP) {
						tally.add(o, Cells.cost(now));
						if (TRACE_REFUNDS) {
							Architect.LOGGER.info("refund-trace player {} {} was {} now {} qi {}", s.id(), m.toShortString(), was, now, qi);
						}
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
			// a shared crate other sites still build from stays; this site's refunds drop at its cell (R6)
			if (crate != null && otherBuildingShared(s).isEmpty() && (s.group() == null || RoadBuilder.building(s.group()).isEmpty())) {
				keepDelivered(srv, s, crate, false);
				stock = crate.ledger().takeStock();
				restoreCrateCell(level, c.crate());
				if (sharedGroup(s) != null) {
					SiteJournal.releaseKind(crateOwner(s), WorldJournal.CRATE); // the group's crate went (its own entry, phase 4e)
				}
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
		JsonObject o = stateOf(srv, id);
		// phase 4e: its journal entries, the cells another site covers, the sites it lies on and under
		JsonObject j = SiteJournal.siteJson(id);
		j.entrySet().forEach(e -> o.add(e.getKey(), e.getValue()));
		JsonObject layers = new JsonObject();
		layers.add("covers", j.get("covers"));
		layers.add("coveredBy", j.get("coveredBy"));
		o.add("layers", layers);
		return o;
	}

	private static JsonObject stateOf(MinecraftServer srv, String id) throws Sites.SiteException {
		Site s = Sites.get(id);
		if (s == null) {
			Infra i = Infras.get(id) != null ? Infras.get(id) : Infras.pending(id);
			if (i != null) {
				JsonObject o = i.toJson();
				o.remove("id");
				o.addProperty("site", id);
				o.addProperty("state", Infras.get(id) == null ? "removed" : i.placing() ? "placing" : "placed");
				return o;
			}
			throw new Sites.SiteException("No site " + id);
		}
		Construction c = s.construction();
		JsonObject o = new JsonObject();
		o.addProperty("site", id); // not "id": DevBridge replies carry the request id there
		o.addProperty("blueprint", s.blueprint());
		// phase 5b: the version, the cells the player changed that deltas kept, the delta entries standing, the refunds of
		// construction deltas so far (this world session)
		o.addProperty("version", SiteDeltas.versionOf(srv, s));
		o.addProperty("headVersion", SiteDeltas.headVersion(s.blueprint()));
		o.addProperty("deviations", s.versioning().deviations());
		o.addProperty("deltas", (int) SiteJournal.active(id).stream().filter(m -> m.kind().equals(WorldJournal.DELTA)).count());
		o.add("deltaRefunds", counts(REFUNDED.getOrDefault(id, Map.of())));
		if (c == null) {
			o.addProperty("state", "instant");
			return o;
		}
		o.addProperty("swaps", c.swap().cardinality());
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

	// ------------------------------------------------------------------ phase 5b: construction deltas (survival)

	/** Refunds per site (dev.site.state, the gate's items-in = items-out), since the world started. */
	static final Map<String, Map<String, Integer>> REFUNDED = new ConcurrentHashMap<>();
	/** Dev trace (ARCHITECT_TRACE_REFUNDS=1): every refunded cell in the log. */
	static final boolean TRACE_REFUNDS = System.getenv("ARCHITECT_TRACE_REFUNDS") != null;

	/** A swap: the old block's item goes to the crate's cell (when it was paid), and the cell counts as paid for its new block. */
	private static void refundSwap(ServerLevel level, Site s, Run r, int i, BitSet free) {
		if (r.old != null && r.old[i] != null && !free.get(i)) {
			Map<String, Integer> items = new TreeMap<>();
			Cells.cost(r.old[i]).forEach(c -> items.merge(c.item(), c.count(), Integer::sum));
			if (TRACE_REFUNDS) {
				Architect.LOGGER.info("refund-trace swap {} {} old {}", s.id(), r.pos(i).toShortString(), r.old[i]);
			}
			Construction c = s.construction();
			BlockPos at = c.crate() != null ? new BlockPos(c.crate().x(), c.crate().y(), c.crate().z()).above() : dropPos(s);
			dropItems(level, at, items, null);
			items.forEach((k, v) -> REFUNDED.computeIfAbsent(s.id(), x -> new ConcurrentHashMap<>()).merge(k, v, Integer::sum));
		}
		free.clear(i);
	}

	/**
	 * The verdict of a construction delta (survival: INSTANT not allowed for the actor; docs/CONTRACT.md phase 5b "Survival"): the
	 * instant check, plus its bill of materials (the queued cells: added and changed, at their new block) and refunds (removed
	 * cells and swapped ones that were paid and are still the site's), and creative-only blocks.
	 */
	public static SiteDeltas.Check checkConstructionDelta(ServerLevel level, SiteDeltas.Request r) {
		SiteDeltas.Check c = SiteDeltas.check(level, r);
		if (c.plan() == null) {
			return c;
		}
		Site site = Sites.get(r.siteId());
		Map<String, Integer> bom = new TreeMap<>();
		Map<String, Integer> refund = new TreeMap<>();
		List<SiteDeltas.Refusal> more = new ArrayList<>();
		java.util.Set<String> creative = new java.util.TreeSet<>();
		BitSet paid = paidCells(site);
		Anchors.Bounds box = site.restoreBox();
		for (var e : c.plan().outcome().write().entrySet()) {
			BlockPos p = BlockPos.of(e.getKey());
			BlockState target = WorldJournal.state(e.getValue());
			Byte kind = c.ghost().get(e.getKey());
			boolean queued = !target.isAir() && kind != null && kind != SiteDeltas.REMOVED;
			if (queued) {
				for (SurvivalItems.Cost x : Cells.cost(target)) {
					bom.merge(x.item(), x.count(), Integer::sum);
				}
				if (SurvivalItems.bundled().creativeOnly(Cells.blockId(target))) {
					creative.add(Cells.blockId(target));
				}
			}
			// what goes back: the site's paid block there (removed now, or swapped later)
			if (box.contains(p.getX(), p.getY(), p.getZ()) && paid.get(boxIndex(box, p))) {
				BlockState now = level.getBlockState(p);
				if (!now.isAir()) {
					for (SurvivalItems.Cost x : Cells.cost(now)) {
						refund.merge(x.item(), x.count(), Integer::sum);
					}
				}
			}
		}
		if (!creative.isEmpty()) {
			more.add(new SiteDeltas.Refusal(dev.larattalabs.architect.api.Reason.CREATIVE_ONLY_BLOCK, "This version uses " + String.join(", ", creative)
				+ ", which survival can't build", false));
		}
		return c.withSurvival(bom, refund, more);
	}

	/** The cells of a site's restore box that hold a paid block now (queued, not free), as box indexes. */
	static BitSet paidCells(Site s) {
		BitSet out = new BitSet();
		Construction c = s.construction();
		if (c == null) {
			return out; // an instant site: nothing was paid
		}
		BitSet free = c.free();
		int[] q = c.queue();
		for (int i = 0; i < q.length; i++) {
			if (!free.get(i)) {
				out.set(q[i]);
			}
		}
		return out;
	}

	static int boxIndex(Anchors.Bounds box, BlockPos p) {
		int dx = box.maxX() - box.minX() + 1;
		int dz = box.maxZ() - box.minZ() + 1;
		return Construction.index(p.getX() - box.minX(), p.getY() - box.minY(), p.getZ() - box.minZ(), dx, dz);
	}

	/**
	 * Starts a construction delta (survival; docs/CONTRACT.md phase 5b "Survival"): the delta is applied as an instant delta (its
	 * entry's after is what an instant apply leaves: the target), then turned into a construction: removed cells stay written
	 * (free) and their paid blocks are refunded; added cells are cleared to air (free) and queued; changed cells get the old
	 * version's block back and are queued as swaps (no hole while materials wait). A new crate goes beside the approach end.
	 * Its history step is never journal-undone ({@code revertible} false): a survival revert is a paid forward delta.
	 */
	public static SiteDeltas.Result applyConstructionDelta(ServerLevel level, SiteDeltas.Request r, @org.jspecify.annotations.Nullable ServerPlayer actor)
		throws Sites.SiteException {
		SiteDeltas.Check c = checkConstructionDelta(level, r);
		if (!c.ok()) {
			SiteDeltas.Refusal f = c.refusals().get(0);
			throw new Sites.SiteException(f.reason(), f.message());
		}
		MinecraftServer srv = level.getServer();
		Site before = Sites.get(r.siteId());
		BitSet paidBefore = paidCells(before);
		Anchors.Bounds oldBox = before.restoreBox();
		Construction oldC = before.construction();
		Map<Long, BlockState> was = new HashMap<>();
		for (long p : c.plan().outcome().write().keySet()) {
			was.put(p, level.getBlockState(BlockPos.of(p)));
		}
		// the player's blocks an OVERWRITE replaces drop as items (phase 3 rule)
		if (r.edits() == dev.larattalabs.architect.delta.DeltaPlanner.Edits.OVERWRITE) {
			Map<String, Integer> drop = new TreeMap<>();
			for (var k : c.plan().outcome().edited()) {
				BlockState now = level.getBlockState(BlockPos.of(k.pos()));
				Cells.cost(now).forEach(x -> drop.merge(x.item(), x.count(), Integer::sum));
			}
			dropItems(level, dropPos(before), drop, null);
		}
		SiteDeltas.Result res = SiteDeltas.applyChecked(level, c, r.edits() == dev.larattalabs.architect.delta.DeltaPlanner.Edits.OVERWRITE, "delta");
		Site s = Sites.get(r.siteId());
		String entry = s.versioning().history().get(s.versioning().history().size() - 1).deltaEntry();
		Anchors.Bounds box = s.restoreBox();
		int dx = box.maxX() - box.minX() + 1;
		int dz = box.maxZ() - box.minZ() + 1;
		// the queue: the site's paid cells (old queue, remapped to the new box) minus the removed ones, plus the queued delta cells
		Map<Integer, Boolean> freeOf = new java.util.LinkedHashMap<>(); // box index -> free
		if (oldC != null) {
			int odx = oldBox.maxX() - oldBox.minX() + 1;
			int odz = oldBox.maxZ() - oldBox.minZ() + 1;
			BitSet of = oldC.free();
			int[] oq = oldC.queue();
			for (int i = 0; i < oq.length; i++) {
				int[] o = Construction.offsets(oq[i], odx, odz);
				BlockPos p = new BlockPos(oldBox.minX() + o[0], oldBox.minY() + o[1], oldBox.minZ() + o[2]);
				freeOf.put(boxIndex(box, p), of.get(i));
			}
		}
		Map<String, Integer> refunded = new TreeMap<>();
		List<Integer> swapIdx = new ArrayList<>();
		BlockPos.MutableBlockPos mp = new BlockPos.MutableBlockPos();
		List<BlockPos> clearAir = new ArrayList<>();
		for (var e : c.plan().outcome().write().entrySet()) {
			BlockPos p = BlockPos.of(e.getKey());
			BlockState target = WorldJournal.state(e.getValue());
			Byte kind = c.ghost().get(e.getKey());
			int k = boxIndex(box, p);
			boolean wasPaid = oldBox.contains(p.getX(), p.getY(), p.getZ()) && paidBefore.get(boxIndexOld(oldBox, p));
			BlockState old = was.get(e.getKey());
			if (target.isAir() || kind == null || kind == SiteDeltas.REMOVED) {
				// removed (or now air): written already, free; the paid block that stood there is refunded now
				if (wasPaid && old != null && !old.isAir()) {
					Cells.cost(old).forEach(x -> refunded.merge(x.item(), x.count(), Integer::sum));
					if (TRACE_REFUNDS) {
						Architect.LOGGER.info("refund-trace delta-removed {} {} old {} target {} kind {}", s.id(), p.toShortString(), old, target, kind);
					}
				}
				freeOf.remove(k);
				continue;
			}
			if (kind == SiteDeltas.CHANGED && old != null && !old.isAir()) {
				// a swap: the old block goes back now, the new one when its item is in the crate
				level.setBlock(mp.set(p), old, Sites.FLAGS);
				freeOf.put(k, !wasPaid);
				swapIdx.add(k);
			} else {
				clearAir.add(p.immutable());
				freeOf.put(k, false);
			}
		}
		// added cells: cleared to air (free, no drops), top down
		clearAir.sort((a, b) -> Integer.compare(b.getY(), a.getY()));
		for (BlockPos p : clearAir) {
			level.setBlock(p, Blocks.AIR.defaultBlockState(), CLEAR_FLAGS);
		}
		// the queue in build order (bottom up, supports first, pairs together), as a construction placement orders it
		int[] boxIdx = freeOf.keySet().stream().mapToInt(Integer::intValue).toArray();
		Cells t = SiteJournal.target(s.id(), box);
		Site probe = s.withConstruction(new Construction(Construction.BUILDING, boxIdx, JOURNAL_TARGET, null, new BitSet(), false, null));
		Run pr = new Run(probe, t);
		int n = boxIdx.length;
		int[] ys = new int[n];
		int[] kinds = new int[n];
		int[] pairOf = new int[n];
		for (int i = 0; i < n; i++) {
			ys[i] = pr.pos(i).getY();
			kinds[i] = kind(pr.target[i]);
			pairOf[i] = pr.isSecond[i] ? pr.pairFirst(i) : -1;
		}
		int[] order = BuildOrder.order(ys, kinds, pr.support, pairOf);
		int[] queue = new int[n];
		BitSet free = new BitSet();
		BitSet swap = new BitSet();
		java.util.Set<Integer> swaps = new HashSet<>(swapIdx);
		for (int i = 0; i < n; i++) {
			queue[i] = boxIdx[order[i]];
			if (Boolean.TRUE.equals(freeOf.get(queue[i]))) {
				free.set(i);
			}
			if (swaps.contains(queue[i])) {
				swap.set(i);
			}
		}
		// the crate: beside the new version's approach end (its own crate entry in the site's undo group)
		BlockPos cp = deltaCratePos(level, s, c.plan().pb());
		Construction.Crate crate = null;
		if (cp != null) {
			BlockState wasC = level.getBlockState(cp);
			crate = new Construction.Crate(cp.getX(), cp.getY(), cp.getZ(), NbtUtils.writeBlockState(wasC).toString(), null);
			dev.larattalabs.architect.journal.JournalStore js = SiteJournal.store();
			dev.larattalabs.architect.journal.JournalStore.Txn txn = js.begin().label("crate:" + s.id());
			SiteJournal.crateEntry(txn, level, s.id(), s.group(), cp, WorldJournal.value(CrateBlocks.CRATE.defaultBlockState()));
			SiteJournal.await(js.submit(txn), "the crate of " + s.id());
			level.setBlock(cp, CrateBlocks.CRATE.defaultBlockState(), Sites.FLAGS);
			if (level.getBlockEntity(cp) instanceof CrateBlockEntity be) {
				be.setSiteId(s.id());
			}
		}
		Construction nc = (oldC != null ? oldC : new Construction(Construction.BUILT, new int[0], JOURNAL_TARGET, null, new BitSet(), false, actor
			== null ? null : actor.getStringUUID())).withDelta(queue, free, crate, entry, swap);
		// the step is never journal-undone (a survival revert is a paid forward delta)
		List<Site.History> h = new ArrayList<>(s.versioning().history());
		Site.History last = h.remove(h.size() - 1);
		h.add(last.withRevertible(false));
		Site built = s.withConstruction(nc).withVersioning(new Site.Versioning(s.versioning().version(), h, 0, 0, s.versioning().deviations()));
		Sites.replace(srv, built);
		RUNS.remove(s.id());
		dropItems(level, crate != null ? cp.above() : dropPos(s), refunded, null);
		refunded.forEach((k, v) -> REFUNDED.computeIfAbsent(s.id(), x -> new ConcurrentHashMap<>()).merge(k, v, Integer::sum));
		Architect.LOGGER.info("Construction delta of {} v{} -> v{}: {} cells queued ({} swaps), refunds {}", s.id(), res.from(), res.to(), n, swap
			.cardinality(), refunded);
		return new SiteDeltas.Result(true, s.id(), res.from(), res.to(), res.written(), res.kept(), res.reshaped(), List.of(), res.notes(), before, built,
			refunded);
	}

	static int boxIndexOld(Anchors.Bounds box, BlockPos p) {
		return boxIndex(box, p);
	}

	/** The crate's cell of a construction delta: beside the new version's approach end (the phase 3 rule), outside every site. */
	static @org.jspecify.annotations.Nullable BlockPos deltaCratePos(ServerLevel level, Site s, dev.larattalabs.architect.delta.SitePlanner.Plan pb) {
		Anchors.Bounds sb = s.restoreBox();
		Blueprint bp = Blueprints.get(s.blueprint());
		int turns = dev.larattalabs.architect.placement.BlueprintTransform.parseTurns(s.rotation());
		String front = dev.larattalabs.architect.placement.BlueprintTransform.rotateDirection(bp == null ? "south" : bp.front(), turns);
		int[] out = Approach.outward(front);
		double[] end = pb.approach().end();
		BlockPos start;
		int step;
		if (end != null) {
			start = BlockPos.containing(end[0], end[1], end[2]);
			step = 1;
		} else {
			Anchor e = s.anchors().get(Blueprint.ENTRANCE);
			start = e != null ? BlockPos.containing(e.x(), e.y(), e.z()) : new BlockPos((sb.minX() + sb.maxX()) / 2, s.box().minY() + 1, (sb.minZ() + sb
				.maxZ()) / 2);
			step = 2;
		}
		int[] right = {-out[1], out[0]};
		BlockPos p = start.offset(out[0] * step + right[0], 0, out[1] * step + right[1]);
		for (int i = 0; i < 24 && (sb.contains(p.getX(), p.getY(), p.getZ()) || inOtherSite(level, p) || SiteJournal.owned(s.dimension(), p.asLong())); i++) {
			p = p.offset(out[0], 0, out[1]);
		}
		return p;
	}
}
