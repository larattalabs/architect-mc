package dev.larattalabs.architect.site;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import dev.larattalabs.architect.Architect;
import dev.larattalabs.architect.journal.Journal;
import dev.larattalabs.architect.journal.JournalStore;
import dev.larattalabs.architect.journal.WorldJournal;
import dev.larattalabs.architect.placement.Anchors;
import dev.larattalabs.architect.survival.CellBits;
import dev.larattalabs.architect.survival.CrateBlockEntity;
import dev.larattalabs.architect.survival.CrateBlocks;
import dev.larattalabs.architect.survival.Ledger;
import dev.larattalabs.architect.survival.SiteNet;
import dev.larattalabs.architect.survival.SurvivalItems;
import dev.larattalabs.architect.survival.SurvivalWorld;
import java.util.ArrayList;
import java.util.BitSet;
import java.util.Comparator;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import net.minecraft.core.BlockPos;
import net.minecraft.nbt.NbtUtils;
import net.minecraft.network.chat.Component;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.entity.BlockEntity;
import net.minecraft.world.level.block.state.BlockState;
import org.jspecify.annotations.Nullable;

/**
 * C16 (docs/CONTRACT.md phase 6c slice 0c §7): a road of a survival batch with a shared crate, built by the builder from the
 * group's crate. Placing runs the instant road unchanged (its journal entry's {@code before} is the ground, its {@code after} the
 * target, so an undo is exact); then every changed cell that isn't a cut (cut cells stay cleared, free) goes back to its
 * {@code before} and is queued in centre-line order, bottom up per column. Each queued cell costs its target's items, except a
 * {@code dirt_path} on {@code grass_block}, which is free (the coordinator: a shovel's work). Costs come from the entry's
 * {@code before}, never the live world, so {@code checkRoad}'s BOM equals the stock's outstanding bill after placing. The
 * builder's {@link Builder.Run} is reused through a probe {@link Site} (the road's id, box and construction), so the crate's
 * acceptance, the ledger and the ghost work as for buildings. Server thread.
 */
public final class RoadBuilder {
	private static final Map<String, Builder.Run> RUNS = new ConcurrentHashMap<>();
	/** Per road, the queued cells' {@code before} states (what the builder may replace). */
	private static final Map<String, BlockState[]> BEFORE = new ConcurrentHashMap<>();
	private static final Map<String, long[]> PROGRESS = new ConcurrentHashMap<>();
	/** The marker in a road record's spec: built as a construction road once placed. */
	static final String SPEC_CONSTRUCTION = "construction";
	private static long ticks;

	private RoadBuilder() {
	}

	static void init() {
		net.fabricmc.fabric.api.event.lifecycle.v1.ServerTickEvents.END_SERVER_TICK.register(RoadBuilder::tick);
		net.fabricmc.fabric.api.event.lifecycle.v1.ServerLifecycleEvents.SERVER_STOPPED.register(s -> {
			RUNS.clear();
			BEFORE.clear();
			PROGRESS.clear();
		});
	}

	// ------------------------------------------------------------------ costs

	/** Whether a road cell is free: a dirt path laid on grass (N-0c-2, the coordinator's decision). */
	static boolean freeCell(BlockState before, BlockState target) {
		return target.is(Blocks.DIRT_PATH) && before.is(Blocks.GRASS_BLOCK);
	}

	/** Whether the road queues a cell: it writes a block (not a cut to air) other than the one there. */
	static boolean queued(BlockState before, BlockState target) {
		return !target.isAir() && !before.is(target.getBlock());
	}

	/** {@code checkRoad}'s BOM in construction mode: what the queued cells cost, against the world now. */
	public static Map<String, Integer> bom(ServerLevel level, long[] positions, Journal.Value[] values) {
		Map<String, Integer> out = new TreeMap<>();
		BlockPos.MutableBlockPos m = new BlockPos.MutableBlockPos();
		for (int i = 0; i < positions.length; i++) {
			BlockState before = level.getBlockState(m.set(Journal.x(positions[i]), Journal.y(positions[i]), Journal.z(positions[i])));
			BlockState target = WorldJournal.state(values[i]);
			if (!queued(before, target) || freeCell(before, target)) {
				continue;
			}
			for (SurvivalItems.Cost c : Cells.cost(dry(target))) {
				out.merge(c.item(), c.count(), Integer::sum);
			}
		}
		return out;
	}

	private static BlockState dry(BlockState s) {
		return s.hasProperty(net.minecraft.world.level.block.state.properties.BlockStateProperties.WATERLOGGED) ? s.setValue(
			net.minecraft.world.level.block.state.properties.BlockStateProperties.WATERLOGGED, false) : s;
	}

	// ------------------------------------------------------------------ place: instant road -> construction road

	/** Whether a road just placed is to become a construction road (its record's spec says so) and isn't one yet. */
	static boolean wanted(Infra i) {
		return i.road() && i.construction() == null && i.spec().has(SPEC_CONSTRUCTION) && i.spec().get(SPEC_CONSTRUCTION).getAsBoolean();
	}

	/**
	 * After the instant road's ACTIVE commit: the queue (centre-line order, bottom up per column), the group's crate (put down
	 * when the group has none yet), every queued cell back to its {@code before}. Returns the record with its construction.
	 */
	static Infra convert(ServerLevel level, Infra road) throws Sites.SiteException {
		MinecraftServer srv = level.getServer();
		Anchors.Bounds box = road.box();
		Cells target = SiteJournal.target(road.id(), box);
		JournalStore.Meta main = SiteJournal.main(road.id());
		Cells before = main == null ? null : SiteJournal.beforeOf(main.id(), box);
		if (target == null || before == null) {
			throw new Sites.SiteException("the construction road " + road.id() + " has no journal target");
		}
		SiteGroupRec g = road.group() == null ? null : Sites.group(road.group());
		if (g == null || !g.sharedCrate()) {
			throw new Sites.SiteException(dev.larattalabs.architect.api.Reason.NOT_ALLOWED, "a construction road needs its batch's shared crate");
		}
		int dx = box.maxX() - box.minX() + 1;
		int dz = box.maxZ() - box.minZ() + 1;
		// the columns in centre-line order (the record's walkway), then the others (lantern posts) in box order
		Map<Long, Integer> colOrder = new HashMap<>();
		JsonArray walk = road.spec().has("walk") ? road.spec().getAsJsonArray("walk") : new JsonArray();
		for (int i = 0; i + 2 < walk.size(); i += 3) {
			colOrder.putIfAbsent(col(walk.get(i).getAsInt(), walk.get(i + 2).getAsInt()), colOrder.size());
		}
		List<int[]> cells = new ArrayList<>(); // {boxIndex, colOrder, y}
		for (int y = box.minY(); y <= box.maxY(); y++) {
			for (int z = box.minZ(); z <= box.maxZ(); z++) {
				for (int x = box.minX(); x <= box.maxX(); x++) {
					int k = Construction.index(x - box.minX(), y - box.minY(), z - box.minZ(), dx, dz);
					if (k < target.size() && queued(before.states[k], target.states[k])) {
						Integer o = colOrder.get(col(x, z));
						cells.add(new int[] {k, o == null ? Integer.MAX_VALUE : o, y, z, x});
					}
				}
			}
		}
		cells.sort(Comparator.<int[]>comparingInt(c -> c[1]).thenComparingInt(c -> c[4]).thenComparingInt(c -> c[3]).thenComparingInt(c -> c[2]));
		int[] queue = cells.stream().mapToInt(c -> c[0]).toArray();
		Construction.Crate crate = ensureCrate(level, g, road);
		// every queued cell back to its before (no drops, no neighbour shape updates); cut cells stay cleared
		BlockPos.MutableBlockPos m = new BlockPos.MutableBlockPos();
		int[] topDown = queue.clone();
		java.util.Arrays.sort(topDown);
		for (int i = topDown.length - 1; i >= 0; i--) {
			int[] o = Construction.offsets(topDown[i], dx, dz);
			level.setBlock(m.set(box.minX() + o[0], box.minY() + o[1], box.minZ() + o[2]), before.states[topDown[i]], Builder.CLEAR_FLAGS);
		}
		Construction c = new Construction(Construction.BUILDING, queue, Builder.JOURNAL_TARGET, crate, new BitSet(), false, null);
		Architect.LOGGER.info("Construction road {}: {} cells queued, crate at {},{},{}", road.id(), queue.length, crate.x(), crate.y(), crate.z());
		RUNS.remove(road.id());
		BEFORE.remove(road.id());
		return road.withConstruction(c);
	}

	private static long col(int x, int z) {
		return ((long) x << 32) ^ (z & 0xFFFFFFFFL);
	}

	/** The group's shared crate, put down (with its journal entry) at the group's crateAt when no site of it has one yet. */
	static Construction.Crate ensureCrate(ServerLevel level, SiteGroupRec g, Infra road) throws Sites.SiteException {
		Construction.Crate gc = g.crate();
		if (gc != null && level.getBlockEntity(new BlockPos(gc.x(), gc.y(), gc.z())) instanceof CrateBlockEntity be && g.crateOwner().equals(be.siteId())) {
			return gc;
		}
		BlockPos at;
		if (g.crateAt() != null) {
			at = new BlockPos(g.crateAt()[0], g.crateAt()[1], g.crateAt()[2]);
		} else {
			JsonArray pts = road.spec().getAsJsonArray("points");
			JsonArray p0 = pts.get(0).getAsJsonArray();
			at = new BlockPos(p0.get(0).getAsInt(), p0.get(1).getAsInt(), p0.get(2).getAsInt() - 3);
		}
		BlockState was = level.getBlockState(at);
		BlockEntity wasBe = level.getBlockEntity(at);
		String wasNbt = wasBe == null ? null : wasBe.saveWithFullMetadata(level.registryAccess()).toString();
		Construction.Crate c = new Construction.Crate(at.getX(), at.getY(), at.getZ(), NbtUtils.writeBlockState(was).toString(), wasNbt);
		JournalStore s = SiteJournal.store();
		JournalStore.Txn t = s.begin().label("crate:" + g.id());
		SiteJournal.crateEntry(t, level, g.crateOwner(), g.id(), at, WorldJournal.value(CrateBlocks.CRATE.defaultBlockState()));
		SiteJournal.await(s.submit(t), "the crate of group " + g.id());
		level.setBlock(at, CrateBlocks.CRATE.defaultBlockState(), Sites.FLAGS);
		if (level.getBlockEntity(at) instanceof CrateBlockEntity be) {
			be.setSiteId(g.crateOwner());
		}
		Sites.putGroup(level.getServer(), g.withCrate(c));
		return c;
	}

	// ------------------------------------------------------------------ the run

	/** The probe site the builder's helpers read: the road's id, box, group and construction. */
	static Site probe(Infra i) {
		return new Site(i.id(), "road", "none", i.box(), i.box(), Map.of(), i.placedAt(), i.dimension(), i.box(), Builder.JOURNAL_TARGET, null, null,
			i.construction(), i.owner(), new JsonObject(), i.member(), false, Site.Versioning.NONE);
	}

	static Builder.@Nullable Run run(MinecraftServer srv, Infra i) {
		if (i.construction() == null) {
			return null;
		}
		Builder.Run r = RUNS.get(i.id());
		if (r != null && r.placedAt == i.placedAt()) {
			return r;
		}
		Cells target = SiteJournal.target(i.id(), i.box());
		JournalStore.Meta main = SiteJournal.main(i.id());
		Cells before = main == null ? null : SiteJournal.beforeOf(main.id(), i.box());
		if (target == null || before == null) {
			Architect.LOGGER.warn("Construction road {}: its journal target can't be read; it can only be removed", i.id());
			return null;
		}
		r = new Builder.Run(probe(i), target);
		r.name = "road " + i.id();
		BlockState[] bs = new BlockState[r.size()];
		for (int q = 0; q < r.size(); q++) {
			int k = r.queue[q];
			bs[q] = k < before.size() ? before.states[k] : Blocks.AIR.defaultBlockState();
			if (freeCell(bs[q], r.target[q])) {
				// free: off the bill (before the rescan derives what is built)
				for (SurvivalItems.Cost c : r.cost.get(q)) {
					r.unbuilt.merge(c.item(), -c.count(), Integer::sum);
					r.bom.merge(c.item(), -c.count(), Integer::sum);
				}
				r.cost.set(q, List.of());
			}
		}
		r.unbuilt.values().removeIf(v -> v == 0);
		r.bom.values().removeIf(v -> v == 0);
		ServerLevel level = Sites.levelOf(srv, i.dimension());
		if (level != null) {
			r.rescan(level);
			r.newlyCount = 0;
			r.resend = false;
		}
		RUNS.put(i.id(), r);
		BEFORE.put(i.id(), bs);
		return r;
	}

	/** The building construction roads of a group. */
	static List<Infra> building(String groupId) {
		List<Infra> out = new ArrayList<>();
		for (Infra i : Infras.all()) {
			if (i.building() && groupId.equals(i.group())) {
				out.add(i);
			}
		}
		return out;
	}

	/** Hook for {@link Builder}: what the roads a crate feeds still need of {@code item} ({@code group:<id>} crates only). */
	static int unbuiltFor(MinecraftServer srv, String crateOwner, String item) {
		if (!crateOwner.startsWith(SiteGroupRec.CRATE_PREFIX)) {
			return 0;
		}
		int n = 0;
		for (Infra i : building(crateOwner.substring(SiteGroupRec.CRATE_PREFIX.length()))) {
			Builder.Run r = run(srv, i);
			if (r != null) {
				n += r.unbuiltCost(item);
			}
		}
		return n;
	}

	/** Hook for {@link Builder}: whether a crate feeds a building road. */
	static boolean feeds(String crateOwner) {
		return crateOwner.startsWith(SiteGroupRec.CRATE_PREFIX) && !building(crateOwner.substring(SiteGroupRec.CRATE_PREFIX.length())).isEmpty();
	}

	/** Hook for {@link Builder#groupStock}: the outstanding bill of the group's building roads, by road id. */
	static void stock(MinecraftServer srv, SiteGroupRec g, Map<String, Map<String, Integer>> bySite, Map<String, Integer> total) {
		for (Infra i : building(g.id())) {
			Builder.Run r = run(srv, i);
			if (r == null) {
				continue;
			}
			Map<String, Integer> out = new TreeMap<>();
			r.unbuilt.forEach((k, v) -> {
				if (v > 0) {
					out.put(k, v);
				}
			});
			bySite.put(i.id(), out);
			out.forEach((k, v) -> total.merge(k, v, Integer::sum));
		}
	}

	/** {built, queued} of a road ({0, 0} for an instant one). */
	public static int[] progress(MinecraftServer srv, Infra i) {
		Construction c = i.construction();
		if (c == null) {
			return new int[] {0, 0};
		}
		if (!c.building()) {
			return new int[] {c.size(), c.size()};
		}
		Builder.Run r = srv == null ? null : run(srv, i);
		return r == null ? new int[] {0, c.size()} : new int[] {r.built.cardinality(), r.size()};
	}

	// ------------------------------------------------------------------ the builder

	static void tick(MinecraftServer srv) {
		ticks++;
		for (Infra i : Infras.all()) {
			if (!i.building() || i.placing()) {
				continue;
			}
			ServerLevel level = Sites.levelOf(srv, i.dimension());
			Builder.Run r = level == null ? null : run(srv, i);
			if (r == null) {
				continue;
			}
			try {
				step(srv, level, i, r);
			} catch (RuntimeException e) {
				Architect.LOGGER.error("Construction road {}: builder step failed", i.id(), e);
			}
			Infra now = Infras.get(i.id());
			if (now != null && now.building()) {
				long[] last = PROGRESS.computeIfAbsent(i.id(), k -> new long[] {Long.MIN_VALUE / 2, r.built.cardinality()});
				int built = r.built.cardinality();
				if (Builder.progressDue(last[0], (int) last[1], ticks, built)) {
					last[0] = ticks;
					last[1] = built;
					dev.larattalabs.architect.apiimpl.ApiEvents.progressInfra(srv, now);
				}
			}
		}
		syncGhosts(srv);
	}

	private static void step(MinecraftServer srv, ServerLevel level, Infra road, Builder.Run r) {
		if (ticks % 20 == 0) {
			r.rescan(level);
		}
		Site s = probe(road);
		Construction c = road.construction();
		CrateBlockEntity crate = Builder.crate(level, s, false);
		BlockPos cp = c.crate() == null ? null : new BlockPos(c.crate().x(), c.crate().y(), c.crate().z());
		r.crateMissing = cp == null || level.isLoaded(cp) && crate == null;
		if (r.built.cardinality() == r.size()) {
			complete(srv, level, road, r, crate);
			return;
		}
		if (crate == null || c.paused()) {
			return;
		}
		Ledger ledger = crate.ledger();
		BlockState[] before = BEFORE.get(road.id());
		int budget = SurvivalWorld.blocksPerTick();
		int placed = 0;
		int scanned = 0;
		for (int i = r.built.nextClearBit(0); i < r.size() && budget > 0 && scanned < Builder.SCAN && (placed == 0 || Placement.remainingNanos() > 0);
			i = r.built.nextClearBit(i + 1)) {
			scanned++;
			BlockPos p = r.pos(i);
			if (!level.isLoaded(p)) {
				continue;
			}
			BlockState now = level.getBlockState(p);
			if (r.matches(now, i)) {
				r.markBuilt(i, true);
				continue;
			}
			if (!r.affordable(i, ledger)) {
				continue;
			}
			// bottom up: the queued cell below first (a gravel surface never falls into unbuilt fill); an attachable's support first
			int below = r.queuePos(p.below());
			if (below >= 0 && !r.built.get(below) || r.support[i] >= 0 && !r.built.get(r.support[i])) {
				continue;
			}
			// the builder replaces what the road planned to replace (its before: grass under a path), or air, a fluid, a plant
			boolean planned = before != null && i < before.length && now.is(before[i].getBlock());
			if (!planned && !Builder.free(level, p, now, r.target[i])) {
				r.blockedSince.putIfAbsent(i, Builder.ticksNow());
				continue;
			}
			r.blockedSince.remove(i);
			for (SurvivalItems.Cost x : r.cost.get(i)) {
				ledger.consume(x.item(), x.count());
			}
			Builder.put(level, r, i, p, true);
			budget--;
			placed++;
		}
		if (placed > 0) {
			crate.ledgerChanged();
		}
		if (r.built.cardinality() == r.size()) {
			complete(srv, level, Infras.get(road.id()), r, crate);
		}
	}

	/** Every queued cell built: the road is built; the group's crate goes once nothing of the group builds from it. */
	private static void complete(MinecraftServer srv, ServerLevel level, @Nullable Infra road, Builder.Run r, @Nullable CrateBlockEntity crate) {
		if (road == null) {
			return;
		}
		Construction c = road.construction();
		String group = road.group();
		boolean keepCrate = group != null && (Builder.anyBuildingShared(group) || building(group).stream().anyMatch(x -> !x.id().equals(road.id())));
		Map<String, Integer> left = Map.of();
		if (!keepCrate && crate != null && c.crate() != null) {
			SiteGroupRec g = Sites.group(group);
			if (g != null) {
				Sites.putGroup(srv, g.withDelivered(crate.ledger().delivered()));
			}
			left = crate.ledger().takeStock();
			BlockPos at = new BlockPos(c.crate().x(), c.crate().y(), c.crate().z());
			Builder.restoreCrateCell(level, c.crate());
			SiteJournal.releaseKind(SiteGroupRec.CRATE_PREFIX + group, WorldJournal.CRATE);
			Builder.dropItems(level, at, left, null);
		}
		Infra done = road.withConstruction(c.withState(Construction.BUILT, c.crate()).withPaused(false));
		Infras.put(srv, done);
		Builder.sendClear(srv, r, true);
		r.blockedSince.clear();
		for (ServerPlayer p : level.players()) {
			if (Builder.near(p, road.box(), Builder.RANGE)) {
				p.sendSystemMessage(Component.literal("[Architect] road " + road.id() + " is built"));
			}
		}
		Architect.LOGGER.info("Construction road {}: built ({} cells); crate leftovers {}", road.id(), r.size(), left);
		PROGRESS.remove(road.id());
		dev.larattalabs.architect.apiimpl.ApiEvents.builtInfra(srv, done);
	}

	private static void syncGhosts(MinecraftServer srv) {
		for (Infra i : Infras.all()) {
			if (!i.building()) {
				continue;
			}
			Builder.Run r = RUNS.get(i.id());
			ServerLevel level = Sites.levelOf(srv, i.dimension());
			if (r == null || level == null) {
				continue;
			}
			int[] newly = r.takeNewly();
			boolean full = r.resend;
			r.resend = false;
			Site s = probe(i);
			for (ServerPlayer p : srv.getPlayerList().getPlayers()) {
				boolean in = p.level() == level && Builder.near(p, i.box(), Builder.RANGE);
				boolean had = r.sentTo.contains(p.getUUID());
				if (!in) {
					if (had) {
						r.sentTo.remove(p.getUUID());
						Builder.send(p, new SiteNet.SiteClear(i.id(), false, r.name));
					}
					continue;
				}
				if (!had || full) {
					Builder.send(p, Builder.ghost(s, r));
					r.sentTo.add(p.getUUID());
				} else if (newly.length > 0) {
					Builder.send(p, new SiteNet.SiteProgress(i.id(), CellBits.encodeInts(newly)));
				}
				if (!had || ticks % 20 == 0) {
					Builder.send(p, Builder.status(srv, level, s, r));
				}
			}
			r.sentTo.removeIf(u -> srv.getPlayerList().getPlayer(u) == null);
		}
	}

	/** {@code /architect site finish} for a road: the remaining cells, free. */
	public static int finish(MinecraftServer srv, String id) throws Sites.SiteException {
		Infra i = Infras.get(id);
		if (i == null || !i.building()) {
			throw new Sites.SiteException(id + " is not a construction road still building");
		}
		ServerLevel level = Sites.levelOf(srv, i.dimension());
		Builder.Run r = level == null ? null : run(srv, i);
		if (r == null) {
			throw new Sites.SiteException(id + " can't be finished (not loaded)");
		}
		int n = 0;
		for (int q = r.built.nextClearBit(0); q < r.size(); q = r.built.nextClearBit(q + 1)) {
			Builder.put(level, r, q, r.pos(q), false);
			n++;
		}
		complete(srv, level, i, r, Builder.crate(level, probe(i), false));
		return n;
	}

	/**
	 * Before a construction road's undo: refunds for the paid cells standing as built drop at the crate's cell, and when nothing
	 * else of the group builds from the shared crate its stock drops and the crate goes. The undo restores the ground exactly.
	 */
	static void beforeRemove(ServerLevel level, Infra road) {
		Construction c = road.construction();
		if (c == null) {
			return;
		}
		MinecraftServer srv = level.getServer();
		Map<String, Integer> refund = new LinkedHashMap<>();
		BlockPos at = c.crate() == null ? new BlockPos((road.box().minX() + road.box().maxX()) / 2, road.box().maxY() + 1, (road.box().minZ()
			+ road.box().maxZ()) / 2) : new BlockPos(c.crate().x(), c.crate().y(), c.crate().z());
		Builder.Run r = run(srv, road);
		if (r != null) {
			r.rescan(level, true);
			for (int q = r.built.nextSetBit(0); q >= 0; q = r.built.nextSetBit(q + 1)) {
				r.cost.get(q).forEach(x -> refund.merge(x.item(), x.count(), Integer::sum));
			}
		}
		if (c.building() && c.crate() != null && road.group() != null && !Builder.anyBuildingShared(road.group()) && building(road.group()).stream()
			.allMatch(x -> x.id().equals(road.id()))) {
			CrateBlockEntity crate = Builder.crate(level, probe(road), true);
			if (crate != null) {
				SiteGroupRec g = Sites.group(road.group());
				if (g != null) {
					Sites.putGroup(srv, g.withDelivered(crate.ledger().delivered()));
				}
				crate.ledger().takeStock().forEach((k, v) -> refund.merge(k, v, Integer::sum));
				Builder.restoreCrateCell(level, c.crate());
				SiteJournal.releaseKind(SiteGroupRec.CRATE_PREFIX + road.group(), WorldJournal.CRATE);
			}
		}
		if (r != null) {
			Builder.sendClear(srv, r, false);
		}
		RUNS.remove(road.id());
		BEFORE.remove(road.id());
		PROGRESS.remove(road.id());
		Builder.dropItems(level, at, refund, null);
		Architect.LOGGER.info("Construction road {} removed: refunds and crate stock {} at {}", road.id(), refund, at.toShortString());
	}

	/** The DevBridge's view of a construction road (dev.site.state's shape, roughly): built, queued, outstanding. */
	public static @Nullable JsonObject state(MinecraftServer srv, String id) {
		Infra i = Infras.get(id);
		if (i == null || i.construction() == null) {
			return null;
		}
		JsonObject o = new JsonObject();
		int[] p = progress(srv, i);
		o.addProperty("site", id);
		o.addProperty("state", i.construction().state());
		o.addProperty("built", p[0]);
		o.addProperty("queued", p[1]);
		Builder.Run r = i.building() ? run(srv, i) : null;
		JsonObject out = new JsonObject();
		if (r != null) {
			r.unbuilt.forEach((k, v) -> {
				if (v > 0) {
					out.addProperty(k, v);
				}
			});
		}
		o.add("outstanding", out);
		return o;
	}
}
